import type { AccountSnapshot, ClosedTrade, ExchangeType, Position } from './types.js';
import { tradesDbDelete, tradesDbLoad, tradesDbUpsert } from './db.js';
import { coverageGet, coverageMark } from './backfill.js';
import { guessCategory } from './categories.js';

// Closed trades, persisted to SQLite so period stats (24h / 3d / 7d / 30d) survive restarts.
//
// - MT5: built from the broker's deal history (tradesObserveMt5, called by the MT5 connector):
//   one trade per closing deal (partial closes are separate trades), exact price, net PnL incl.
//   commission + swap.
// - Crypto venues: the venue's own closed-position / fill history (connector.fetchClosedTrades,
//   polled by the scheduler every few minutes → tradesObserveVenue), upserted by a stable id.
// - Fallback: inferred from position changes between snapshots (trackSnapshot) for accounts
//   whose venue history isn't available. The exit price is the last polled price, so PnL is
//   approximate and fees are not included. Once an account delivers venue history, its inferred
//   trades are dropped and inference stops for it.

const KEEP_MS = 400 * 86_400_000;
const MAX_TRADES = 20_000;

/** Newest first */
let trades: ClosedTrade[] = [];
const tradeIds = new Set<string>();

function addTrade(trade: ClosedTrade): void {
  if (tradeIds.has(trade.id)) return;
  tradeIds.add(trade.id);
  insertSorted(trade);
  tradesDbUpsert(trade.id, Date.parse(trade.exitTime), trade);
}

/** Insert or replace (venue records can be revised, e.g. an order that keeps filling) */
function upsertTrade(trade: ClosedTrade): void {
  if (tradeIds.has(trade.id)) {
    const i = trades.findIndex((t) => t.id === trade.id);
    if (i >= 0 && JSON.stringify(trades[i]) === JSON.stringify(trade)) return;
    if (i >= 0) trades.splice(i, 1);
  }
  tradeIds.add(trade.id);
  insertSorted(trade);
  tradesDbUpsert(trade.id, Date.parse(trade.exitTime), trade);
}

function insertSorted(trade: ClosedTrade): void {
  const exitMs = Date.parse(trade.exitTime);
  // Keep newest first (venue deals may arrive out of order on the first back-fill)
  let i = 0;
  while (i < trades.length && Date.parse(trades[i].exitTime) > exitMs) i++;
  trades.splice(i, 0, trade);
  if (trades.length > MAX_TRADES) tradeIds.delete(trades.pop()!.id);
}

export function tradesInit(): void {
  for (const t of tradesDbLoad<ClosedTrade>(Date.now() - KEEP_MS)) {
    if (tradeIds.has(t.id)) continue;
    tradeIds.add(t.id);
    trades.push(normalize(t));
  }
  if (trades.length > MAX_TRADES) trades = trades.slice(0, MAX_TRADES);
  if (trades.length) console.log(`[trades] loaded ${trades.length} closed trade(s)`);
}

/** Rows stored by earlier versions: no / old category ('commodity' → 'xau'), TP/SL fields */
function normalize(t: ClosedTrade & { exitReason?: unknown; plan?: unknown; rMultiple?: unknown; category?: string }): ClosedTrade {
  const { exitReason: _r, plan: _p, rMultiple: _m, ...rest } = t;
  const category = (rest.category as string) === 'commodity' ? 'xau' : rest.category;
  return { ...rest, category: (category as ClosedTrade['category']) ?? guessCategory(rest.symbol, rest.exchange === 'mt5' ? 'cfd' : undefined) };
}

// ---------------------------------------------------------------------------------------------
// MT5: broker deal history

export interface Mt5Deal {
  ticket: number;
  order: number;
  position: number;
  symbol: string;
  entry: 'in' | 'out';
  side: 'buy' | 'sell';
  volume: number;
  price: number;
  profitUsd: number;
  feesUsd: number;
  comment: string;
  time: number; // ms
}

export interface Mt5OpenPosition {
  ticket: number;
  side: 'long' | 'short';
  openPrice: number;
}

