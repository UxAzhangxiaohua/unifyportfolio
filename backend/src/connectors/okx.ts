import { createHmac } from 'node:crypto';
import { applyFunding, BaseConnector, cachedPublic, lower, num, parseOptionSymbol, stableCoin, type FundingQuote } from './base.js';
import type { AccountConfig, AccountSnapshot, ClosedTrade, FundFlow, OKXCredentials, Position, StableBalance, TradeCategory } from '../types.js';
import { guessCategory } from '../categories.js';

const BASE_URL = 'https://www.okx.com';
const STABLES = new Set(['USDT', 'USDC']);

interface OKXBalance {
  totalEq: string;
  adjEq: string;
  imr: string;
  details: Array<{ ccy: string; eq: string; cashBal: string; upl: string; availEq: string }>;
}
interface OKXPosition {
  instId: string;
  /** Accumulated funding fee since open, in the margin coin (+ received / − paid, part of realizedPnl) */
  fundingFee?: string;
  instType: 'SWAP' | 'FUTURES' | 'OPTION' | 'MARGIN';
  posSide: string;
  pos: string;
  avgPx: string;
  markPx: string;
  upl: string;
  lever: string;
  liqPx: string;
  notionalUsd: string;
  imr: string;
  margin: string;
  ccy: string;
  usdPx?: string;
  idxPx?: string;
  deltaBS?: string;
  deltaPA?: string;
  gammaBS?: string;
  thetaBS?: string;
  vegaBS?: string;
}
interface OKXFunding { ccy: string; bal: string }
interface OKXSavings { ccy: string; amt: string }
interface OKXStakingOrder { ccy: string; investData: Array<{ ccy: string; amt: string }> }

interface OKXWithdrawal { wdId: string; ccy: string; chain: string; amt: string; fee: string; to: string; txId: string; ts: string; state: string }
interface OKXDeposit { depId: string; ccy: string; chain: string; amt: string; to: string; txId: string; ts: string; state: string }

/** instFamily (e.g. BTC-USD) → underlying units per option contract (ctMult; BTC-USD 0.01, ETH-USD 0.1) */
const ctMultCache = new Map<string, number>();

const okxGreek = (v: string | undefined) => (v != null && v !== '' ? num(v) : null);

export class OKXConnector extends BaseConnector {
  private apiKey: string;
  private apiSecret: string;
  private passphrase: string;

  constructor(account: AccountConfig) {
    super(account);
    const creds = account.credentials as OKXCredentials;
    this.apiKey = creds.apiKey;
    this.apiSecret = creds.apiSecret;
    this.passphrase = creds.passphrase;
  }

