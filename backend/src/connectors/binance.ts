import { createHmac } from 'node:crypto';
import { applyFunding, BaseConnector, cachedPublic, lower, num, parseOptionSymbol, stableCoin, type FundingQuote } from './base.js';
import type { AccountConfig, AccountSnapshot, BinanceCredentials, ClosedTrade, FundFlow, Position, StableBalance, TradeCategory } from '../types.js';
import { guessCategory } from '../categories.js';

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
  positions?: Array<{ symbol: string; positionSide: string; initialMargin: string }>;
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
/** Public /eapi/v1/mark row — greeks are per 1 contract (1 unit of underlying) */
interface OptionMark { symbol: string; markIV: string; delta: string; gamma: string; theta: string; vega: string }
interface OptionMarginAccount { asset: Array<{ asset: string; equity: string; unrealizedPNL: string }> }

interface BinanceWithdrawal {
  id: string; amount: string; transactionFee: string; coin: string; status: number; address: string;
  txId?: string; applyTime: string; completeTime?: string; network?: string;
}
interface BinanceDeposit {
  id: string; amount: string; coin: string; status: number; address: string; txId?: string;
  insertTime: number; completeTime?: number; network?: string;
  /** Sender address, returned with includeSource=true */
  sourceAddress?: string;
}
/** "2026-11-23 13:42:55" (UTC) → ms */
const binanceTime = (s: string | undefined) => (s ? Date.parse(`${s.replace(' ', 'T')}Z`) || 0 : 0);

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
        this.sticky('Funding', warnings, () => this.signed<FundingAsset[]>(SPOT_BASE, '/sapi/v1/asset/get-funding-asset', {}, 'POST'), []),
        this.sticky('Earn flexible', warnings, () => this.signed<EarnRows<FlexiblePos>>(SPOT_BASE, '/sapi/v1/simple-earn/flexible/position', { size: '100' }), { rows: [], total: 0 }),
        this.sticky('Earn locked', warnings, () => this.signed<EarnRows<LockedPos>>(SPOT_BASE, '/sapi/v1/simple-earn/locked/position', { size: '100' }), { rows: [], total: 0 }),
        this.sticky('Futures', warnings, () => this.signed<FuturesAccount>(FUTURES_BASE, '/fapi/v3/account'), null),
        this.sticky('Futures positions', warnings, () => this.signed<PositionRisk[]>(FUTURES_BASE, '/fapi/v2/positionRisk'), []),
        this.sticky('Options', warnings, () => this.signed<OptionPosition[]>(OPTIONS_BASE, '/eapi/v1/position'), [], true),
        this.sticky('Options account', warnings, () => this.signed<OptionMarginAccount>(OPTIONS_BASE, '/eapi/v1/marginAccount'), null, true),
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

      // Per-position initial margin lives in the account endpoint (keyed by symbol; summed over hedge sides)
      const imBySymbol = new Map<string, number>();
      for (const fp of futures?.positions ?? []) imBySymbol.set(fp.symbol, (imBySymbol.get(fp.symbol) ?? 0) + num(fp.initialMargin));

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
          margin: imBySymbol.get(p.symbol) || null,
          assetClass: 'crypto-perp',
        });
      }

      const perps = positions.filter((p) => p.assetClass === 'crypto-perp');
      if (perps.length) {
        const quotes = await this.sticky('Funding rates', warnings, binanceFundingQuotes, new Map<string, FundingQuote>(), true);
        for (const p of perps) applyFunding(p, quotes.get(p.symbol));
      }

      const openOptions = options.filter((o) => num(o.quantity) !== 0);
      const marks = new Map<string, OptionMark>();
      const indexPx = new Map<string, number>();
      if (openOptions.length) {
        const underlyings = [...new Set(openOptions.map((o) => `${o.symbol.split('-')[0]}USDT`))];
        // The closures return their data so sticky() can serve the last good copy on failure
        const [markList, idx] = await Promise.all([
          this.sticky('Option greeks', warnings, () => this.publicGet<OptionMark[]>('/eapi/v1/mark'), [] as OptionMark[], true),
          this.sticky('Option index', warnings, async () => {
            const px = await Promise.all(underlyings.map(async (u) =>
              [u, num((await this.publicGet<{ indexPrice: string }>('/eapi/v1/index', { underlying: u })).indexPrice)] as const));
            return new Map(px);
          }, new Map<string, number>(), true),
        ]);
        for (const m of markList) marks.set(m.symbol, m);
        for (const [u, px] of idx) if (px > 0) indexPx.set(u, px);
      }

      for (const o of openOptions) {
        const qty = num(o.quantity);
        const parsed = parseOptionSymbol(o.symbol);
        const m = marks.get(o.symbol);
        const mult = Math.abs(qty) * (o.side === 'SHORT' ? -1 : 1);
        const g = (v: string | undefined) => (v != null && v !== '' ? num(v) * mult : null);
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
            delta: g(m?.delta),
            gamma: g(m?.gamma),
            theta: g(m?.theta),
            vega: g(m?.vega),
            iv: m?.markIV ? num(m.markIV) : null,
            underlyingPrice: indexPx.get(`${o.symbol.split('-')[0]}USDT`) || null,
            expiryTs: o.expiryDate || null,
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

  /**
   * Verified live: withdrawal `amount` is what the recipient gets (fee charged on top);
   * txId matches the receiving venue's deposit txId.
   */
  async fetchFlows(sinceMs: number, untilMs = Date.now()): Promise<FundFlow[]> {
    // ≤ 90 days per query
    const startTime = String(Math.max(sinceMs, untilMs - 89 * 86_400_000));
    const endTime = String(untilMs);
    const [wd, dep] = await Promise.all([
      this.signed<BinanceWithdrawal[]>(SPOT_BASE, '/sapi/v1/capital/withdraw/history', { startTime, endTime }),
      this.signed<BinanceDeposit[]>(SPOT_BASE, '/sapi/v1/capital/deposit/hisrec', { startTime, endTime, includeSource: 'true' }),
    ]);
    const flows: FundFlow[] = [];
    for (const w of wd) {
      const coin = stableCoin(w.coin);
      if (!coin) continue;
      // 6 completed; 1 cancelled, 3 rejected, 5 failure; others in progress
      const status: FundFlow['status'] = w.status === 6 ? 'done' : [1, 3, 5].includes(w.status) ? 'failed' : 'pending';
      flows.push({
        id: `out:${w.id}`, direction: 'out', coin, amount: num(w.amount), fee: num(w.transactionFee),
        txId: lower(w.txId), address: lower(w.address), network: w.network ?? null,
        time: binanceTime(w.applyTime), doneTime: status === 'done' ? binanceTime(w.completeTime) || null : null, status,
      });
    }
    for (const d of dep) {
      const coin = stableCoin(d.coin);
      if (!coin) continue;
      // 1 success, 6 credited (cannot withdraw yet); 2 rejected, 7 wrong deposit; others pending
      const status: FundFlow['status'] = d.status === 1 || d.status === 6 ? 'done' : d.status === 2 || d.status === 7 ? 'failed' : 'pending';
      flows.push({
        id: `in:${d.id}`, direction: 'in', coin, amount: num(d.amount), fee: 0,
        txId: lower(d.txId), address: lower(d.address), network: d.network ?? null, from: lower(d.sourceAddress),
        time: num(d.insertTime), doneTime: status === 'done' ? num(d.completeTime) || num(d.insertTime) : null, status,
      });
    }
    return flows;
  }

  /**
   * Closed trades. USDⓈ-M: REALIZED_PNL income rows locate the closes (symbol + time, all symbols
   * in one query), then /fapi/v1/userTrades (≤ 7 days per query) gives price, size and commission
   * per fill; closing fills (realizedPnl ≠ 0) are grouped per order. Entry = exit − pnl ÷ size.
   * Options: /eapi/v1/userTrades fills with realizedProfit ≠ 0, grouped per order (exercise at
   * expiry is not included).
   */
  async fetchClosedTrades(sinceMs: number): Promise<ClosedTrade[]> {
    const out: ClosedTrade[] = [];
    const now = Date.now();
    const WEEK = 7 * 86_400_000;

    // 1. Where were closes? income history, paged by time
    const windows = new Map<string, Set<number>>(); // symbol → window starts
    let start = sinceMs;
    for (let page = 0; page < 20; page++) {
      const rows = await this.signed<BinanceIncome[]>(FUTURES_BASE, '/fapi/v1/income', { incomeType: 'REALIZED_PNL', startTime: String(start), endTime: String(now), limit: '1000' });
      for (const r of rows) {
        const w = sinceMs + Math.floor((r.time - sinceMs) / WEEK) * WEEK;
        if (!windows.has(r.symbol)) windows.set(r.symbol, new Set());
        windows.get(r.symbol)!.add(w);
      }
      if (rows.length < 1000) break;
      start = rows[rows.length - 1].time + 1;
    }

    // 2. Fills for those symbols / weeks
    if (windows.size) {
      const meta = await this.futuresMeta().catch(() => new Map<string, { underlyingType: string; sub: string[] }>());
      for (const [symbol, ws] of windows) {
        const fills: BinanceUserTrade[] = [];
        for (const w of ws) {
          fills.push(...await this.signed<BinanceUserTrade[]>(FUTURES_BASE, '/fapi/v1/userTrades', {
            symbol, startTime: String(w), endTime: String(Math.min(w + WEEK - 1, now)), limit: '1000',
          }));
        }
        const byOrder = new Map<number, BinanceUserTrade[]>();
        for (const f of fills) {
          if (num(f.realizedPnl) === 0) continue;
          byOrder.set(f.orderId, [...(byOrder.get(f.orderId) ?? []), f]);
        }
        for (const [orderId, g] of byOrder) {
          const qty = g.reduce((s, f) => s + num(f.qty), 0);
          if (!(qty > 0)) continue;
          const exit = g.reduce((s, f) => s + num(f.price) * num(f.qty), 0) / qty;
          const gross = g.reduce((s, f) => s + num(f.realizedPnl), 0);
          // Commission in a stablecoin only (BNB-paid fees can't be valued here)
          const fees = -g.reduce((s, f) => s + (stableCoin(f.commissionAsset) ? num(f.commission) : 0), 0);
          const ps = g[0].positionSide;
          const side: 'long' | 'short' = ps === 'LONG' ? 'long' : ps === 'SHORT' ? 'short' : g[0].side === 'SELL' ? 'long' : 'short';
          const dir = side === 'long' ? 1 : -1;
          out.push(this.trade({
            id: `binance:um:${symbol}:${orderId}`,
            symbol, side,
            entryPrice: exit - gross / (qty * dir),
            exitPrice: exit,
            quantity: qty,
            pnl: gross + fees,
            fees,
            entryTime: null,
            exitTime: Math.max(...g.map((f) => f.time)),
            category: binanceCategory(symbol, meta.get(symbol)),
          }));
        }
      }
    }

    // 3. Options (an account without options access just has none)
    const opt = await this.signed<BinanceOptionTrade[]>(OPTIONS_BASE, '/eapi/v1/userTrades', { startTime: String(sinceMs), endTime: String(now), limit: '1000' }).catch(() => []);
    const optByOrder = new Map<number, BinanceOptionTrade[]>();
    for (const f of opt) {
      if (num(f.realizedProfit) === 0) continue;
      optByOrder.set(f.orderId, [...(optByOrder.get(f.orderId) ?? []), f]);
    }
    for (const [orderId, g] of optByOrder) {
      const qty = g.reduce((s, f) => s + num(f.quantity), 0);
      if (!(qty > 0)) continue;
      const exit = g.reduce((s, f) => s + num(f.price) * num(f.quantity), 0) / qty;
      const gross = g.reduce((s, f) => s + num(f.realizedProfit), 0);
      // Option fees are reported negative (a cost)
      const fees = g.reduce((s, f) => s + num(f.fee), 0);
      const side: 'long' | 'short' = g[0].side === 'SELL' ? 'long' : 'short';
      const dir = side === 'long' ? 1 : -1;
      out.push(this.trade({
        id: `binance:opt:${g[0].symbol}:${orderId}`,
        symbol: g[0].symbol, side,
        entryPrice: exit - gross / (qty * dir),
        exitPrice: exit,
        quantity: qty,
        pnl: gross + fees,
        fees,
        entryTime: null,
        exitTime: Math.max(...g.map((f) => f.time)),
        category: 'option',
      }));
    }
    return out;
  }

  /** symbol → underlyingType / underlyingSubType (EQUITY, COMMODITY, FX, INDEX, COIN, …) */
  private futuresMeta(): Promise<Map<string, { underlyingType: string; sub: string[] }>> {
    return cachedPublic('binance:fapi:exchangeInfo', 6 * 3_600_000, async () => {
      const res = await fetch(`${FUTURES_BASE}/fapi/v1/exchangeInfo`);
      if (!res.ok) throw new Error(`Binance exchangeInfo ${res.status}`);
      const body = (await res.json()) as { symbols: Array<{ symbol: string; underlyingType?: string; underlyingSubType?: string[] }> };
      return new Map(body.symbols.map((s) => [s.symbol, { underlyingType: s.underlyingType ?? '', sub: s.underlyingSubType ?? [] }]));
    });
  }

  private async publicGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${OPTIONS_BASE}${path}${qs ? `?${qs}` : ''}`);
    if (!res.ok) throw new Error(`Binance ${path} ${res.status}`);
    return res.json() as Promise<T>;
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

/** All USDⓈ-M funding rates in one call; non-8h intervals come from fundingInfo (only adjusted symbols are listed) */
async function binanceFundingQuotes(): Promise<Map<string, FundingQuote>> {
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${FUTURES_BASE}${path}`);
    if (!res.ok) throw new Error(`Binance ${path} ${res.status}`);
    return res.json() as Promise<T>;
  };
  const [idx, info] = await Promise.all([
    cachedPublic('binance:premiumIndex', 60_000, () => get<Array<{ symbol: string; lastFundingRate: string; nextFundingTime: number }>>('/fapi/v1/premiumIndex')),
    cachedPublic('binance:fundingInfo', 3_600_000, () => get<Array<{ symbol: string; fundingIntervalHours: number }>>('/fapi/v1/fundingInfo')),
  ]);
  const interval = new Map(info.map((i) => [i.symbol, i.fundingIntervalHours]));
  return new Map(idx.map((i) => [i.symbol, { rate: num(i.lastFundingRate), nextTime: num(i.nextFundingTime) || null, intervalH: interval.get(i.symbol) ?? 8 }]));
}

interface BinanceIncome { symbol: string; incomeType: string; income: string; time: number; tradeId?: string }
interface BinanceUserTrade {
  symbol: string; orderId: number; side: 'BUY' | 'SELL'; positionSide: 'BOTH' | 'LONG' | 'SHORT';
  price: string; qty: string; realizedPnl: string; commission: string; commissionAsset: string; time: number;
}
interface BinanceOptionTrade {
  symbol: string; orderId: number; side: 'BUY' | 'SELL'; price: string; quantity: string; fee: string; realizedProfit: string; time: number;
}

function binanceCategory(symbol: string, m: { underlyingType: string; sub: string[] } | undefined): TradeCategory {
  // Gold, including gold-backed tokens (PAXG / XAUT are listed as coins)
  if (!m || guessCategory(symbol) === 'xau') return guessCategory(symbol);
  const t = m.underlyingType;
  if (t === 'COMMODITY' || t === 'FX') return 'xau';
  if (t.endsWith('EQUITY') || m.sub.includes('Pre-IPO')) return 'stock';
  // INDEX covers crypto indices (BTCDOM, DEFI) as well as TradFi ones
  if (t === 'INDEX') return m.sub.includes('TradFi') ? 'stock' : 'crypto';
  return 'crypto';
}