/** Accounts whose trades come from deal history (inference is skipped for them) */
const dealAccounts = new Set<string>();
/** Opening deals per position: VWAP entry, first time, opening fees (USD) */
const entries = new Map<string, { price: number; volume: number; time: number; side: 'long' | 'short'; fees: number }>();
/** Opening deals already folded into `entries` (the history window is re-read every poll) */
const seenIn = new Set<string>();
/** Open positions seen while polling: entry fallback when the opening deal is older than the window */
const openSeen = new Map<string, { side: 'long' | 'short'; openPrice: number; firstSeen: number }>();
const posKeyOf = (accountId: string, ticket: number) => `${accountId}:${ticket}`;

/**
 * @param positions open positions of this poll
 * @param deals trading deals of the queried window, or null when the history wasn't available
 */
export function tradesObserveMt5(
  accountId: string, exchange: ExchangeType, positions: Mt5OpenPosition[], deals: Mt5Deal[] | null,
): void {
  const now = Date.now();
  for (const p of positions) {
    const k = posKeyOf(accountId, p.ticket);
    if (!openSeen.has(k)) openSeen.set(k, { side: p.side, openPrice: p.openPrice, firstSeen: now });
  }

  if (!deals) return;
  dealAccounts.add(accountId);

  const sorted = [...deals].sort((a, b) => a.time - b.time || a.ticket - b.ticket);
  for (const d of sorted) {
    const pk = posKeyOf(accountId, d.position);
    if (d.entry === 'in') {
      const side = d.side === 'buy' ? 'long' : 'short';
      const e = entries.get(pk);
      if (!e) entries.set(pk, { price: d.price, volume: d.volume, time: d.time, side, fees: d.feesUsd });
      else if (!seenIn.has(`${pk}:${d.ticket}`)) {
        // Adding to the position: volume-weighted entry
        const vol = e.volume + d.volume;
        entries.set(pk, { ...e, price: (e.price * e.volume + d.price * d.volume) / vol, volume: vol, fees: e.fees + d.feesUsd });
      }
      seenIn.add(`${pk}:${d.ticket}`);
      continue;
    }

    const id = `${accountId}:deal:${d.ticket}`;
    if (tradeIds.has(id)) continue;
    const e = entries.get(pk);
    const o = openSeen.get(pk);
    // Entry deal older than the queried window: fall back to the position's open price
    // Unknown when the opening deal is older than the window and the position was never seen open
    // here: the trade is still recorded (its PnL comes from the deal), without entry price / time
    const ep = e?.price ?? o?.openPrice;
    const entryPrice = ep && ep > 0 ? ep : null;
    // Closing a long is a sell
    const side: 'long' | 'short' = e?.side ?? o?.side ?? (d.side === 'sell' ? 'long' : 'short');
    const entryTime = e?.time ?? o?.firstSeen ?? null;
    // Opening fees, pro rata to the closed volume
    const entryFees = e && e.volume > 0 ? e.fees * Math.min(1, d.volume / e.volume) : 0;
    const fees = d.feesUsd + entryFees;
    const priceDiff = entryPrice == null ? 0 : side === 'long' ? d.price - entryPrice : entryPrice - d.price;

    addTrade({
      id,
      accountId,
      exchange,
      symbol: d.symbol,
      side,
      entryPrice,
      exitPrice: d.price,
      quantity: d.volume,
      realizedPnl: d.profitUsd + fees,
      pnlPercent: entryPrice == null ? 0 : (priceDiff / entryPrice) * 100,
      entryTime: entryTime == null ? null : new Date(entryTime).toISOString(),
      exitTime: new Date(d.time).toISOString(),
      durationSeconds: entryTime == null ? null : Math.max(0, Math.floor((d.time - entryTime) / 1000)),
      category: guessCategory(d.symbol, 'cfd'),
      source: 'venue',
      fees,
    });
  }

  // Positions no longer open don't need their fallback after their close is recorded
  const open = new Set(positions.map((p) => posKeyOf(accountId, p.ticket)));
  for (const [k, v] of openSeen) if (k.startsWith(`${accountId}:`) && !open.has(k) && now - v.firstSeen > 7 * 86_400_000) openSeen.delete(k);
}

// ---------------------------------------------------------------------------------------------
// Crypto venues: closed-trade history from the venue

/** Accounts whose venue history has been loaded in this process */
const venuePrimed = new Set<string>();

