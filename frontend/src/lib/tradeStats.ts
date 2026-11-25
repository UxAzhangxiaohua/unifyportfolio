import type { ClosedTrade } from '../types';
import { baseSymbol } from './exposure';

/** Group key for per-instrument stats: XAUUSDm → XAUUSD, BTCUSDT / BTC-USDT-SWAP → BTC */
export function instrumentKey(t: ClosedTrade): string {
  if (t.exchange === 'mt5') return t.symbol.replace(/\.[A-Za-z0-9]+$/, '').replace(/[a-z]+$/, '') || t.symbol;
  return baseSymbol(t.symbol);
}

export interface Summary {
  n: number;
  wins: number;
  losses: number;
  winRate: number | null;
  pnl: number;
  grossWin: number;
  grossLoss: number;
  avgWin: number | null;
  avgLoss: number | null;
  /** avg win ÷ |avg loss| */
  payoff: number | null;
  /** gross win ÷ |gross loss| */
  profitFactor: number | null;
  expectancy: number | null;
  fees: number;
}

export function summarize(trades: ClosedTrade[]): Summary {
  let wins = 0, losses = 0, grossWin = 0, grossLoss = 0, fees = 0;
  for (const t of trades) {
    if (t.realizedPnl > 0) { wins++; grossWin += t.realizedPnl; }
    else if (t.realizedPnl < 0) { losses++; grossLoss += t.realizedPnl; }
    fees += t.fees ?? 0;
  }
  const n = trades.length;
  const decided = wins + losses;
  const avgWin = wins ? grossWin / wins : null;
  const avgLoss = losses ? grossLoss / losses : null;
  return {
    n, wins, losses,
    winRate: decided ? (wins / decided) * 100 : null,
    pnl: grossWin + grossLoss,
    grossWin, grossLoss, avgWin, avgLoss,
    payoff: avgWin != null && avgLoss ? avgWin / Math.abs(avgLoss) : null,
    profitFactor: grossLoss ? grossWin / Math.abs(grossLoss) : null,
    expectancy: n ? (grossWin + grossLoss) / n : null,
    fees,
  };
}
