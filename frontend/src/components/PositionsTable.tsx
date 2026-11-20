import { useMemo, useState } from 'react';
import type { AccountSnapshot, ExchangeType, Position } from '../types';
import { EXCHANGES } from '../lib/exchanges';
import { fmtCompact, fmtPct, fmtPrice, fmtQty, fmtSigned, fmtUSD, pnlClass } from '../lib/format';
import { CardHeader, EmptyState, ExchangeTag, Segmented, SideBadge } from './ui';

type Row = Position & { accountLabel: string; exchange: ExchangeType; accountId: string };
type SortKey = 'value' | 'pnl' | 'symbol' | 'liq';

export function flatten(accounts: AccountSnapshot[], pred: (p: Position) => boolean): Row[] {
  return accounts.flatMap((a) =>
    a.positions.filter(pred).map((p) => ({ ...p, accountLabel: a.label, exchange: a.exchange, accountId: a.accountId })),
  );
}

/** Distance from mark to liquidation, as % of mark (always positive = room left) */
function liqDistance(p: Position): number | null {
  if (!p.liquidationPrice || !p.currentPrice) return null;
  const d = p.side === 'long'
    ? (p.currentPrice - p.liquidationPrice) / p.currentPrice
    : (p.liquidationPrice - p.currentPrice) / p.currentPrice;
  return d * 100;
}

export function PositionsTable({ accounts }: { accounts: AccountSnapshot[] }) {
  const [ex, setEx] = useState<ExchangeType | 'all'>('all');
  const [sort, setSort] = useState<{ k: SortKey; asc: boolean }>({ k: 'value', asc: false });

  const all = useMemo(() => flatten(accounts, (p) => p.assetClass === 'crypto-perp' || p.assetClass === 'crypto-future'), [accounts]);
  const exchanges = [...new Set(all.map((p) => p.exchange))];

  const rows = useMemo(() => {
    const r = ex === 'all' ? all : all.filter((p) => p.exchange === ex);
    const dir = sort.asc ? 1 : -1;
    return [...r].sort((a, b) => {
      switch (sort.k) {
        case 'symbol': return dir * a.symbol.localeCompare(b.symbol);
        case 'pnl': return dir * (a.unrealizedPnl - b.unrealizedPnl);
        case 'liq': return dir * ((liqDistance(a) ?? 1e9) - (liqDistance(b) ?? 1e9));
        default: return dir * (a.marketValue - b.marketValue);
      }
    });
  }, [all, ex, sort]);

  const upl = rows.reduce((s, p) => s + p.unrealizedPnl, 0);
  const notional = rows.reduce((s, p) => s + p.marketValue, 0);

  const Th = ({ k, children, r }: { k: SortKey; children: string; r?: boolean }) => (
    <th className={`cursor-pointer select-none hover:text-text-secondary ${r ? 'r' : ''}`}
      onClick={() => setSort((s) => ({ k, asc: s.k === k ? !s.asc : k === 'liq' || k === 'symbol' }))}>
      {children}{sort.k === k && <span className="text-accent ml-1">{sort.asc ? '↑' : '↓'}</span>}
    </th>
  );

  return (
    <section className="card overflow-hidden">
      <CardHeader
        title="合约持仓"
        sub={all.length ? <>{rows.length} 个 · 名义 <span className="num">{fmtCompact(notional)}</span> · 盈亏 <span className={`num ${pnlClass(upl)}`}>{fmtSigned(upl)}</span></> : undefined}
        right={exchanges.length > 1 && (
          <Segmented value={ex} onChange={setEx}
            options={[{ value: 'all' as const, label: '全部' }, ...exchanges.map((e) => ({ value: e, label: EXCHANGES[e].name }))]} />
        )}
      />
      {rows.length === 0 ? <EmptyState>当前没有永续 / 交割合约持仓</EmptyState> : (
        <div className="overflow-x-auto">
          <table className="data">
            <thead>
              <tr>
                <th>账户</th>
                <Th k="symbol">合约</Th>
                <th>方向</th>
                <th className="r">数量</th>
                <th className="r">开仓价</th>
                <th className="r">标记价</th>
                <Th k="value" r>名义价值</Th>
                <Th k="pnl" r>未实现盈亏</Th>
                <th className="r">杠杆</th>
                <Th k="liq" r>强平价 / 距离</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p, i) => {
                const roe = p.avgPrice > 0 ? ((p.currentPrice - p.avgPrice) / p.avgPrice) * 100 * (p.side === 'short' ? -1 : 1) : 0;
                const dist = liqDistance(p);
                return (
                  <tr key={`${p.accountId}-${p.symbol}-${i}`}>
                    <td className="max-w-[160px]"><ExchangeTag exchange={p.exchange} label={p.accountLabel} /></td>
                    <td>
                      <span className="font-semibold">{p.symbol}</span>
                      {p.assetClass === 'crypto-future' && <span className="chip ml-2 !text-[10px] !py-0">交割</span>}
                    </td>
                    <td><SideBadge side={p.side} /></td>
                    <td className="r num">{fmtQty(p.quantity)}</td>
                    <td className="r num text-text-secondary">{fmtPrice(p.avgPrice)}</td>
                    <td className="r num">{fmtPrice(p.currentPrice)}</td>
                    <td className="r num">{fmtUSD(p.marketValue, { decimals: false })}</td>
                    <td className="r">
                      <div className={`num font-medium ${pnlClass(p.unrealizedPnl)}`}>{fmtSigned(p.unrealizedPnl)}</div>
                      {roe !== 0 && <div className={`num text-[11px] opacity-70 ${pnlClass(roe)}`}>{fmtPct(roe)}</div>}
                    </td>
                    <td className="r num text-text-secondary">{p.leverage ? `${p.leverage}×` : '—'}</td>
                    <td className="r">
                      <div className="num text-text-secondary">{p.liquidationPrice ? fmtPrice(p.liquidationPrice) : '—'}</div>
                      {dist != null && (
                        <div className={`num text-[11px] ${dist < 10 ? 'text-loss' : dist < 25 ? 'text-delayed' : 'text-text-muted'}`}>{dist.toFixed(1)}%</div>
                      )}
                    </td>
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
