import { createHmac } from 'node:crypto';
import { BaseConnector, num, optional } from './base.js';
import type { AccountConfig, AccountSnapshot, BitgetCredentials, Position, StableBalance } from '../types.js';

// Bitget: V2 API for classic accounts, V3 for Unified Accounts (auto-detected). Read-only key is sufficient.
const BASE = 'https://api.bitget.com';
const STABLES = new Set(['USDT', 'USDC']);

interface BitgetSpotAsset { coin: string; available: string; frozen: string; locked: string }
interface BitgetFuturesAccount {
  marginCoin: string;
  accountEquity: string;
  usdtEquity: string;
  unrealizedPL: string;
  available: string;
}
interface BitgetPosition {
  symbol: string;
  marginCoin: string;
  holdSide: 'long' | 'short';
  total: string;
  openPriceAvg: string;
  markPrice: string;
  unrealizedPL: string;
  leverage: string;
  liquidationPrice: string;
  marginSize: string;
}
interface BitgetSavings { resultList: Array<{ productCoin: string; holdAmount: string }> }

// V3 (Unified Account)
interface UtaAssets {
  accountEquity: string;
  usdtEquity: string;
  unrealisedPnl: string;
  imr: string;
  mgnRatio: string;
  assets: Array<Record<string, string>> | null;
}
interface UtaFunding { coin: string; balance: string; available: string; frozen: string }
type UtaPosition = Record<string, string>;

/** First non-empty field among alternatives (V3 field names vary between docs versions) */
const pick = (o: Record<string, string>, ...keys: string[]) => {
  for (const k of keys) if (o[k] != null && o[k] !== '') return o[k];
  return '';
};

class BitgetApiError extends Error {
  constructor(message: string, public code: string) { super(message); }
}

const PRODUCTS = [
  { productType: 'USDT-FUTURES', marginCoin: 'USDT' },
  { productType: 'USDC-FUTURES', marginCoin: 'USDC' },
] as const;

export class BitgetConnector extends BaseConnector {
  private apiKey: string;
  private apiSecret: string;
  private passphrase: string;

  constructor(account: AccountConfig) {
    super(account);
    const creds = account.credentials as BitgetCredentials;
    this.apiKey = creds.apiKey;
    this.apiSecret = creds.apiSecret;
    this.passphrase = creds.passphrase;
  }

  /** null = not yet detected */
  private unified: boolean | null = null;

