import type { AccountSnapshot, HistoryBackfill } from './types.js';
import { historyDbInsert, historyDbLoad, historyDbOpen } from './db.js';
import { transitAdjuster } from './transfers.js';
import { estimatorFor, type Estimator } from './backfill.js';

interface EquityPoint {
  t: number; // unix seconds
  total: number;
  accounts: Record<string, number>;
  /** Per-account USD outside the trading wallets (earn + funding stables). Absent on old points */
  off?: Record<string, number>;
  /** Synthetic point before the first recorded sample (backfill.ts estimate) */
  est?: boolean;
}

/** Spacing of the synthetic points before the first recorded sample */
const BACKFILL_STEP_S = 3600;

/** 'total' = all equity; 'trading' = equity minus earn and funding wallets (CFD/MT5 count as trading) */
export type HistoryScope = 'total' | 'trading';

const MAX_POINTS = 25_000; // ~8.5 days at 30s intervals
/** Fine-grained 30s samples since this process started (in memory) */
const points: EquityPoint[] = [];
/** Long-term samples persisted to SQLite, one every PERSIST_EVERY_S (survive restarts) */
const longPoints: EquityPoint[] = [];
const PERSIST_EVERY_S = 30 * 60;
let lastPersistedT = 0;

/** Open the store and load persisted history. Call once at startup. */
export async function historyInit(): Promise<void> {
  if (!(await historyDbOpen())) return;
  longPoints.push(...historyDbLoad());
  lastPersistedT = longPoints.at(-1)?.t ?? 0;
  console.log(`[history] loaded ${longPoints.length} persisted point(s)`);
}

let backfills: Array<{ accountId: string; before: number; amount: number }> = [];

/** Manual backfills from accounts.json `historyBackfill` (see HistoryBackfill) */
/** Unix seconds of an account's first recorded sample, null if it has none */
export function historyFirstSeen(accountId: string): number | null {
  for (const p of storedSeries()) if (p.accounts[accountId] != null) return p.t;
  return null;
}

export function historySetBackfill(list: HistoryBackfill[] | undefined): void {
  backfills = [];
  for (const b of list ?? []) {
    const before = typeof b.before === 'number' ? b.before : Math.floor(Date.parse(b.before) / 1000);
    if (!b.accountId || !Number.isFinite(before) || !Number.isFinite(b.amount) || b.amount === 0) {
      console.warn(`[history] ignoring invalid historyBackfill entry ${JSON.stringify(b)}`);
      continue;
    }
    backfills.push({ accountId: b.accountId, before, amount: b.amount });
  }
  if (backfills.length) console.log(`[history] ${backfills.length} manual backfill(s) applied to the curve`);
}

/** Persisted history up to the start of this session, then the fine-grained session samples (as recorded) */
function storedSeries(): EquityPoint[] {
  const sessionStart = points[0]?.t ?? Infinity;
  const older = longPoints.filter((p) => p.t < sessionStart);
  return older.length ? [...older, ...points] : points;
}

/**
 * Recorded series with funds that existed before they were tracked added back, so connecting an
 * account (or a wallet type) later doesn't look like a gain:
 * - automatic: before an account's first sample, its estimated equity (backfill.ts: venue history or
 *   walked back from trades + deposits/withdrawals; else its first recorded equity) is added to
 *   the total; per-account values stay absent on recorded points;
 * - manual (`historyBackfill`): the amount is added to the account and the total before `before`;
 * - before the first recorded sample: hourly synthetic points (`est`) from the estimates, once
 *   every account has one there.
 * Stored data is never modified.
 */
