import { createHmac } from 'node:crypto';
import { applyFunding, BaseConnector, cachedPublic, lower, num, parseOptionSymbol, stableCoin, type FundingQuote } from './base.js';
import type { AccountConfig, AccountSnapshot, BybitCredentials, FundFlow, Position, StableBalance } from '../types.js';

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
  positionIM?: string;
  createdTime?: string;
  delta?: string;
  gamma?: string;
  vega?: string;
  theta?: string;
}

/** Public option ticker — greeks are per 1 contract (1 unit of underlying) */
interface BybitOptionTicker {
  symbol: string;
  delta: string;
  gamma: string;
  vega: string;
  theta: string;
  markIv: string;
  underlyingPrice: string;
  indexPrice: string;
}

interface BybitFundCoin { coin: string; walletBalance: string }
/** /v5/asset/asset-overview — the only V5 endpoint that exposes the TradFi (MT5 CFD) account */
interface BybitAssetOverview {
  list: Array<{ accountType: string; totalEquity: string; coinDetail?: Array<{ coin: string; equity: string }> }>;
}
interface BybitEarnPos { coin: string; amount: string }

interface BybitWithdrawal { withdrawId: string; coin: string; chain: string; amount: string; withdrawFee: string; toAddress: string; txID: string; status: string; createTime: string; updateTime: string }
interface BybitDeposit { id: string; coin: string; chain: string; amount: string; toAddress: string; txID: string; status: number; successAt: string }

/** /v5/account/transaction-log row. `size` = position size after the entry; SETTLEMENT `funding` is signed cash (− paid) */
interface BybitTxLog { id: string; symbol: string; type: string; funding: string; size: string; transactionTime: string }
interface LedgerRow { sym: string; t: number; settle: boolean; funding: number; size: number }
interface BybitLinearTicker { fundingRate: string; nextFundingTime: string; fundingIntervalHour?: string }

const DAY = 86_400_000;
/** transaction-log allows at most 7 days per query */
const LOG_WINDOW = 7 * DAY - 60_000;
/** Don't look further back than this for funding since open */
const LEDGER_MAX_AGE = 30 * DAY;

interface BybitInstrument { symbol: string; deliveryTime: string; priceFilter: { tickSize: string } }
/** Instrument specs never change for a listed option — cache across polls */
const instrumentCache = new Map<string, { expiryTs: number | null; tickSize: number | null }>();

