import type { FundFlow, TransferView, TransfersResponse } from './types.js';
import { flowsDbLoad, flowsDbUpsert } from './db.js';

// Internal-transfer bridging.
//
// Moving stablecoins between two tracked accounts makes the total dip while the funds are on-chain
// (source already debited, destination not yet credited). Each connector reports its deposit /
// withdrawal records alongside every balance snapshot; here a withdrawal is paired with the deposit
// it became at another tracked account (same tx hash, else same coin + amount within the fee
// tolerance + plausible timing), and the total is lifted by the in-transit amount between the
// moment we *observed* the debit and the moment we *observed* the credit. Using observation times
// (not venue timestamps) keeps the bridge aligned with the balances the sampler actually saw.
//
// Raw equity is stored unchanged; the adjustment is applied when history is read, so a pairing
// found later (or a withdrawal later recognised as external) corrects the past curve too.
// The fee is a real cost and remains as a small step.

interface StoredFlow extends FundFlow {
  accountId: string;
  /** ms: out = debit observed; in = unused (see doneSeenAt) */
  seenAt: number;
  /** ms: in = credit observed (status done) */
  doneSeenAt: number | null;
  /** ms: out = refund observed (failed / cancelled after being debited) */
  failedSeenAt: number | null;
}

/** Initial lookback, then a short rolling window per poll */
const FIRST_LOOKBACK_MS = 30 * 86_400_000;
const ROLLING_LOOKBACK_MS = 3 * 86_400_000;
/** Max time between a withdrawal and the deposit it pairs with */
const MATCH_WINDOW_MS = 48 * 3_600_000;
/** An unpaired withdrawal to one of our exchange deposit addresses counts as in transit for at most this long */
const TRANSIT_MAX_MS = 24 * 3_600_000;
/**
 * Same for an address that is only a self-custody wallet (e.g. the Hyperliquid wallet): funds there
 * often stay or get spent, so they would inflate the total for a whole day before dropping out.
 * Onward transfers from it to an exchange normally follow within minutes.
 */
const WALLET_TRANSIT_MAX_MS = 2 * 3_600_000;
/** Deposits may be timestamped slightly before the withdrawal on another venue's clock */
const CLOCK_SKEW_MS = 10 * 60_000;
const LIST_DAYS_MS = 14 * 86_400_000;

const flows = new Map<string, StoredFlow>();
/** Accounts whose first flow load in this process has completed */
const primed = new Set<string>();
let ownAddresses = new Set<string>();
let labels: Record<string, string> = {};
let version = 0;

const keyOf = (accountId: string, id: string) => `${accountId}|${id}`;

export function transfersInit(opts: { ownAddresses: string[]; labels: Record<string, string> }): void {
  ownAddresses = new Set(opts.ownAddresses.map((a) => a.toLowerCase()));
  labels = opts.labels;
  for (const f of flowsDbLoad<StoredFlow>()) flows.set(keyOf(f.accountId, f.id), f);
  if (flows.size) console.log(`[transfers] loaded ${flows.size} deposit/withdrawal record(s)`);
}

/** Start of the window the next flow query for this account should cover */
export function transfersSince(accountId: string, now = Date.now()): number {
  return now - (primed.has(accountId) ? ROLLING_LOOKBACK_MS : FIRST_LOOKBACK_MS);
}

/**
 * Record the flows reported together with an account's balance snapshot.
 * Records first seen on this process's first load (i.e. that happened while we weren't watching)
 * get venue timestamps; anything appearing later gets the observation time.
 */
export function transfersObserve(accountId: string, list: FundFlow[], now = Date.now()): void {
  const first = !primed.has(accountId);
  primed.add(accountId);
  for (const f of list) {
    if (!(f.amount > 0)) continue;
    const key = keyOf(accountId, f.id);
    const prev = flows.get(key);
    const rec: StoredFlow = prev
      ? { ...prev, ...f, accountId, seenAt: prev.seenAt, doneSeenAt: prev.doneSeenAt, failedSeenAt: prev.failedSeenAt }
      : { ...f, accountId, seenAt: first ? f.time : now, doneSeenAt: null, failedSeenAt: null };
    const venueDone = f.doneTime ?? f.time;
    if (f.status === 'done' && rec.doneSeenAt == null) rec.doneSeenAt = first && !prev ? venueDone : now;
    if (f.status === 'failed' && rec.failedSeenAt == null) rec.failedSeenAt = first && !prev ? venueDone : now;
    if (!prev || JSON.stringify(prev) !== JSON.stringify(rec)) {
      flows.set(key, rec);
      flowsDbUpsert(key, rec);
      version++;
    }
  }
}

interface Built {
  views: TransferView[];
  /** Step function: total adjustment = Σ delta of events with t ≤ sample time (ms) */
  events: Array<{ t: number; delta: number }>;
  prefix: number[];
}
let cache: { version: number; minute: number; built: Built } | null = null;

