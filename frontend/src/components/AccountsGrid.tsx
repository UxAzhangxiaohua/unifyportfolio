import { useEffect, useState } from 'react';
import type { AccountSnapshot } from '../types';
import { EXCHANGES } from '../lib/exchanges';
import { fmtCompact, fmtSigned, fmtUSD, pnlClass, timeAgo } from '../lib/format';
import { StatusDot } from './ui';
import { tr } from '../lib/i18n';

const SMALL_USD = 10;
const FOLD_KEY = 'unify.foldSmallAccounts';

export function AccountsGrid({ accounts, total }: { accounts: AccountSnapshot[]; total: number }) {
  const [fold, setFold] = useState(() => {
    try { return localStorage.getItem(FOLD_KEY) !== '0'; } catch { return true; }
  });
  useEffect(() => { try { localStorage.setItem(FOLD_KEY, fold ? '1' : '0'); } catch { /* ignore */ } }, [fold]);

  const sorted = [...accounts].sort((a, b) => b.equity - a.equity);
  // Accounts in error stay visible even when small: the error is what needs attention
  const isSmall = (a: AccountSnapshot) => Math.abs(a.equity) < SMALL_USD && !a.error;
  const small = sorted.filter(isSmall);
  const shown = fold ? sorted.filter((a) => !isSmall(a)) : sorted;

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5 gap-3">
        {shown.map((a) => <AccountCard key={a.accountId} a={a} total={total} />)}
      </div>
      {small.length > 0 && (
        <button type="button" onClick={() => setFold(!fold)}
          className="self-start text-[12px] text-text-muted hover:text-text-secondary transition-colors">
          {fold
            ? <>▸ {tr(`显示 ${small.length} 个小于 $${SMALL_USD} 的账户`, `Show ${small.length} account(s) under $${SMALL_USD}`)}
                <span className="num ml-1.5">({small.map((a) => EXCHANGES[a.exchange].short).join(' · ')}, {fmtUSD(small.reduce((s, a) => s + a.equity, 0))})</span></>
            : <>▾ {tr(`折叠小于 $${SMALL_USD} 的账户`, `Fold accounts under $${SMALL_USD}`)}</>}
        </button>
      )}
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
          {a.error ? tr('错误', 'Error') : a.isDelayed ? tr('延迟', 'Delayed') : timeAgo(a.fetchedAt)}
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
            <div className="text-text-muted text-[11px]">{tr('稳定币', 'Stables')}</div>
            <div className="num">{fmtCompact(stables)}</div>
          </div>
          <div className="rounded-lg bg-bg-inset px-2.5 py-2">
            <div className="text-text-muted text-[11px]">{tr('理财', 'Earn')}</div>
            <div className="num text-earn">{fmtCompact(earn)}</div>
          </div>
        </div>
      )}

      {mr != null && (
        <div>
          <div className="flex justify-between text-[11px] text-text-muted mb-1">
            <span>{tr('保证金占用', 'Margin used')}</span>
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
        <span>{tr('合约', 'Perps')} <span className="text-text-secondary">{perps}</span></span>
        <span>{tr('期权', 'Options')} <span className="text-text-secondary">{opts}</span></span>
        {a.warnings?.length ? <span className="text-delayed ml-auto" title={a.warnings.join('\n')}>⚠ {a.warnings.length}</span> : null}
      </div>
    </div>
  );
}
