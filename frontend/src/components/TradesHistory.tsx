import { useTrades } from '../hooks/usePortfolio';
import { ExchangeTag, SideBadge, CardHeader, EmptyState } from './ui';

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
    <section className="card overflow-hidden">
      <CardHeader
        title="已平仓记录"
        sub={summary.totalTrades > 0 ? `${summary.totalTrades} 笔 · 根据持仓变化推断，重启后清空` : undefined}
        right={summary.totalTrades > 0 && (
          <div className="flex items-center gap-4 text-[12px] text-text-muted">
            <span>胜率 <span className={`num ${summary.winRate >= 50 ? 'text-profit' : 'text-loss'}`}>{summary.winRate.toFixed(1)}%</span></span>
            <span>已实现 <span className={`num ${summary.totalRealizedPnl >= 0 ? 'text-profit' : 'text-loss'}`}>
              {summary.totalRealizedPnl >= 0 ? '+' : ''}{formatUSD(summary.totalRealizedPnl)}</span></span>
          </div>
        )}
      />
      {trades.length === 0 ? (
        <EmptyState>暂无平仓记录 —— 持仓关闭后会出现在这里</EmptyState>
      ) : (
        <div className="overflow-x-auto max-h-[420px]">
          <table className="data">
            <thead>
              <tr>
                <th>时间</th><th>合约</th><th>交易所</th><th>方向</th>
                <th className="r">开仓</th><th className="r">平仓</th><th className="r">数量</th>
                <th className="r">盈亏</th><th className="r">持仓时长</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => {
                const win = t.realizedPnl >= 0;
                return (
                  <tr key={t.id}>
                    <td className="num text-text-muted">
                      {new Date(t.exitTime).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}
                    </td>
                    <td className="font-medium">{t.symbol}</td>
                    <td><ExchangeTag exchange={t.exchange} /></td>
                    <td><SideBadge side={t.side} /></td>
                    <td className="r num text-text-secondary">{formatPrice(t.entryPrice)}</td>
                    <td className="r num text-text-secondary">{formatPrice(t.exitPrice)}</td>
                    <td className="r num text-text-secondary">{formatQty(t.quantity)}</td>
                    <td className="r">
                      <div className={`num ${win ? 'text-profit' : 'text-loss'}`}>{win ? '+' : ''}{formatUSD(t.realizedPnl)}</div>
                      <div className={`num text-[11px] opacity-70 ${win ? 'text-profit' : 'text-loss'}`}>{win ? '+' : ''}{t.pnlPercent.toFixed(2)}%</div>
                    </td>
                    <td className="r num text-text-muted">{formatDuration(t.durationSeconds)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
