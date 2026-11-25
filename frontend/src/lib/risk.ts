import type { AccountSnapshot, Position } from '../types';
import { baseSymbol, exposureOf, isPerpLike, sumExposure, tradingEquity, type ExposureTotals } from './exposure';

// Portfolio-level risk across perps / futures, CFDs and options (positions page).

export const isDeriv = (p: Position) => isPerpLike(p) || p.assetClass === 'cfd' || p.assetClass === 'option';

/** Earn + funding (spot) stables: not margin */
export const offStables = (a: AccountSnapshot) =>
  (a.stables ?? []).filter((s) => s.location !== 'trading').reduce((s, b) => s + b.amount, 0);

/** Equity that backs derivatives: total minus earn / funding wallets (CFD sub-accounts included) */
export const riskEquity = (a: AccountSnapshot) => a.equity - offStables(a);

/** Distance from mark to liquidation, as % of mark (always positive = room left) */
export function liqDistance(p: Position): number | null {
  if (!p.liquidationPrice || !p.currentPrice) return null;
  const d = p.side === 'long'
    ? (p.currentPrice - p.liquidationPrice) / p.currentPrice
    : (p.liquidationPrice - p.currentPrice) / p.currentPrice;
  return d * 100;
}

/** $Delta of an option position (signed, position-level delta × underlying price) */
export const dollarDelta = (p: Position) => {
  const o = p.option;
  return o?.delta != null && o.underlyingPrice ? o.delta * o.underlyingPrice : null;
};

/**
 * One leverage group of an account. Crypto perps / futures and CFD (MT5, Bitget CFD sub-account)
 * are kept apart: different equity base, margin rules and exposure, so mixing them hides both.
 */
export interface RiskGroup {
  x: ExposureTotals;
  /** perp: trading equity excl. earn / funding / CFD sub-accounts; cfd: Σ CFD account equity */
  equity: number;
  margin: number;
  marginEstimated: boolean;
  /** gross exposure ÷ equity */
  lev: number | null;
  upl: number;
}

export interface AccountRisk {
  a: AccountSnapshot;
  perps: Position[];
  cfds: Position[];
  options: Position[];
  perp: RiskGroup;
  /** null when the account has no CFD account / positions */
  cfd: RiskGroup | null;
  /** All derivatives incl. options */
  upl: number;
  /** Nearest liquidation distance (%) over perps */
  liq: number | null;
  liqSymbol: string | null;
  nextFunding: number | null;
  /** CFD account margin level (lowest), % */
  marginLevel: number | null;
}

export function accountRisk(a: AccountSnapshot): AccountRisk {
  const perps = a.positions.filter(isPerpLike);
  const cfds = a.positions.filter((p) => p.assetClass === 'cfd');
  const options = a.positions.filter((p) => p.assetClass === 'option');
  const perpX = sumExposure(perps);
  const cfdX = sumExposure(cfds);
  const cfdStates = (a.cfd ?? []).filter((c) => !c.equityOnly);
  const optUpl = options.reduce((s, p) => s + p.unrealizedPnl, 0);

  // CFD: the CFD account's own equity / margin; floating PnL from the account (incl. swap / commission)
  const cfdMargin = cfdStates.reduce((s, c) => s + c.usedMargin, 0);
  const cfdEquity = cfdStates.reduce((s, c) => s + c.equity, 0);
  const cfdUpl = cfdStates.length ? cfdStates.reduce((s, c) => s + c.floatingPnl, 0) : cfdX.upl;
  const cfd: RiskGroup | null = cfdStates.length || cfds.length ? {
    x: cfdX, equity: cfdEquity, margin: cfdMargin,
    marginEstimated: cfdStates.some((c) => c.marginEstimated),
    lev: cfdEquity > 0 ? cfdX.gross / cfdEquity : null, upl: cfdUpl,
  } : null;

  // Perps: account-level initial margin includes the CFD sub-account (Bitget, MT5) — take it out
  const venue = a.marginUsed != null && a.marginUsed > 0 ? a.marginUsed : null;
  const perpMargin = venue != null ? Math.max(venue - cfdMargin, 0) : perpX.margin;
  const perpEquity = tradingEquity(a);
  const perp: RiskGroup = {
    x: perpX, equity: perpEquity, margin: perpMargin,
    marginEstimated: venue == null && perps.some((p) => exposureOf(p).marginEstimated),
    lev: perpEquity > 0 ? perpX.gross / perpEquity : null, upl: perpX.upl + optUpl,
  };

  let liq: number | null = null, liqSymbol: string | null = null;
  for (const p of perps) {
    const d = liqDistance(p);
    if (d != null && (liq == null || d < liq)) { liq = d; liqSymbol = p.symbol; }
  }
  const nf = perps.filter((p) => p.nextFunding != null);
  const levels = cfdStates.map((c) => c.marginLevel).filter((v): v is number => v != null);
  return {
    a, perps, cfds, options, perp, cfd,
    upl: perp.upl + (cfd?.upl ?? 0),
    liq, liqSymbol,
    nextFunding: nf.length ? nf.reduce((s, p) => s + (p.nextFunding as number), 0) : null,
    marginLevel: levels.length ? Math.min(...levels) : null,
  };
}

