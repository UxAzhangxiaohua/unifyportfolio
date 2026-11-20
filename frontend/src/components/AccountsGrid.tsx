import type { AccountSnapshot } from '../types';
import { EXCHANGES } from '../lib/exchanges';
import { fmtCompact, fmtSigned, fmtUSD, pnlClass, timeAgo } from '../lib/format';
import { StatusDot } from './ui';

export function AccountsGrid({ accounts, total }: { accounts: AccountSnapshot[]; total: number }) {
  const sorted = [...accounts].sort((a, b) => b.equity - a.equity);
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5 gap-3">
      {sorted.map((a) => <AccountCard key={a.accountId} a={a} total={total} />)}
    </div>
  );
}

function AccountCard({ a, total }: { a: AccountSnapshot; total: number }) {
  const ex = EXCHANGES[a.exchange];
  const stables = (a.stables ?? []).reduce((s, b) => s + b.amount, 0);
  const earn = (a.stables ?? []).filter((b) => b.location === 'earn').reduce((s, b) => s + b.amount, 0);
  const perps = a.positions.filter((p) => p.assetClass === 'crypto-perp' || p.assetClass === 'crypto-future').length;
  const opts = a.positions.filter((p) => p.assetClass === 'option').length;
  const share = total > 0 ? (a.equity / total) * 100 : 0;
  const mr = a.marginRatio;
  const status = a.error ? 'error' : a.isDelayed ? 'delayed' : 'ok';

  return (
    <div className={`card p-4 flex flex-col gap-3 relative overflow-hidden transition-colors hover:border-border-hover ${a.error ? 'border-loss/30' : ''}`}>
      <div className="absolute inset-x-0 top-0 h-px" style={{ background: `linear-gradient(90deg, ${ex.color}, transparent 70%)` }} />
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-6 h-6 rounded-md grid place-items-center text-[10px] font-bold shrink-0"
            style={{ backgroundColor: `${ex.color}1f`, color: ex.color }}>{ex.short}</span>
          <span className="text-[13px] font-medium truncate">{a.label}</span>
        </div>
        <span className="inline-flex items-center gap-1.5 text-[11px] text-text-muted shrink-0"
          title={a.error ?? a.warnings?.join('\n') ?? ''}>
          <StatusDot status={status} />
          {a.error ? '错误' : a.isDelayed ? '延迟' : timeAgo(a.fetchedAt)}
        </span>
      </div>

      <div>
        <div className="num text-[22px] font-semibold leading-tight">{fmtUSD(a.equity, { decimals: false })}</div>
        <div className="flex items-center justify-between text-[12px] mt-1">
          <span className={`num ${pnlClass(a.unrealizedPnl)}`}>{fmtSigned(a.unrealizedPnl)}</span>
          <span className="num text-text-muted">{share.toFixed(1)}%</span>
        </div>
      </div>

      {a.exchange !== 'ibkr' && (
        <div className="grid grid-cols-2 gap-2 text-[12px]">
          <div className="rounded-lg bg-bg-inset px-2.5 py-2">
            <div className="text-text-muted text-[11px]">稳定币</div>
            <div className="num">{fmtCompact(stables)}</div>
          </div>
          <div className="rounded-lg bg-bg-inset px-2.5 py-2">
            <div className="text-text-muted text-[11px]">理财</div>
            <div className="num text-earn">{fmtCompact(earn)}</div>
          </div>
        </div>
      )}

      {mr != null && (
        <div>
          <div className="flex justify-between text-[11px] text-text-muted mb-1">
            <span>保证金占用</span>
            <span className="num">{(mr * 100).toFixed(1)}%</span>
          </div>
          <div className="h-1 bg-bg-inset rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all duration-700" style={{
              width: `${Math.min(mr * 100, 100)}%`,
              backgroundColor: mr > 0.8 ? 'var(--color-loss)' : mr > 0.5 ? 'var(--color-delayed)' : 'var(--color-profit)',
            }} />
          </div>
        </div>
      )}

      <div className="flex gap-3 text-[11.5px] text-text-muted mt-auto">
        <span>合约 <span className="text-text-secondary">{perps}</span></span>
        <span>期权 <span className="text-text-secondary">{opts}</span></span>
        {a.warnings?.length ? <span className="text-delayed ml-auto" title={a.warnings.join('\n')}>⚠ {a.warnings.length}</span> : null}
      </div>
    </div>
  );
}