function rawSeries(): EquityPoint[] {
  const list = storedSeries();
  if (!list.length) return list;
  const first = new Map<string, { t: number; v: number; off: number }>();
  for (const p of list) {
    for (const [id, v] of Object.entries(p.accounts)) {
      if (!first.has(id)) first.set(id, { t: p.t, v, off: p.off?.[id] ?? 0 });
    }
  }
  // Estimated equity before each account's first sample (venue history or walked back from it)
  const est = new Map<string, Estimator>();
  for (const [id, f] of first) {
    const e = estimatorFor(id, f.t * 1000, f.v);
    if (e) est.set(id, e);
  }

  /** Manual backfill for a value at t. `auto`: the value is derived from the first sample */
  const manual = (id: string, t: number, auto: boolean) => {
    let add = 0;
    for (const b of backfills) {
      if (b.accountId !== id || t >= b.before) continue;
      // A first sample taken after `before` already includes these funds
      if (auto && (first.get(id)?.t ?? Infinity) >= b.before) continue;
      add += b.amount;
    }
    return add;
  };
  /** Value of an account at t before its first sample */
  const before = (id: string, t: number) => {
    const e = est.get(id);
    const f = first.get(id)!;
    const v = e && t * 1000 >= e.from ? e.at(t * 1000) : f.v;
    return Math.max(0, v + manual(id, t, true));
  };

  const recorded = list.map((p) => {
    let total = p.total;
    let accounts = p.accounts;
    let off = p.off;
    for (const [id, f] of first) {
      if (p.t >= f.t || p.accounts[id] != null) continue;
      total += before(id, p.t);
      if (off && f.off) off = { ...off, [id]: f.off };
    }
    for (const b of backfills) {
      if (p.t >= b.before || accounts[b.accountId] == null) continue;
      total += b.amount;
      accounts = { ...accounts, [b.accountId]: accounts[b.accountId] + b.amount };
    }
    return total === p.total && accounts === p.accounts && off === p.off ? p : { ...p, total, accounts, off };
  });

  // Synthetic points before the first sample. Accounts without an estimate (no longer configured,
  // MT5 deal history unavailable this run, …) are held at their first recorded value there, as on
  // recorded points, instead of suppressing the whole reconstruction
  if (!est.size) return recorded;
  const start = Math.max(...[...est.values()].map((e) => Math.ceil(e.from / 1000)));
  const end = list[0].t;
  const synth: EquityPoint[] = [];
  for (let t = Math.ceil(start / BACKFILL_STEP_S) * BACKFILL_STEP_S; t < end; t += BACKFILL_STEP_S) {
    const accounts: Record<string, number> = {};
    let total = 0;
    for (const id of first.keys()) total += accounts[id] = before(id, t);
    synth.push({ t, total, accounts, est: true });
  }
  return synth.length ? [...synth, ...recorded] : recorded;
}

/** Unix seconds of the first recorded sample (points before it are estimates) */
function firstRecordedT(): number | null {
  return storedSeries()[0]?.t ?? null;
}

/**
 * Same series with funds in transit between tracked accounts added back to the total, so an
 * internal transfer shows only its fee instead of a dip and recovery. Per-account values stay raw.
 */
function series(): EquityPoint[] {
  const adj = transitAdjuster();
  return rawSeries().map((p) => {
    // +0.999s: a sample's t is floored to the second but it saw everything observed before it
    const a = adj(p.t + 0.999);
    return a === 0 ? p : { ...p, total: p.total + a };
  });
}

/** Most recent recorded equity per account (session first, then persisted history) */
function lastKnown(accountId: string): { equity: number; off: number | null } | null {
  for (const list of [points, longPoints]) {
    for (let i = list.length - 1; i >= 0; i--) {
      const v = list[i].accounts[accountId];
      if (v != null) return { equity: v, off: list[i].off ? list[i].off![accountId] ?? 0 : null };
    }
  }
  return null;
}

/** USD of an account outside its trading wallets */
const offTrading = (a: AccountSnapshot) =>
  (a.stables ?? []).filter((s) => s.location !== 'trading').reduce((s, b) => s + b.amount, 0);

/**
 * @param expectedIds accounts that should be in the total. One without data yet (its first fetch
 *   failed after a restart) is carried forward at its last recorded equity instead of being
 *   dropped — otherwise the total shows a fake dip, which would also be persisted.
 */
export function historyRecord(accounts: AccountSnapshot[], expectedIds: string[] = []): void {
  if (accounts.length === 0) return;

  const accts: Record<string, number> = {};
  const off: Record<string, number> = {};
  for (const a of accounts) {
    accts[a.accountId] = a.equity;
    const o = offTrading(a);
    if (o) off[a.accountId] = o;
  }
  for (const id of expectedIds) {
    if (accts[id] != null) continue;
    const prev = lastKnown(id);
    if (prev == null) continue;
    accts[id] = prev.equity;
    if (prev.off) off[id] = prev.off;
  }
  const total = Object.values(accts).reduce((s, v) => s + v, 0);
  const point: EquityPoint = { t: Math.floor(Date.now() / 1000), total, accounts: accts, off };
  points.push(point);

  // Persist on the first complete sample after a restart, then every 30 min
  if (point.t - lastPersistedT >= PERSIST_EVERY_S - 15) {
    historyDbInsert(point);
    longPoints.push(point);
    lastPersistedT = point.t;
  }

  if (points.length > MAX_POINTS) {
    points.splice(0, points.length - MAX_POINTS);
  }
}