  async fetch(): Promise<AccountSnapshot> {
    try {
      if (this.unified !== true) {
        try {
          const snap = await this.fetchClassic();
          this.unified = false;
          return snap;
        } catch (err) {
          // 40085: "You are in Unified Account mode, and the Classic Account API is not supported"
          if (!(err instanceof BitgetApiError && err.code === '40085')) throw err;
          this.unified = true;
          console.log(`[bitget] ${this.account.id}: unified account detected, switching to V3 API`);
        }
      }
      return await this.fetchUnified();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[bitget] ${this.account.id}: ${msg}`);
      return this.makeErrorSnapshot(msg);
    }
  }

  private async fetchUnified(): Promise<AccountSnapshot> {
    const warnings: string[] = [];
    const assets = await this.signedGet<UtaAssets>('/api/v3/account/assets');
    const [funding, ...posLists] = await Promise.all([
      optional('Funding', warnings, () => this.signedGet<UtaFunding[]>('/api/v3/account/funding-assets'), []),
      ...PRODUCTS.map((p) =>
        optional(`${p.productType} positions`, warnings, () =>
          this.signedGet<{ list: UtaPosition[] | null }>('/api/v3/position/current-position', { category: p.productType }), { list: [] })),
    ]);

    const stables: StableBalance[] = [];
    const add = (coin: string, location: StableBalance['location'], amount: number, source: string) => {
      if (STABLES.has(coin) && Math.abs(amount) >= 0.01) stables.push({ asset: coin as 'USDT' | 'USDC', location, amount, source });
    };
    for (const a of assets.assets ?? []) add(a.coin, 'trading', num(pick(a, 'balance', 'equity', 'available')), 'Unified account');
    for (const f of funding) add(f.coin, 'funding', num(f.balance) || num(f.available) + num(f.frozen), 'Funding account');

    const positions: Position[] = [];
    for (const list of posLists as Array<{ list: UtaPosition[] | null }>) {
      for (const p of list.list ?? []) {
        const size = num(pick(p, 'total', 'size', 'qty'));
        if (size === 0) continue;
        const mark = num(pick(p, 'markPrice', 'markPx'));
        const side = pick(p, 'posSide', 'holdSide', 'side').toLowerCase();
        positions.push({
          symbol: p.symbol,
          side: side === 'short' || side === 'sell' ? 'short' : 'long',
          quantity: Math.abs(size),
          avgPrice: num(pick(p, 'avgPrice', 'openPriceAvg', 'openAvgPrice')),
          currentPrice: mark,
          unrealizedPnl: num(pick(p, 'unrealisedPnl', 'unrealizedPnl', 'unrealizedPL')),
          marketValue: Math.abs(num(pick(p, 'positionValue', 'notional')) || size * mark),
          leverage: num(p.leverage) || null,
          liquidationPrice: num(pick(p, 'liquidationPrice', 'liqPrice')) > 0 ? num(pick(p, 'liquidationPrice', 'liqPrice')) : null,
          assetClass: 'crypto-perp',
        });
      }
    }

    const upl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
    const offTrading = stables.filter((b) => b.location !== 'trading').reduce((s, b) => s + b.amount, 0);
    const equity = num(assets.usdtEquity) || num(assets.accountEquity);
    const imr = num(assets.imr);

    return {
      accountId: this.account.id,
      exchange: 'bitget',
      label: this.account.label,
      equity: equity + offTrading,
      availableBalance: (assets.assets ?? []).filter((a) => STABLES.has(a.coin)).reduce((s, a) => s + num(a.available), 0),
      unrealizedPnl: upl,
      marginUsed: imr,
      marginRatio: equity > 0 ? imr / equity : null,
      positions,
      stables,
      fetchedAt: new Date().toISOString(),
      isDelayed: false,
      warnings: warnings.length ? warnings : undefined,
    };
  }

  private async fetchClassic(): Promise<AccountSnapshot> {
    const warnings: string[] = [];
    {
      // Spot is the "is the key valid" check
      const spot = await this.signedGet<BitgetSpotAsset[]>('/api/v2/spot/account/assets');

      const [futAccts, futPos, flexible, fixed] = await Promise.all([
        Promise.all(PRODUCTS.map((p) =>
          optional(`${p.productType} account`, warnings, () =>
            this.signedGet<BitgetFuturesAccount[]>('/api/v2/mix/account/accounts', { productType: p.productType }), []))),
        Promise.all(PRODUCTS.map((p) =>
          optional(`${p.productType} positions`, warnings, () =>
            this.signedGet<BitgetPosition[]>('/api/v2/mix/position/all-position', p), []))),
        optional('Earn flexible', warnings, () => this.signedGet<BitgetSavings>('/api/v2/earn/savings/assets', { periodType: 'flexible' }), { resultList: [] }),
        optional('Earn fixed', warnings, () => this.signedGet<BitgetSavings>('/api/v2/earn/savings/assets', { periodType: 'fixed' }), { resultList: [] }, true),
      ]);

      const stables: StableBalance[] = [];
      const add = (coin: string, location: StableBalance['location'], amount: number, source: string) => {
        if (STABLES.has(coin) && Math.abs(amount) >= 0.01) stables.push({ asset: coin as 'USDT' | 'USDC', location, amount, source });
      };

      for (const a of spot) add(a.coin, 'funding', num(a.available) + num(a.frozen) + num(a.locked), 'Spot account');
      let futuresUpl = 0;
      let futuresEquity = 0;
      for (const list of futAccts) {
        for (const a of list) {
          const upl = num(a.unrealizedPL);
          futuresUpl += upl;
          futuresEquity += num(a.usdtEquity) || num(a.accountEquity);
          // accountEquity includes uPnL; uPnL is counted separately via positions
          add(a.marginCoin, 'trading', num(a.accountEquity) - upl, `${a.marginCoin}-M Futures`);
        }
      }
      for (const r of flexible.resultList ?? []) add(r.productCoin, 'earn', num(r.holdAmount), 'Earn Flexible');
      for (const r of fixed.resultList ?? []) add(r.productCoin, 'earn', num(r.holdAmount), 'Earn Fixed');

      const positions: Position[] = [];
      let marginUsed = 0;
      for (const list of futPos) {
        for (const p of list) {
          const size = num(p.total);
          if (size === 0) continue;
          const mark = num(p.markPrice);
          marginUsed += num(p.marginSize);
          positions.push({
            symbol: p.symbol,
            side: p.holdSide === 'short' ? 'short' : 'long',
            quantity: Math.abs(size),
            avgPrice: num(p.openPriceAvg),
            currentPrice: mark,
            unrealizedPnl: num(p.unrealizedPL),
            marketValue: Math.abs(size * mark),
            leverage: num(p.leverage) || null,
            liquidationPrice: num(p.liquidationPrice) > 0 ? num(p.liquidationPrice) : null,
            assetClass: 'crypto-perp',
          });
        }
      }

      const stableTotal = stables.reduce((s, b) => s + b.amount, 0);

      return {
        accountId: this.account.id,
        exchange: 'bitget',
        label: this.account.label,
        // Non-stable spot coins are intentionally excluded (derivatives + stables focus)
        equity: stableTotal + futuresUpl,
        availableBalance: futAccts.flat().reduce((s, a) => s + num(a.available), 0),
        unrealizedPnl: futuresUpl,
        marginUsed,
        marginRatio: futuresEquity > 0 ? marginUsed / futuresEquity : null,
        positions,
        stables,
        fetchedAt: new Date().toISOString(),
        isDelayed: false,
        warnings: warnings.length ? warnings : undefined,
      };
    }
  }

  private async signedGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const timestamp = Date.now().toString();
    const qs = new URLSearchParams(params).toString();
    const requestPath = qs ? `${path}?${qs}` : path;
    const signature = createHmac('sha256', this.apiSecret).update(timestamp + 'GET' + requestPath).digest('base64');

    const res = await fetch(`${BASE}${requestPath}`, {
      headers: {
        'ACCESS-KEY': this.apiKey,
        'ACCESS-SIGN': signature,
        'ACCESS-TIMESTAMP': timestamp,
        'ACCESS-PASSPHRASE': this.passphrase,
        'Content-Type': 'application/json',
        locale: 'en-US',
      },
    });

    const text = await res.text();
    let body: { code: string; msg: string; data: T };
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Bitget ${path} ${res.status}: ${text.substring(0, 200)}`);
    }
    if (!res.ok || body.code !== '00000') {
      throw new BitgetApiError(`Bitget ${path} ${res.status} code ${body.code}: ${body.msg}`, String(body.code));
    }
    return body.data;
  }
}