export class BybitConnector extends BaseConnector {
  private apiKey: string;
  private apiSecret: string;
  /** Linear transaction log (settlements + trades), used for funding since open. In memory; refilled on restart */
  private ledger = new Map<string, LedgerRow>();
  private ledgerFrom = 0;
  private ledgerTo = 0;

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
      const [options, fund, earnFlex, earnChain, overview] = await Promise.all([
        this.sticky('Options', warnings, () => this.signedGet<{ list: BybitPosition[] }>('/v5/position/list', { category: 'option' }), { list: [] }, true),
        this.sticky('Funding', warnings, () => this.signedGet<{ balance: BybitFundCoin[] }>('/v5/asset/transfer/query-account-coins-balance', { accountType: 'FUND', coin: 'USDT,USDC' }), { balance: [] }),
        this.sticky('Earn', warnings, () => this.signedGet<{ list: BybitEarnPos[] }>('/v5/earn/position', { category: 'FlexibleSaving' }), { list: [] }),
        this.sticky('On-chain Earn', warnings, () => this.signedGet<{ list: BybitEarnPos[] }>('/v5/earn/position', { category: 'OnChain' }), { list: [] }, true),
        this.sticky('TradFi', warnings, () => this.signedGet<BybitAssetOverview>('/v5/asset/asset-overview', {}), { list: [] }),
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
      // TradFi (MT5 CFD) account: equity only (incl. floating CFD PnL) — positions aren't exposed via V5
      const tradfi = (overview.list ?? []).find((a) => a.accountType === 'TradFi');
      const tradfiEquity = num(tradfi?.totalEquity);
      for (const c of tradfi?.coinDetail ?? []) add(c.coin, 'trading', num(c.equity), 'TradFi (CFD)');

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
          margin: num(p.positionIM) || null,
          // Dated linear futures look like BTCUSDT-27DEC24 / BTC-27DEC24
          assetClass: /-\d{1,2}[A-Z]{3}\d{2}$/.test(p.symbol) ? 'crypto-future' : 'crypto-perp',
        });
      }

      // Funding: current rate + next payment (public tickers), and funding since open (transaction log)
      const linear = [...linearUsdt.list, ...linearUsdc.list].filter((p) => num(p.size) !== 0);
      const perps = positions.filter((p) => p.assetClass === 'crypto-perp');
      if (perps.length) {
        const [quotes, paid] = await Promise.all([
          this.sticky('Funding rates', warnings, () => this.fundingQuotes(perps.map((p) => p.symbol)), new Map<string, FundingQuote>(), true),
          this.sticky('Funding history', warnings, () => this.fundingSinceOpen(linear), new Map<string, number>()),
        ]);
        for (const p of perps) {
          applyFunding(p, quotes.get(p.symbol));
          p.fundingPnl = paid.get(p.symbol) ?? null;
        }
      }

      const openOptions = (options.list ?? []).filter((p) => num(p.size) !== 0);
      const tickers = new Map<string, BybitOptionTicker>();
      await Promise.all(openOptions.map((p) => this.sticky(`Option ticker ${p.symbol}`, warnings, async () => {
        const t = await this.publicGet<{ list: BybitOptionTicker[] }>('/v5/market/tickers', { category: 'option', symbol: p.symbol });
        if (t.list?.[0]) tickers.set(p.symbol, t.list[0]);
      }, undefined, true)));

      await Promise.all(openOptions.filter((p) => !instrumentCache.has(p.symbol)).map((p) => this.sticky(`Option spec ${p.symbol}`, warnings, async () => {
        const r = await this.publicGet<{ list: BybitInstrument[] }>('/v5/market/instruments-info', { category: 'option', symbol: p.symbol });
        const i = r.list?.[0];
        if (i) instrumentCache.set(p.symbol, { expiryTs: num(i.deliveryTime) || null, tickSize: num(i.priceFilter?.tickSize) || null });
      }, undefined, true)));

      for (const p of openOptions) {
        const size = num(p.size);
        const spec = instrumentCache.get(p.symbol);
        const parsed = parseOptionSymbol(p.symbol.replace(/-(USDT|USDC)$/, ''));
        const t = tickers.get(p.symbol);
        const sign = p.side === 'Sell' ? -1 : 1;
        // Prefer per-contract ticker greeks × size × side; fall back to the position's own (already position-level) greeks
        const greek = (perContract: string | undefined, positionLevel: string | undefined) =>
          perContract != null && perContract !== '' ? num(perContract) * size * sign
          : positionLevel != null && positionLevel !== '' ? num(positionLevel) : null;
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
          option: parsed ? {
            ...parsed,
            delta: greek(t?.delta, p.delta),
            gamma: greek(t?.gamma, p.gamma),
            theta: greek(t?.theta, p.theta),
            vega: greek(t?.vega, p.vega),
            iv: t?.markIv ? num(t.markIv) : null,
            underlyingPrice: t ? num(t.underlyingPrice) || num(t.indexPrice) || null : null,
            expiryTs: spec?.expiryTs ?? null,
            tickSize: spec?.tickSize ?? null,
          } : undefined,
        });
      }

      const offTrading = stables.filter((s) => s.location !== 'trading').reduce((s, b) => s + b.amount, 0);
      const upl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);

      return {
        accountId: this.account.id,
        exchange: 'bybit',
        label: this.account.label,
        equity: num(wallet.totalEquity) + offTrading + tradfiEquity,
        availableBalance: num(wallet.totalAvailableBalance),
        unrealizedPnl: upl,
        marginUsed: num(wallet.totalInitialMargin),
        marginRatio: wallet.accountIMRate ? num(wallet.accountIMRate) : null,
        positions,
        stables,
        cfd: tradfi && Math.abs(tradfiEquity) >= 0.01 ? [{
          name: 'Bybit TradFi (MT5)', equityOnly: true, currency: 'USDT',
          balance: tradfiEquity, equity: tradfiEquity, floatingPnl: 0, usedMargin: 0, freeMargin: 0,
          marginLevel: null, leverage: null, marginCallLevel: null, stopOutLevel: null, effectiveLeverage: null, notional: 0,
        }] : undefined,
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

  /** On-chain + off-chain withdrawals and on-chain deposits. Query window is capped at 7 days. */
  async fetchFlows(sinceMs: number): Promise<FundFlow[]> {
    const endTime = Date.now();
    const range = { startTime: String(Math.max(sinceMs, endTime - 7 * 86_400_000 + 60_000)), endTime: String(endTime), limit: '50' };
    const [wd, dep] = await Promise.all([
      this.signedGet<{ rows: BybitWithdrawal[] }>('/v5/asset/withdraw/query-record', { ...range, withdrawType: '2' }),
      this.signedGet<{ rows: BybitDeposit[] }>('/v5/asset/deposit/query-record', range),
    ]);
    const flows: FundFlow[] = [];
    for (const w of wd.rows ?? []) {
      const coin = stableCoin(w.coin);
      if (!coin) continue;
      const status: FundFlow['status'] = w.status === 'success' || w.status === 'BlockchainConfirmed' ? 'done'
        : ['CancelByUser', 'Reject', 'Fail'].includes(w.status) ? 'failed' : 'pending';
      flows.push({
        id: `out:${w.withdrawId}`, direction: 'out', coin, amount: num(w.amount), fee: num(w.withdrawFee),
        txId: lower(w.txID), address: lower(w.toAddress), network: w.chain || null,
        time: num(w.createTime), doneTime: status === 'done' ? num(w.updateTime) || null : null, status,
      });
    }
    for (const d of dep.rows ?? []) {
      const coin = stableCoin(d.coin);
      if (!coin) continue;
      // 3 success, 10012 credited to funding pool; 4 failed; others pending
      const status: FundFlow['status'] = d.status === 3 || d.status === 10012 ? 'done' : d.status === 4 ? 'failed' : 'pending';
      flows.push({
        id: `in:${d.id}`, direction: 'in', coin, amount: num(d.amount), fee: 0,
        txId: lower(d.txID), address: lower(d.toAddress), network: d.chain || null,
        time: num(d.successAt), doneTime: status === 'done' ? num(d.successAt) || null : null, status,
      });
    }
    return flows;
  }

  private async fundingQuotes(symbols: string[]): Promise<Map<string, FundingQuote>> {
    const out = new Map<string, FundingQuote>();
    await Promise.all([...new Set(symbols)].map(async (symbol) => {
      const t = await cachedPublic(`bybit:ticker:${symbol}`, 60_000, async () =>
        (await this.publicGet<{ list: BybitLinearTicker[] }>('/v5/market/tickers', { category: 'linear', symbol })).list[0]);
      if (t) out.set(symbol, { rate: num(t.fundingRate), nextTime: num(t.nextFundingTime) || null, intervalH: num(t.fundingIntervalHour) || null });
    }));
    return out;
  }

  /** Fetch one ≤7-day window of the linear transaction log; returns the earliest time actually covered */
  private async loadLog(start: number, end: number): Promise<number> {
    let cursor = '';
    let earliest = end;
    for (let page = 0; page < 40; page++) {
      const r = await this.signedGet<{ list: BybitTxLog[]; nextPageCursor?: string }>('/v5/account/transaction-log', {
        accountType: 'UNIFIED', category: 'linear', startTime: String(start), endTime: String(end), limit: '50', ...(cursor ? { cursor } : {}),
      });
      for (const x of r.list ?? []) {
        const t = num(x.transactionTime);
        earliest = Math.min(earliest, t);
        this.ledger.set(x.id, { sym: x.symbol, t, settle: x.type === 'SETTLEMENT', funding: num(x.funding), size: num(x.size) });
      }
      cursor = r.nextPageCursor ?? '';
      if (!cursor) return start;
    }
    return earliest; // truncated (rows come newest first): only covered back to the oldest row seen
  }

  /**
   * Funding received (+) / paid (−) per symbol since the position was opened: the sum of SETTLEMENT
   * rows after max(createdTime, last log entry that left the position flat). createdTime alone can
   * predate a full close + reopen. Incremental: new rows every 5 min (or right after the hour, when
   * settlements post), history back-filled once.
   */
  private lastLedgerPoll = 0;
  private async fundingSinceOpen(linear: BybitPosition[]): Promise<Map<string, number>> {
    const now = Date.now();
    if (!this.ledgerTo) this.ledgerFrom = this.ledgerTo = now;
    const hourTurned = Math.floor(now / 3_600_000) !== Math.floor(this.lastLedgerPoll / 3_600_000) && now % 3_600_000 > 90_000;
    if (now - this.lastLedgerPoll > 5 * 60_000 || hourTurned) {
      for (let s = this.ledgerTo - 120_000; s < now; s += LOG_WINDOW) await this.loadLog(s, Math.min(s + LOG_WINDOW, now));
      this.ledgerTo = now;
      this.lastLedgerPoll = now;
    }
    const want = Math.max(Math.min(...linear.map((p) => num(p.createdTime) || now)), now - LEDGER_MAX_AGE);
    while (this.ledgerFrom > want + 1000) {
      const s = Math.max(want, this.ledgerFrom - LOG_WINDOW);
      const reached = await this.loadLog(s, this.ledgerFrom);
      this.ledgerFrom = reached;
      if (reached > s) break;
    }
    for (const [id, r] of this.ledger) if (r.t < now - LEDGER_MAX_AGE - DAY) this.ledger.delete(id);
    if (this.ledgerFrom < now - LEDGER_MAX_AGE - DAY) this.ledgerFrom = now - LEDGER_MAX_AGE - DAY;

    const rows = [...this.ledger.values()];
    const out = new Map<string, number>();
    for (const p of linear) {
      let from = num(p.createdTime);
      for (const r of rows) if (r.sym === p.symbol && !r.settle && r.size === 0 && r.t > from) from = r.t;
      let sum = 0;
      for (const r of rows) if (r.sym === p.symbol && r.settle && r.t > from) sum += r.funding;
      out.set(p.symbol, sum);
    }
    return out;
  }

  private async publicGet<T>(path: string, params: Record<string, string>): Promise<T> {
    const res = await fetch(`${BASE}${path}?${new URLSearchParams(params)}`);
    if (!res.ok) throw new Error(`Bybit ${path} ${res.status}`);
    const body = (await res.json()) as BybitResponse<T>;
    if (body.retCode !== 0) throw new Error(`Bybit ${path} retCode ${body.retCode}: ${body.retMsg}`);
    return body.result;
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
