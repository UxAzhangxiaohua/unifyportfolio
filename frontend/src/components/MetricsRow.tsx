import { useMetrics } from '../hooks/usePortfolio';

function formatPnl(n: number): string {
  const sign = n >= 0 ? '+' : '';
  return sign + n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function MetricCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-[10px] text-text-muted uppercase tracking-wider whitespace-nowrap">{label}</span>
      <span className={`text-sm font-bold tabular-nums ${color ?? 'text-text-primary'}`}>{value}</span>
      {sub && <span className={`text-[10px] tabular-nums ${color ?? 'text-text-muted'}`}>{sub}</span>}
    </div>
  );
}

export function MetricsRow() {
  const { data: metrics } = useMetrics();

  if (!metrics) return null;

  const items: Array<{ label: string; value: string; sub?: string; color?: string }> = [];

  // Sharpe Ratio
  items.push({
    label: 'Sharpe',
    value: metrics.sharpeRatio != null ? metrics.sharpeRatio.toFixed(2) : '--',
    color: metrics.sharpeRatio != null
      ? metrics.sharpeRatio >= 1 ? 'text-profit' : metrics.sharpeRatio >= 0 ? 'text-text-primary' : 'text-loss'
      : undefined,
  });

  // Max Drawdown
  items.push({
    label: 'Max Drawdown',
    value: metrics.maxDrawdown > 0 ? `-${metrics.maxDrawdownPercent.toFixed(2)}%` : '--',
    sub: metrics.maxDrawdown > 0 ? `-$${Math.round(metrics.maxDrawdown).toLocaleString()}` : undefined,
    color: metrics.maxDrawdown > 0 ? 'text-loss' : undefined,
  });

  // Period changes
  const periods = [
    { key: '1h', label: '1H PnL' },
    { key: '4h', label: '4H PnL' },
    { key: '24h', label: '24H PnL' },
    { key: '1w', label: '1W PnL' },
  ];

  for (const { key, label } of periods) {
    const change = metrics.changes[key];
    if (change) {
      const isPos = change.pnl >= 0;
      items.push({
        label,
        value: formatPnl(change.pnl),
        sub: `${isPos ? '+' : ''}${change.percent.toFixed(2)}%`,
        color: isPos ? 'text-profit' : 'text-loss',
      });
    } else {
      items.push({ label, value: '--' });
    }
  }

  return (
    <div className="bg-bg-card border border-border-card rounded-xl px-5 py-3">
      <div className="flex items-start justify-between gap-6 overflow-x-auto">
        {items.map((item) => (
          <MetricCard key={item.label} {...item} />
        ))}
      </div>
    </div>
  );
}