/** Start of the window the next fetchClosedTrades() for this account should cover */
/** How far back the first venue query reaches (also the start of the equity backfill) */
export const TRADES_FIRST_DAYS = 90;

export function tradesSince(accountId: string, now = Date.now()): number {
  if (venuePrimed.has(accountId)) return now - 3 * 86_400_000;
  // Never fully read yet: the whole window (the equity backfill relies on complete history)
  if (coverageGet('trades', accountId) == null) return now - TRADES_FIRST_DAYS * 86_400_000;
  // After a restart: from shortly before the newest stored venue trade, so downtime is covered
  // without re-reading 90 days every time
  const last = trades.find((t) => t.accountId === accountId && t.source === 'venue');
  const lastMs = last ? Date.parse(last.exitTime) : 0;
  return Math.max(now - TRADES_FIRST_DAYS * 86_400_000, lastMs ? lastMs - 2 * 86_400_000 : 0);
}

/** @param sinceMs start of the queried window (marks the account's history as complete from there) */
export function tradesObserveVenue(accountId: string, list: ClosedTrade[], sinceMs?: number): void {
  if (!venuePrimed.has(accountId)) {
    venuePrimed.add(accountId);
    dealAccounts.add(accountId);
    // Exact history replaces the approximations made before
    const inferred = trades.filter((t) => t.accountId === accountId && t.source !== 'venue');
    if (inferred.length) {
      trades = trades.filter((t) => !(t.accountId === accountId && t.source !== 'venue'));
      for (const t of inferred) { tradeIds.delete(t.id); tradesDbDelete(t.id); }
      console.log(`[trades] ${accountId}: replaced ${inferred.length} inferred trade(s) with venue history`);
    }
  }
  for (const t of list) {
    if (!(Number.isFinite(t.realizedPnl) && Date.parse(t.exitTime) > 0)) continue;
    // Venue records only grow (more fills of the same order, more partial closes of the same
    // position). A smaller one means the query window started after the order's first fills:
    // keep the complete stored record instead of overwriting it with that fragment.
    if (tradeIds.has(t.id)) {
      const prev = trades.find((x) => x.id === t.id);
      if (prev && t.quantity < prev.quantity * (1 - 1e-9)) continue;
    }
    upsertTrade(normalize(t));
  }
  if (sinceMs != null) coverageMark('trades', accountId, sinceMs);
}

/** All kept trades of one account (newest first) */
export function tradesForAccount(accountId: string): ClosedTrade[] {
  return trades.filter((t) => t.accountId === accountId);
}

// ---------------------------------------------------------------------------------------------
// Other venues: inferred from position changes

interface TrackedPosition {
  accountId: string;
  exchange: ExchangeType;
  symbol: string;
  side: 'long' | 'short';
  quantity: number;
  avgPrice: number;
  lastPrice: number;
  /** PnL per (Δprice × quantity): 1 for coins/shares; contract size for CFD lots */
  mult: number;
  firstSeen: string;
  assetClass: Position['assetClass'];
}

const tracked = new Map<string, TrackedPosition>();

function posKey(accountId: string, symbol: string, side: string): string {
  return `${accountId}:${symbol}:${side}`;
}

/**
 * One entry per account + symbol + side: MT5 (hedging) accounts can hold several orders on the
 * same symbol and side; tracked separately they would overwrite each other every cycle.
 * Merged = Σ quantity, quantity-weighted avg entry, Σ notional.
 */
