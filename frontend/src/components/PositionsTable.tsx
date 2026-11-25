import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AccountSnapshot, ExchangeType, Position } from '../types';
import { EXCHANGES } from '../lib/exchanges';
import { fmtCompact, fmtPct, fmtPrice, fmtQty, fmtSigned, fmtUSD, pnlClass } from '../lib/format';
import { exposureOf, fmtLev, isPerpLike, sumExposure, tradingEquity, type Exposure } from '../lib/exposure';
import { CardHeader, EmptyState, ExchangeTag, Segmented, SideBadge } from './ui';
import { tr } from '../lib/i18n';
import { liqDistance } from '../lib/risk';

type Row = Position & { accountLabel: string; exchange: ExchangeType; accountId: string };
type XRow = Row & { x: Exposure };
type SortKey = 'exposure' | 'pnl' | 'symbol' | 'liq';
type View = 'account' | 'symbol';
const VIEW_KEY = 'unify.posview';

export function flatten(accounts: AccountSnapshot[], pred: (p: Position) => boolean): Row[] {
  return accounts.flatMap((a) =>
    a.positions.filter(pred).map((p) => ({ ...p, accountLabel: a.label, exchange: a.exchange, accountId: a.accountId })),
  );
}

const levTitle = () => tr('实际杠杆 = 敞口 ÷ 交易账户权益（不含理财、资金账户和 CFD 账户；杠杆 ETF 已乘以其倍数）', 'Actual leverage = exposure ÷ trading-account equity (excl. earn, funding and CFD accounts; leveraged ETFs multiplied by their factor)');
const eqTitle = () => tr('交易账户权益：总权益减去理财、资金账户（现货）余额和 CFD 账户', 'Trading-account equity: total equity minus earn, funding (spot) wallets and CFD accounts');
const expTitle = () => tr('敞口 = 名义价值 × 杠杆 ETF 倍数；反向 ETF 的空单计为多头', 'Exposure = notional × leveraged-ETF factor; a short on an inverse ETF counts as long');

function Stat({ label, value, foot, hint }: { label: string; value: ReactNode; foot?: ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-1 min-w-0" title={hint}>
      <span className="text-[11px] text-text-muted truncate">{label}</span>
      <span className="num text-[16px] font-semibold leading-tight truncate">{value}</span>
      {foot && <span className="text-[11px] text-text-muted truncate">{foot}</span>}
    </div>
  );
}

/** Raw side, plus the effective direction when a leveraged / inverse ETF changes it */
/** Leveraged ETFs show only the effective direction × factor, e.g. short SOXS → L×3 (raw side in the tooltip) */
function DirCell({ p, x }: { p: Position; x: Exposure }) {
  if (!x.etf) return <SideBadge side={p.side} />;
  const isShort = p.side === 'short';
  const raw = isShort ? tr('空', 'short') : tr('多', 'long');
  const eff = x.dir > 0 ? tr('多头', 'long') : tr('空头', 'short');
  return (
    <span
      className={`inline-flex items-center justify-center h-5 px-1.5 rounded text-[11px] font-semibold ${isShort ? 'bg-loss/12 text-loss' : 'bg-profit/12 text-profit'}`}
      title={tr(
        `持仓：${raw} ${x.base}（${x.etf.lev}x 杠杆 ETF，${x.etf.underlying}）· 计入${eff}敞口`,
        `Held: ${raw} ${x.base} (${x.etf.lev}x leveraged ETF, ${x.etf.underlying}) · counted as ${eff} exposure`,
      )}>
      {isShort ? 'S' : 'L'}×{Math.abs(x.etf.lev)}
    </span>
  );
}

function ExpCell({ signed, etfLev }: { signed: number; etfLev?: number | null }) {
  return (
    <span className={`num font-medium ${signed > 0 ? 'text-profit' : signed < 0 ? 'text-loss' : 'text-text-secondary'}`}>
      {signed === 0 ? '—' : `${signed > 0 ? '+' : '−'}${fmtUSD(Math.abs(signed), { decimals: false })}`}
      {etfLev ? <span className="ml-1 text-[10px] text-text-muted">×{Math.abs(etfLev)}</span> : null}
    </span>
  );
}

