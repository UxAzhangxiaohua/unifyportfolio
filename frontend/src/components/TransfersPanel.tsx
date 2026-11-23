import { useTransfers } from '../hooks/usePortfolio';
import type { TransferState } from '../types';
import { fmtUSD } from '../lib/format';
import { tr, locale } from '../lib/i18n';
import { CardHeader } from './ui';

// Deposits / withdrawals reported by each venue. A withdrawal that lands at another tracked
// account is an internal transfer: while it's on-chain the amount stays in the total, so the
// equity curve only shows the fee instead of a dip and recovery.

const STATE_STYLE: Record<TransferState, string> = {
  in_transit: 'bg-delayed/12 text-delayed',
  completed: 'bg-profit/12 text-profit',
  external_out: 'bg-loss/10 text-loss',
  external_in: 'bg-accent/12 text-accent',
  failed: 'bg-white/5 text-text-muted',
};
const stateLabel = (s: TransferState) => ({
  in_transit: tr('在途', 'In transit'),
  completed: tr('内部转账', 'Internal'),
  external_out: tr('转出（外部）', 'Withdrawal (external)'),
  external_in: tr('转入（外部）', 'Deposit (external)'),
  failed: tr('失败/取消', 'Failed / cancelled'),
})[s];
const stateHint = (s: TransferState) => ({
  in_transit: tr('转往自己的地址，等待到账；期间金额计入总资产', 'Sent to one of your own addresses, waiting to be credited; counted in the total meanwhile'),
  completed: tr('已在另一个账户到账，曲线只体现手续费', 'Credited at another tracked account — the curve only reflects the fee'),
  external_out: tr('未在其他账户找到对应入账，视为资金流出', 'No matching deposit at a tracked account — treated as an outflow'),
  external_in: tr('来自未跟踪的地址', 'From an untracked source'),
  failed: tr('已退回，不影响曲线', 'Refunded — no effect on the curve'),
})[s];

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function TransfersPanel() {
  const { data } = useTransfers();
  if (!data || !data.transfers.length) return null;
  const { inTransit, transfers } = data;
  const internal = transfers.filter((t) => t.state === 'completed');
  const fees = internal.reduce((s, t) => s + t.fee, 0);

  return (
    <section className="card overflow-hidden">
      <CardHeader
        title={tr('资金划转', 'Transfers')}
        sub={tr('近 14 天 · 自动识别账户间转账，在途资金计入总资产', 'Last 14 days · transfers between your accounts are detected automatically; funds in transit count toward the total')}
        right={
          <div className="flex items-center gap-4 text-[12px] text-text-muted">
            {Math.abs(inTransit) >= 0.01 && <span>{tr('在途', 'In transit')} <span className="num text-delayed">{fmtUSD(inTransit)}</span></span>}
            {internal.length > 0 && <span>{tr(`内部转账 ${internal.length} 笔 · 手续费`, `${internal.length} internal · fees`)} <span className="num text-text-secondary">{fmtUSD(fees)}</span></span>}
          </div>
        }
      />
      <div className="overflow-x-auto max-h-[360px]">
        <table className="data">
          <thead>
            <tr>
              <th>{tr('时间', 'Time')}</th>
              <th>{tr('转出', 'From')}</th>
              <th>{tr('转入', 'To')}</th>
              <th className="r">{tr('金额', 'Amount')}</th>
              <th className="r">{tr('手续费', 'Fee')}</th>
              <th>{tr('网络', 'Network')}</th>
              <th className="r">{tr('耗时', 'Took')}</th>
              <th>{tr('状态', 'Status')}</th>
            </tr>
          </thead>
          <tbody>
            {transfers.map((t) => (
              <tr key={t.id}>
                <td className="num text-text-muted">
                  {new Date(t.startedAt).toLocaleString(locale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}
                </td>
                <td className="text-text-secondary">{t.fromAccount ?? '—'}</td>
                <td className="text-text-secondary">{t.toAccount ?? (t.state === 'in_transit' ? '…' : '—')}</td>
                <td className="r num">{t.amount.toLocaleString('en-US', { maximumFractionDigits: 2 })} <span className="text-[11px] text-text-muted">{t.coin}</span></td>
                <td className="r num text-text-secondary">{t.fee ? t.fee.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '—'}</td>
                <td className="text-text-muted text-[12px]">{t.network ?? '—'}</td>
                <td className="r num text-text-muted">
                  {t.state === 'completed' && t.arrivedAt ? fmtDuration(t.arrivedAt - t.startedAt)
                    : t.state === 'in_transit' ? fmtDuration(Date.now() - t.startedAt) : '—'}
                </td>
                <td>
                  <span title={stateHint(t.state)} className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium ${STATE_STYLE[t.state]}`}>
                    {stateLabel(t.state)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
