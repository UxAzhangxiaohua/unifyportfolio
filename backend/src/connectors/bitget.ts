import { createHmac } from 'node:crypto';
import { applyFunding, BaseConnector, cachedPublic, lower, num, stableCoin, type FundingQuote } from './base.js';
import type { AccountConfig, AccountSnapshot, BitgetCredentials, CfdAccountState, ClosedTrade, FundFlow, Position, StableBalance } from '../types.js';
import { guessCategory } from '../categories.js';

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
// SharkFin rows: amount field name unverified, parsed defensively
interface BitgetSharkfin { resultList: Array<Record<string, string>> }

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

/** CFD (TradFi) account — /api/v3/cfd/account/fund-detail, works for classic and unified accounts */
interface CfdFundDetail {
  balance: string; equity: string; pnl: string; marginUsed: string; marginFree: string; currency: string;
  leverage?: string; marginLevel?: string; marginCall?: string; marginStopOut?: string;
}
type CfdPosition = Record<string, string>;
const loggedCfdShapes = new Set<string>();

interface BitgetFlowRow {
  orderId: string; coin: string; size: string; fee?: string; status: string; chain?: string; toAddress?: string;
  /** V3: tx hash */ recordId?: string; /** V2: tx hash */ tradeId?: string;
  createdTime?: string; updatedTime?: string; cTime?: string; uTime?: string;
}

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
  private loggedClosedRow = false;

  /**
   * Closed positions: classic /api/v2/mix/position/history-position (productType), unified
   * /api/v3/position/history-position (category); 3 months back, cursor-paged. Field names differ
   * between the two (and the V3 shape is unverified: no closed rows on the account so far), so
   * several spellings are accepted and the first raw row is logged once.
   */
  async fetchClosedTrades(sinceMs: number): Promise<ClosedTrade[] | null> {
    if (this.unified == null) return null; // account mode not detected yet (first fetch pending)
    const out: ClosedTrade[] = [];
    const now = Date.now();
    for (const productType of ['USDT-FUTURES', 'USDC-FUTURES', 'COIN-FUTURES']) {
      const rows: Record<string, unknown>[] = [];
      let cursor = '';
      for (let page = 0; page < 20; page++) {
        const params: Record<string, string> = { startTime: String(sinceMs), endTime: String(now), limit: '100' };
        let list: Record<string, unknown>[];
        let next = '';
        if (this.unified) {
          const r = await this.signedGet<{ list: Record<string, unknown>[] | null; cursor?: string | null }>(
            '/api/v3/position/history-position', { ...params, category: productType, ...(cursor ? { cursor } : {}) });
          list = r.list ?? [];
          next = r.cursor ?? '';
        } else {
          const r = await this.signedGet<{ list: Record<string, unknown>[] | null; endId?: string | null }>(
            '/api/v2/mix/position/history-position', { ...params, productType, ...(cursor ? { idLessThan: cursor } : {}) });
          list = r.list ?? [];
          next = r.endId ?? '';
        }
        rows.push(...list);
        if (list.length < 100 || !next || next === cursor) break;
        cursor = next;
      }
      for (const r of rows) {
        if (!this.loggedClosedRow) {
          this.loggedClosedRow = true;
          console.log(`[bitget] ${this.account.id}: first closed-position row: ${JSON.stringify(r).substring(0, 600)}`);
        }
        const pick = (...keys: string[]) => { for (const k of keys) if (r[k] != null && r[k] !== '') return r[k]; return undefined; };
        const entry = num(pick('openAvgPrice', 'openPriceAvg', 'avgOpenPrice', 'openPrice'));
        const exit = num(pick('closeAvgPrice', 'closePriceAvg', 'avgClosePrice', 'closePrice'));
        const qty = num(pick('closeTotalPos', 'closeSize', 'closedSize', 'size', 'totalPos'));
        const exitTime = num(pick('utime', 'uTime', 'updatedTime', 'updateTime', 'ctime'));
        if (!(entry > 0 && exit > 0 && qty > 0 && exitTime > 0)) continue;
        const symbol = String(pick('symbol') ?? '');
        const fees = num(pick('openFee')) + num(pick('closeFee')) + num(pick('totalFunding', 'fundingFee'));
        const net = pick('netProfit', 'netPnl', 'achievedProfits');
        const pnl = net != null ? num(net) : num(pick('pnl', 'realizedPnl')) + fees;
        const holdSide = String(pick('holdSide', 'posSide', 'side') ?? '').toLowerCase();
        out.push(this.trade({
          id: `bitget:${pick('positionId', 'id') ?? `${symbol}:${exitTime}`}`,
          symbol,
          side: holdSide.includes('short') || holdSide === 'sell' ? 'short' : 'long',
          entryPrice: entry,
          exitPrice: exit,
          quantity: qty,
          pnl,
          // Bitget reports fees as negative numbers
          fees,
          entryTime: num(pick('ctime', 'cTime', 'createdTime')) || null,
          exitTime,
          category: guessCategory(symbol),
        }));
      }
    }
    return out;
  }

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

  /**
   * CFD (TradFi) account: balance/equity from fund-detail, positions from current-positions.
   * Position field names are not verified against a live position yet, so parse defensively
   * and log the first raw row per symbol to confirm the shape.
   */
  private async fetchCfd(warnings: string[]) {
    // Both CFD calls are quiet: keys/accounts without TradFi access would otherwise warn on every poll.
    // sticky() still warns (and serves the last good data) if they worked before and now fail.
    const [fund, rawPositions] = await Promise.all([
      this.sticky('CFD account', warnings, () => this.signedGet<CfdFundDetail>('/api/v3/cfd/account/fund-detail'), null, true),
      this.sticky('CFD positions', warnings, () => this.signedGet<CfdPosition[] | { list?: CfdPosition[] }>('/api/v3/cfd/trade/current-positions'), [], true),
    ]);
    const rows = (Array.isArray(rawPositions) ? rawPositions : rawPositions?.list ?? []) as CfdPosition[];
    const positions: Position[] = [];
    for (const p of rows) {
      const symbol = pick(p, 'symbol', 'instId', 'productCode');
      if (!loggedCfdShapes.has(symbol)) {
        loggedCfdShapes.add(symbol);
        console.log(`[bitget] ${this.account.id}: CFD position shape ${JSON.stringify(p)}`);
      }
      const size = num(pick(p, 'volume', 'size', 'total', 'qty', 'lots', 'amount'));
      if (size === 0) continue;
      const mark = num(pick(p, 'currentPrice', 'markPrice', 'priceCurrent', 'price', 'closePrice'));
      const side = pick(p, 'side', 'holdSide', 'posSide', 'direction', 'tradeSide').toLowerCase();
      positions.push({
        symbol,
        side: side === 'short' || side === 'sell' || side === '1' ? 'short' : 'long',
        quantity: Math.abs(size),
        avgPrice: num(pick(p, 'openPrice', 'openPriceAvg', 'avgPrice', 'priceOpen', 'openAvgPrice')),
        currentPrice: mark,
        unrealizedPnl: num(pick(p, 'profit', 'unrealizedPL', 'unrealizedPnl', 'unrealisedPnl', 'pnl', 'floatingPnl')),
        marketValue: Math.abs(num(pick(p, 'positionValue', 'notional', 'marketValue')) || size * mark),
        leverage: num(pick(p, 'leverage')) || null,
        liquidationPrice: null,
        assetClass: 'cfd',
      });
    }
    // Account is USD-denominated; USDT ≈ USD. Balance excludes floating PnL (counted separately).
    const stable: StableBalance | null = fund && Math.abs(num(fund.balance)) >= 0.01
      ? { asset: 'USDT', location: 'trading', amount: num(fund.balance), source: 'CFD (TradFi)' }
      : null;
    const equity = num(fund?.equity), used = num(fund?.marginUsed);
    const notional = positions.reduce((s, p) => s + p.marketValue, 0);
    // Only surface the CFD panel when the account is actually funded or has positions
    const state: CfdAccountState | null = fund && (Math.abs(equity) >= 0.01 || positions.length)
      ? {
          name: 'Bitget CFD',
          currency: fund.currency || 'USD',
          balance: num(fund.balance),
          equity,
          floatingPnl: num(fund.pnl),
          usedMargin: used,
          freeMargin: num(fund.marginFree) || equity - used,
          // Bitget reports 999.99 when no margin is used
          marginLevel: used > 0 ? (num(fund.marginLevel) || (equity / used) * 100) : null,
          leverage: num(fund.leverage) || null,
          marginCallLevel: fund.marginCall ? num(fund.marginCall) : null,
          stopOutLevel: fund.marginStopOut ? num(fund.marginStopOut) : null,
          effectiveLeverage: equity > 0 ? notional / equity : null,
          notional,
        }
      : null;
    return { equity, pnl: num(fund?.pnl), marginUsed: used, positions, stable, state };
  }

  private async fetchUnified(): Promise<AccountSnapshot> {
    const warnings: string[] = [];
    const assets = await this.signedGet<UtaAssets>('/api/v3/account/assets');
    // V2 earn endpoints reject UTA keys with 40085; V3 mirrors the savings response shape
    const [cfd, funding, flexible, fixed, sharkfin, ...posLists] = await Promise.all([
      this.fetchCfd(warnings),
      this.sticky('UTA Funding', warnings, () => this.signedGet<UtaFunding[]>('/api/v3/account/funding-assets'), []),
      this.sticky('UTA Earn flexible', warnings, () => this.signedGet<BitgetSavings>('/api/v3/earn/savings/assets', { periodType: 'flexible' }), { resultList: [] }),
      this.sticky('UTA Earn fixed', warnings, () => this.signedGet<BitgetSavings>('/api/v3/earn/savings/assets', { periodType: 'fixed' }), { resultList: [] }, true),
      this.sticky('UTA SharkFin', warnings, () => this.signedGet<BitgetSharkfin>('/api/v3/earn/sharkfin/assets'), { resultList: [] }, true),
      ...PRODUCTS.map((p) =>
        this.sticky(`UTA ${p.productType} positions`, warnings, () =>
          this.signedGet<{ list: UtaPosition[] | null }>('/api/v3/position/current-position', { category: p.productType }), { list: [] })),
    ]);

    const stables: StableBalance[] = [];
    const add = (coin: string, location: StableBalance['location'], amount: number, source: string) => {
      if (STABLES.has(coin) && Math.abs(amount) >= 0.01) stables.push({ asset: coin as 'USDT' | 'USDC', location, amount, source });
    };
    for (const a of assets.assets ?? []) add(a.coin, 'trading', num(pick(a, 'balance', 'equity', 'available')), 'Unified account');
    for (const f of funding as UtaFunding[]) add(f.coin, 'funding', num(f.balance) || num(f.available) + num(f.frozen), 'Funding account');
    for (const r of (flexible as BitgetSavings).resultList ?? []) add(r.productCoin, 'earn', num(r.holdAmount), 'Earn Flexible');
    for (const r of (fixed as BitgetSavings).resultList ?? []) add(r.productCoin, 'earn', num(r.holdAmount), 'Earn Fixed');
    for (const r of (sharkfin as BitgetSharkfin).resultList ?? []) {
      add(pick(r, 'productCoin', 'subscribeCoin', 'coin'), 'earn', num(pick(r, 'holdAmount', 'amount', 'subscribeAmount')), 'SharkFin');
    }
    if (cfd.stable) stables.push(cfd.stable);

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
          margin: num(pick(p, 'imr', 'margin', 'marginSize', 'positionIM')) || null,
          assetClass: 'crypto-perp',
        });
      }
    }

    await this.addFunding(positions, warnings);

    positions.push(...cfd.positions);

    // CFD uPnL comes from fund-detail (authoritative) rather than the defensively parsed rows
    const upl = positions.filter((p) => p.assetClass !== 'cfd').reduce((s, p) => s + p.unrealizedPnl, 0) + cfd.pnl;
    const offTrading = stables.filter((b) => b.location !== 'trading').reduce((s, b) => s + b.amount, 0);
    const equity = num(assets.usdtEquity) || num(assets.accountEquity);
    const imr = num(assets.imr);

    return {
      accountId: this.account.id,
      exchange: 'bitget',
      label: this.account.label,
      equity: equity + offTrading + cfd.equity,
      availableBalance: (assets.assets ?? []).filter((a) => STABLES.has(a.coin)).reduce((s, a) => s + num(a.available), 0),
      unrealizedPnl: upl,
      marginUsed: imr + cfd.marginUsed,
      marginRatio: equity > 0 ? imr / equity : null,
      positions,
      stables,
      cfd: cfd.state ? [cfd.state] : undefined,
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

      const [cfd, futAccts, futPos, flexible, fixed] = await Promise.all([
        this.fetchCfd(warnings),
        Promise.all(PRODUCTS.map((p) =>
          this.sticky(`${p.productType} account`, warnings, () =>
            this.signedGet<BitgetFuturesAccount[]>('/api/v2/mix/account/accounts', { productType: p.productType }), []))),
        Promise.all(PRODUCTS.map((p) =>
          this.sticky(`${p.productType} positions`, warnings, () =>
            this.signedGet<BitgetPosition[]>('/api/v2/mix/position/all-position', p), []))),
        this.sticky('Earn flexible', warnings, () => this.signedGet<BitgetSavings>('/api/v2/earn/savings/assets', { periodType: 'flexible' }), { resultList: [] }),
        this.sticky('Earn fixed', warnings, () => this.signedGet<BitgetSavings>('/api/v2/earn/savings/assets', { periodType: 'fixed' }), { resultList: [] }, true),
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
      if (cfd.stable) stables.push(cfd.stable);

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
            margin: num(p.marginSize) || null,
            assetClass: 'crypto-perp',
          });
        }
      }

      await this.addFunding(positions, warnings);

      positions.push(...cfd.positions);
      const futuresMargin = marginUsed;
      marginUsed += cfd.marginUsed;
      const stableTotal = stables.reduce((s, b) => s + b.amount, 0);

      return {
        accountId: this.account.id,
        exchange: 'bitget',
        label: this.account.label,
        // Non-stable spot coins are intentionally excluded (derivatives + stables focus)
        // stables already include the CFD cash balance; add its floating PnL
        equity: stableTotal + futuresUpl + cfd.pnl,
        availableBalance: futAccts.flat().reduce((s, a) => s + num(a.available), 0),
        unrealizedPnl: futuresUpl + cfd.pnl,
        marginUsed,
        marginRatio: futuresEquity > 0 ? futuresMargin / futuresEquity : null,
        positions,
        stables,
        cfd: cfd.state ? [cfd.state] : undefined,
        fetchedAt: new Date().toISOString(),
        isDelayed: false,
        warnings: warnings.length ? warnings : undefined,
      };
    }
  }

  /**
   * Deposits/withdrawals. UTA: /api/v3/account/{deposit,withdrawal}-records (verified live: `size` is
   * gross incl. fee, `fee` is negative, `recordId` is the chain tx hash). Classic: V2 wallet records
   * (same field semantics assumed; not verified against a classic account).
   */
  async fetchFlows(sinceMs: number, untilMs = Date.now()): Promise<FundFlow[]> {
    // The record endpoints have no usable cursor here: a full page means more rows in the window,
    // so split it in half until every page is complete
    const { flows, full } = await this.flowsPage(sinceMs, untilMs);
    if (!full || untilMs - sinceMs < 60_000) return flows;
    const mid = Math.floor((sinceMs + untilMs) / 2);
    return [...await this.fetchFlows(sinceMs, mid), ...await this.fetchFlows(mid + 1, untilMs)];
  }

  private async flowsPage(sinceMs: number, untilMs: number): Promise<{ flows: FundFlow[]; full: boolean }> {
    const LIMIT = 100;
    const params = { startTime: String(sinceMs), endTime: String(untilMs), limit: String(LIMIT) };
    let unified = this.unified;
    let rows: [BitgetFlowRow[], BitgetFlowRow[]];
    if (unified !== true) {
      try {
        rows = await Promise.all([
          this.signedGet<BitgetFlowRow[]>('/api/v2/spot/wallet/withdrawal-records', params),
          this.signedGet<BitgetFlowRow[]>('/api/v2/spot/wallet/deposit-records', params),
        ]);
      } catch (err) {
        if (!(err instanceof BitgetApiError && err.code === '40085')) throw err;
        unified = true;
      }
    }
    if (unified === true) {
      rows = await Promise.all([
        this.signedGet<BitgetFlowRow[]>('/api/v3/account/withdrawal-records', params),
        this.signedGet<BitgetFlowRow[]>('/api/v3/account/deposit-records', params),
      ]);
    }
    const [wd, dep] = rows!;
    const status = (s: string): FundFlow['status'] => (s === 'success' ? 'done' : /fail|reject|cancel/i.test(s) ? 'failed' : 'pending');
    const flows: FundFlow[] = [];
    for (const [list, direction] of [[wd, 'out'], [dep, 'in']] as const) {
      for (const r of list ?? []) {
        const coin = stableCoin(r.coin);
        if (!coin) continue;
        const fee = Math.abs(num(r.fee));
        const size = num(r.size);
        const t = num(r.createdTime ?? r.cTime);
        const u = num(r.updatedTime ?? r.uTime);
        const st = status(r.status);
        flows.push({
          id: `${direction}:${r.orderId}`,
          direction,
          coin,
          amount: direction === 'out' ? size - fee : size,
          fee: direction === 'out' ? fee : 0,
          txId: lower(r.recordId ?? r.tradeId),
          address: lower(r.toAddress),
          network: r.chain ?? null,
          time: t,
          doneTime: st === 'done' ? u || t : null,
          status: st,
        });
      }
    }
    return { flows, full: (wd?.length ?? 0) >= LIMIT || (dep?.length ?? 0) >= LIMIT };
  }

  /** Current funding rate + next payment for perps (public endpoint, per symbol) */
  private async addFunding(positions: Position[], warnings: string[]): Promise<void> {
    const perps = positions.filter((p) => p.assetClass === 'crypto-perp');
    if (!perps.length) return;
    const quotes = await this.sticky('Funding rates', warnings, async () => {
      const out = new Map<string, FundingQuote>();
      await Promise.all([...new Set(perps.map((p) => p.symbol))].map(async (symbol) => {
        const productType = symbol.endsWith('USDC') ? 'USDC-FUTURES' : symbol.endsWith('USD') ? 'COIN-FUTURES' : 'USDT-FUTURES';
        const r = await cachedPublic(`bitget:fund:${symbol}`, 60_000, async () => {
          const res = await fetch(`${BASE}/api/v2/mix/market/current-fund-rate?${new URLSearchParams({ symbol, productType })}`);
          const body = (await res.json()) as { code: string; msg: string; data: Array<{ fundingRate: string; fundingRateInterval: string; nextUpdate: string }> };
          if (body.code !== '00000') throw new Error(`current-fund-rate ${symbol}: ${body.msg}`);
          return body.data[0];
        });
        if (r) out.set(symbol, { rate: num(r.fundingRate), nextTime: num(r.nextUpdate) || null, intervalH: num(r.fundingRateInterval) || null });
      }));
      return out;
    }, new Map<string, FundingQuote>(), true);
    for (const p of perps) applyFunding(p, quotes.get(p.symbol));
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
