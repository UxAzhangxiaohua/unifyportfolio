const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** $12,345 — or $12.34 for small values */
export function fmtUSD(n: number, opts: { decimals?: boolean } = {}): string {
  if (!Number.isFinite(n)) return '—';
  const useCents = opts.decimals ?? Math.abs(n) < 100;
  return (useCents ? usd2 : usd0).format(n);
}

export function fmtSigned(n: number, opts: { decimals?: boolean } = {}): string {
  if (!Number.isFinite(n) || n === 0) return fmtUSD(0, opts);
  return (n > 0 ? '+' : '−') + fmtUSD(Math.abs(n), opts);
}

/** Compact: $1.2M, $45.3K */
export function fmtCompact(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${sign}$${(a / 1e3).toFixed(1)}K`;
  return sign + fmtUSD(a);
}

export function fmtPrice(n: number): string {
  if (!n) return '—';
  const a = Math.abs(n);
  const digits = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8;
  return n.toLocaleString('en-US', { minimumFractionDigits: a >= 1000 ? 2 : 2, maximumFractionDigits: digits });
}

export function fmtQty(n: number): string {
  if (!n) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: Math.abs(n) < 1 ? 6 : 4 });
}

export function fmtPct(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(digits)}%`;
}

export function pnlClass(n: number): string {
  return n > 0 ? 'text-profit' : n < 0 ? 'text-loss' : 'text-text-secondary';
}

export function timeAgo(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}秒前`;
  if (s < 3600) return `${Math.floor(s / 60)}分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)}小时前`;
  return `${Math.floor(s / 86400)}天前`;
}

/** Days to expiry (can be fractional / negative) — options expire 08:00 UTC on crypto venues */
export function daysToExpiry(expiry: string): number {
  const t = new Date(`${expiry}T08:00:00Z`).getTime();
  return (t - Date.now()) / 86_400_000;
}
