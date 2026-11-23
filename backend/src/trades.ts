import type { AccountSnapshot, ClosedTrade, ExchangeType, Position } from './types.js';

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
}

const tracked = new Map<string, TrackedPosition>();
const trades: ClosedTrade[] = [];
const MAX_TRADES = 500;

function posKey(accountId: string, symbol: string, side: string): string {
  return `${accountId}:${symbol}:${side}`;
}

function addTrade(trade: ClosedTrade): void {
  trades.unshift(trade);
  if (trades.length > MAX_TRADES) trades.pop();
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

export function trackSnapshot(snapshot: AccountSnapshot): void {
  if (snapshot.error) return;

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
      });
    } else {
      // A cycle without a usable price (no quote) must not become the exit price or the multiplier
      const price = pos.currentPrice > 0 ? pos.currentPrice : existing.lastPrice;
      const mult = Number.isFinite(pos.mult) ? pos.mult : existing.mult;
      if (pos.quantity < existing.quantity && price > 0 && Number.isFinite(mult)) {
        // Partial close
        const closedQty = existing.quantity - pos.quantity;
        const priceDiff = pos.side === 'long' ? price - existing.avgPrice : existing.avgPrice - price;
        const realizedPnl = priceDiff * closedQty * mult;
        const pnlPercent = existing.avgPrice !== 0 ? (priceDiff / existing.avgPrice) * 100 : 0;
        const durationSeconds = Math.floor((Date.now() - new Date(existing.firstSeen).getTime()) / 1000);

        addTrade({
          id: `${key}:${Date.now()}`,
          accountId: snapshot.accountId,
          exchange: snapshot.exchange,
          symbol: pos.symbol,
          side: pos.side,
          entryPrice: existing.avgPrice,
          exitPrice: price,
          quantity: closedQty,
          realizedPnl,
          pnlPercent,
          entryTime: existing.firstSeen,
          exitTime: now,
          durationSeconds,
        });
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

    const priceDiff =
      tp.side === 'long' ? tp.lastPrice - tp.avgPrice : tp.avgPrice - tp.lastPrice;
    const realizedPnl = priceDiff * tp.quantity * tp.mult;
    const pnlPercent = tp.avgPrice !== 0 ? (priceDiff / tp.avgPrice) * 100 : 0;
    const durationSeconds = Math.floor((Date.now() - new Date(tp.firstSeen).getTime()) / 1000);

    addTrade({
      id: `${key}:${Date.now()}`,
      accountId: tp.accountId,
      exchange: tp.exchange,
      symbol: tp.symbol,
      side: tp.side,
      entryPrice: tp.avgPrice,
      exitPrice: tp.lastPrice,
      quantity: tp.quantity,
      realizedPnl,
      pnlPercent,
      entryTime: tp.firstSeen,
      exitTime: new Date().toISOString(),
      durationSeconds,
    });
  }
}

export function tradesGet(): {
  trades: ClosedTrade[];
  summary: { totalTrades: number; wins: number; losses: number; winRate: number; totalRealizedPnl: number };
} {
  const wins = trades.filter((t) => t.realizedPnl > 0).length;
  const losses = trades.filter((t) => t.realizedPnl < 0).length;
  const totalPnl = trades.reduce((s, t) => s + t.realizedPnl, 0);

  return {
    trades,
    summary: {
      totalTrades: trades.length,
      wins,
      losses,
      winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
      totalRealizedPnl: totalPnl,
    },
  };
}
