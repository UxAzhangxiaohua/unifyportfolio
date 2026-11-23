import { Fragment, useState, type ReactNode } from 'react';
import type { AccountSnapshot, CfdAccountState, Position } from '../types';
import { fmtCompact, fmtPrice, fmtQty, fmtSigned, fmtUSD, pnlClass } from '../lib/format';
import { tr } from '../lib/i18n';
import { CardHeader, ExchangeTag, SideBadge } from './ui';
import { flatten } from './PositionsTable';

// CFD / margin accounts (Bitget CFD, Bybit TradFi, MT5 investor logins): equity, margin, actual
// leverage (Σ notional / equity) vs the leverage setting, and the planned outcome of the TP/SL
// orders set on the positions (MT5) — exits are managed by TP/SL, so no stop-out risk display.

const fmtLev = (x: number) => `${x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2)}x`;

function Metric({ label, value, foot, hint }: { label: string; value: ReactNode; foot?: ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-1 min-w-0" title={hint}>
      <span className="text-[11px] text-text-muted truncate">{label}</span>
      <span className="num text-[15px] font-semibold leading-tight truncate">{value}</span>
      {foot && <span className="text-[11px] text-text-muted truncate">{foot}</span>}
    </div>
  );
}

/** Σ PnL at TP (or SL) over positions, plus how many positions have no TP (SL) set */
function planned(positions: Position[], k: 'tpPnl' | 'slPnl') {
  const set = positions.filter((p) => p[k] != null);
  return { sum: set.reduce((s, p) => s + (p[k] as number), 0), set: set.length, missing: positions.length - set.length };
}

function PlanMetric({ label, positions, k, equity }: { label: string; positions: Position[]; k: 'tpPnl' | 'slPnl'; equity: number }) {
  const r = planned(positions, k);
  if (!positions.length) return <Metric label={label} value="—" />;
  if (!r.set) return <Metric label={label} value="—" foot={tr('未设置', 'Not set')} />;
  return (
    <Metric label={label}
      value={<span className={pnlClass(r.sum)}>{fmtSigned(r.sum)}</span>}
      foot={<>
        {equity > 0 && <span className="num">{r.sum >= 0 ? '+' : ''}{((r.sum / equity) * 100).toFixed(1)}% {tr('权益', 'equity')}</span>}
        {r.missing > 0 && <span className="text-delayed"> · {tr(`${r.missing} 笔未设`, `${r.missing} unset`)}</span>}
      </>}
      hint={tr('全部持仓按各自止盈/止损价平仓的价格盈亏，不含隔夜利息与手续费', 'Price PnL if every position closes at its TP/SL; excl. swap & commission')} />
  );
}

