import { useMemo } from 'react';
import type { AccountSnapshot } from '../types';
import { daysToExpiry, fmtPrice, fmtQty, fmtSigned, fmtUSD, pnlClass } from '../lib/format';
import { CardHeader, EmptyState, ExchangeTag, SideBadge } from './ui';
import { flatten } from './PositionsTable';

export function OptionsTable({ accounts }: { accounts: AccountSnapshot[] }) {
  const rows = useMemo(() => {
    const r = flatten(accounts, (p) => p.assetClass === 'option');
    return r.sort((a, b) => (a.option?.expiry ?? '').localeCompare(b.option?.expiry ?? '') || (a.option?.strike ?? 0) - (b.option?.strike ?? 0));
  }, [accounts]);

  const upl = rows.reduce((s, p) => s + p.unrealizedPnl, 0);
  // Net premium value: long options are assets, short options liabilities
  const net = rows.reduce((s, p) => s + (p.side === 'short' ? -1 : 1) * p.marketValue, 0);

  return (
    <section className="card overflow-hidden">
      <CardHeader
        title="期权持仓"
        sub={rows.length ? <>{rows.length} 个 · 净权利金价值 <span className="num">{fmtSigned(net, { decimals: false })}</span> · 盈亏 <span className={`num ${pnlClass(upl)}`}>{fmtSigned(upl)}</span></> : undefined}
      />
      {rows.length === 0 ? <EmptyState>当前没有期权持仓</EmptyState> : (
        <div className="overflow-x-auto">
          <table className="data">
            <thead>
              <tr>
                <th>账户</th>
                <th>标的</th>
                <th>类型</th>
                <th className="r">行权价</th>
                <th>到期</th>
                <th>方向</th>
                <th className="r">数量</th>
                <th className="r">开仓价</th>
                <th className="r">标记价</th>
                <th className="r">价值</th>
                <th className="r">未实现盈亏</th>
                <th className="r">Delta</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p, i) => {
                const o = p.option;
                const dte = o?.expiry ? daysToExpiry(o.expiry) : null;
                const ccy = o?.premiumCcy;
                return (
                  <tr key={`${p.accountId}-${p.symbol}-${i}`} title={p.symbol}>
                    <td className="max-w-[160px]"><ExchangeTag exchange={p.exchange} label={p.accountLabel} /></td>
                    <td className="font-semibold">{o?.underlying ?? p.symbol}</td>
                    <td>
                      {o ? (
                        <span className={`text-[11px] font-semibold px-1.5 py-0.5 rounded ${o.type === 'call' ? 'bg-profit/10 text-profit' : 'bg-loss/10 text-loss'}`}>
                          {o.type === 'call' ? 'CALL' : 'PUT'}
                        </span>
                      ) : <span className="text-text-muted">—</span>}
                    </td>
                    <td className="r num">{o ? o.strike.toLocaleString('en-US') : '—'}</td>
                    <td>
                      <span className="num">{o?.expiry ? o.expiry.slice(2) : '—'}</span>
                      {dte != null && (
                        <span className={`num text-[11px] ml-2 ${dte < 2 ? 'text-loss' : dte < 7 ? 'text-delayed' : 'text-text-muted'}`}>
                          {dte < 1 ? `${Math.max(dte * 24, 0).toFixed(0)}h` : `${dte.toFixed(0)}d`}
                        </span>
                      )}
                    </td>
                    <td><SideBadge side={p.side} /></td>
                    <td className="r num">{fmtQty(p.quantity)}</td>
                    <td className="r num text-text-secondary">{fmtPrice(p.avgPrice)}{ccy && <span className="text-text-muted text-[10px] ml-1">{ccy}</span>}</td>
                    <td className="r num">{fmtPrice(p.currentPrice)}{ccy && <span className="text-text-muted text-[10px] ml-1">{ccy}</span>}</td>
                    <td className="r num">{fmtUSD(p.marketValue)}</td>
                    <td className={`r num font-medium ${pnlClass(p.unrealizedPnl)}`}>{fmtSigned(p.unrealizedPnl)}</td>
                    <td className="r num text-text-secondary">{o?.delta != null ? o.delta.toFixed(3) : '—'}</td>
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
