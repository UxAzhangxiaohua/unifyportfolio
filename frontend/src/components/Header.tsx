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
  const pnlBg = data.totalUnrealizedPnl >= 0 ? 'bg-profit/8' : 'bg-loss/8';

  return (
    <div className="mb-6">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-sm font-semibold text-text-secondary uppercase tracking-wider">
              Total Portfolio
            </h1>
            <span className="text-[10px] text-text-muted px-2 py-0.5 border border-border-card rounded-md">
              {data.accounts.length} accounts
            </span>
          </div>
          <div className="flex items-baseline gap-4">
            <span className="text-4xl font-bold tabular-nums tracking-tight">
              {formatUSD(data.totalEquity)}
            </span>
            <span className={`text-lg font-bold tabular-nums ${pnlColor} ${pnlBg} px-2 py-0.5 rounded-md`}>
              {formatPnl(data.totalUnrealizedPnl)}
            </span>
          </div>
        </div>
        <div className="text-right mt-1">
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-profit animate-pulse" />
            <span className="text-[10px] text-text-muted">LIVE</span>
          </div>
          <div className="text-[10px] text-text-muted mt-1">
            {new Date(data.timestamp).toLocaleTimeString()}
          </div>
        </div>
      </div>
    </div>
  );
}
