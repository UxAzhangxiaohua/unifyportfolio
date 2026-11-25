import type { ClosedTrade } from '../types';
import { baseSymbol } from './exposure';

// Commodity contracts on different venues → one row: MT5 XAUUSD, XAUUSDT perp (→ XAU), XAUT, PAXG
const COMMODITY_ALIASES: Record<string, string> = {
  XAUUSD: 'XAU', XAUT: 'XAU', PAXG: 'XAU', GOLD: 'XAU',
  XAGUSD: 'XAG', SILVER: 'XAG',
  USOIL: 'WTI', XTIUSD: 'WTI', CL: 'WTI', UKOIL: 'BRENT', XBRUSD: 'BRENT',
};

/** Group key for per-instrument stats: BTCUSDT / BTC-USDT-SWAP → BTC, options → underlying, commodities merged across venues (MT5 XAUUSDm + XAUUSDT perp + XAUT → XAU) */
export function instrumentKey(t: ClosedTrade): string {
  const k = rawInstrumentKey(t);
  return t.category === 'xau' ? COMMODITY_ALIASES[k] ?? k : k;
}

function rawInstrumentKey(t: ClosedTrade): string {
  if (t.exchange === 'mt5') return t.symbol.replace(/\.[A-Za-z0-9]+$/, '').replace(/[a-z]+$/, '').toUpperCase() || t.symbol;
  // Options: one group per underlying (BTC17NOV2665000P, BTC-USD-251128-90000-C → BTC)
  if (t.category === 'option') return t.symbol.toUpperCase().match(/^[A-Z]+/)?.[0] ?? t.symbol;
  // Scaled meme contracts: Binance 1000PEPE, Hyperliquid kPEPE → PEPE
  const raw = t.exchange === 'hyperliquid' ? t.symbol.replace(/^k(?=[A-Z])/, '') : t.symbol;
  return baseSymbol(raw).replace(/^1000+(?=[A-Z])/, '');
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
