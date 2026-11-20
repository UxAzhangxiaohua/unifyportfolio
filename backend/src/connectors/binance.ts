import { createHmac } from 'node:crypto';
import { BaseConnector, num, optional, parseOptionSymbol } from './base.js';
import type { AccountConfig, AccountSnapshot, BinanceCredentials, Position, StableBalance } from '../types.js';

const SPOT_BASE = 'https://api.binance.com';
const FUTURES_BASE = 'https://fapi.binance.com';
const OPTIONS_BASE = 'https://eapi.binance.com';

const STABLES = ['USDT', 'USDC'] as const;
type Stable = (typeof STABLES)[number];
const isStable = (a: string): a is Stable => (STABLES as readonly string[]).includes(a);

interface SpotAccount { balances: Array<{ asset: string; free: string; locked: string }> }
interface FundingAsset { asset: string; free: string; locked: string; freeze: string }
interface EarnRows<T> { rows: T[]; total: number }
interface FlexiblePos { asset: string; totalAmount: string }
interface LockedPos { asset: string; amount: string }
interface FuturesAccount {
  totalUnrealizedProfit: string;
  totalInitialMargin: string;
  totalMarginBalance: string;
  availableBalance: string;
  assets: Array<{ asset: string; walletBalance: string }>;
}
interface PositionRisk {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  leverage: string;
  notional: string;
}
interface OptionPosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  quantity: string;
  entryPrice: string;
  markPrice: string;
  unrealizedPNL: string;
  markValue: string;
  strikePrice: string;
  optionSide: 'CALL' | 'PUT';
  expiryDate: number;
}
interface OptionMarginAccount { asset: Array<{ asset: string; equity: string; unrealizedPNL: string }> }

export class BinanceConnector extends BaseConnector {
  private apiKey: string;
  private apiSecret: string;

  constructor(account: AccountConfig) {
    super(account);
    const creds = account.credentials as BinanceCredentials;
    this.apiKey = creds.apiKey;
    this.apiSecret = creds.apiSecret;
  }

