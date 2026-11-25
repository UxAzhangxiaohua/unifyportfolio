import { useState } from 'react';
import type { AccountSnapshot } from '../types';
import { fmtCompact, fmtSigned, pnlClass } from '../lib/format';
import { byUnderlying } from '../lib/risk';
import { tr } from '../lib/i18n';
import { CardHeader } from './ui';

const TOP = 10;

const signedOrDash = (v: number) => (Math.abs(v) < 0.5 ? <span className="text-text-muted">—</span> : <span className={pnlClass(v)}>{fmtSigned(v, { decimals: false })}</span>);

/** Net exposure per underlying across all accounts and instruments (perps, CFD, options $delta) */
export function ExposureByUnderlying({ accounts }: { accounts: AccountSnapshot[] }) {
  const [all, setAll] = useState(false);
  const rows = byUnderlying(accounts);
  if (!rows.length) return null;
  const hasCfd = rows.some((r) => r.cfd !== 0);
  const hasOpt = rows.some((r) => r.opt !== 0);
  const gross = rows.reduce((s, r) => s + r.long + r.short, 0);
  const max = Math.max(...rows.map((r) => Math.abs(r.net)), 1);
  const shown = all ? rows : rows.slice(0, TOP);

  return (
    <section className="card overflow-hidden">
      <CardHeader title={tr('按标的敞口', 'Exposure by underlying')}
        sub={tr('跨账户合并：合约 + CFD + 期权 $Delta；XAUT / PAXG / XAUUSD 合并为 XAU，USTEC / NAS100 合并', 'Merged across accounts: perps + CFD + options $delta; XAUT / PAXG / XAUUSD → XAU, USTEC / NAS100 merged')} />
      <div className="overflow-x-auto border-t border-border-card">
        <table className="data">
          <thead>
            <tr>
              <th>{tr('标的', 'Underlying')}</th>
              <th className="w-[32%] min-w-[200px]">{tr('净敞口', 'Net exposure')}</th>
              <th className="r">{tr('合约', 'Perps')}</th>
              {hasCfd && <th className="r">CFD</th>}
              {hasOpt && <th className="r" title={tr('Σ delta × 标的价格', 'Σ delta × underlying price')}>{tr('期权 $Δ', 'Options $Δ')}</th>}
              <th className="r">{tr('多 / 空', 'Long / short')}</th>
              <th className="r">{tr('占总敞口', 'Of gross')}</th>
              <th className="r">{tr('未实现盈亏', 'uPnL')}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const w = (Math.abs(r.net) / max) * 50;
              const share = gross > 0 ? ((r.long + r.short) / gross) * 100 : 0;
              return (
                <tr key={r.key}>
                  <td>
                    <div className="font-semibold">{r.key}</div>
                    <div className="text-[11px] text-text-muted truncate max-w-[220px]" title={[...r.accounts].join(', ')}>{[...r.accounts].join(' · ')}</div>
                  </td>
                  <td>
                    <div className="flex items-center gap-3">
                      <div className="relative h-2.5 flex-1 min-w-[120px]" title={fmtSigned(r.net, { decimals: false })}>
                        <div className="absolute inset-y-[-3px] left-1/2 w-px bg-border-hover" />
                        <div className={`absolute inset-y-0 rounded-[3px] ${r.net >= 0 ? 'bg-profit/80' : 'bg-loss/80'}`}
                          style={r.net >= 0 ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }} />
                      </div>
                      <span className={`num text-[12.5px] font-medium w-[86px] text-right ${pnlClass(r.net)}`}>{fmtSigned(r.net, { decimals: false })}</span>
                    </div>
                  </td>
                  <td className="r num">{signedOrDash(r.perp)}</td>
                  {hasCfd && <td className="r num">{signedOrDash(r.cfd)}</td>}
                  {hasOpt && <td className="r num">{signedOrDash(r.opt)}</td>}
                  <td className="r num text-[12px]"><span className="text-profit">{fmtCompact(r.long)}</span><span className="text-text-muted"> / </span><span className="text-loss">{fmtCompact(r.short)}</span></td>
                  <td className="r num text-text-secondary">{share.toFixed(1)}%</td>
                  <td className={`r num ${pnlClass(r.upl)}`}>{fmtSigned(r.upl)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length > TOP && (
          <button className="w-full py-2.5 text-[12px] text-text-secondary hover:text-text-primary border-t border-border-card" onClick={() => setAll(!all)}>
            {all ? tr('收起', 'Show less') : tr(`显示全部 ${rows.length} 个标的`, `Show all ${rows.length}`)}
          </button>
        )}
      </div>
    </section>
  );
}