  async fetch(): Promise<AccountSnapshot> {
    const warnings: string[] = [];
    try {
      const [balance, positionsRaw] = await Promise.all([
        this.signedGet<OKXBalance[]>('/api/v5/account/balance'),
        this.signedGet<OKXPosition[]>('/api/v5/account/positions'),
      ]);
      const [funding, savings, staking] = await Promise.all([
        this.sticky('Funding', warnings, () => this.signedGet<OKXFunding[]>('/api/v5/asset/balances?ccy=USDT,USDC'), []),
        this.sticky('Simple Earn', warnings, () => this.signedGet<OKXSavings[]>('/api/v5/finance/savings/balance'), []),
        this.sticky('On-chain Earn', warnings, () => this.signedGet<OKXStakingOrder[]>('/api/v5/finance/staking-defi/orders-active'), [], true),
      ]);

      const acct = balance[0];
      const stables: StableBalance[] = [];
      const add = (ccy: string, location: StableBalance['location'], amount: number, source: string) => {
        if (STABLES.has(ccy) && Math.abs(amount) >= 0.01) stables.push({ asset: ccy as 'USDT' | 'USDC', location, amount, source });
      };
      // Trading account: cash balance (excl. uPnL, which is counted on positions)
      for (const d of acct?.details ?? []) add(d.ccy, 'trading', num(d.cashBal), 'Trading account');
      for (const f of funding) add(f.ccy, 'funding', num(f.bal), 'Funding account');
      for (const s of savings) add(s.ccy, 'earn', num(s.amt), 'Simple Earn');
      for (const o of staking) for (const i of o.investData ?? []) add(i.ccy, 'earn', num(i.amt), 'On-chain Earn');

      const families = [...new Set(positionsRaw.filter((p) => p.instType === 'OPTION').map((p) => p.instId.split('-').slice(0, 2).join('-')))];
      // Cached for the process lifetime; on failure the multiplier stays unknown (null) and is retried next cycle
      await Promise.all(families.filter((f) => !ctMultCache.has(f)).map(async (f) => {
        try {
          const res = await fetch(`${BASE_URL}/api/v5/public/instruments?instType=OPTION&instFamily=${encodeURIComponent(f)}`,
            { signal: AbortSignal.timeout(10_000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = (await res.json()) as { code?: string; msg?: string; data?: Array<{ ctMult: string; ctVal: string }> };
          if (body.code !== '0') throw new Error(`code ${body.code}: ${body.msg}`);
          const i = body.data?.[0];
          const m = i ? (num(i.ctMult) || 1) * (num(i.ctVal) || 1) : 0;
          if (!(m > 0)) throw new Error('no contract multiplier in response');
          ctMultCache.set(f, m);
        } catch (err) {
          warnings.push(`Option specs ${f}: ${err instanceof Error ? err.message : String(err)} — option PnL estimates unavailable`.substring(0, 300));
        }
      }));

      const positions: Position[] = [];
      for (const p of positionsRaw) {
        const pos = num(p.pos);
        if (pos === 0 || p.instType === 'MARGIN') continue;
        const side: Position['side'] =
          p.posSide === 'long' || (p.posSide === 'net' && pos > 0) ? 'long'
          : p.posSide === 'short' || (p.posSide === 'net' && pos < 0) ? 'short'
          : 'flat';

        // Coin-margined contracts (incl. BTC-USD options) report uPnL in the margin coin
        const coinPx = STABLES.has(p.ccy) || !p.ccy ? 1 : num(p.usdPx) || num(p.idxPx) || 0;
        const base: Position = {
          symbol: p.instId,
          side,
          quantity: Math.abs(pos),
          avgPrice: num(p.avgPx),
          currentPrice: num(p.markPx),
          unrealizedPnl: num(p.upl) * coinPx,
          marketValue: Math.abs(num(p.notionalUsd)),
          leverage: num(p.lever) || null,
          liquidationPrice: num(p.liqPx) || null,
          // cross: imr; isolated: margin (both in the margin coin)
          margin: (num(p.imr) || num(p.margin)) * coinPx || null,
          assetClass: p.instType === 'SWAP' ? 'crypto-perp' : p.instType === 'FUTURES' ? 'crypto-future' : 'option',
        };
        if (p.instType === 'SWAP' && p.fundingFee != null && p.fundingFee !== '') base.fundingPnl = num(p.fundingFee) * coinPx;

        if (p.instType === 'OPTION') {
          const parsed = parseOptionSymbol(p.instId);
          base.leverage = null;
          if (parsed) {
            base.option = {
              ...parsed,
              // OKX position greeks (BS = USD-quoted Black-Scholes) are already position-level
              delta: okxGreek(p.deltaBS),
              gamma: okxGreek(p.gammaBS),
              theta: okxGreek(p.thetaBS),
              vega: okxGreek(p.vegaBS),
              underlyingPrice: num(p.idxPx) || null,
              premiumCcy: STABLES.has(p.ccy) ? undefined : p.ccy,
              contractMultiplier: ctMultCache.get(p.instId.split('-').slice(0, 2).join('-')) ?? null,
            };
          }
        }
        positions.push(base);
      }

      const swaps = positions.filter((p) => p.assetClass === 'crypto-perp');
      if (swaps.length) {
        const quotes = await this.sticky('Funding rates', warnings, () => okxFundingQuotes(swaps.map((p) => p.symbol)), new Map<string, FundingQuote>(), true);
        for (const p of swaps) applyFunding(p, quotes.get(p.symbol));
      }

      const totalEq = num(acct?.totalEq);
      const offTrading = stables.filter((s) => s.location !== 'trading').reduce((s, b) => s + b.amount, 0);
      const upl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
      const marginUsed = num(acct?.imr) || positionsRaw.reduce((s, p) => s + (num(p.imr) || num(p.margin)), 0);
      const adjEq = num(acct?.adjEq) || totalEq;

      return {
        accountId: this.account.id,
        exchange: 'okx',
        label: this.account.label,
        // Trading account total equity (USD, incl. uPnL) + funding/earn stables
        equity: totalEq + offTrading,
        availableBalance: (acct?.details ?? []).filter((d) => STABLES.has(d.ccy)).reduce((s, d) => s + num(d.availEq), 0),
        unrealizedPnl: upl,
        marginUsed,
        marginRatio: adjEq > 0 ? marginUsed / adjEq : null,
        positions,
        stables,
        fetchedAt: new Date().toISOString(),
        isDelayed: false,
        warnings: warnings.length ? warnings : undefined,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[okx] ${this.account.id}: ${msg}`);
      return this.makeErrorSnapshot(msg);
    }
  }

  /**
   * Newest-first history pages (max 100 rows, all coins) walked backwards with `after` (= records
   * older than ts) until a page reaches `sinceMs` — a single `before=since` page could miss the
   * newest records once more than 100 exist in the window.
   */
  private async historySince<T extends { ts: string }>(path: string, sinceMs: number): Promise<T[]> {
    const out: T[] = [];
    let after: number | null = null;
    for (let page = 0; page < 20; page++) {
      const rows: T[] = await this.signedGet<T[]>(`${path}?limit=100${after != null ? `&after=${after}` : ''}`);
      out.push(...rows.filter((r) => num(r.ts) >= sinceMs));
      if (rows.length < 100) break;
      const oldest = Math.min(...rows.map((r) => num(r.ts)));
      if (!(oldest > sinceMs) || oldest === after) break;
      after = oldest;
    }
    return out;
  }

  /**
   * Closed positions: /api/v5/account/positions-history (3 months; one row per position, updated
   * on partial closes — so the id is the position id and the row is upserted). realizedPnl is net
   * of fees and funding, in the margin currency: coin-margined values are converted to USD at the
   * close price (index price for options).
   */
  async fetchClosedTrades(sinceMs: number): Promise<ClosedTrade[]> {
    const out: ClosedTrade[] = [];
    for (const instType of ['SWAP', 'FUTURES', 'OPTION'] as const) {
      const rows: OKXClosedPosition[] = [];
      let after: number | null = null;
      for (let page = 0; page < 20; page++) {
        const batch: OKXClosedPosition[] = await this.signedGet<OKXClosedPosition[]>(
          `/api/v5/account/positions-history?instType=${instType}&limit=100${after != null ? `&after=${after}` : ''}`);
        rows.push(...batch.filter((r) => num(r.uTime) >= sinceMs));
        if (batch.length < 100) break;
        const oldest = Math.min(...batch.map((r) => num(r.uTime)));
        if (!(oldest > sinceMs) || oldest === after) break;
        after = oldest;
      }
      if (!rows.length) continue;
      const cats = instType === 'OPTION' ? null : await this.instCategories(instType).catch(() => new Map<string, string>());
      for (const r of rows) {
        const coinMargined = !STABLES.has(r.ccy) && r.ccy !== 'USD';
        let usd = 1;
        if (coinMargined) usd = instType === 'OPTION' ? await this.indexPrice(r.uly).catch(() => 0) : num(r.closeAvgPx);
        if (!(usd > 0)) continue;
        const fees = (num(r.fee) + num(r.fundingFee) + num(r.liqPenalty)) * usd;
        out.push(this.trade({
          id: `okx:${r.posId}`,
          symbol: r.instId,
          side: r.direction === 'short' ? 'short' : 'long',
          entryPrice: num(r.openAvgPx),
          exitPrice: num(r.closeAvgPx),
          quantity: num(r.closeTotalPos),
          pnl: num(r.realizedPnl) * usd,
          fees,
          entryTime: num(r.cTime),
          exitTime: num(r.uTime),
          category: instType === 'OPTION' ? 'option' : okxCategory(r.instId, cats?.get(r.instId)),
        }));
      }
    }
    return out;
  }

  /** instId → instCategory ('1' crypto, '3' stocks, '4' commodities, '5' forex, …) */
  private instCategories(instType: 'SWAP' | 'FUTURES'): Promise<Map<string, string>> {
    return cachedPublic(`okx:instCategory:${instType}`, 6 * 3_600_000, async () => {
      const res = await fetch(`${BASE_URL}/api/v5/public/instruments?instType=${instType}`);
      if (!res.ok) throw new Error(`OKX instruments ${res.status}`);
      const body = (await res.json()) as { data: Array<{ instId: string; instCategory?: string }> };
      return new Map(body.data.map((i) => [i.instId, i.instCategory ?? '']));
    });
  }

  private indexPrice(uly: string): Promise<number> {
    const instId = uly.replace(/-USDT?$|-USDC$/, '') + '-USD';
    return cachedPublic(`okx:index:${instId}`, 60_000, async () => {
      const res = await fetch(`${BASE_URL}/api/v5/market/index-tickers?instId=${encodeURIComponent(instId)}`);
      const body = (await res.json()) as { data?: Array<{ idxPx: string }> };
      return num(body.data?.[0]?.idxPx);
    });
  }

  /** OKX: `amt` excludes the fee (fee charged separately, verified live) */
  async fetchFlows(sinceMs: number): Promise<FundFlow[]> {
    const [wd, dep] = await Promise.all([
      this.historySince<OKXWithdrawal>('/api/v5/asset/withdrawal-history', sinceMs),
      this.historySince<OKXDeposit>('/api/v5/asset/deposit-history', sinceMs),
    ]);
    const flows: FundFlow[] = [];
    for (const w of wd) {
      const coin = stableCoin(w.ccy);
      if (!coin) continue;
      // 2 success; -1 failed, -2 canceled, -3 canceling; others in progress / review
      const status: FundFlow['status'] = w.state === '2' ? 'done' : ['-1', '-2', '-3'].includes(w.state) ? 'failed' : 'pending';
      flows.push({
        id: `out:${w.wdId}`, direction: 'out', coin, amount: num(w.amt), fee: num(w.fee),
        txId: lower(w.txId), address: lower(w.to), network: w.chain || null,
        time: num(w.ts), doneTime: null, status,
      });
    }
    for (const d of dep) {
      const coin = stableCoin(d.ccy);
      if (!coin) continue;
      // 1 credited, 2 successful; 0 waiting confirmation; others held / blocked
      const status: FundFlow['status'] = d.state === '1' || d.state === '2' ? 'done' : d.state === '0' ? 'pending' : 'failed';
      flows.push({
        id: `in:${d.depId}`, direction: 'in', coin, amount: num(d.amt), fee: 0,
        txId: lower(d.txId), address: lower(d.to), network: d.chain || null,
        time: num(d.ts), doneTime: status === 'done' ? num(d.ts) : null, status,
      });
    }
    return flows;
  }

  private async signedGet<T>(path: string): Promise<T> {
    const timestamp = new Date().toISOString();
    const signature = createHmac('sha256', this.apiSecret).update(timestamp + 'GET' + path).digest('base64');

    const res = await fetch(`${BASE_URL}${path}`, {
      headers: {
        'OK-ACCESS-KEY': this.apiKey,
        'OK-ACCESS-SIGN': signature,
        'OK-ACCESS-TIMESTAMP': timestamp,
        'OK-ACCESS-PASSPHRASE': this.passphrase,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      throw new Error(`OKX ${path} ${res.status}: ${(await res.text()).substring(0, 200)}`);
    }
    const body = (await res.json()) as { code: string; msg: string; data: T };
    if (body.code !== '0') {
      throw new Error(`OKX ${path} error code ${body.code}: ${body.msg}`);
    }
    return body.data;
  }
}

/** fundingTime = upcoming settlement, nextFundingTime = the one after (their gap is the interval) */
async function okxFundingQuotes(instIds: string[]): Promise<Map<string, FundingQuote>> {
  const out = new Map<string, FundingQuote>();
  await Promise.all([...new Set(instIds)].map(async (instId) => {
    const r = await cachedPublic(`okx:fund:${instId}`, 60_000, async () => {
      const res = await fetch(`${BASE_URL}/api/v5/public/funding-rate?instId=${encodeURIComponent(instId)}`);
      const body = (await res.json()) as { code: string; msg: string; data: Array<{ fundingRate: string; fundingTime: string; nextFundingTime: string }> };
      if (body.code !== '0') throw new Error(`funding-rate ${instId}: ${body.msg}`);
      return body.data[0];
    });
    if (!r) return;
    const t = num(r.fundingTime), t2 = num(r.nextFundingTime);
    out.set(instId, { rate: num(r.fundingRate), nextTime: t || null, intervalH: t && t2 > t ? (t2 - t) / 3_600_000 : null });
  }));
  return out;
}

interface OKXClosedPosition {
  instId: string; instType: string; uly: string; ccy: string; posId: string; direction: 'long' | 'short' | string;
  openAvgPx: string; closeAvgPx: string; closeTotalPos: string; realizedPnl: string; fee: string; fundingFee: string;
  liqPenalty?: string; type: string; cTime: string; uTime: string;
}

function okxCategory(instId: string, instCategory: string | undefined): TradeCategory {
  // Gold, including gold-backed tokens listed as crypto
  if (guessCategory(instId) === 'xau') return 'xau';
  switch (instCategory) {
    case '1': return 'crypto';
    case '3': return 'stock';
    case '4': case '5': return 'xau';
    default: return guessCategory(instId);
  }
}