const PERIOD_SECONDS: Record<string, number> = {
  '1h': 3600,
  '4h': 4 * 3600,
  '24h': 24 * 3600,
  '1w': 7 * 24 * 3600,
  '30d': 30 * 24 * 3600,
};

export interface HistoryResponse {
  points: Array<{ t: number; v: number }>;
  pnl: number;
  pnlPercent: number;
  period: string;
  /** Trading scope: points before this unix time use an estimated earn/funding breakdown */
  estimatedBefore?: number;
  /** Total scope: points before this unix time are reconstructed estimates (no sample recorded yet) */
  backfilledBefore?: number;
}

export function historyGet(period: string, accountId?: string, scope: HistoryScope = 'total'): HistoryResponse {
  const cutoff =
    period === 'all'
      ? 0
      : Math.floor(Date.now() / 1000) - (PERIOD_SECONDS[period] ?? 3600);

  // Skip samples taken before a given account had data, instead of plotting them as 0
  // Trading scope uses raw totals (no transit lift: the funds left a funding wallet, which this
  // scope excludes anyway). Points recorded before the earn/funding breakdown existed get the
  // earliest recorded breakdown (estimate), so the curve isn't cut off at that point
  const trading = scope === 'trading';
  let estimatedBefore: number | undefined;
  let base: EquityPoint[];
  if (trading) {
    // Synthetic pre-history estimates have no earn/funding split: total scope only
    const raw = rawSeries().filter((p) => !p.est);
    const firstOff = raw.find((p) => p.off);
    if (!firstOff) base = [];
    else {
      if (raw[0] !== firstOff) estimatedBefore = firstOff.t;
      base = raw.map((p) => (p.off ? p : { ...p, off: firstOff.off }));
    }
  } else base = series();
  const filtered = base.filter((p) => p.t >= cutoff && (!accountId || p.accounts[accountId] != null));

  if (filtered.length === 0) {
    return { points: [], pnl: 0, pnlPercent: 0, period };
  }
  if (estimatedBefore != null && filtered[0].t >= estimatedBefore) estimatedBefore = undefined;
  const backfilledBefore = filtered[0].est ? firstRecordedT() ?? undefined : undefined;

  const sumOff = (p: EquityPoint) => Object.values(p.off ?? {}).reduce((s, v) => s + v, 0);
  const getValue = accountId
    ? (p: EquityPoint) => (p.accounts[accountId] ?? 0) - (trading ? p.off?.[accountId] ?? 0 : 0)
    : (p: EquityPoint) => (trading ? p.total - sumOff(p) : p.total);

  const startEquity = getValue(filtered[0]);
  const currentEquity = getValue(filtered[filtered.length - 1]);
  const pnl = currentEquity - startEquity;
  const pnlPercent = startEquity > 0 ? (pnl / startEquity) * 100 : 0;

  // Downsample if too many points for the chart
  const maxChart = 500;
  const chartPoints =
    filtered.length > maxChart ? downsample(filtered, maxChart) : filtered;

  return {
    points: chartPoints.map((p) => ({ t: p.t, v: getValue(p) })),
    pnl,
    pnlPercent,
    period,
    ...(estimatedBefore != null ? { estimatedBefore } : {}),
    ...(backfilledBefore != null ? { backfilledBefore } : {}),
  };
}

/** Return list of account IDs that appear in history */
export function historyAccounts(): string[] {
  if (points.length === 0) return [];
  // Use latest point to get current account list
  return Object.keys(points[points.length - 1].accounts);
}

/**
 * Time-bucketed downsample (last point per bucket). Index-based stepping would be skewed
 * by the mix of sparse 30-min persisted points and dense 30s session points.
 */
function downsample(data: EquityPoint[], target: number): EquityPoint[] {
  const n = data.length, t0 = data[0].t, span = data[n - 1].t - t0;
  if (span <= 0) return [data[n - 1]];
  const width = span / target;
  const result: EquityPoint[] = [data[0]];
  let prevBucket = 0;
  for (let i = 1; i < n; i++) {
    const b = Math.floor((data[i].t - t0) / width);
    if (b !== prevBucket) {
      if (result[result.length - 1] !== data[i - 1]) result.push(data[i - 1]);
      prevBucket = b;
    }
  }
  if (result[result.length - 1] !== data[n - 1]) result.push(data[n - 1]);
  return result;
}

