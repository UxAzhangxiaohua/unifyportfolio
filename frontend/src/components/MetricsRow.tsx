import { useMetrics } from '../hooks/usePortfolio';
import { fmtPct, fmtSigned } from '../lib/format';

export function MetricsRow() {
  const { data: m } = useMetrics();
  if (!m) return null;

  const items: Array<{ label: string; value: string; sub?: string; tone?: 'up' | 'down' }> = [];
  items.push({
    label: 'Sharpe',
    value: m.sharpeRatio != null ? m.sharpeRatio.toFixed(2) : '—',
    tone: m.sharpeRatio == null ? undefined : m.sharpeRatio >= 0 ? 'up' : 'down',
  });
  items.push({
    label: '最大回撤',
    value: m.maxDrawdown > 0 ? fmtPct(-m.maxDrawdownPercent) : '—',
    sub: m.maxDrawdown > 0 ? fmtSigned(-m.maxDrawdown, { decimals: false }) : undefined,
    tone: m.maxDrawdown > 0 ? 'down' : undefined,
  });
  for (const [k, label] of [['1h', '1小时'], ['4h', '4小时'], ['24h', '24小时'], ['1w', '1周']] as const) {
    const c = m.changes[k];
    items.push(c
      ? { label, value: fmtSigned(c.pnl, { decimals: false }), sub: fmtPct(c.percent), tone: c.pnl >= 0 ? 'up' : 'down' }
      : { label, value: '—' });
  }

  return (
    <div className="card grid grid-cols-3 md:grid-cols-6 divide-x divide-border-card overflow-hidden">
      {items.map((it) => {
        const color = it.tone === 'up' ? 'text-profit' : it.tone === 'down' ? 'text-loss' : 'text-text-primary';
        return (
          <div key={it.label} className="px-4 py-3 min-w-0">
            <div className="text-[11.5px] text-text-muted">{it.label}</div>
            <div className={`num text-[15px] font-semibold mt-0.5 truncate ${color}`}>{it.value}</div>
            {it.sub && <div className={`num text-[11px] opacity-70 ${color}`}>{it.sub}</div>}
          </div>
        );
      })}
    </div>
  );
}
