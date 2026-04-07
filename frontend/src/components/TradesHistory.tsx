import { useTrades } from '../hooks/usePortfolio';
import type { ExchangeType } from '../types';

const EXCHANGE_COLORS: Record<ExchangeType, string> = {
  ibkr: '#3b82f6',
  hyperliquid: '#10b981',
  binance: '#eab308',
  okx: '#a855f7',
};

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

function formatUSD(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPrice(n: number): string {
  if (n >= 1000) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 1) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

function formatQty(n: number): string {
  if (Number.isInteger(n)) return n.toString();
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

export function TradesHistory() {
  const { data, isLoading } = useTrades();

  if (isLoading || !data) return null;

  const { trades, summary } = data;

  return (
    <div className="bg-bg-card border border-border-card rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="text-xs text-text-secondary uppercase tracking-wider font-semibold">
            Trade History
          </span>
          {summary.totalTrades > 0 && (
            <span className="text-[10px] text-text-muted bg-bg-surface px-2 py-0.5 rounded-full">
              {summary.totalTrades} trade{summary.totalTrades !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        {summary.totalTrades > 0 && (
          <div className="flex items-center gap-4 text-xs tabular-nums">
            <span className="text-text-muted">
              Win Rate:{' '}
              <span className={summary.winRate >= 50 ? 'text-profit' : 'text-loss'}>
                {summary.winRate.toFixed(1)}%
              </span>
            </span>
            <span className="text-text-muted">
              Realized PnL:{' '}
              <span className={summary.totalRealizedPnl >= 0 ? 'text-profit' : 'text-loss'}>
                {summary.totalRealizedPnl >= 0 ? '+' : ''}
                {formatUSD(summary.totalRealizedPnl)}
              </span>
            </span>
          </div>
        )}
      </div>

      {trades.length === 0 ? (
        <div className="px-5 pb-6 text-center text-text-muted text-sm">
          No closed trades detected yet. Trades appear when positions close.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-text-muted border-t border-border-card">
                <th className="text-left font-medium px-5 py-2.5">Time</th>
                <th className="text-left font-medium px-3 py-2.5">Symbol</th>
                <th className="text-left font-medium px-3 py-2.5">Exchange</th>
                <th className="text-left font-medium px-3 py-2.5">Side</th>
                <th className="text-right font-medium px-3 py-2.5">Entry</th>
                <th className="text-right font-medium px-3 py-2.5">Exit</th>
                <th className="text-right font-medium px-3 py-2.5">Qty</th>
                <th className="text-right font-medium px-3 py-2.5">PnL</th>
                <th className="text-right font-medium px-5 py-2.5">Duration</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((trade) => {
                const isWin = trade.realizedPnl >= 0;
                return (
                  <tr
                    key={trade.id}
                    className="border-t border-border-card/50 hover:bg-bg-card-hover transition-colors"
                  >
                    <td className="px-5 py-2.5 text-text-muted tabular-nums whitespace-nowrap">
                      {new Date(trade.exitTime).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    <td className="px-3 py-2.5 font-medium text-text-primary">{trade.symbol}</td>
                    <td className="px-3 py-2.5">
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          className="w-1.5 h-1.5 rounded-full"
                          style={{ backgroundColor: EXCHANGE_COLORS[trade.exchange] }}
                        />
                        <span className="text-text-secondary uppercase">{trade.exchange}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                          trade.side === 'long'
                            ? 'bg-profit/10 text-profit'
                            : 'bg-loss/10 text-loss'
                        }`}
                      >
                        {trade.side.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-text-secondary">
                      {formatPrice(trade.entryPrice)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-text-secondary">
                      {formatPrice(trade.exitPrice)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-text-secondary">
                      {formatQty(trade.quantity)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      <div className="flex flex-col items-end">
                        <span className={isWin ? 'text-profit' : 'text-loss'}>
                          {isWin ? '+' : ''}
                          {formatUSD(trade.realizedPnl)}
                        </span>
                        <span className={`text-[10px] ${isWin ? 'text-profit/70' : 'text-loss/70'}`}>
                          {isWin ? '+' : ''}
                          {trade.pnlPercent.toFixed(2)}%
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-2.5 text-right tabular-nums text-text-muted">
                      {formatDuration(trade.durationSeconds)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
