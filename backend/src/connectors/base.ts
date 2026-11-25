import type { AccountConfig, AccountSnapshot, ClosedTrade, FundFlow, Position, TradeCategory } from '../types.js';

/** Warning text marking data served from sticky()'s cache (scheduler.ts checks for it) */
export const STALE_MARKER = ': using data from ';

/** How long a failed sub-request may be served from its last good result */
const STICKY_MAX_AGE_MS = 15 * 60_000;

export abstract class BaseConnector {
  constructor(protected account: AccountConfig) {}

  abstract fetch(): Promise<AccountSnapshot>;

  /**
   * Stablecoin deposits/withdrawals since `sinceMs` (null = venue not supported).
   * Called alongside fetch() so a balance change and its withdrawal record are observed together.
   */
  async fetchFlows(_sinceMs: number, _untilMs?: number): Promise<FundFlow[] | null> {
    return null;
  }

  /**
   * The venue's own account-value history (USD, oldest first; null = not available). Used to fill
   * the equity curve before the first recorded sample (backfill.ts).
   */
  async fetchEquityHistory(): Promise<Array<{ t: number; v: number }> | null> {
    return null;
  }

  /**
   * Closed trades since `sinceMs` from the venue's own history (null = venue not supported).
   * Ids must be stable across calls (records are upserted). Polled by the scheduler every few minutes.
   */
  async fetchClosedTrades(_sinceMs: number): Promise<ClosedTrade[] | null> {
    return null;
  }

  /** Build a venue ClosedTrade; pnl is net (fees included), fees negative = cost */
  protected trade(p: {
    id: string; symbol: string; side: 'long' | 'short'; entryPrice: number; exitPrice: number; quantity: number;
    pnl: number; fees: number; entryTime: number | null; exitTime: number; category: TradeCategory;
  }): ClosedTrade {
    const dir = p.side === 'long' ? 1 : -1;
    const entryTime = p.entryTime && p.entryTime > 0 && p.entryTime <= p.exitTime ? p.entryTime : null;
    return {
      id: `${this.account.id}:${p.id}`,
      accountId: this.account.id,
      exchange: this.account.exchange,
      symbol: p.symbol,
      side: p.side,
      entryPrice: p.entryPrice,
      exitPrice: p.exitPrice,
      quantity: p.quantity,
      realizedPnl: p.pnl,
      pnlPercent: p.entryPrice > 0 ? ((p.exitPrice - p.entryPrice) / p.entryPrice) * 100 * dir : 0,
      entryTime: entryTime ? new Date(entryTime).toISOString() : null,
      exitTime: new Date(p.exitTime).toISOString(),
      durationSeconds: entryTime ? Math.floor((p.exitTime - entryTime) / 1000) : null,
      category: p.category,
      source: 'venue',
      fees: p.fees,
    };
  }

  private stickyCache = new Map<string, { value: unknown; at: number }>();

  /**
   * Like optional(), but when the sub-request fails and it succeeded within the last 15 min,
   * serve that last good result (with a warning) instead of the fallback. A transient failure
   * of e.g. the earn or positions endpoint then doesn't make equity dip or positions look closed.
   * `label` must be unique per call site within the connector.
   */
  protected async sticky<T>(label: string, warnings: string[], fn: () => Promise<T>, fallback: T, quiet = false): Promise<T> {
    try {
      const value = await fn();
      this.stickyCache.set(label, { value, at: Date.now() });
      return value;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const prev = this.stickyCache.get(label);
      if (prev && Date.now() - prev.at < STICKY_MAX_AGE_MS) {
        warnings.push(`${label}${STALE_MARKER}${Math.round((Date.now() - prev.at) / 1000)}s ago — ${msg}`.substring(0, 300));
        return prev.value as T;
      }
      // quiet: product often simply not enabled for the account (e.g. options) — don't nag
      if (!quiet) warnings.push(`${label}: ${msg}`.substring(0, 300));
      return fallback;
    }
  }

