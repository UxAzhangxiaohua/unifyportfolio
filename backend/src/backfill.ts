import { metaGet, metaSet } from './db.js';
import { tradesForAccount } from './trades.js';
import { flowsForAccount } from './transfers.js';

// Equity before the first recorded sample (read-time estimate; nothing is stored as history).
//
// Per account, anchored at its first recorded sample (t0, E0):
// - native: the venue's own account-value history (Hyperliquid `portfolio`), shifted so it meets
//   E0 at t0 (it counts a few non-stable tokens the connector doesn't);
// - otherwise walked back: E(t) = E0 − Σ events in (t, t0], events = closed-trade PnL (net of fees)
//   + stablecoin deposits − withdrawals (incl. fee) + MT5 balance operations.
//   Not covered: unrealized PnL of positions open at t (taken as at t0), funding payments not in
//   the trade PnL, earn interest, and non-stablecoin transfers — so it is an estimate.
//
// An account's estimate only exists from its coverage start (the oldest point from which its trade
// and flow history is known complete; persisted markers, see coverageMark).

const DAY_MS = 86_400_000;
/** Deep back-fill depth for flows (trades use TRADES_FIRST_DAYS, MT5 its first deal query) */
export const BACKFILL_DAYS = 90;

type Kind = 'trades' | 'flows';

const coverCache = new Map<string, number | null>();

/** Oldest time (ms) from which this kind of history is complete for the account; null = unknown */
export function coverageGet(kind: Kind, accountId: string): number | null {
  const k = `cover:${kind}:${accountId}`;
  if (!coverCache.has(k)) {
    const v = metaGet(k);
    coverCache.set(k, v != null && Number.isFinite(Number(v)) ? Number(v) : null);
  }
  return coverCache.get(k)!;
}

export function coverageMark(kind: Kind, accountId: string, fromMs: number): void {
  const prev = coverageGet(kind, accountId);
  if (prev != null && prev <= fromMs) return;
  coverCache.set(`cover:${kind}:${accountId}`, fromMs);
  metaSet(`cover:${kind}:${accountId}`, String(Math.floor(fromMs)));
}

/** Venue account-value history (ms, USD), oldest first */
const native = new Map<string, Array<{ t: number; v: number }>>();

export function backfillSetNative(accountId: string, pts: Array<{ t: number; v: number }>): void {
  const list = pts.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v)).sort((a, b) => a.t - b.t);
  if (list.length >= 2) native.set(accountId, list);
}

/** MT5 balance operations (deposits / withdrawals / corrections), with the start of the queried window */
const balanceOps = new Map<string, { from: number; ops: Map<number, { t: number; amount: number }> }>();

export function backfillObserveBalanceOps(accountId: string, fromMs: number, ops: Array<{ ticket: number; time: number; amountUsd: number }>): void {
  const cur = balanceOps.get(accountId) ?? { from: fromMs, ops: new Map() };
  cur.from = Math.min(cur.from, fromMs);
  for (const o of ops) cur.ops.set(o.ticket, { t: o.time, amount: o.amountUsd });
  balanceOps.set(accountId, cur);
}

/** ms from which an account's pre-history estimate exists (null = none) */
export function estimateFrom(accountId: string): number | null {
  const nat = native.get(accountId);
  if (nat) return nat[0].t;
  const mt = balanceOps.get(accountId);
  if (mt) return mt.from;
  const a = coverageGet('trades', accountId), b = coverageGet('flows', accountId);
  return a == null || b == null ? null : Math.max(a, b);
}

export interface Estimator {
  /** ms: estimate defined from here */
  from: number;
  source: 'venue' | 'reconstructed';
  /** Estimated equity (USD) at tMs ≤ anchor */
  at(tMs: number): number;
}

function interp(list: Array<{ t: number; v: number }>, t: number): number {
  if (t <= list[0].t) return list[0].v;
  const last = list[list.length - 1];
  if (t >= last.t) return last.v;
  let lo = 0, hi = list.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (list[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = list[lo], b = list[hi];
  return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
}

/** Estimator for one account anchored at its first recorded sample (anchorMs, anchorV); null = no data */
export function estimatorFor(accountId: string, anchorMs: number, anchorV: number): Estimator | null {
  const nat = native.get(accountId);
  if (nat && nat[0].t < anchorMs) {
    const shift = anchorV - interp(nat, anchorMs);
    return { from: nat[0].t, source: 'venue', at: (t) => Math.max(0, interp(nat, t) + shift) };
  }

  const events: Array<{ t: number; d: number }> = [];
  let from: number;
  const mt = balanceOps.get(accountId);
  if (mt) {
    // MT5: the deal history query covers both trades and balance operations
    from = mt.from;
    for (const o of mt.ops.values()) events.push({ t: o.t, d: o.amount });
  } else {
    const a = coverageGet('trades', accountId), b = coverageGet('flows', accountId);
    if (a == null || b == null) return null;
    from = Math.max(a, b);
    for (const f of flowsForAccount(accountId)) {
      if (f.direction === 'in' && f.status === 'done') {
        events.push({ t: f.doneSeenAt ?? f.doneTime ?? f.time, d: f.amount });
      } else if (f.direction === 'out' && f.status !== 'failed') {
        events.push({ t: f.seenAt ?? f.time, d: -(f.amount + (f.fee || 0)) });
      }
    }
  }
  for (const tr of tradesForAccount(accountId)) {
    const t = Date.parse(tr.exitTime);
    if (Number.isFinite(t) && Number.isFinite(tr.realizedPnl)) events.push({ t, d: tr.realizedPnl });
  }

  // Only events between the coverage start and the anchor matter
  const ev = events.filter((e) => e.t > from - DAY_MS && e.t <= anchorMs).sort((x, y) => x.t - y.t);
  // suffix[i] = Σ d of ev[i..]
  const suffix = new Array<number>(ev.length + 1).fill(0);
  for (let i = ev.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + ev[i].d;
  return {
    from,
    source: 'reconstructed',
    at: (t) => {
      // first event strictly after t
      let lo = 0, hi = ev.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ev[mid].t <= t) lo = mid + 1; else hi = mid;
      }
      // Not clamped here: manual historyBackfill amounts are added on top (history.ts clamps)
      return anchorV - suffix[lo];
    },
  };
}
