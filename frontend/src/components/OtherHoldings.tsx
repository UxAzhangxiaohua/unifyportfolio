import { useMemo, useState } from 'react';
import type { AccountSnapshot } from '../types';
import { fmtPrice, fmtQty, fmtSigned, fmtUSD, pnlClass } from '../lib/format';
import { ExchangeTag } from './ui';
import { flatten } from './PositionsTable';

/** Spot coins / stocks — collapsed by default since the focus is derivatives + stables */
export function OtherHoldings({ accounts }: { accounts: AccountSnapshot[] }) {
  const [open, setOpen] = useState(false);
  const rows = useMemo(
    () => flatten(accounts, (p) => ['crypto-spot', 'stock', 'etf'].includes(p.assetClass)).sort((a, b) => b.marketValue - a.marketValue),
    [accounts],
  );
  if (rows.length === 0) return null;

  return (
    <section className="card overflow-hidden">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-white/[0.015]">
        <span className="flex items-center gap-2.5">
          <span className={`text-text-muted text-[10px] transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
          <span className="section-title !text-text-secondary">其他持仓</span>
          <span className="text-[12px] text-text-muted">现货 / 股票 · {rows.length} 项（不计入合约统计）</span>
        </span>
      </button>
      {open && (
        <div className="overflow-x-auto border-t border-border-card">
          <table className="data">
            <thead>
              <tr><th>账户</th><th>资产</th><th className="r">数量</th><th className="r">成本价</th><th className="r">现价</th><th className="r">价值</th><th className="r">盈亏</th></tr>
            </thead>
            <tbody>
              {rows.map((p, i) => (
                <tr key={`${p.accountId}-${p.symbol}-${i}`}>
                  <td><ExchangeTag exchange={p.exchange} label={p.accountLabel} /></td>
                  <td className="font-medium">{p.symbol}</td>
                  <td className="r num">{fmtQty(p.quantity)}</td>
                  <td className="r num text-text-secondary">{fmtPrice(p.avgPrice)}</td>
                  <td className="r num">{fmtPrice(p.currentPrice)}</td>
                  <td className="r num">{p.marketValue ? fmtUSD(p.marketValue) : <span className="text-text-muted">未估值</span>}</td>
                  <td className={`r num ${pnlClass(p.unrealizedPnl)}`}>{p.unrealizedPnl ? fmtSigned(p.unrealizedPnl) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