export interface MetricsResponse {
  sharpeRatio: number | null;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  totalEquity: number;
  /** estimated: the reference point is a reconstructed (pre-history) estimate */
  changes: Record<string, { pnl: number; percent: number; estimated?: boolean } | null>;
}

export function metricsGet(): MetricsResponse {
  const empty: MetricsResponse = {
    sharpeRatio: null,
    maxDrawdown: 0,
    maxDrawdownPercent: 0,
    totalEquity: 0,
    changes: { '1h': null, '4h': null, '24h': null, '1w': null },
  };

  // Drawdown and period changes use the full (persisted + session) series;
  // Sharpe uses only the evenly spaced 30s session samples.
  // Drawdown on recorded samples only; period changes may reach back into the reconstruction (flagged)
  const withEst = series();
  const all = withEst.filter((p) => !p.est);
  if (all.length < 2) return empty;

  const currentEquity = all[all.length - 1].total;

  // Returns between consecutive session points (adjusted, so transfers don't register as returns)
  const sessionStart = points[0]?.t ?? Infinity;
  const session = all.filter((p) => p.t >= sessionStart);
  const returns: number[] = [];
  for (let i = 1; i < session.length; i++) {
    if (session[i - 1].total > 0) {
      returns.push(
        (session[i].total - session[i - 1].total) / session[i - 1].total,
      );
    }
  }

  // Sharpe ratio — only meaningful with >120 samples (~1 hour at 30s)
  let sharpeRatio: number | null = null;
  if (returns.length > 120) {
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance =
      returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    const std = Math.sqrt(variance);
    if (std > 0) {
      // Annualize assuming 30s intervals → 1,051,200/year
      const annualFactor = Math.sqrt(365.25 * 24 * 120);
      sharpeRatio = Math.round(((mean / std) * annualFactor) * 100) / 100;
    }
  }

  // Max drawdown
  let peak = all[0].total;
  let maxDD = 0;
  for (const p of all) {
    if (p.total > peak) peak = p.total;
    const dd = peak - p.total;
    if (dd > maxDD) maxDD = dd;
  }
  const maxDDPct = peak > 0 ? (maxDD / peak) * 100 : 0;

  // Period changes
  const now = Math.floor(Date.now() / 1000);
  const changes: MetricsResponse['changes'] = {};

  for (const [period, seconds] of Object.entries(PERIOD_SECONDS)) {
    const cutoff = now - seconds;
    const closest = withEst.find((p) => p.t >= cutoff);
    // History must actually reach back to the period start (within a 30-min sample / 2 h estimate step)
    if (closest && closest.t - cutoff <= (closest.est ? 2 * BACKFILL_STEP_S : PERSIST_EVERY_S + 60)) {
      const pnl = currentEquity - closest.total;
      const percent = closest.total > 0 ? (pnl / closest.total) * 100 : 0;
      changes[period] = {
        pnl: Math.round(pnl * 100) / 100,
        percent: Math.round(percent * 100) / 100,
        ...(closest.est ? { estimated: true } : {}),
      };
    } else {
      changes[period] = null;
    }
  }

  return {
    sharpeRatio,
    maxDrawdown: Math.round(maxDD * 100) / 100,
    maxDrawdownPercent: Math.round(maxDDPct * 100) / 100,
    totalEquity: currentEquity,
    changes,
  };
}

/** Start periodic sampling from cache */
export function startHistorySampler(
  getCachedAccounts: () => AccountSnapshot[],
  intervalMs = 30_000,
  expectedIds: string[] = [],
): void {
  const expectedAccounts = expectedIds.length;
  const startedAt = Date.now();
  // An account whose first fetch failed has only an empty error snapshot (equity 0)
  const hasData = (a: AccountSnapshot) => !a.error || a.equity !== 0 || a.positions.length > 0;
  const sample = () => {
    const accounts = getCachedAccounts();
    // Wait until every account has reported once, so the curve doesn't start with a fake step up.
    // After 3 minutes, record anyway (an account may be permanently failing).
    const ready = accounts.length >= expectedAccounts && accounts.every(hasData);
    if (!ready && Date.now() - startedAt < 180_000) return;
    historyRecord(accounts.filter(hasData), expectedIds);
  };
  setTimeout(sample, 5000);
  setInterval(sample, intervalMs);
}