  async fetch(): Promise<AccountSnapshot> {
    const warnings: string[] = [];
    try {
      // Spot account is the "is the key valid" check — if it fails, the whole account fails.
      const spot = await this.signed<SpotAccount>(SPOT_BASE, '/api/v3/account', { omitZeroBalances: 'true' });

      const [funding, flexible, locked, futures, risk, options, optionAcct] = await Promise.all([
        optional('Funding', warnings, () => this.signed<FundingAsset[]>(SPOT_BASE, '/sapi/v1/asset/get-funding-asset', {}, 'POST'), []),
        optional('Earn flexible', warnings, () => this.signed<EarnRows<FlexiblePos>>(SPOT_BASE, '/sapi/v1/simple-earn/flexible/position', { size: '100' }), { rows: [], total: 0 }),
        optional('Earn locked', warnings, () => this.signed<EarnRows<LockedPos>>(SPOT_BASE, '/sapi/v1/simple-earn/locked/position', { size: '100' }), { rows: [], total: 0 }),
        optional('Futures', warnings, () => this.signed<FuturesAccount>(FUTURES_BASE, '/fapi/v3/account'), null),
        optional('Futures positions', warnings, () => this.signed<PositionRisk[]>(FUTURES_BASE, '/fapi/v2/positionRisk'), []),
        optional('Options', warnings, () => this.signed<OptionPosition[]>(OPTIONS_BASE, '/eapi/v1/position'), [], true),
        optional('Options account', warnings, () => this.signed<OptionMarginAccount>(OPTIONS_BASE, '/eapi/v1/marginAccount'), null, true),
      ]);

      const stables: StableBalance[] = [];
      const add = (asset: string, location: StableBalance['location'], amount: number, source: string) => {
        if (isStable(asset) && Math.abs(amount) >= 0.01) stables.push({ asset, location, amount, source });
      };

      for (const b of spot.balances) add(b.asset, 'funding', num(b.free) + num(b.locked), 'Spot wallet');
      for (const b of funding) add(b.asset, 'funding', num(b.free) + num(b.locked) + num(b.freeze), 'Funding wallet');
      for (const r of flexible.rows) add(r.asset, 'earn', num(r.totalAmount), 'Simple Earn Flexible');
      for (const r of locked.rows) add(r.asset, 'earn', num(r.amount), 'Simple Earn Locked');
      for (const a of futures?.assets ?? []) add(a.asset, 'trading', num(a.walletBalance), 'USDⓈ-M Futures');
      for (const a of optionAcct?.asset ?? []) add(a.asset, 'trading', num(a.equity) - num(a.unrealizedPNL), 'Options');

      const positions: Position[] = [];
      for (const p of risk) {
        const amt = num(p.positionAmt);
        if (amt === 0) continue;
        positions.push({
          symbol: p.symbol,
          side: amt > 0 ? 'long' : 'short',
          quantity: Math.abs(amt),
          avgPrice: num(p.entryPrice),
          currentPrice: num(p.markPrice),
          unrealizedPnl: num(p.unRealizedProfit),
          marketValue: Math.abs(num(p.notional)),
          leverage: num(p.leverage) || null,
          liquidationPrice: num(p.liquidationPrice) || null,
          assetClass: 'crypto-perp',
        });
      }

      for (const o of options) {
        const qty = num(o.quantity);
        if (qty === 0) continue;
        const parsed = parseOptionSymbol(o.symbol);
        positions.push({
          symbol: o.symbol,
          side: o.side === 'SHORT' ? 'short' : 'long',
          quantity: Math.abs(qty),
          avgPrice: num(o.entryPrice),
          currentPrice: num(o.markPrice),
          unrealizedPnl: num(o.unrealizedPNL),
          marketValue: Math.abs(num(o.markValue)),
          leverage: null,
          liquidationPrice: null,
          assetClass: 'option',
          option: {
            underlying: parsed?.underlying ?? o.symbol.split('-')[0],
            type: o.optionSide === 'PUT' ? 'put' : 'call',
            strike: num(o.strikePrice),
            expiry: o.expiryDate ? new Date(o.expiryDate).toISOString().slice(0, 10) : parsed?.expiry ?? '',
          },
        });
      }

      const futuresUpl = num(futures?.totalUnrealizedProfit);
      const optionsUpl = (optionAcct?.asset ?? []).reduce((s, a) => s + num(a.unrealizedPNL), 0);
      const stableTotal = stables.reduce((s, b) => s + b.amount, 0);
      const marginUsed = num(futures?.totalInitialMargin);
      const marginBalance = num(futures?.totalMarginBalance);

      return {
        accountId: this.account.id,
        exchange: 'binance',
        label: this.account.label,
        // Spot non-stable coins are intentionally excluded (derivatives + stables focus)
        equity: stableTotal + futuresUpl + optionsUpl,
        availableBalance: num(futures?.availableBalance),
        unrealizedPnl: futuresUpl + optionsUpl,
        marginUsed,
        marginRatio: marginBalance > 0 ? marginUsed / marginBalance : null,
        positions,
        stables,
        fetchedAt: new Date().toISOString(),
        isDelayed: false,
        warnings: warnings.length ? warnings : undefined,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[binance] ${this.account.id}: ${msg}`);
      return this.makeErrorSnapshot(msg);
    }
  }

  private async signed<T>(baseUrl: string, path: string, params: Record<string, string> = {}, method: 'GET' | 'POST' = 'GET'): Promise<T> {
    const query = new URLSearchParams({ ...params, timestamp: Date.now().toString(), recvWindow: '10000' }).toString();
    const signature = createHmac('sha256', this.apiSecret).update(query).digest('hex');
    const res = await fetch(`${baseUrl}${path}?${query}&signature=${signature}`, {
      method,
      headers: { 'X-MBX-APIKEY': this.apiKey },
    });
    if (!res.ok) {
      throw new Error(`Binance ${path} ${res.status}: ${(await res.text()).substring(0, 200)}`);
    }
    return res.json() as Promise<T>;
  }
}
