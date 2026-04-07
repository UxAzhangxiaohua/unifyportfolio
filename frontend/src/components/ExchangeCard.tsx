import type { AccountSnapshot, ExchangeType } from '../types';
import { StatusBadge } from './StatusBadge';
import { AccountRow } from './AccountRow';

const EXCHANGE_NAMES: Record<ExchangeType, string> = {
  ibkr: 'IBKR',
  hyperliquid: 'Hyperliquid',
  binance: 'Binance',
  okx: 'OKX',
};

function formatUSD(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatPnl(n: number): string {
  return (n >= 0 ? '+' : '') + formatUSD(n);
}

export function ExchangeCard({ exchange, accounts }: { exchange: ExchangeType; accounts: AccountSnapshot[] }) {
  const totalEquity = accounts.reduce((s, a) => s + a.equity, 0);
  const totalPnl = accounts.reduce((s, a) => s + a.unrealizedPnl, 0);
  const pnlColor = totalPnl >= 0 ? 'text-profit' : 'text-loss';

  // Aggregate margin info for accounts that have it
  const accountsWithMargin = accounts.filter(a => a.marginRatio != null);
  const avgMarginRatio = accountsWithMargin.length > 0
    ? accountsWithMargin.reduce((s, a) => s + (a.marginRatio ?? 0), 0) / accountsWithMargin.length
    : null;

  return (
    <div className="bg-bg-card border border-border-card rounded-lg p-4 hover:border-border-card/80 transition-colors">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">
          {EXCHANGE_NAMES[exchange]}
        </h3>
        <StatusBadge accounts={accounts} />
      </div>

      {/* Totals */}
      <div className="text-2xl font-bold tabular-nums mb-0.5">{formatUSD(totalEquity)}</div>
      <div className={`text-sm tabular-nums ${pnlColor}`}>
        PnL {formatPnl(totalPnl)}
      </div>

      {/* Margin bar */}
      {avgMarginRatio != null && (
        <div className="mt-3">
          <div className="flex justify-between text-[10px] text-text-muted mb-1">
            <span>Margin</span>
            <span>{(avgMarginRatio * 100).toFixed(1)}%</span>
          </div>
          <div className="h-1 bg-bg-primary rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-700"
              style={{
                width: `${Math.min(avgMarginRatio * 100, 100)}%`,
                backgroundColor: avgMarginRatio > 0.8 ? '#ff4455' : avgMarginRatio > 0.6 ? '#f59e0b' : '#00ff88',
              }}
            />
          </div>
        </div>
      )}

      {/* Per-account breakdown (only if multiple accounts) */}
      {accounts.length > 1 && (
        <div className="mt-3 pt-3 border-t border-border-card space-y-0.5">
          {accounts.map((a) => (
            <AccountRow key={a.accountId} account={a} />
          ))}
        </div>
      )}

      {/* Position count */}
      <div className="mt-3 text-[10px] text-text-muted">
        {accounts.reduce((s, a) => s + a.positions.length, 0)} position(s)
      </div>
    </div>
  );
}
