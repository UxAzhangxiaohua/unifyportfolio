import { createHmac } from 'node:crypto';
import { BaseConnector, num, optional, parseOptionSymbol } from './base.js';
import type { AccountConfig, AccountSnapshot, BybitCredentials, Position, StableBalance } from '../types.js';

// Bybit V5 API (Unified Trading Account). Read-only key is sufficient.
const BASE = 'https://api.bybit.com';
const RECV_WINDOW = '10000';
const STABLES = new Set(['USDT', 'USDC', 'BUSD', 'TUSD', 'FDUSD', 'USDE', 'DAI']);

interface BybitResponse<T> {
  retCode: number;
  retMsg: string;
  result: T;
}

interface BybitCoin {
  coin: string;
  walletBalance: string;
  usdValue: string;
  unrealisedPnl: string;
}

interface BybitWallet {
  accountType: string;
  totalEquity: string;
  totalAvailableBalance: string;
  totalPerpUPL: string;
  totalInitialMargin: string;
  accountIMRate: string;
  coin: BybitCoin[];
}

interface BybitPosition {
  symbol: string;
  side: 'Buy' | 'Sell' | '';
  size: string;
  avgPrice: string;
  markPrice: string;
  unrealisedPnl: string;
  positionValue: string;
  leverage: string;
  liqPrice: string;
  delta?: string;
}

interface BybitFundCoin { coin: string; walletBalance: string }
interface BybitEarnPos { coin: string; amount: string }

export class BybitConnector extends BaseConnector {
  private apiKey: string;
  private apiSecret: string;

  constructor(account: AccountConfig) {
    super(account);
    const creds = account.credentials as BybitCredentials;
    this.apiKey = creds.apiKey;
    this.apiSecret = creds.apiSecret;
  }

