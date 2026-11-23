// Black-Scholes helpers for the option exit calculator (r = 0, as crypto venues effectively price).
// Times are in years; vol is a decimal (0.55 = 55%).

const YEAR_MS = 365 * 86_400_000;

/** Standard normal CDF (Abramowitz–Stegun 26.2.17, |err| < 7.5e-8) */
function N(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}

export function intrinsic(S: number, K: number, type: 'call' | 'put'): number {
  return Math.max(type === 'call' ? S - K : K - S, 0);
}

export function bsPrice(S: number, K: number, T: number, vol: number, type: 'call' | 'put'): number {
  if (T <= 0 || vol <= 0) return intrinsic(S, K, type);
  const sd = vol * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (sd * sd) / 2) / sd;
  const d2 = d1 - sd;
  return type === 'call' ? S * N(d1) - K * N(d2) : K * N(-d2) - S * N(-d1);
}

/** Vol that reproduces `price` (bisection; price is monotonic in vol). Null if outside no-arbitrage bounds. */
export function impliedVol(price: number, S: number, K: number, T: number, type: 'call' | 'put'): number | null {
  if (T <= 0 || price <= intrinsic(S, K, type) + 1e-9) return null;
  let lo = 0.005, hi = 8;
  if (bsPrice(S, K, T, hi, type) < price) return null;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (bsPrice(S, K, T, mid, type) > price) hi = mid; else lo = mid;
    if (hi - lo < 1e-6) break;
  }
  return (lo + hi) / 2;
}

/** Expiry instant in ms — exchange-reported when available, else 08:00 UTC (crypto venue convention) */
export function expiryMs(expiry: string, expiryTs?: number | null): number {
  return expiryTs || new Date(`${expiry}T08:00:00Z`).getTime();
}

export const yearsBetween = (fromMs: number, toMs: number) => Math.max(toMs - fromMs, 0) / YEAR_MS;
