import { useMetrics } from '../hooks/usePortfolio';
import { fmtPct, fmtSigned } from '../lib/format';
import { tr } from '../lib/i18n';

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
    label: tr('最大回撤', 'Max drawdown'),
    value: m.maxDrawdown > 0 ? fmtPct(-m.maxDrawdownPercent) : '—',
    sub: m.maxDrawdown > 0 ? fmtSigned(-m.maxDrawdown, { decimals: false }) : undefined,
    tone: m.maxDrawdown > 0 ? 'down' : undefined,
  });
  for (const [k, label] of [['1h', tr('1小时', '1h')], ['4h', tr('4小时', '4h')], ['24h', tr('24小时', '24h')], ['1w', tr('1周', '1w')]] as const) {
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
