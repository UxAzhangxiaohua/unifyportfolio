import type { AccountSnapshot, Position } from '../types';

// Effective exposure of a derivatives position.
// Perps on leveraged ETFs carry the fund's leverage: 1 SOXS (−3x semis) short = +3x semis long.
// exposure = |notional| × |ETF leverage|, direction = position side × sign(ETF leverage).

export interface LeveragedEtf {
  /** Daily leverage target; negative = inverse fund */
  lev: number;
  /** What it tracks */
  underlying: string;
}

export const LEVERAGED_ETFS: Record<string, LeveragedEtf> = {
  SOXL: { lev: 3, underlying: 'Semis (SOX)' },
  SOXS: { lev: -3, underlying: 'Semis (SOX)' },
  TQQQ: { lev: 3, underlying: 'Nasdaq-100' },
  SQQQ: { lev: -3, underlying: 'Nasdaq-100' },
  SNXX: { lev: 2, underlying: 'SNDK' },
  MUU: { lev: 2, underlying: 'MU' },
  KORU: { lev: 3, underlying: 'MSCI Korea' },
};

/**
 * Venue symbol → base ticker: SOXSUSDT, SOXS-USDT-SWAP, xyz:SOXS, SOXS_USDT, SOXSPERP → SOXS.
 * Dated-futures suffixes (BTCUSDT-27DEC24, BTC-USD-250328) are kept so they don't merge with the perp.
 */
export function baseSymbol(symbol: string): string {
  let s = symbol.toUpperCase().replace(/^[A-Z0-9]+:/, '');
  s = s.replace(/-(USDT|USDC|USD)-SWAP$/, '').replace(/[-_]?(USDT|USDC|USD)?[-_]?PERP$/, '');
  const dated = s.match(/^(.*?)[-_]?(USDT|USDC|USD)?[-_](\d{6}|\d{1,2}[A-Z]{3}\d{2})$/);
  if (dated) return `${dated[1].replace(/[-_]/g, '')}-${dated[3]}`;
  return s.replace(/[-_]?(USDT|USDC|USD)$/, '').replace(/[-_]/g, '') || symbol;
}

export interface Exposure {
  base: string;
  etf: LeveragedEtf | null;
  /** +1 long / −1 short, after accounting for inverse funds */
  dir: 1 | -1;
  /** |notional| × |ETF leverage| (USD, ≥ 0) */
  exposure: number;
  /** dir × exposure */
  signed: number;
  /** Value at entry price: notional × entry / mark */
  entryValue: number;
  /** Venue-reported initial margin, else notional / leverage setting */
  margin: number | null;
  marginEstimated: boolean;
}

export function exposureOf(p: Position): Exposure {
  const base = baseSymbol(p.symbol);
  const etf = LEVERAGED_ETFS[base] ?? null;
  const side = p.side === 'short' ? -1 : 1;
  const dir = (etf && etf.lev < 0 ? -side : side) as 1 | -1;
  const exposure = Math.abs(p.marketValue) * Math.abs(etf?.lev ?? 1);
  const entryValue = p.avgPrice > 0 && p.currentPrice > 0 ? Math.abs(p.marketValue) * (p.avgPrice / p.currentPrice) : Math.abs(p.quantity * p.avgPrice);
  const venueMargin = p.margin != null && p.margin > 0 ? p.margin : null;
  const margin = venueMargin ?? (p.leverage ? Math.abs(p.marketValue) / p.leverage : null);
  return { base, etf, dir, exposure, signed: dir * exposure, entryValue, margin, marginEstimated: venueMargin == null && margin != null };
}

export interface ExposureTotals { long: number; short: number; net: number; gross: number; notional: number; entryValue: number; margin: number; upl: number }

export function sumExposure(positions: Position[]): ExposureTotals {
  const t: ExposureTotals = { long: 0, short: 0, net: 0, gross: 0, notional: 0, entryValue: 0, margin: 0, upl: 0 };
  for (const p of positions) {
    const e = exposureOf(p);
    if (e.dir > 0) t.long += e.exposure; else t.short += e.exposure;
    t.notional += Math.abs(p.marketValue);
    t.entryValue += e.entryValue;
    t.margin += e.margin ?? 0;
    t.upl += p.unrealizedPnl;
  }
  t.net = t.long - t.short;
  t.gross = t.long + t.short;
  return t;
}

export const isPerpLike = (p: Position) => p.assetClass === 'crypto-perp' || p.assetClass === 'crypto-future';

export const fmtLev = (x: number) => `${x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2)}x`;

/**
 * Equity of the trading account that backs perps: total equity minus earn / funding (spot) wallets
 * and separate CFD sub-accounts. Used as the base for actual leverage, so idle earn money doesn't
 * make leverage look lower than it is.
 */
export function tradingEquity(a: AccountSnapshot): number {
  const off = (a.stables ?? []).filter((s) => s.location !== 'trading').reduce((s, b) => s + b.amount, 0);
  const cfd = (a.cfd ?? []).reduce((s, c) => s + c.equity, 0);
  return a.equity - off - cfd;
}
