import { Fragment, useState } from 'react';
import type { AccountSnapshot, StableBalance, StableLocation } from '../types';
import { LOCATION_LABEL } from '../lib/exchanges';
import { fmtUSD } from '../lib/format';
import { CardHeader, EmptyState, ExchangeTag } from './ui';

const LOCS: StableLocation[] = ['trading', 'funding', 'earn'];

interface Row {
  account: AccountSnapshot;
  usdt: number;
  usdc: number;
  byLoc: Record<StableLocation, number>;
  total: number;
}

function summarize(stables: StableBalance[]) {
  const byLoc: Record<StableLocation, number> = { trading: 0, funding: 0, earn: 0 };
  let usdt = 0, usdc = 0;
  for (const s of stables) {
    byLoc[s.location] += s.amount;
    if (s.asset === 'USDT') usdt += s.amount; else usdc += s.amount;
  }
  return { usdt, usdc, byLoc, total: usdt + usdc };
}

const Cell = ({ v, cls = '' }: { v: number; cls?: string }) => (
  <td className={`r num ${Math.abs(v) < 0.005 ? 'text-text-muted/50' : cls}`}>{Math.abs(v) < 0.005 ? '—' : fmtUSD(v)}</td>
);

export function StablesPanel({ accounts }: { accounts: AccountSnapshot[] }) {
  const [open, setOpen] = useState<string | null>(null);

  const rows: Row[] = accounts
    .filter((a) => a.exchange !== 'ibkr')
    .map((a) => ({ account: a, ...summarize(a.stables ?? []) }))
    .sort((a, b) => b.total - a.total || b.account.equity - a.account.equity);

  const tot = summarize(accounts.flatMap((a) => a.stables ?? []));

  return (
    <section className="card overflow-hidden">
      <CardHeader title="稳定币持仓" sub="USDT / USDC · 交易 + 资金 + 理财" right={
        <div className="flex gap-3 text-[12px] text-text-secondary">
          {LOCS.map((l) => (
            <span key={l} className="inline-flex items-center gap-1.5">
              <i className={`w-2 h-2 rounded-sm ${l === 'trading' ? 'bg-accent' : l === 'funding' ? 'bg-text-muted' : 'bg-earn'}`} />
              {LOCATION_LABEL[l]}
            </span>
          ))}
        </div>
      } />
      {rows.length === 0 ? <EmptyState>暂无加密账户</EmptyState> : (
        <div className="overflow-x-auto">
          <table className="data">
            <thead>
              <tr>
                <th>账户</th>
                <th className="r">USDT</th>
                <th className="r">USDC</th>
                <th className="r">交易账户</th>
                <th className="r">资金账户</th>
                <th className="r">理财</th>
                <th className="r">合计</th>
                <th className="w-[22%] min-w-[140px]">分布</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const id = r.account.accountId;
                const isOpen = open === id;
                return (
                  <Fragment key={id}>
                    <tr className="cursor-pointer" onClick={() => setOpen(isOpen ? null : id)}>
                      <td>
                        <span className="inline-flex items-center gap-2">
                          <span className={`text-text-muted text-[10px] transition-transform ${isOpen ? 'rotate-90' : ''}`}>▶</span>
                          <ExchangeTag exchange={r.account.exchange} label={r.account.label} />
                          {r.account.warnings?.length ? (
                            <span className="text-delayed text-[11px]" title={r.account.warnings.join('\n')}>部分数据缺失</span>
                          ) : null}
                        </span>
                      </td>
                      <Cell v={r.usdt} />
                      <Cell v={r.usdc} />
                      <Cell v={r.byLoc.trading} cls="text-text-secondary" />
                      <Cell v={r.byLoc.funding} cls="text-text-secondary" />
                      <Cell v={r.byLoc.earn} cls="text-earn" />
                      <Cell v={r.total} cls="font-semibold" />
                      <td><LocBar byLoc={r.byLoc} /></td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={8} className="!py-0 !px-0 bg-bg-inset/60">
                          <div className="px-12 py-3 grid gap-1.5 text-[12.5px]">
                            {(r.account.stables ?? []).length === 0 && <span className="text-text-muted">无稳定币余额</span>}
                            {[...(r.account.stables ?? [])].sort((a, b) => b.amount - a.amount).map((s, i) => (
                              <div key={i} className="flex items-center gap-3">
                                <span className={`w-12 text-[11px] font-medium ${s.asset === 'USDT' ? 'text-usdt' : 'text-usdc'}`}>{s.asset}</span>
                                <span className="w-20 text-text-muted">{LOCATION_LABEL[s.location]}</span>
                                <span className="flex-1 text-text-secondary">{s.source}</span>
                                <span className="num">{fmtUSD(s.amount)}</span>
                              </div>
                            ))}
                            {r.account.warnings?.map((w, i) => <div key={`w${i}`} className="text-delayed/90 text-[11.5px] truncate">⚠ {w}</div>)}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-border-hover">
                <td className="!pl-5 py-3 text-[12px] text-text-secondary font-medium">合计</td>
                <Cell v={tot.usdt} cls="font-semibold text-usdt" />
                <Cell v={tot.usdc} cls="font-semibold text-usdc" />
                <Cell v={tot.byLoc.trading} cls="font-medium" />
                <Cell v={tot.byLoc.funding} cls="font-medium" />
                <Cell v={tot.byLoc.earn} cls="font-medium text-earn" />
                <Cell v={tot.total} cls="font-semibold text-[14px]" />
                <td className="!pr-5"><LocBar byLoc={tot.byLoc} /></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

function LocBar({ byLoc }: { byLoc: Record<StableLocation, number> }) {
  const total = LOCS.reduce((s, l) => s + Math.max(byLoc[l], 0), 0);
  if (total <= 0) return <div className="h-1.5 rounded-full bg-bg-inset" />;
  const color = { trading: 'var(--color-accent)', funding: 'var(--color-text-muted)', earn: 'var(--color-earn)' };
  return (
    <div className="h-1.5 rounded-full overflow-hidden flex gap-px bg-bg-inset"
      title={LOCS.map((l) => `${LOCATION_LABEL[l]} ${((Math.max(byLoc[l], 0) / total) * 100).toFixed(0)}%`).join(' · ')}>
      {LOCS.map((l) => (
        <div key={l} className="h-full" style={{ width: `${(Math.max(byLoc[l], 0) / total) * 100}%`, backgroundColor: color[l] }} />
      ))}
    </div>
  );
}
