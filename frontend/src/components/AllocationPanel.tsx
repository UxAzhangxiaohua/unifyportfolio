import { useState } from 'react';
import type { PortfolioResponse } from '../types';
import { EXCHANGES } from '../lib/exchanges';
import { fmtCompact, fmtUSD } from '../lib/format';
import { tr } from '../lib/i18n';
import { CardHeader } from './ui';

// Validated (dark surface #11141b, adjacent CVD ΔE ≥ 10.9): trading / funding / earn match StablesPanel
const TYPE_COLORS = {
  trading: 'var(--color-loc-trading)',
  funding: 'var(--color-loc-funding)',
  earn: 'var(--color-loc-earn)',
  spot: '#4a90e2',
  option: '#d0679d',
  other: '#5d6475',
  transit: '#8a91a3',
} as const;
type TypeKey = keyof typeof TYPE_COLORS;

const TOP_ACCOUNTS = 8;

/** Where the money sits: by account and by kind of holding */
export function AllocationPanel({ data }: { data: PortfolioResponse }) {
  const total = data.totalEquity;
  return (
    <section className="card overflow-hidden">
      <CardHeader title={tr('资产分布', 'Allocation')} sub={<>{tr('总资产', 'Total')} <span className="num text-text-secondary">{fmtUSD(total, { decimals: false })}</span></>} />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-6 px-5 pb-5">
        <ByAccount data={data} />
        <ByType data={data} />
      </div>
    </section>
  );
}

function ByAccount({ data }: { data: PortfolioResponse }) {
  const [all, setAll] = useState(false);
  const total = data.totalEquity;
  const sorted = [...data.accounts].sort((a, b) => b.equity - a.equity);
  const max = Math.max(...sorted.map((a) => a.equity), 1);
  const head = all ? sorted : sorted.slice(0, TOP_ACCOUNTS);
  const rest = all ? [] : sorted.slice(TOP_ACCOUNTS);
  const restSum = rest.reduce((s, a) => s + a.equity, 0);

  return (
    <div className="min-w-0">
      <div className="text-[12px] font-medium text-text-secondary mb-3">{tr('按账户', 'By account')}</div>
      <div className="flex flex-col gap-2.5">
        {head.map((a) => {
          const ex = EXCHANGES[a.exchange];
          const pct = total > 0 ? (a.equity / total) * 100 : 0;
          return (
            <div key={a.accountId} className="grid grid-cols-[minmax(0,150px)_1fr_auto] items-center gap-3 text-[12.5px]" title={`${a.label}: ${fmtUSD(a.equity)}`}>
              <span className="inline-flex items-center gap-2 min-w-0">
                <i className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: ex.color }} />
                <span className="truncate text-text-secondary">{a.label}</span>
              </span>
              <div className="h-2 rounded-r-[4px] bg-bg-inset overflow-hidden">
                <div className="h-full rounded-r-[4px] transition-all duration-700" style={{ width: `${(Math.max(a.equity, 0) / max) * 100}%`, backgroundColor: ex.color, opacity: 0.85 }} />
              </div>
              <span className="num text-right whitespace-nowrap">
                {fmtCompact(a.equity)} <span className="text-text-muted inline-block w-[44px]">{pct.toFixed(1)}%</span>
              </span>
            </div>
          );
        })}
        {rest.length > 0 && (
          <button className="self-start text-[12px] text-text-muted hover:text-text-secondary" onClick={() => setAll(true)}>
            ▸ {tr(`其余 ${rest.length} 个账户`, `${rest.length} more accounts`)} <span className="num">{fmtCompact(restSum)}</span>
          </button>
        )}
        {all && sorted.length > TOP_ACCOUNTS && (
          <button className="self-start text-[12px] text-text-muted hover:text-text-secondary" onClick={() => setAll(false)}>▾ {tr('收起', 'Show less')}</button>
        )}
      </div>
    </div>
  );
}

function ByType({ data }: { data: PortfolioResponse }) {
  const total = data.totalEquity;
  const stables = data.accounts.flatMap((a) => a.stables ?? []);
  const loc = (l: 'trading' | 'funding' | 'earn') => stables.filter((s) => s.location === l).reduce((s, b) => s + b.amount, 0);
  const pos = data.accounts.flatMap((a) => a.positions);
  const spot = pos.filter((p) => ['crypto-spot', 'stock', 'etf'].includes(p.assetClass)).reduce((s, p) => s + Math.abs(p.marketValue), 0);
  // Long options are assets, short options liabilities
  const option = pos.filter((p) => p.assetClass === 'option').reduce((s, p) => s + (p.side === 'short' ? -1 : 1) * Math.abs(p.marketValue), 0);
  const transit = data.inTransit ?? 0;
  const known = loc('trading') + loc('funding') + loc('earn') + spot + option + transit;

  const parts: Array<{ k: TypeKey; label: string; v: number; hint?: string }> = [
    { k: 'trading', label: tr('稳定币 · 交易账户', 'Stables · trading'), v: loc('trading') },
    { k: 'funding', label: tr('稳定币 · 资金账户', 'Stables · funding'), v: loc('funding') },
    { k: 'earn', label: tr('稳定币 · 理财', 'Stables · earn'), v: loc('earn') },
    { k: 'spot', label: tr('现货 / 股票', 'Spot / stocks'), v: spot },
    { k: 'option', label: tr('期权净权利金', 'Options (net premium)'), v: option },
    { k: 'transit', label: tr('转账在途', 'In transit'), v: transit },
    { k: 'other', label: tr('浮动盈亏及其他', 'Unrealized PnL & other'), v: total - known,
      hint: tr('总资产减去以上各项：合约 / CFD 浮动盈亏、非稳定币保证金等', 'Total minus the rows above: perp / CFD floating PnL, non-stablecoin collateral, …') },
  ].filter((p) => Math.abs(p.v) >= 1) as Array<{ k: TypeKey; label: string; v: number; hint?: string }>;
  const posSum = parts.reduce((s, p) => s + Math.max(p.v, 0), 0);

  return (
    <div className="min-w-0">
      <div className="text-[12px] font-medium text-text-secondary mb-3">{tr('按资金类型', 'By type')}</div>
      <div className="h-3 flex gap-[2px] rounded-[4px] overflow-hidden bg-bg-inset mb-4">
        {posSum > 0 && parts.filter((p) => p.v > 0).map((p) => (
          <div key={p.k} className="h-full transition-all duration-700" title={`${p.label}: ${fmtUSD(p.v)}`}
            style={{ width: `${(p.v / posSum) * 100}%`, backgroundColor: TYPE_COLORS[p.k] }} />
        ))}
      </div>
      <table className="w-full text-[12.5px]">
        <tbody>
          {parts.map((p) => (
            <tr key={p.k} title={p.hint} className="border-t border-border-card/60 first:border-t-0">
              <td className="py-2">
                <span className="inline-flex items-center gap-2">
                  <i className="w-2.5 h-2.5 rounded-[3px] shrink-0" style={{ backgroundColor: TYPE_COLORS[p.k] }} />
                  <span className="text-text-secondary">{p.label}</span>
                  {p.hint && <span className="text-text-muted text-[11px]">ⓘ</span>}
                </span>
              </td>
              <td className="py-2 text-right num">{fmtUSD(p.v, { decimals: false })}</td>
              <td className="py-2 text-right num text-text-muted w-[64px]">{total > 0 ? `${((p.v / total) * 100).toFixed(1)}%` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