function MarginCell({ x }: { x: Pick<Exposure, 'margin' | 'marginEstimated'> }) {
  if (x.margin == null) return <span className="text-text-muted">—</span>;
  return (
    <span className="num text-text-secondary" title={x.marginEstimated ? tr('交易所未提供，按 名义 ÷ 杠杆 估算', 'Not reported by the venue — estimated as notional ÷ leverage') : undefined}>
      {x.marginEstimated && '≈'}{fmtUSD(x.margin, { decimals: false })}
    </span>
  );
}

function LiqCell({ p }: { p: Position }) {
  const dist = liqDistance(p);
  return (
    <>
      <div className="num text-text-secondary">{p.liquidationPrice ? fmtPrice(p.liquidationPrice) : '—'}</div>
      {dist != null && <div className={`num text-[11px] ${dist < 10 ? 'text-loss' : dist < 25 ? 'text-delayed' : 'text-text-muted'}`}>{dist.toFixed(1)}%</div>}
    </>
  );
}

const fundTitle = () => tr('资金费：开仓以来已收取（+）/ 已支付（−）；下次 = 按当前费率和名义价值估算的下一次结算金额', 'Funding: received (+) / paid (−) since open; next = estimated next settlement at the current rate and notional');

function fmtCountdown(t: number | null | undefined): string {
  if (!t) return '';
  const m = Math.max(0, Math.round((t - Date.now()) / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}
const fmtRate = (r: number) => `${r >= 0 ? '+' : '−'}${Math.abs(r * 100).toFixed(4)}%`;

interface FundingSum { paid: number; hasPaid: boolean; next: number; hasNext: boolean; nextTime: number | null }
function sumFunding(list: Position[]): FundingSum {
  const f: FundingSum = { paid: 0, hasPaid: false, next: 0, hasNext: false, nextTime: null };
  for (const p of list) {
    if (p.fundingPnl != null) { f.paid += p.fundingPnl; f.hasPaid = true; }
    if (p.nextFunding != null) { f.next += p.nextFunding; f.hasNext = true; }
    if (p.nextFundingTime && (f.nextTime == null || p.nextFundingTime < f.nextTime)) f.nextTime = p.nextFundingTime;
  }
  return f;
}

function FundingCell({ p }: { p: Position }) {
  if (p.fundingPnl == null && p.nextFunding == null) return <span className="text-text-muted">—</span>;
  const rate = p.fundingRate;
  const tip = rate != null
    ? tr(`当前费率 ${fmtRate(rate)} / ${p.fundingIntervalH ?? '?'}h${p.fundingIntervalH ? `（年化 ${fmtRate(rate * (24 / p.fundingIntervalH) * 365)}）` : ''}；正费率多付空`,
      `Rate ${fmtRate(rate)} / ${p.fundingIntervalH ?? '?'}h${p.fundingIntervalH ? ` (APR ${fmtRate(rate * (24 / p.fundingIntervalH) * 365)})` : ''}; positive = longs pay shorts`)
    : undefined;
  return (
    <div title={tip}>
      <div className={`num font-medium ${p.fundingPnl != null ? pnlClass(p.fundingPnl) : 'text-text-muted'}`}>
        {p.fundingPnl != null ? fmtSigned(p.fundingPnl) : '—'}
      </div>
      {p.nextFunding != null && (
        <div className="num text-[11px] text-text-muted whitespace-nowrap">
          {tr('下次', 'next')} <span className={pnlClass(p.nextFunding)}>{fmtSigned(p.nextFunding)}</span>
          {rate != null && <> · {fmtRate(rate)}</>}
          {p.nextFundingTime ? <> · {fmtCountdown(p.nextFundingTime)}</> : null}
        </div>
      )}
    </div>
  );
}

function FundingSumCell({ f }: { f: FundingSum }) {
  if (!f.hasPaid && !f.hasNext) return <span className="text-text-muted">—</span>;
  return (
    <div>
      <div className={`num font-medium ${f.hasPaid ? pnlClass(f.paid) : 'text-text-muted'}`}>{f.hasPaid ? fmtSigned(f.paid) : '—'}</div>
      {f.hasNext && <div className="num text-[11px] text-text-muted whitespace-nowrap">{tr('下次', 'next')} <span className={pnlClass(f.next)}>{fmtSigned(f.next)}</span></div>}
    </div>
  );
}

function PnlCell({ p }: { p: Pick<Position, 'unrealizedPnl'>; roe?: number }) {
  return <div className={`num font-medium ${pnlClass(p.unrealizedPnl)}`}>{fmtSigned(p.unrealizedPnl)}</div>;
}

export function PositionsTable({ accounts }: { accounts: AccountSnapshot[] }) {
  const [ex, setEx] = useState<ExchangeType | 'all'>('all');
  const [sort, setSort] = useState<{ k: SortKey; asc: boolean }>({ k: 'exposure', asc: false });
  const [view, setView] = useState<View>(() => {
    try { return localStorage.getItem(VIEW_KEY) === 'symbol' ? 'symbol' : 'account'; } catch { return 'account'; }
  });
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => { try { localStorage.setItem(VIEW_KEY, view); } catch { /* ignore */ } }, [view]);

  const all = useMemo<XRow[]>(() => flatten(accounts, isPerpLike).map((p) => ({ ...p, x: exposureOf(p) })), [accounts]);
  const exchanges = [...new Set(all.map((p) => p.exchange))];
  const rows = ex === 'all' ? all : all.filter((p) => p.exchange === ex);

  const cmp = (a: { sym: string; pnl: number; gross: number; liq: number | null }, b: typeof a) => {
    const dir = sort.asc ? 1 : -1;
    switch (sort.k) {
      case 'symbol': return dir * a.sym.localeCompare(b.sym);
      case 'pnl': return dir * (a.pnl - b.pnl);
      case 'liq': return dir * ((a.liq ?? 1e9) - (b.liq ?? 1e9));
      default: return dir * (a.gross - b.gross);
    }
  };
  const key = (p: XRow) => ({ sym: p.x.base, pnl: p.unrealizedPnl, gross: p.x.exposure, liq: liqDistance(p) });

  // Accounts in scope: those holding perps (for leverage), within the exchange filter
  const scoped = accounts.filter((a) => (ex === 'all' || a.exchange === ex) && rows.some((r) => r.accountId === a.accountId));
  // Leverage base: trading-account equity only (earn / funding wallets aren't margin)
  const equity = scoped.reduce((s, a) => s + tradingEquity(a), 0);
  const t = sumExposure(rows);
  const acctMargin = scoped.reduce((s, a) => s + (a.marginUsed ?? 0), 0);
  const margin = acctMargin > 0 ? acctMargin : t.margin;
  const fund = sumFunding(rows);

  const Th = ({ k, children, r, title }: { k?: SortKey; children: ReactNode; r?: boolean; title?: string }) => (
    <th title={title} className={`${k ? 'cursor-pointer select-none hover:text-text-secondary' : ''} ${r ? 'r' : ''}`}
      onClick={k ? () => setSort((s) => ({ k, asc: s.k === k ? !s.asc : k === 'liq' || k === 'symbol' })) : undefined}>
      {children}{k && sort.k === k && <span className="text-accent ml-1">{sort.asc ? '↑' : '↓'}</span>}
    </th>
  );
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <section className="card overflow-hidden">
      <CardHeader
        title={tr('合约持仓', 'Perps & Futures')}
        sub={all.length ? <>{rows.length} {tr('个', 'positions')} · {tr('盈亏', 'PnL')} <span className={`num ${pnlClass(t.upl)}`}>{fmtSigned(t.upl)}</span></> : undefined}
        right={all.length > 0 && (
          <>
            <Segmented value={view} onChange={setView}
              options={[{ value: 'account' as const, label: tr('按账户', 'By account') }, { value: 'symbol' as const, label: tr('按仓位', 'By position') }]} />
            {exchanges.length > 1 && (
              <Segmented value={ex} onChange={setEx}
                options={[{ value: 'all' as const, label: tr('全部', 'All') }, ...exchanges.map((e) => ({ value: e, label: EXCHANGES[e].name }))]} />
            )}
          </>
        )}
      />
      {rows.length === 0 ? <EmptyState>{tr('当前没有永续 / 交割合约持仓', 'No perpetual / futures positions')}</EmptyState> : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-x-5 gap-y-3 px-5 pb-4">
            <Stat label={tr('多头敞口', 'Long exposure')} hint={expTitle()} value={<span className="text-profit">{fmtUSD(t.long, { decimals: false })}</span>} />
            <Stat label={tr('空头敞口', 'Short exposure')} hint={expTitle()} value={<span className="text-loss">{fmtUSD(t.short, { decimals: false })}</span>} />
            <Stat label={tr('净敞口', 'Net exposure')} value={<span className={pnlClass(t.net)}>{fmtSigned(t.net, { decimals: false })}</span>}
              foot={equity > 0 ? <>{tr('净杠杆', 'Net lev.')} <span className="num">{fmtLev(Math.abs(t.net) / equity)}</span></> : undefined} />
            <Stat label={tr('实际杠杆（总敞口）', 'Actual leverage (gross)')} hint={levTitle()} value={equity > 0 ? fmtLev(t.gross / equity) : '—'}
              foot={<>{tr('总敞口', 'Gross')} <span className="num">{fmtCompact(t.gross)}</span> · <span title={eqTitle()}>{tr('交易权益', 'Trading eq.')} <span className="num">{fmtCompact(equity)}</span></span></>} />
            <Stat label={tr('保证金占用', 'Margin used')} value={fmtUSD(margin, { decimals: false })}
              foot={equity > 0 ? <>{((margin / equity) * 100).toFixed(1)}% {tr('交易权益', 'of trading eq.')}</> : undefined} />
            <Stat label={tr('名义价值', 'Notional')} value={fmtUSD(t.notional, { decimals: false })}
              foot={<>{tr('开仓价值', 'At entry')} <span className="num">{fmtCompact(t.entryValue)}</span></>} />
            <Stat label={tr('未实现盈亏', 'uPnL')} value={<span className={pnlClass(t.upl)}>{fmtSigned(t.upl, { decimals: false })}</span>}
              foot={t.entryValue > 0 ? <span className={pnlClass(t.upl)}>{fmtPct((t.upl / t.entryValue) * 100)} {tr('开仓价值', 'of entry')}</span> : undefined} />
            <Stat label={tr('资金费（开仓以来）', 'Funding (since open)')} hint={fundTitle()}
              value={fund.hasPaid ? <span className={pnlClass(fund.paid)}>{fmtSigned(fund.paid)}</span> : '—'}
              foot={fund.hasNext ? <span title={tr('各仓位下一次结算的预估金额合计（按当前费率）', 'Sum of each position’s next estimated settlement at the current rate')}>
                {tr('下一轮', 'Next round')} <span className={`num ${pnlClass(fund.next)}`}>{fmtSigned(fund.next)}</span>{fund.nextTime ? <> · {fmtCountdown(fund.nextTime)}</> : null}</span> : undefined} />
          </div>
          <div className="px-5 pb-4">
            <div className="h-1.5 rounded-full overflow-hidden flex gap-px bg-bg-inset">
              {t.gross > 0 && <>
                <div className="h-full bg-profit transition-all duration-700" style={{ width: `${(t.long / t.gross) * 100}%` }} />
                <div className="h-full bg-loss transition-all duration-700" style={{ width: `${(t.short / t.gross) * 100}%` }} />
              </>}
            </div>
          </div>

          <div className="overflow-x-auto border-t border-border-card">
            {view === 'account' ? (
              <table className="data">
                <thead>
                  <tr>
                    <Th k="symbol">{tr('合约', 'Contract')}</Th>
                    <th>{tr('方向', 'Side')}</th>
                    <th className="r">{tr('数量', 'Qty')}</th>
                    <th className="r">{tr('开仓价', 'Entry')}</th>
                    <th className="r">{tr('标记价', 'Mark')}</th>
                    <th className="r">{tr('开仓价值', 'Entry value')}</th>
                    <th className="r">{tr('名义价值', 'Notional')}</th>
                    <Th k="exposure" r title={expTitle()}>{tr('敞口', 'Exposure')}</Th>
                    <th className="r">{tr('保证金', 'Margin')}</th>
                    <th className="r" title={levTitle()}>{tr('杠杆 设置 / 实际', 'Lev. set / actual')}</th>
                    <Th k="pnl" r>{tr('未实现盈亏', 'uPnL')}</Th>
                    <th className="r" title={fundTitle()}>{tr('资金费 已收付 / 下次', 'Funding paid / next')}</th>
                    <Th k="liq" r>{tr('强平价 / 距离', 'Liq. / Distance')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {scoped
                    .map((a) => ({ a, list: rows.filter((r) => r.accountId === a.accountId) }))
                    .map((g) => ({ ...g, s: sumExposure(g.list) }))
                    .sort((x, y) => y.s.gross - x.s.gross)
                    .map(({ a, list, s }) => {
                      const m = a.marginUsed ?? s.margin;
                      const te = tradingEquity(a);
                      const fa = sumFunding(list);
                      return (
                        <Fragment key={a.accountId}>
                          <tr className="bg-bg-inset/40">
                            <td colSpan={13} className="!py-2.5">
                              <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[12px] text-text-muted">
                                <span className="text-[13px] font-medium text-text-primary"><ExchangeTag exchange={a.exchange} label={a.label} /></span>
                                <span title={eqTitle()}>{tr('交易账户权益', 'Trading equity')} <span className="num text-text-primary">{fmtUSD(te, { decimals: false })}</span>
                                  {Math.abs(a.equity - te) >= 1 && <span className="text-text-muted"> / {tr('总', 'total')} <span className="num">{fmtCompact(a.equity)}</span></span>}</span>
                                <span>{tr('保证金', 'Margin')} <span className="num text-text-primary">{fmtUSD(m, { decimals: false })}</span>
                                  {a.marginRatio != null && <span className="num"> · {(a.marginRatio * 100).toFixed(1)}%</span>}</span>
                                <span>{tr('可用', 'Available')} <span className="num text-text-secondary">{fmtUSD(a.availableBalance, { decimals: false })}</span></span>
                                <span>{tr('多', 'Long')} <span className="num text-profit">{fmtCompact(s.long)}</span></span>
                                <span>{tr('空', 'Short')} <span className="num text-loss">{fmtCompact(s.short)}</span></span>
                                <span>{tr('净', 'Net')} <span className={`num ${pnlClass(s.net)}`}>{fmtSigned(s.net, { decimals: false })}</span></span>
                                <span title={levTitle()}>{tr('实际杠杆', 'Actual lev.')} <span className="num text-text-primary">{te > 0 ? fmtLev(s.gross / te) : '—'}</span></span>
                                <span>{tr('盈亏', 'uPnL')} <span className={`num ${pnlClass(s.upl)}`}>{fmtSigned(s.upl)}</span></span>
                                {(fa.hasPaid || fa.hasNext) && <span title={fundTitle()}>{tr('资金费', 'Funding')} <span className={`num ${pnlClass(fa.paid)}`}>{fa.hasPaid ? fmtSigned(fa.paid) : '—'}</span>
                                  {fa.hasNext && <> · {tr('下一轮', 'next')} <span className={`num ${pnlClass(fa.next)}`}>{fmtSigned(fa.next)}</span>{fa.nextTime ? <span className="num"> · {fmtCountdown(fa.nextTime)}</span> : null}</>}</span>}
                              </div>
                            </td>
                          </tr>
                          {[...list].sort((x, y) => cmp(key(x), key(y))).map((p, i) => {
                            const roe = p.avgPrice > 0 ? ((p.currentPrice - p.avgPrice) / p.avgPrice) * 100 * (p.side === 'short' ? -1 : 1) : 0;
                            return (
                              <tr key={`${p.symbol}-${p.side}-${i}`}>
                                <td>
                                  <span className="font-semibold">{p.symbol}</span>
                                  {p.assetClass === 'crypto-future' && <span className="chip ml-2 !text-[10px] !py-0">{tr('交割', 'Dated')}</span>}
                                </td>
                                <td><DirCell p={p} x={p.x} /></td>
                                <td className="r num">{fmtQty(p.quantity)}</td>
                                <td className="r num text-text-secondary">{fmtPrice(p.avgPrice)}</td>
                                <td className="r num">{fmtPrice(p.currentPrice)}</td>
                                <td className="r num text-text-secondary">{fmtUSD(p.x.entryValue, { decimals: false })}</td>
                                <td className="r num">{fmtUSD(p.marketValue, { decimals: false })}</td>
                                <td className="r"><ExpCell signed={p.x.signed} etfLev={p.x.etf?.lev} /></td>
                                <td className="r"><MarginCell x={p.x} /></td>
                                <td className="r num text-text-secondary">
                                  {p.leverage ? `${p.leverage}×` : '—'} <span className="text-text-muted">/</span> <span className="text-text-primary">{te > 0 ? fmtLev(p.x.exposure / te) : '—'}</span>
                                </td>
                                <td className="r">
                                  <PnlCell p={p} />
                                  {roe !== 0 && <div className={`num text-[11px] opacity-70 ${pnlClass(roe)}`}>{fmtPct(roe)}</div>}
                                </td>
                                <td className="r"><FundingCell p={p} /></td>
                                <td className="r"><LiqCell p={p} /></td>
                              </tr>
                            );
                          })}
                        </Fragment>
                      );
                    })}
                </tbody>
              </table>
            ) : (
              <SymbolView rows={rows} accounts={accounts} equity={equity} open={open} toggle={toggle} Th={Th} cmp={cmp} />
            )}
          </div>
        </>
      )}
    </section>
  );
}

