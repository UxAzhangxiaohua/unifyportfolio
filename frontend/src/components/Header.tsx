import type { PortfolioResponse } from '../types';

function formatUSD(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatPnl(n: number): string {
  const sign = n >= 0 ? '+' : '';
  return sign + formatUSD(n);
}

export function Header({ data }: { data: PortfolioResponse }) {
  const pnlColor = data.totalUnrealizedPnl >= 0 ? 'text-profit' : 'text-loss';

  return (
    <div className="mb-8">
      <div className="flex items-center gap-3 mb-4">
        <h1 className="text-2xl font-bold tracking-tight">UnifyPortfolio</h1>
        <span className="text-text-muted text-xs px-2 py-0.5 border border-border-card rounded">
          {data.accounts.length} accounts
        </span>
      </div>
      <div className="flex flex-wrap items-baseline gap-8">
        <div>
          <div className="text-text-secondary text-xs uppercase tracking-wider mb-1">Total Equity</div>
          <div className="text-4xl font-bold tabular-nums">{formatUSD(data.totalEquity)}</div>
        </div>
        <div>
          <div className="text-text-secondary text-xs uppercase tracking-wider mb-1">Unrealized PnL</div>
          <div className={`text-2xl font-bold tabular-nums ${pnlColor}`}>
            {formatPnl(data.totalUnrealizedPnl)}
          </div>
        </div>
        <div className="ml-auto text-right">
          <div className="text-text-muted text-xs">
            Last updated {new Date(data.timestamp).toLocaleTimeString()}
          </div>
        </div>
      </div>
    </div>
  );
}
