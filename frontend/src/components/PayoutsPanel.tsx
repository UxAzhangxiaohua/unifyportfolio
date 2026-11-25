import { usePayouts } from '../hooks/usePortfolio';
import type { PayoutView } from '../types';
import { fmtUSD } from '../lib/format';
import { tr, locale } from '../lib/i18n';
import { CardHeader } from './ui';

// Withdrawals to the user's own cash-out addresses (accounts.json `payoutAddresses`).
// The address itself never reaches the page (it's public behind the tunnel).

const STATUS_STYLE: Record<PayoutView['status'], string> = {
  done: 'bg-profit/12 text-profit',
  pending: 'bg-delayed/12 text-delayed',
  failed: 'bg-white/5 text-text-muted',
};
const statusLabel = (s: PayoutView['status']) => ({
  done: tr('已完成', 'Done'),
  pending: tr('处理中', 'Pending'),
  failed: tr('失败/取消', 'Failed / cancelled'),
})[s];

const monthKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

export function PayoutsPanel() {
  const { data } = usePayouts();
  if (!data?.configured) return null;
  const { payouts } = data;

  // Failed / cancelled withdrawals were refunded, so they don't count
  const counted = payouts.filter((p) => p.status !== 'failed');
  const total = counted.reduce((s, p) => s + p.amount, 0);
  const fees = counted.reduce((s, p) => s + p.fee, 0);
  const thisMonth = monthKey(Date.now());
  const monthTotal = counted.filter((p) => monthKey(p.time) === thisMonth).reduce((s, p) => s + p.amount, 0);

  const byMonth = new Map<string, { amount: number; n: number }>();
  for (const p of counted) {
    const k = monthKey(p.time);
    const m = byMonth.get(k) ?? { amount: 0, n: 0 };
    m.amount += p.amount; m.n++;
    byMonth.set(k, m);
  }

  return (
    <section className="card overflow-hidden">
      <CardHeader
        title={tr('出金记录', 'Cash-outs')}
        sub={tr('转到你的出金地址的提现 · 各交易所回溯 90 天', 'Withdrawals to your cash-out address · each venue read 90 days back')}
        right={
          <div className="flex items-center gap-4 text-[12px] text-text-muted">
            <span>{tr('本月', 'This month')} <span className="num text-text-secondary">{fmtUSD(monthTotal)}</span></span>
            <span>{tr(`累计 ${counted.length} 笔`, `${counted.length} total`)} <span className="num text-text-primary font-medium">{fmtUSD(total)}</span></span>
            {fees > 0 && <span>{tr('手续费', 'Fees')} <span className="num text-text-secondary">{fmtUSD(fees)}</span></span>}
          </div>
        }
      />

      {byMonth.size > 1 && (
        <div className="flex flex-wrap gap-2 px-5 pb-3">
          {[...byMonth.entries()].map(([k, m]) => (
            <span key={k} className="chip text-[12px]">
              <span className="text-text-muted">{k}</span>
              <span className="num ml-2 text-text-secondary">{fmtUSD(m.amount)}</span>
              <span className="text-text-muted ml-1.5">×{m.n}</span>
            </span>
          ))}
        </div>
      )}

      {payouts.length === 0 ? (
        <div className="px-5 pb-5 text-[13px] text-text-muted">{tr('暂无出金记录', 'No cash-outs on record yet')}</div>
      ) : (
        <div className="overflow-x-auto max-h-[360px]">
          <table className="data">
            <thead>
              <tr>
                <th>{tr('时间', 'Time')}</th>
                <th>{tr('转出账户', 'From')}</th>
                <th className="r">{tr('金额', 'Amount')}</th>
                <th className="r">{tr('手续费', 'Fee')}</th>
                <th>{tr('网络', 'Network')}</th>
                <th>{tr('状态', 'Status')}</th>
              </tr>
            </thead>
            <tbody>
              {payouts.map((p) => (
                <tr key={p.id} className={p.status === 'failed' ? 'opacity-50' : undefined}>
                  <td className="num text-text-muted">
                    {new Date(p.time).toLocaleString(locale(), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}
                  </td>
                  <td className="text-text-secondary">{p.account}</td>
                  <td className="r num">{p.amount.toLocaleString('en-US', { maximumFractionDigits: 2 })} <span className="text-[11px] text-text-muted">{p.coin}</span></td>
                  <td className="r num text-text-secondary">{p.fee ? p.fee.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '—'}</td>
                  <td className="text-text-muted text-[12px]">{p.network ?? '—'}</td>
                  <td>
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium ${STATUS_STYLE[p.status]}`}>
                      {statusLabel(p.status)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