  protected makeErrorSnapshot(error: string): AccountSnapshot {
    return {
      accountId: this.account.id,
      exchange: this.account.exchange,
      label: this.account.label,
      equity: 0,
      availableBalance: 0,
      unrealizedPnl: 0,
      marginUsed: null,
      marginRatio: null,
      positions: [],
      stables: [],
      fetchedAt: new Date().toISOString(),
      isDelayed: false,
      error,
    };
  }
}

/** Run an optional sub-request; on failure record a warning instead of failing the whole account. */
export async function optional<T>(label: string, warnings: string[], fn: () => Promise<T>, fallback: T, quiet = false): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    // quiet: product often simply not enabled for the account (e.g. options) — don't nag
    if (quiet) return fallback;
    warnings.push(`${label}: ${err instanceof Error ? err.message : String(err)}`.substring(0, 300));
    return fallback;
  }
}

const MONTHS: Record<string, string> = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};

/**
 * Parse option symbols like:
 *   BTC-USD-241227-60000-C  (OKX)      BTC-241227-60000-C (Binance)
 *   BTC-27DEC24-60000-C     (Bybit/Deribit style)
 */
export function parseOptionSymbol(symbol: string): { underlying: string; type: 'call' | 'put'; strike: number; expiry: string } | null {
  const parts = symbol.split('-');
  if (parts.length < 4) return null;
  const cp = parts[parts.length - 1].toUpperCase();
  if (cp !== 'C' && cp !== 'P') return null;
  const strike = parseFloat(parts[parts.length - 2]);
  const date = parts[parts.length - 3].toUpperCase();
  let expiry = '';
  if (/^\d{6}$/.test(date)) {
    expiry = `20${date.slice(0, 2)}-${date.slice(2, 4)}-${date.slice(4, 6)}`;
  } else {
    const m = date.match(/^(\d{1,2})([A-Z]{3})(\d{2})$/);
    if (m && MONTHS[m[2]]) expiry = `20${m[3]}-${MONTHS[m[2]]}-${m[1].padStart(2, '0')}`;
  }
  if (!expiry || !Number.isFinite(strike)) return null;
  return { underlying: parts[0], type: cp === 'C' ? 'call' : 'put', strike, expiry };
}

/** Map a venue coin name to a tracked stablecoin (USDT0 = Hyperliquid's bridged USDT) */
export const stableCoin = (c: string): 'USDT' | 'USDC' | null =>
  c === 'USDT' || c === 'USDT0' ? 'USDT' : c === 'USDC' ? 'USDC' : null;

export const lower = (s: unknown): string | null => (typeof s === 'string' && s.trim() ? s.trim().toLowerCase() : null);

export const num = (s: unknown): number => {
  const n = typeof s === 'number' ? s : parseFloat(String(s ?? ''));
  return Number.isFinite(n) ? n : 0;
};

export function createConnector(account: AccountConfig): BaseConnector {
  // Dynamic import would create circular deps, so we use a registry pattern.
  // This is populated by the scheduler after importing all connectors.
  throw new Error(`No connector registered for exchange: ${account.exchange}`);
}

/** Funding quote for one perp: rate per interval (positive = longs pay shorts) */
export interface FundingQuote { rate: number; nextTime: number | null; intervalH: number | null }

const quoteCache = new Map<string, { at: number; value: unknown }>();
/** Short-lived cache for public market data shared across accounts (funding rates move slowly) */
export async function cachedPublic<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = quoteCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await fn();
  quoteCache.set(key, { at: Date.now(), value });
  return value;
}

/** Attach the funding quote and the estimated next payment (+ receive / − pay) to a perp position */
export function applyFunding(p: Position, q: FundingQuote | undefined): void {
  if (!q || !Number.isFinite(q.rate)) return;
  p.fundingRate = q.rate;
  p.fundingIntervalH = q.intervalH;
  p.nextFundingTime = q.nextTime;
  const sign = p.side === 'long' ? 1 : p.side === 'short' ? -1 : 0;
  p.nextFunding = -sign * p.marketValue * q.rate;
}