function build(now: number): Built {
  const minute = Math.floor(now / 60_000);
  if (cache && cache.version === version && cache.minute === minute) return cache.built;

  const all = [...flows.values()];
  const outs = all.filter((f) => f.direction === 'out').sort((a, b) => a.time - b.time);
  const ins = all.filter((f) => f.direction === 'in' && f.doneSeenAt != null).sort((a, b) => a.time - b.time);
  // Exchange deposit addresses we have received funds at (a credit there is observable)
  const depositAddrs = new Set<string>();
  for (const f of all) if (f.direction === 'in' && f.address) depositAddrs.add(f.address);

  const used = new Set<StoredFlow>();
  const views: TransferView[] = [];
  const events: Built['events'] = [];

  for (const o of outs) {
    const base = { id: `${o.accountId}|${o.id}`, coin: o.coin, fee: o.fee, fromAccount: o.accountId, network: o.network, startedAt: o.time };

    if (o.status === 'failed') {
      // Debited then refunded: bridge the gap so the refund doesn't look like a dip + recovery
      if (o.failedSeenAt != null && o.failedSeenAt > o.seenAt) {
        events.push({ t: o.seenAt, delta: o.amount + o.fee }, { t: o.failedSeenAt, delta: -(o.amount + o.fee) });
      }
      views.push({ ...base, state: 'failed', amount: o.amount, toAccount: null, arrivedAt: null });
      continue;
    }

    const tol = Math.max(0.05, o.amount * 0.003);
    const candidates = ins.filter((i) => !used.has(i) && i.accountId !== o.accountId && i.coin === o.coin);
    const match =
      (o.txId && candidates.find((i) => i.txId === o.txId)) ||
      candidates.find((i) =>
        i.time >= o.time - CLOCK_SKEW_MS && i.time - o.time <= MATCH_WINDOW_MS &&
        i.amount >= o.amount - o.fee - tol && i.amount <= o.amount + tol);

    if (match) {
      used.add(match);
      // +amount from debit to credit. If the credit was observed first (destination polled before
      // source), the same pair gives −amount over [credit, debit) and cancels the double count.
      events.push({ t: o.seenAt, delta: match.amount }, { t: match.doneSeenAt!, delta: -match.amount });
      views.push({ ...base, state: 'completed', amount: match.amount, toAccount: match.accountId, arrivedAt: match.doneTime ?? match.time });
      continue;
    }

    const toDeposit = !!o.address && depositAddrs.has(o.address);
    const toWallet = !toDeposit && !!o.address && ownAddresses.has(o.address);
    const maxMs = toDeposit ? TRANSIT_MAX_MS : toWallet ? WALLET_TRANSIT_MAX_MS : 0;
    if (now - o.seenAt < maxMs) {
      events.push({ t: o.seenAt, delta: o.amount });
      views.push({ ...base, state: 'in_transit', amount: o.amount, toAccount: null, arrivedAt: null });
    } else {
      views.push({ ...base, state: 'external_out', amount: o.amount, toAccount: null, arrivedAt: null });
    }
  }

  for (const i of ins) {
    if (used.has(i)) continue;
    views.push({
      id: `${i.accountId}|${i.id}`, state: 'external_in', coin: i.coin, amount: i.amount, fee: 0,
      fromAccount: null, toAccount: i.accountId, network: i.network, startedAt: i.doneTime ?? i.time, arrivedAt: i.doneTime ?? i.time,
    });
  }

  events.sort((a, b) => a.t - b.t);
  const prefix: number[] = [];
  let run = 0;
  for (const e of events) prefix.push((run += e.delta));
  views.sort((a, b) => b.startedAt - a.startedAt);
  const built = { views, events, prefix };
  cache = { version, minute, built };
  return built;
}

/** USD to add to the raw total at time `tMs` (funds in transit between tracked accounts) */
export function transitAt(tMs: number, now = Date.now()): number {
  const { events, prefix } = build(now);
  // last event with t ≤ tMs
  let lo = 0, hi = events.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].t <= tMs) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const v = idx < 0 ? 0 : prefix[idx];
  return Math.abs(v) < 1e-6 ? 0 : v;
}

/** Returns a function giving the adjustment for many timestamps (seconds) at once */
export function transitAdjuster(now = Date.now()): (tSec: number) => number {
  build(now);
  return (tSec) => transitAt(tSec * 1000, now);
}

export function transfersGet(now = Date.now()): TransfersResponse {
  const { views } = build(now);
  const label = (id: string | null) => (id ? labels[id] ?? id : null);
  return {
    inTransit: transitAt(now, now),
    transfers: views
      .filter((v) => now - v.startedAt < LIST_DAYS_MS)
      .slice(0, 100)
      .map((v) => ({ ...v, fromAccount: label(v.fromAccount), toAccount: label(v.toAccount) })),
  };
}