/** Σ over accounts of one group (perp or cfd) */
export function sumGroup(risks: AccountRisk[], k: 'perp' | 'cfd') {
  const gs = risks.map((r) => r[k]).filter((g): g is RiskGroup => g != null && (g.x.gross > 0 || g.margin > 0));
  const long = gs.reduce((s, g) => s + g.x.long, 0);
  const short = gs.reduce((s, g) => s + g.x.short, 0);
  const equity = gs.reduce((s, g) => s + g.equity, 0);
  const margin = gs.reduce((s, g) => s + g.margin, 0);
  return {
    n: gs.length, long, short, gross: long + short, net: long - short, equity, margin,
    marginEstimated: gs.some((g) => g.marginEstimated),
    lev: equity > 0 ? (long + short) / equity : null,
    upl: gs.reduce((s, g) => s + g.upl, 0),
  };
}

/** Accounts holding any derivative position, biggest exposure first */
export function riskAccounts(accounts: AccountSnapshot[]): AccountRisk[] {
  return accounts.filter((a) => a.positions.some(isDeriv)).map(accountRisk)
    .sort((x, y) => (y.perp.x.gross + (y.cfd?.x.gross ?? 0)) - (x.perp.x.gross + (x.cfd?.x.gross ?? 0)) || Math.abs(y.upl) - Math.abs(x.upl));
}

// ── Exposure by underlying ────────────────────────────────────────────────────

const ALIASES: Record<string, string> = {
  XAUUSD: 'XAU', XAUT: 'XAU', PAXG: 'XAU', GOLD: 'XAU',
  XAGUSD: 'XAG', SILVER: 'XAG',
  USTEC: 'NAS100', US100: 'NAS100', NDX: 'NAS100', NAS100: 'NAS100',
  US500: 'US500', SPX500: 'US500',
  US30: 'US30', DJ30: 'US30',
  USOIL: 'WTI', XTIUSD: 'WTI', UKOIL: 'BRENT', XBRUSD: 'BRENT',
};

/** MT5 suffixes (XAUUSDm, US500.cash) stripped; dated futures merged with their perp */
function rawUnderlying(p: Position): string {
  if (p.assetClass === 'option') return (p.option?.underlying ?? baseSymbol(p.symbol)).toUpperCase().replace(/[-_]?(USDT|USDC|USD)$/, '');
  if (p.assetClass === 'cfd') return p.symbol.replace(/\.[A-Za-z0-9]+$/, '').replace(/[a-z]+$/, '').toUpperCase();
  return baseSymbol(p.symbol).replace(/-(\d{6}|\d{1,2}[A-Z]{3}\d{2})$/, '');
}

export function underlyingOf(p: Position): string {
  const x = exposureOf(p);
  if (x.etf) return x.etf.underlying; // SOXL long + SOXS short net out on the same index
  const k = rawUnderlying(p).replace(/^1000+(?=[A-Z])/, ''); // 1000PEPE → PEPE
  return ALIASES[k] ?? k;
}

export interface UnderlyingRow {
  key: string;
  /** Signed exposure: perps / futures, CFD, options ($delta) */
  perp: number;
  cfd: number;
  opt: number;
  net: number;
  long: number;
  short: number;
  upl: number;
  accounts: Set<string>;
}

export function byUnderlying(accounts: AccountSnapshot[]): UnderlyingRow[] {
  const m = new Map<string, UnderlyingRow>();
  const row = (k: string) => {
    let r = m.get(k);
    if (!r) { r = { key: k, perp: 0, cfd: 0, opt: 0, net: 0, long: 0, short: 0, upl: 0, accounts: new Set() }; m.set(k, r); }
    return r;
  };
  for (const a of accounts) {
    for (const p of a.positions) {
      if (!isDeriv(p)) continue;
      const r = row(underlyingOf(p));
      r.accounts.add(a.label);
      r.upl += p.unrealizedPnl;
      let s: number;
      if (p.assetClass === 'option') {
        const d = dollarDelta(p);
        if (d == null) continue;
        s = d; r.opt += d;
      } else {
        s = exposureOf(p).signed;
        if (p.assetClass === 'cfd') r.cfd += s; else r.perp += s;
      }
      if (s >= 0) r.long += s; else r.short -= s;
    }
  }
  for (const r of m.values()) r.net = r.perp + r.cfd + r.opt;
  return [...m.values()].sort((x, y) => (y.long + y.short) - (x.long + x.short));
}
