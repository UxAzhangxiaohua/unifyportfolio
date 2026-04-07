import type { AccountSnapshot } from '../types';

function formatUSD(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatPnl(n: number): string {
  return (n >= 0 ? '+' : '') + formatUSD(n);
}

export function AccountRow({ account }: { account: AccountSnapshot }) {
  const pnlColor = account.unrealizedPnl >= 0 ? 'text-profit' : account.unrealizedPnl < 0 ? 'text-loss' : 'text-text-secondary';

  return (
    <div className="flex items-center justify-between text-sm py-1">
      <div className="flex items-center gap-2">
        <span className="text-text-secondary truncate max-w-[140px]">{account.label}</span>
        {account.error && <span className="text-loss text-[10px]" title={account.error}>!</span>}
      </div>
      <div className="flex items-center gap-4 tabular-nums">
        <span className="text-text-primary">{formatUSD(account.equity)}</span>
        <span className={`${pnlColor} min-w-[80px] text-right`}>{formatPnl(account.unrealizedPnl)}</span>
      </div>
    </div>
  );
}