function CfdCard({ a, c }: { a: AccountSnapshot; c: CfdAccountState }) {
  const positions = a.positions.filter((p) => p.assetClass === 'cfd');
  const hasPlan = positions.some((p) => p.tp != null || p.sl != null || p.tpPnl != null || p.slPnl != null);

  return (
    <div className="rounded-xl border border-border-card bg-bg-surface/60 p-4 flex flex-col gap-4 min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        <ExchangeTag exchange={a.exchange} label={a.label} />
        {a.exchange !== 'mt5' && <span className="text-[12px] text-text-muted truncate">{c.name}</span>}
      </div>

      {c.equityOnly ? (
        <div className="flex flex-col gap-1">
          <Metric label={tr('权益', 'Equity')} value={fmtUSD(c.equity)} />
          <span className="text-[11px] text-text-muted">{tr('该账户运行在 MT5 上，交易所 API 仅提供权益，无保证金与持仓数据', 'Runs on MT5 — the venue API only exposes equity, not margin or positions')}</span>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3">
            <Metric label={tr('权益', 'Equity')} value={fmtUSD(c.equity)} foot={<>{tr('余额', 'Balance')} <span className="num">{fmtUSD(c.balance)}</span></>} />
            <Metric label={tr('浮动盈亏', 'Floating PnL')} value={<span className={pnlClass(c.floatingPnl)}>{fmtSigned(c.floatingPnl)}</span>}
              hint={tr('权益 − 余额，含隔夜利息与手续费', 'Equity − balance, incl. swap & commission')} />
            <Metric label={tr('已用保证金', 'Used margin')} value={<>{c.marginEstimated && '≈'}{fmtUSD(c.usedMargin)}</>}
              hint={c.marginEstimated ? tr('服务器未返回保证金，按 名义价值 ÷ 杠杆 估算', 'Not reported by the server — estimated as notional ÷ leverage') : undefined}
              foot={<>{tr('可用', 'Free')} <span className="num">{fmtUSD(c.freeMargin)}</span></>} />
            <Metric label={tr('保证金率', 'Margin level')}
              value={c.marginLevel == null ? '—' : `${c.marginLevel >= 10000 ? c.marginLevel.toFixed(0) : c.marginLevel.toFixed(1)}%`}
              hint={tr('权益 ÷ 已用保证金', 'Equity ÷ used margin')} />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3 pt-3 border-t border-border-card">
            <Metric label={tr('实际杠杆', 'Actual leverage')}
              value={c.effectiveLeverage == null ? '—' : fmtLev(c.effectiveLeverage)}
              foot={<>{tr('名义敞口', 'Notional')} <span className="num">{fmtCompact(c.notional)}</span></>}
              hint={tr('持仓名义价值合计 ÷ 权益', 'Σ position notional ÷ equity')} />
            <Metric label={tr('账户杠杆设置', 'Leverage setting')} value={c.leverage ? `1:${c.leverage.toLocaleString('en-US')}` : c.leverageText ?? '—'}
              hint={tr('决定保证金占用，不等于实际风险敞口', 'Sets margin requirement; not your actual exposure')} />
            {hasPlan ? (
              <>
                <PlanMetric label={tr('全部止盈预计', 'If all TP hit')} positions={positions} k="tpPnl" equity={c.equity} />
                <PlanMetric label={tr('全部止损预计', 'If all SL hit')} positions={positions} k="slPnl" equity={c.equity} />
              </>
            ) : (
              <span className="col-span-2 self-center text-[11px] text-text-muted">
                {positions.length ? tr('该交易所未提供止盈/止损数据', 'TP/SL not available from this venue') : tr('无持仓', 'No positions')}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

type Flat = ReturnType<typeof flatten>[number];
type Sum = Flat & { count: number; tpMissing?: number; slMissing?: number };
type Group = { key: string; sum: Sum; items: Flat[] };

/** Group same account + symbol + side; the summary row has Σ lots, lot-weighted average entry, Σ PnL */
function group(rows: Flat[]): Group[] {
  const groups = new Map<string, Flat[]>();
  for (const p of rows) {
    const k = `${p.accountId}|${p.symbol}|${p.side}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  return [...groups.entries()].map(([key, g]) => {
    const qty = g.reduce((s, p) => s + p.quantity, 0);
    const sumOr = (k: 'tpPnl' | 'slPnl') => (g.some((p) => p[k] != null) ? g.reduce((s, p) => s + (p[k] ?? 0), 0) : null);
    const same = (k: 'tp' | 'sl') => (g.every((p) => p[k] === g[0][k]) ? g[0][k] : undefined); // undefined = mixed
    const sum = g.length === 1 ? { ...g[0], count: 1 } : {
      ...g[0],
      count: g.length,
      quantity: qty,
      avgPrice: qty > 0 ? g.reduce((s, p) => s + p.avgPrice * p.quantity, 0) / qty : g[0].avgPrice,
      unrealizedPnl: g.reduce((s, p) => s + p.unrealizedPnl, 0),
      marketValue: g.reduce((s, p) => s + p.marketValue, 0),
      tp: same('tp'),
      sl: same('sl'),
      tpPnl: sumOr('tpPnl'),
      slPnl: sumOr('slPnl'),
      tpMissing: g.filter((p) => p.tpPnl == null).length,
      slMissing: g.filter((p) => p.slPnl == null).length,
    };
    return { key, sum, items: [...g].sort((x, y) => x.avgPrice - y.avgPrice) };
  }).sort((x, y) => y.sum.marketValue - x.sum.marketValue);
}

/** SL/TP price cell: undefined = differs across merged positions */
const level = (v: number | null | undefined) =>
  v === undefined ? <span className="text-text-muted" title={tr('合并的订单设置不同', 'Differs across merged orders')}>{tr('多个', 'mixed')}</span>
    : v == null ? <span className="text-text-muted">—</span> : fmtPrice(v);

export function CfdPanel({ accounts }: { accounts: AccountSnapshot[] }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (k: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  const cards = accounts.flatMap((a) => (a.cfd ?? []).map((c) => ({ a, c })));
  const flat = flatten(accounts, (p) => p.assetClass === 'cfd');
  if (!cards.length && !flat.length) return null;
  const groups = group(flat);
  const multi = groups.filter((g) => g.items.length > 1);
  const allOpen = multi.length > 0 && multi.every((g) => open.has(g.key));
  const hasPlan = flat.some((p) => p.tp != null || p.sl != null);

  const equity = cards.reduce((s, x) => s + x.c.equity, 0);
  const pnl = cards.reduce((s, x) => s + x.c.floatingPnl, 0);
  const notional = cards.reduce((s, x) => s + x.c.notional, 0);
  const eqWithPositions = cards.filter((x) => !x.c.equityOnly).reduce((s, x) => s + x.c.equity, 0);

  return (
    <section className="card overflow-hidden">
      <CardHeader
        title={tr('CFD 账户', 'CFD accounts')}
        sub={<>
          {tr('权益', 'Equity')} <span className="num">{fmtUSD(equity, { decimals: false })}</span>
          {' · '}{tr('浮动盈亏', 'Floating')} <span className={`num ${pnlClass(pnl)}`}>{fmtSigned(pnl)}</span>
          {eqWithPositions > 0 && notional > 0 && <> · {tr('合计实际杠杆', 'Overall leverage')} <span className="num">{fmtLev(notional / eqWithPositions)}</span></>}
        </>}
        right={multi.length > 0 ? (
          <button type="button" className="chip hover:text-text-primary transition-colors"
            onClick={() => setOpen(allOpen ? new Set() : new Set(multi.map((g) => g.key)))}>
            {allOpen ? tr('全部折叠', 'Collapse all') : tr('全部展开', 'Expand all')}
          </button>
        ) : undefined}
      />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 px-5 pb-4">
        {cards.map(({ a, c }) => <CfdCard key={`${a.accountId}-${c.name}`} a={a} c={c} />)}
      </div>

      {groups.length > 0 && (
        <div className="overflow-x-auto border-t border-border-card">
          <table className="data">
            <thead>
              <tr>
                <th>{tr('账户', 'Account')}</th>
                <th>{tr('品种', 'Instrument')}</th>
                <th>{tr('方向', 'Side')}</th>
                <th className="r">{tr('手数', 'Lots')}</th>
                <th className="r" title={tr('多笔合并时为按手数加权的平均开仓价', 'Lot-weighted average entry for merged orders')}>{tr('开仓均价', 'Avg entry')}</th>
                <th className="r">{tr('现价', 'Price')}</th>
                <th className="r" title={tr('MT5 含隔夜利息/手续费；其他按现价估算', 'MT5 incl. swap/commission; others estimated from price')}>{tr('盈亏', 'PnL')}</th>
                {hasPlan && <>
                  <th className="r">{tr('止损', 'SL')}</th>
                  <th className="r">{tr('止盈', 'TP')}</th>
                  <th className="r" title={tr('按止损价平仓的价格盈亏', 'Price PnL if closed at SL')}>{tr('止损预计', 'At SL')}</th>
                  <th className="r" title={tr('按止盈价平仓的价格盈亏', 'Price PnL if closed at TP')}>{tr('止盈预计', 'At TP')}</th>
                </>}
                <th className="r">{tr('名义价值', 'Notional')}</th>
                <th className="r" title={tr('名义价值 ÷ CFD 账户权益', 'Notional ÷ CFD account equity')}>{tr('占权益', 'x Equity')}</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const expandable = g.items.length > 1;
                const isOpen = expandable && open.has(g.key);
                return (
                  <Fragment key={g.key}>
                    <PosRow p={g.sum} accounts={accounts} hasPlan={hasPlan}
                      lead={expandable ? <span className="inline-block w-3 text-text-muted">{isOpen ? '▾' : '▸'}</span> : <span className="inline-block w-3" />}
                      onClick={expandable ? () => toggle(g.key) : undefined} />
                    {isOpen && g.items.map((p, i) => (
                      <PosRow key={i} p={{ ...p, count: 1 }} accounts={accounts} hasPlan={hasPlan} child />
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PosRow({ p, accounts, hasPlan, lead, onClick, child }: {
  p: Sum; accounts: AccountSnapshot[]; hasPlan: boolean;
  lead?: ReactNode; onClick?: () => void; child?: boolean;
}) {
  // CFD account equity (same base as the card's actual leverage), not the whole exchange account
  const acctEq = accounts.find((a) => a.accountId === p.accountId)?.cfd?.reduce((s, c) => s + c.equity, 0) ?? 0;
  return (
    <tr onClick={onClick} className={`${onClick ? 'cursor-pointer' : ''} ${child ? 'bg-bg-inset/60 text-[12px]' : ''}`}>
      <td>{child ? null : <span className="inline-flex items-center gap-1.5">{lead}<ExchangeTag exchange={p.exchange} label={p.accountLabel} /></span>}</td>
      <td className={child ? 'pl-8 text-text-muted' : 'font-semibold'}>
        {child ? '└' : p.symbol}
        {p.count > 1 && <span className="chip ml-2 !text-[10px] !py-0" title={tr(`${p.count} 笔订单合并`, `${p.count} orders merged`)}>×{p.count}</span>}
      </td>
      <td>{child ? null : <SideBadge side={p.side} />}</td>
      <td className="r num">{fmtQty(p.quantity)}</td>
      <td className="r num text-text-secondary">{fmtPrice(p.avgPrice)}</td>
      <td className="r num">{child ? null : fmtPrice(p.currentPrice)}</td>
      <td className={`r num font-medium ${pnlClass(p.unrealizedPnl)}`}>{p.currentPrice ? fmtSigned(p.unrealizedPnl) : '—'}</td>
      {hasPlan && <>
        <td className="r num text-text-secondary">{level(p.sl)}</td>
        <td className="r num text-text-secondary">{level(p.tp)}</td>
        <PlanCell v={p.slPnl} missing={p.slMissing} />
        <PlanCell v={p.tpPnl} missing={p.tpMissing} />
      </>}
      <td className="r num">{p.marketValue ? fmtUSD(p.marketValue, { decimals: false }) : '—'}</td>
      <td className="r num text-text-secondary">{p.marketValue && acctEq > 0 ? fmtLev(p.marketValue / acctEq) : '—'}</td>
    </tr>
  );
}

/** Planned PnL cell; `missing` > 0 marks a merged total that leaves out orders without TP/SL */
function PlanCell({ v, missing }: { v: number | null | undefined; missing?: number }) {
  if (v == null) return <td className="r num">—</td>;
  return (
    <td className={`r num ${pnlClass(v)}`} title={missing ? tr(`${missing} 笔未设置，未计入`, `${missing} order(s) without it, not included`) : undefined}>
      {fmtSigned(v)}{missing ? <span className="text-delayed">*</span> : null}
    </td>
  );
}