  async fetch(): Promise<AccountSnapshot> {
    const warnings: string[] = [];
    try {
      const [walletRes, linearUsdt, linearUsdc] = await Promise.all([
        this.signedGet<{ list: BybitWallet[] }>('/v5/account/wallet-balance', { accountType: 'UNIFIED' }),
        this.signedGet<{ list: BybitPosition[] }>('/v5/position/list', { category: 'linear', settleCoin: 'USDT' }),
        this.signedGet<{ list: BybitPosition[] }>('/v5/position/list', { category: 'linear', settleCoin: 'USDC' }),
      ]);
      const [options, fund, earnFlex, earnChain] = await Promise.all([
        optional('Options', warnings, () => this.signedGet<{ list: BybitPosition[] }>('/v5/position/list', { category: 'option' }), { list: [] }, true),
        optional('Funding', warnings, () => this.signedGet<{ balance: BybitFundCoin[] }>('/v5/asset/transfer/query-account-coins-balance', { accountType: 'FUND', coin: 'USDT,USDC' }), { balance: [] }),
        optional('Earn', warnings, () => this.signedGet<{ list: BybitEarnPos[] }>('/v5/earn/position', { category: 'FlexibleSaving' }), { list: [] }),
        optional('On-chain Earn', warnings, () => this.signedGet<{ list: BybitEarnPos[] }>('/v5/earn/position', { category: 'OnChain' }), { list: [] }, true),
      ]);

      const wallet = walletRes.list[0];
      if (!wallet) throw new Error('Bybit: no UNIFIED wallet returned');

      const stables: StableBalance[] = [];
      const add = (coin: string, location: StableBalance['location'], amount: number, source: string) => {
        if ((coin === 'USDT' || coin === 'USDC') && Math.abs(amount) >= 0.01) stables.push({ asset: coin, location, amount, source });
      };
      for (const c of wallet.coin ?? []) add(c.coin, 'trading', num(c.walletBalance), 'Unified Trading');
      for (const c of fund.balance ?? []) add(c.coin, 'funding', num(c.walletBalance), 'Funding account');
      for (const e of earnFlex.list ?? []) add(e.coin, 'earn', num(e.amount), 'Flexible Savings');
      for (const e of earnChain.list ?? []) add(e.coin, 'earn', num(e.amount), 'On-chain Earn');

      const positions: Position[] = [];

      // Spot holdings (non-stable coins) — kept for completeness, hidden by default in the UI
      for (const c of wallet.coin ?? []) {
        const qty = num(c.walletBalance);
        if (qty === 0 || STABLES.has(c.coin)) continue;
        const usd = num(c.usdValue);
        positions.push({
          symbol: c.coin,
          side: qty > 0 ? 'long' : 'short',
          quantity: Math.abs(qty),
          avgPrice: 0,
          currentPrice: Math.abs(usd / qty),
          unrealizedPnl: 0,
          marketValue: Math.abs(usd),
          leverage: null,
          liquidationPrice: null,
          assetClass: 'crypto-spot',
        });
      }

      for (const p of [...linearUsdt.list, ...linearUsdc.list]) {
        const size = num(p.size);
        if (size === 0) continue;
        positions.push({
          symbol: p.symbol,
          side: p.side === 'Sell' ? 'short' : 'long',
          quantity: size,
          avgPrice: num(p.avgPrice),
          currentPrice: num(p.markPrice),
          unrealizedPnl: num(p.unrealisedPnl),
          marketValue: Math.abs(num(p.positionValue)),
          leverage: num(p.leverage) || null,
          liquidationPrice: num(p.liqPrice) || null,
          // Dated linear futures look like BTCUSDT-27DEC24 / BTC-27DEC24
          assetClass: /-\d{1,2}[A-Z]{3}\d{2}$/.test(p.symbol) ? 'crypto-future' : 'crypto-perp',
        });
      }

      for (const p of options.list ?? []) {
        const size = num(p.size);
        if (size === 0) continue;
        const parsed = parseOptionSymbol(p.symbol.replace(/-(USDT|USDC)$/, ''));
        positions.push({
          symbol: p.symbol,
          side: p.side === 'Sell' ? 'short' : 'long',
          quantity: size,
          avgPrice: num(p.avgPrice),
          currentPrice: num(p.markPrice),
          unrealizedPnl: num(p.unrealisedPnl),
          marketValue: Math.abs(num(p.positionValue)),
          leverage: null,
          liquidationPrice: null,
          assetClass: 'option',
          option: parsed ? { ...parsed, delta: p.delta ? num(p.delta) : null } : undefined,
        });
      }

      const offTrading = stables.filter((s) => s.location !== 'trading').reduce((s, b) => s + b.amount, 0);
      const upl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);

      return {
        accountId: this.account.id,
        exchange: 'bybit',
        label: this.account.label,
        equity: num(wallet.totalEquity) + offTrading,
        availableBalance: num(wallet.totalAvailableBalance),
        unrealizedPnl: upl,
        marginUsed: num(wallet.totalInitialMargin),
        marginRatio: wallet.accountIMRate ? num(wallet.accountIMRate) : null,
        positions,
        stables,
        fetchedAt: new Date().toISOString(),
        isDelayed: false,
        warnings: warnings.length ? warnings : undefined,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[bybit] ${this.account.id}: ${msg}`);
      return this.makeErrorSnapshot(msg);
    }
  }

  private async signedGet<T>(path: string, params: Record<string, string>): Promise<T> {
    const timestamp = Date.now().toString();
    const queryString = new URLSearchParams(params).toString();
    const signature = createHmac('sha256', this.apiSecret)
      .update(timestamp + this.apiKey + RECV_WINDOW + queryString)
      .digest('hex');

    const res = await fetch(`${BASE}${path}?${queryString}`, {
      headers: {
        'X-BAPI-API-KEY': this.apiKey,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': RECV_WINDOW,
        'X-BAPI-SIGN': signature,
      },
    });

    if (!res.ok) {
      throw new Error(`Bybit ${path} ${res.status}: ${(await res.text()).substring(0, 200)}`);
    }

    const body = (await res.json()) as BybitResponse<T>;
    if (body.retCode !== 0) {
      throw new Error(`Bybit ${path} retCode ${body.retCode}: ${body.retMsg}`);
    }
    return body.result;
  }
}