type ThT = (props: { k?: SortKey; children: ReactNode; r?: boolean; title?: string }) => ReactNode;
type CmpT = (a: { sym: string; pnl: number; gross: number; liq: number | null }, b: { sym: string; pnl: number; gross: number; liq: number | null }) => number;

/** Same contract across accounts merged into one row; click to see each account's leg */
function SymbolView({ rows, accounts, equity, open, toggle, Th, cmp }: {
  rows: XRow[]; accounts: AccountSnapshot[]; equity: number; open: Set<string>; toggle: (id: string) => void; Th: ThT; cmp: CmpT;
}) {
  const groups = new Map<string, XRow[]>();
  for (const r of rows) groups.set(r.x.base, [...(groups.get(r.x.base) ?? []), r]);
  const list = [...groups.entries()].map(([base, legs]) => {
    const s = sumExposure(legs);
    const signedQty = legs.reduce((q, p) => q + (p.side === 'short' ? -1 : 1) * p.quantity, 0);
    const sameSide = legs.every((p) => p.side === legs[0].side);
    const qty = legs.reduce((q, p) => q + p.quantity, 0);
    const avg = sameSide && qty > 0 ? legs.reduce((v, p) => v + p.avgPrice * p.quantity, 0) / qty : null;
    const mark = legs[0].currentPrice;
    const etf = legs[0].x.etf;
    const minLiq = legs.map(liqDistance).filter((d): d is number => d != null);
    return { base, legs, s, signedQty, sameSide, avg, mark, etf, liq: minLiq.length ? Math.min(...minLiq) : null };
  }).sort((a, b) => cmp({ sym: a.base, pnl: a.s.upl, gross: a.s.gross, liq: a.liq }, { sym: b.base, pnl: b.s.upl, gross: b.s.gross, liq: b.liq }));
  const eqOf = (id: string) => { const a = accounts.find((x) => x.accountId === id); return a ? tradingEquity(a) : 0; };

  return (
    <table className="data">
      <thead>
        <tr>
          <Th k="symbol">{tr('合约', 'Contract')}</Th>
          <th>{tr('账户', 'Accounts')}</th>
          <th>{tr('方向', 'Side')}</th>
          <th className="r">{tr('数量', 'Qty')}</th>
          <th className="r">{tr('开仓均价', 'Avg entry')}</th>
          <th className="r">{tr('标记价', 'Mark')}</th>
          <th className="r">{tr('开仓价值', 'Entry value')}</th>
          <th className="r">{tr('名义价值', 'Notional')}</th>
          <Th k="exposure" r title={expTitle()}>{tr('净敞口', 'Net exposure')}</Th>
          <th className="r">{tr('保证金', 'Margin')}</th>
          <th className="r" title={tr('净敞口 ÷ 持仓账户的交易账户权益合计', 'Net exposure ÷ trading equity of the accounts in scope')}>{tr('占交易权益', 'x Trading eq.')}</th>
          <Th k="pnl" r>{tr('未实现盈亏', 'uPnL')}</Th>
          <th className="r" title={fundTitle()}>{tr('资金费 已收付 / 下次', 'Funding paid / next')}</th>
          <Th k="liq" r>{tr('最近强平距离', 'Nearest liq.')}</Th>
        </tr>
      </thead>
      <tbody>
        {list.map((g) => {
          const multi = g.legs.length > 1;
          const isOpen = open.has(g.base);
          const hedged = !g.sameSide;
          return (
            <Fragment key={g.base}>
              <tr className={multi ? 'cursor-pointer' : ''} onClick={multi ? () => toggle(g.base) : undefined}>
                <td>
                  {multi && <span className="inline-block w-3 text-text-muted">{isOpen ? '▾' : '▸'}</span>}
                  <span className="font-semibold">{g.base}</span>
                  {g.etf && <span className="chip ml-2 !text-[10px] !py-0" title={g.etf.underlying}>{g.etf.lev > 0 ? '+' : ''}{g.etf.lev}x ETF</span>}
                </td>
                <td>
                  <span className="inline-flex items-center gap-2">
                    {[...new Map(g.legs.map((p) => [p.accountId, p])).values()].map((p) => <ExchangeTag key={p.accountId} exchange={p.exchange} label={EXCHANGES[p.exchange].short} />)}
                  </span>
                </td>
                <td>
                  {hedged ? <span className="chip !text-[10px] !py-0">{tr('对冲', 'Hedged')}</span>
                    : <DirCell p={g.legs[0]} x={g.legs[0].x} />}
                </td>
                <td className="r num">{hedged ? `${g.signedQty >= 0 ? '+' : '−'}${fmtQty(Math.abs(g.signedQty)) || '0'}` : fmtQty(Math.abs(g.signedQty))}</td>
                <td className="r num text-text-secondary">{g.avg != null ? fmtPrice(g.avg) : '—'}</td>
                <td className="r num">{fmtPrice(g.mark)}</td>
                <td className="r num text-text-secondary">{fmtUSD(g.s.entryValue, { decimals: false })}</td>
                <td className="r num">{fmtUSD(g.s.notional, { decimals: false })}</td>
                <td className="r">
                  <ExpCell signed={g.s.net} etfLev={g.etf?.lev} />
                  {hedged && <div className="num text-[11px] text-text-muted">{tr('多', 'L')} {fmtCompact(g.s.long)} / {tr('空', 'S')} {fmtCompact(g.s.short)}</div>}
                </td>
                <td className="r num text-text-secondary">{g.s.margin > 0 ? fmtUSD(g.s.margin, { decimals: false }) : '—'}</td>
                <td className="r num">{equity > 0 ? fmtLev(Math.abs(g.s.net) / equity) : '—'}</td>
                <td className="r"><PnlCell p={{ unrealizedPnl: g.s.upl }} /></td>
                <td className="r">{g.legs.length > 1 ? <FundingSumCell f={sumFunding(g.legs)} /> : <FundingCell p={g.legs[0]} />}</td>
                <td className={`r num ${g.liq == null ? 'text-text-muted' : g.liq < 10 ? 'text-loss' : g.liq < 25 ? 'text-delayed' : 'text-text-muted'}`}>{g.liq != null ? `${g.liq.toFixed(1)}%` : '—'}</td>
              </tr>
              {multi && isOpen && g.legs.map((p, i) => {
                const eq = eqOf(p.accountId);
                return (
                  <tr key={`${g.base}-${p.accountId}-${i}`} className="text-[12px]">
                    <td className="!pl-10 text-text-muted">{p.symbol}</td>
                    <td><ExchangeTag exchange={p.exchange} label={p.accountLabel} /></td>
                    <td><DirCell p={p} x={p.x} /></td>
                    <td className="r num">{fmtQty(p.quantity)}</td>
                    <td className="r num text-text-secondary">{fmtPrice(p.avgPrice)}</td>
                    <td className="r num">{fmtPrice(p.currentPrice)}</td>
                    <td className="r num text-text-secondary">{fmtUSD(p.x.entryValue, { decimals: false })}</td>
                    <td className="r num">{fmtUSD(p.marketValue, { decimals: false })}</td>
                    <td className="r"><ExpCell signed={p.x.signed} /></td>
                    <td className="r"><MarginCell x={p.x} /></td>
                    <td className="r num text-text-secondary" title={tr('占该账户交易权益', 'Of this account’s trading equity')}>{eq > 0 ? fmtLev(p.x.exposure / eq) : '—'}</td>
                    <td className="r"><PnlCell p={p} /></td>
                    <td className="r"><FundingCell p={p} /></td>
                    <td className="r"><LiqCell p={p} /></td>
                  </tr>
                );
              })}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
