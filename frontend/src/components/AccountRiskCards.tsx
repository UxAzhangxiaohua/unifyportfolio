import type { ReactNode } from 'react';
import type { AccountSnapshot } from '../types';
import { EXCHANGES } from '../lib/exchanges';
import { fmtCompact, fmtSigned, fmtUSD, pnlClass } from '../lib/format';
import { fmtLev } from '../lib/exposure';
import { riskAccounts, type AccountRisk } from '../lib/risk';
import { tr } from '../lib/i18n';
import { CardHeader, EmptyState } from './ui';

function M({ label, value, foot, hint }: { label: string; value: ReactNode; foot?: ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0" title={hint}>
      <span className="text-[11px] text-text-muted truncate">{label}</span>
      <span className="num text-[15px] font-semibold leading-tight truncate">{value}</span>
      {foot && <span className="text-[11px] text-text-muted truncate">{foot}</span>}
    </div>
  );
}

const liqClass = (d: number) => (d < 10 ? 'text-loss' : d < 25 ? 'text-delayed' : 'text-text-primary');

/** One card per account holding derivatives: equity, margin, actual leverage, L/S/net, uPnL, nearest liquidation */
export function AccountRiskCards({ accounts }: { accounts: AccountSnapshot[] }) {
  const risks = riskAccounts(accounts);
  return (
    <section className="card overflow-hidden">
      <CardHeader title={tr('各账户风险', 'Risk by account')}
        sub={tr('仅列出有合约 / CFD / 期权持仓的账户；交易权益 = 总权益 − 理财 − 资金账户', 'Accounts with perps / CFD / options only; trading equity = total − earn − funding wallets')} />
      {risks.length === 0 ? <EmptyState>{tr('当前没有衍生品持仓', 'No derivative positions')}</EmptyState> : (
        <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3 px-5 pb-5">
          {risks.map((r) => <RiskCard key={r.a.accountId} r={r} />)}
        </div>
      )}
    </section>
  );
}

function RiskCard({ r }: { r: AccountRisk }) {
  const { a } = r;
  const ex = EXCHANGES[a.exchange];
  const mPct = r.equity > 0 ? r.margin / r.equity : null;
  const counts = [
    r.perps.length ? tr(`合约 ${r.perps.length}`, `${r.perps.length} perps`) : null,
    r.cfds.length ? `CFD ${r.cfds.length}` : null,
    r.options.length ? tr(`期权 ${r.options.length}`, `${r.options.length} options`) : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className={`relative rounded-xl border bg-bg-surface/60 p-4 flex flex-col gap-3.5 min-w-0 overflow-hidden ${a.error ? 'border-loss/30' : 'border-border-card'}`}>
      <div className="absolute inset-x-0 top-0 h-px" style={{ background: `linear-gradient(90deg, ${ex.color}, transparent 70%)` }} />
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-6 h-6 rounded-md grid place-items-center text-[10px] font-bold shrink-0" style={{ backgroundColor: `${ex.color}1f`, color: ex.color }}>{ex.short}</span>
          <div className="min-w-0">
            <div className="text-[13px] font-medium truncate">{a.label}</div>
            <div className="text-[11px] text-text-muted truncate">{counts}</div>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className={`num text-[16px] font-semibold ${pnlClass(r.upl)}`}>{fmtSigned(r.upl)}</div>
          <div className="text-[11px] text-text-muted">{tr('未实现盈亏', 'uPnL')}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
        <M label={tr('交易权益', 'Trading equity')} value={fmtUSD(r.equity, { decimals: false })}
          foot={Math.abs(a.equity - r.equity) >= 1 ? <>{tr('总', 'Total')} <span className="num">{fmtCompact(a.equity)}</span></> : undefined} />
        <M label={tr('保证金', 'Margin')} value={<>{r.marginEstimated && '≈'}{fmtUSD(r.margin, { decimals: false })}</>}
          hint={r.marginEstimated ? tr('交易所未提供，按 名义 ÷ 杠杆 估算', 'Not reported by the venue — estimated as notional ÷ leverage') : undefined}
          foot={mPct != null ? <span className={mPct >= 0.8 ? 'text-loss' : mPct >= 0.5 ? 'text-delayed' : ''}>{(mPct * 100).toFixed(1)}% {tr('权益', 'of eq.')}</span> : undefined} />
        <M label={tr('实际杠杆', 'Actual lev.')} value={r.lev != null ? fmtLev(r.lev) : '—'}
          hint={tr('合约 + CFD 总敞口 ÷ 交易权益', 'Perp + CFD gross exposure ÷ trading equity')}
          foot={<>{tr('总敞口', 'Gross')} <span className="num">{fmtCompact(r.x.gross)}</span></>} />
        <M label={tr('多 / 空', 'Long / short')}
          value={<><span className="text-profit">{fmtCompact(r.x.long)}</span><span className="text-text-muted text-[12px]"> / </span><span className="text-loss">{fmtCompact(r.x.short)}</span></>} />
        <M label={tr('净敞口', 'Net')} value={<span className={pnlClass(r.x.net)}>{fmtSigned(r.x.net, { decimals: false })}</span>}
          foot={r.equity > 0 ? <>{tr('净杠杆', 'Net lev.')} <span className="num">{fmtLev(Math.abs(r.x.net) / r.equity)}</span></> : undefined} />
        {r.liq != null ? (
          <M label={tr('最近强平', 'Nearest liq.')} value={<span className={liqClass(r.liq)}>{r.liq.toFixed(1)}%</span>}
            hint={tr('标记价距强平价的最小距离', 'Smallest distance from mark to liquidation price')} foot={r.liqSymbol ?? undefined} />
        ) : r.marginLevel != null ? (
          <M label={tr('保证金率', 'Margin level')} value={`${r.marginLevel >= 10000 ? r.marginLevel.toFixed(0) : r.marginLevel.toFixed(1)}%`}
            hint={tr('权益 ÷ 已用保证金', 'Equity ÷ used margin')} />
        ) : r.nextFunding != null ? (
          <M label={tr('下一轮资金费', 'Next funding')} value={<span className={pnlClass(r.nextFunding)}>{fmtSigned(r.nextFunding)}</span>} />
        ) : <M label={tr('最近强平', 'Nearest liq.')} value={<span className="text-text-muted">—</span>} />}
      </div>

      {mPct != null && (
        <div className="h-1 rounded-full overflow-hidden bg-bg-inset" title={tr('保证金占交易权益', 'Margin ÷ trading equity')}>
          <div className={`h-full rounded-full ${mPct >= 0.8 ? 'bg-loss' : mPct >= 0.5 ? 'bg-delayed' : 'bg-accent'}`} style={{ width: `${Math.min(mPct, 1) * 100}%` }} />
        </div>
      )}
    </div>
  );
}
