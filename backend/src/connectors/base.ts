import type { AccountConfig, AccountSnapshot } from '../types.js';

export abstract class BaseConnector {
  constructor(protected account: AccountConfig) {}

  abstract fetch(): Promise<AccountSnapshot>;

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

export const num = (s: unknown): number => {
  const n = typeof s === 'number' ? s : parseFloat(String(s ?? ''));
  return Number.isFinite(n) ? n : 0;
};

export function createConnector(account: AccountConfig): BaseConnector {
  // Dynamic import would create circular deps, so we use a registry pattern.
  // This is populated by the scheduler after importing all connectors.
  throw new Error(`No connector registered for exchange: ${account.exchange}`);
}