function aggregate(positions: Position[]): Array<Position & { side: 'long' | 'short'; mult: number }> {
  const groups = new Map<string, Position[]>();
  for (const p of positions) {
    if (p.side === 'flat' || p.quantity === 0) continue;
    const k = `${p.symbol}:${p.side}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  return [...groups.values()].map((g) => {
    const quantity = g.reduce((s, p) => s + p.quantity, 0);
    const avgPrice = quantity > 0 ? g.reduce((s, p) => s + p.avgPrice * p.quantity, 0) / quantity : g[0].avgPrice;
    const marketValue = g.reduce((s, p) => s + p.marketValue, 0);
    // CFD quantity is in lots: derive units per lot from notional (USD) ÷ (lots × price).
    // NaN = unknown this cycle (no price / notional): the caller keeps the last known value.
    const price = g[0].currentPrice;
    const m = g[0].assetClass !== 'cfd' ? 1 : quantity > 0 && price > 0 && marketValue > 0 ? marketValue / (quantity * price) : NaN;
    return { ...g[0], side: g[0].side as 'long' | 'short', quantity, avgPrice, marketValue, mult: Number.isFinite(m) && m > 0 ? m : NaN };
  });
}

function inferredTrade(key: string, t: Omit<ClosedTrade, 'id' | 'realizedPnl' | 'pnlPercent' | 'durationSeconds' | 'source'>, mult: number): ClosedTrade {
  t = { ...t, category: t.category ?? guessCategory(t.symbol) };
  const entry = t.entryPrice ?? 0;
  const priceDiff = t.side === 'long' ? t.exitPrice - entry : entry - t.exitPrice;
  return {
    ...t,
    id: `${key}:${Date.now()}`,
    realizedPnl: priceDiff * t.quantity * mult,
    pnlPercent: entry !== 0 ? (priceDiff / entry) * 100 : 0,
    durationSeconds: t.entryTime ? Math.floor((Date.parse(t.exitTime) - Date.parse(t.entryTime)) / 1000) : null,
    source: 'inferred',
  };
}

export function trackSnapshot(snapshot: AccountSnapshot): void {
  if (snapshot.error) return;
  // Exact trades come from the deal history for these
  if (dealAccounts.has(snapshot.accountId)) return;

  const now = new Date().toISOString();
  const currentKeys = new Set<string>();

  for (const pos of aggregate(snapshot.positions)) {
    const key = posKey(snapshot.accountId, pos.symbol, pos.side);
    currentKeys.add(key);

    const existing = tracked.get(key);

    if (!existing) {
      tracked.set(key, {
        accountId: snapshot.accountId,
        exchange: snapshot.exchange,
        symbol: pos.symbol,
        side: pos.side,
        quantity: pos.quantity,
        avgPrice: pos.avgPrice,
        lastPrice: pos.currentPrice > 0 ? pos.currentPrice : 0,
        mult: pos.mult,
        firstSeen: now,
        assetClass: pos.assetClass,
      });
    } else {
      // A cycle without a usable price (no quote) must not become the exit price or the multiplier
      const price = pos.currentPrice > 0 ? pos.currentPrice : existing.lastPrice;
      const mult = Number.isFinite(pos.mult) ? pos.mult : existing.mult;
      if (pos.quantity < existing.quantity && price > 0 && Number.isFinite(mult)) {
        // Partial close
        addTrade(inferredTrade(key, {
          accountId: snapshot.accountId, exchange: snapshot.exchange, symbol: pos.symbol, side: pos.side,
          entryPrice: existing.avgPrice, exitPrice: price, quantity: existing.quantity - pos.quantity,
          entryTime: existing.firstSeen, exitTime: now, category: guessCategory(pos.symbol, pos.assetClass),
        }, mult));
      }
      existing.quantity = pos.quantity;
      existing.avgPrice = pos.avgPrice;
      existing.lastPrice = price;
      existing.mult = mult;
    }
  }

  // Detect fully closed positions
  for (const [key, tp] of tracked) {
    if (tp.accountId !== snapshot.accountId) continue;
    if (currentKeys.has(key)) continue;
    tracked.delete(key);
    // Never saw a usable price / multiplier: the PnL would be fiction, so don't record a trade
    if (!(tp.lastPrice > 0) || !Number.isFinite(tp.mult)) continue;
    addTrade(inferredTrade(key, {
      accountId: tp.accountId, exchange: tp.exchange, symbol: tp.symbol, side: tp.side,
      entryPrice: tp.avgPrice, exitPrice: tp.lastPrice, quantity: tp.quantity,
      entryTime: tp.firstSeen, exitTime: now, category: guessCategory(tp.symbol, tp.assetClass),
    }, tp.mult));
  }
}

// ---------------------------------------------------------------------------------------------

/** Trades closed within the last `days` (all kept trades when omitted), newest first */
export function tradesGet(days?: number): { trades: ClosedTrade[] } {
  const cutoff = days && days > 0 ? Date.now() - days * 86_400_000 : 0;
  const list = cutoff ? trades.filter((t) => Date.parse(t.exitTime) >= cutoff) : trades;
  return { trades: list };
}
