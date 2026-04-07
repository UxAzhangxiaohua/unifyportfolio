import type { AccountSnapshot } from './types.js';

interface EquityPoint {
  t: number; // unix seconds
  total: number;
  accounts: Record<string, number>;
}

const MAX_POINTS = 25_000; // ~8.5 days at 30s intervals
const points: EquityPoint[] = [];

export function historyRecord(accounts: AccountSnapshot[]): void {
  if (accounts.length === 0) return;

  const total = accounts.reduce((s, a) => s + a.equity, 0);
  const accts: Record<string, number> = {};
  for (const a of accounts) {
    accts[a.accountId] = a.equity;
  }
  points.push({ t: Math.floor(Date.now() / 1000), total, accounts: accts });

  if (points.length > MAX_POINTS) {
    points.splice(0, points.length - MAX_POINTS);
  }
}

const PERIOD_SECONDS: Record<string, number> = {
  '1h': 3600,
  '4h': 4 * 3600,
  '24h': 24 * 3600,
  '1w': 7 * 24 * 3600,
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

  const filtered = points.filter((p) => p.t >= cutoff);

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

function downsample(data: EquityPoint[], target: number): EquityPoint[] {
  const step = Math.ceil(data.length / target);
  const result: EquityPoint[] = [];
  for (let i = 0; i < data.length; i += step) {
    result.push(data[i]);
  }
  if (result[result.length - 1] !== data[data.length - 1]) {
    result.push(data[data.length - 1]);
  }
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

  if (points.length < 2) return empty;

  const currentEquity = points[points.length - 1].total;

  // Returns between consecutive points
  const returns: number[] = [];
  for (let i = 1; i < points.length; i++) {
    if (points[i - 1].total > 0) {
      returns.push(
        (points[i].total - points[i - 1].total) / points[i - 1].total,
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
  let peak = points[0].total;
  let maxDD = 0;
  for (const p of points) {
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
    const closest = points.find((p) => p.t >= cutoff);
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
): void {
  // First sample after initial data arrives
  setTimeout(() => {
    historyRecord(getCachedAccounts());
  }, 5000);

  setInterval(() => {
    historyRecord(getCachedAccounts());
  }, intervalMs);
}
