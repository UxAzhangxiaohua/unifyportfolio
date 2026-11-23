import type { AccountSnapshot } from './types.js';
import { historyDbInsert, historyDbLoad, historyDbOpen } from './db.js';
import { transitAdjuster } from './transfers.js';

interface EquityPoint {
  t: number; // unix seconds
  total: number;
  accounts: Record<string, number>;
}

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

/** Persisted history up to the start of this session, then the fine-grained session samples (raw totals) */
function rawSeries(): EquityPoint[] {
  const sessionStart = points[0]?.t ?? Infinity;
  const older = longPoints.filter((p) => p.t < sessionStart);
  return older.length ? [...older, ...points] : points;
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
function lastKnown(accountId: string): number | null {
  for (const list of [points, longPoints]) {
    for (let i = list.length - 1; i >= 0; i--) {
      const v = list[i].accounts[accountId];
      if (v != null) return v;
    }
  }
  return null;
}

/**
 * @param expectedIds accounts that should be in the total. One without data yet (its first fetch
 *   failed after a restart) is carried forward at its last recorded equity instead of being
 *   dropped — otherwise the total shows a fake dip, which would also be persisted.
 */
export function historyRecord(accounts: AccountSnapshot[], expectedIds: string[] = []): void {
  if (accounts.length === 0) return;

  const accts: Record<string, number> = {};
  for (const a of accounts) {
    accts[a.accountId] = a.equity;
  }
  for (const id of expectedIds) {
    if (accts[id] != null) continue;
    const prev = lastKnown(id);
    if (prev != null) accts[id] = prev;
  }
  const total = Object.values(accts).reduce((s, v) => s + v, 0);
  const point = { t: Math.floor(Date.now() / 1000), total, accounts: accts };
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
}

export function historyGet(period: string, accountId?: string): HistoryResponse {
  const cutoff =
    period === 'all'
      ? 0
      : Math.floor(Date.now() / 1000) - (PERIOD_SECONDS[period] ?? 3600);

  // Skip samples taken before a given account had data, instead of plotting them as 0
  const filtered = series().filter((p) => p.t >= cutoff && (!accountId || p.accounts[accountId] != null));

  if (filtered.length === 0) {
    return { points: [], pnl: 0, pnlPercent: 0, period };
  }

  const getValue = accountId
    ? (p: EquityPoint) => p.accounts[accountId] ?? 0
    : (p: EquityPoint) => p.total;

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
  changes: Record<string, { pnl: number; percent: number } | null>;
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
  const all = series();
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
  const changes: Record<string, { pnl: number; percent: number } | null> = {};

  for (const [period, seconds] of Object.entries(PERIOD_SECONDS)) {
    const cutoff = now - seconds;
    const closest = all.find((p) => p.t >= cutoff);
    if (closest) {
      const pnl = currentEquity - closest.total;
      const percent = closest.total > 0 ? (pnl / closest.total) * 100 : 0;
      changes[period] = {
        pnl: Math.round(pnl * 100) / 100,
        percent: Math.round(percent * 100) / 100,
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
