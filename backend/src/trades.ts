import type { AccountSnapshot, ClosedTrade, ExchangeType } from './types.js';

interface TrackedPosition {
  accountId: string;
  exchange: ExchangeType;
  symbol: string;
  side: 'long' | 'short';
  quantity: number;
  avgPrice: number;
  lastPrice: number;
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

export function trackSnapshot(snapshot: AccountSnapshot): void {
  if (snapshot.error) return;

  const now = new Date().toISOString();
  const currentKeys = new Set<string>();

  for (const pos of snapshot.positions) {
    if (pos.side === 'flat' || pos.quantity === 0) continue;

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
        lastPrice: pos.currentPrice,
        firstSeen: now,
      });
    } else if (pos.quantity < existing.quantity) {
      // Partial close
      const closedQty = existing.quantity - pos.quantity;
      const priceDiff =
        pos.side === 'long'
          ? pos.currentPrice - existing.avgPrice
          : existing.avgPrice - pos.currentPrice;
      const realizedPnl = priceDiff * closedQty;
      const pnlPercent = existing.avgPrice !== 0 ? (priceDiff / existing.avgPrice) * 100 : 0;
      const durationSeconds = Math.floor((Date.now() - new Date(existing.firstSeen).getTime()) / 1000);

      addTrade({
        id: `${key}:${Date.now()}`,
        accountId: snapshot.accountId,
        exchange: snapshot.exchange,
        symbol: pos.symbol,
        side: pos.side,
        entryPrice: existing.avgPrice,
        exitPrice: pos.currentPrice,
        quantity: closedQty,
        realizedPnl,
        pnlPercent,
        entryTime: existing.firstSeen,
        exitTime: now,
        durationSeconds,
      });

      existing.quantity = pos.quantity;
      existing.avgPrice = pos.avgPrice;
      existing.lastPrice = pos.currentPrice;
    } else {
      existing.quantity = pos.quantity;
      existing.avgPrice = pos.avgPrice;
      existing.lastPrice = pos.currentPrice;
    }
  }

  // Detect fully closed positions
  for (const [key, tp] of tracked) {
    if (tp.accountId !== snapshot.accountId) continue;
    if (currentKeys.has(key)) continue;

    const priceDiff =
      tp.side === 'long' ? tp.lastPrice - tp.avgPrice : tp.avgPrice - tp.lastPrice;
    const realizedPnl = priceDiff * tp.quantity;
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

    tracked.delete(key);
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
