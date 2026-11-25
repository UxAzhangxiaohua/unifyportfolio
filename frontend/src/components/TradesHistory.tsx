import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { useTrades } from '../hooks/usePortfolio';
import type { ClosedTrade, TradeCategory } from '../types';
import { ExchangeTag, SideBadge, CardHeader, EmptyState } from './ui';
import { tr, locale } from '../lib/i18n';
import { pnlClass } from '../lib/format';
import { instrumentKey, summarize, type Summary } from '../lib/tradeStats';
import { TradePnlCurve } from './TradePnlCurve';

// Closed trades, top-down: category tiles (filter) → stats + cumulative PnL for the selection →
// category → instrument breakdown (filter) → the matching trade list.

type Range = '24h' | '3d' | '7d' | '30d' | 'all';
const RANGES: { key: Range; label: () => string; ms: number }[] = [
  { key: '24h', label: () => '24H', ms: 86_400_000 },
  { key: '3d', label: () => tr('3天', '3D'), ms: 3 * 86_400_000 },
  { key: '7d', label: () => tr('7天', '7D'), ms: 7 * 86_400_000 },
  { key: '30d', label: () => tr('30天', '30D'), ms: 30 * 86_400_000 },
  { key: 'all', label: () => tr('全部', 'All'), ms: Infinity },
];
const RANGE_KEY = 'unify.tradesRange';

// Commodity (key 'xau' in the data): gold incl. gold-backed tokens, silver, oil, FX;
// Stock includes index contracts such as NAS100 / USTEC
const CATEGORIES: { key: TradeCategory; label: () => string; hint: () => string }[] = [
  { key: 'xau', label: () => 'Commodity', hint: () => tr('大宗商品：黄金（XAUUSD、XAUT、PAXG 等）、白银、原油等', 'Commodities: gold (XAUUSD, XAUT, PAXG, …), silver, oil, …') },
  { key: 'stock', label: () => 'Stock', hint: () => tr('股票、ETF 与股指合约（NAS100、USTEC 等）', 'Stocks, ETFs and index contracts (NAS100, USTEC, …)') },
  { key: 'crypto', label: () => 'Crypto', hint: () => tr('加密货币合约', 'Crypto contracts') },
  { key: 'option', label: () => tr('期权', 'Options'), hint: () => tr('期权', 'Options') },
];
const catLabel = (c: TradeCategory | undefined) => CATEGORIES.find((x) => x.key === c)?.label() ?? '—';
const LIST_LIMIT = 200;
/** Instruments shown per category before "show all" */
const TREE_LIMIT = 8;
/** "Hide small" toggle: instruments with |PnL| below this are left out of the breakdown */
const SMALL_PNL = 100;
const HIDE_SMALL_KEY = 'unify.tradesHideSmall';

function formatDuration(seconds: number | null): string {
  if (seconds == null) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signedUsd = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${usd(Math.abs(n))}`;

function formatPrice(n: number): string {
  if (n >= 1000) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 1) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

function formatQty(n: number): string {
  if (Number.isInteger(n)) return n.toString();
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

const pct = (n: number | null, d = 0) => (n == null ? '—' : `${n.toFixed(d)}%`);

function Stat({ label, value, foot, title }: { label: string; value: ReactNode; foot?: ReactNode; title?: string }) {
  return (
    <div className="rounded-lg bg-bg-inset border border-border-card px-3.5 py-2.5 min-w-0" title={title}>
      <div className="text-[11px] text-text-muted truncate">{label}</div>
      <div className="num text-[18px] leading-tight font-semibold mt-0.5 truncate">{value}</div>
      {foot && <div className="text-[11px] text-text-muted mt-0.5 truncate">{foot}</div>}
    </div>
  );
}

export function TradesHistory() {
  const { data, isLoading } = useTrades();
  const [range, setRange] = useState<Range>(() => {
    try { const v = localStorage.getItem(RANGE_KEY) as Range | null; return v && RANGES.some((r) => r.key === v) ? v : '7d'; } catch { return '7d'; }
  });
  const pickRange = (r: Range) => { setRange(r); try { localStorage.setItem(RANGE_KEY, r); } catch { /* ignore */ } };
  const [instrument, setInstrument] = useState<string | null>(null);
  const [category, setCategory] = useState<TradeCategory | null>(null);
  const [showAll, setShowAll] = useState(false);

  const all = data?.trades;
  const inRange = useMemo(() => {
    const ms = RANGES.find((r) => r.key === range)!.ms;
    const cutoff = Date.now() - ms;
    return (all ?? []).filter((t) => Date.parse(t.exitTime) >= cutoff);
  }, [all, range]);
  const inCategory = useMemo(() => (category ? inRange.filter((t) => t.category === category) : inRange), [inRange, category]);
  const shown = useMemo(() => (instrument ? inCategory.filter((t) => instrumentKey(t) === instrument) : inCategory), [inCategory, instrument]);
  const byCategory = useMemo(() => CATEGORIES.map((c) => ({ ...c, s: summarize(inRange.filter((t) => t.category === c.key)) })), [inRange]);
  const totalAll = useMemo(() => summarize(inRange), [inRange]);
  const summary = useMemo(() => summarize(shown), [shown]);

  const pickCategory = (c: TradeCategory | null) => { setCategory(c); setInstrument(null); setShowAll(false); };
  const pickInstrument = (c: TradeCategory | undefined, key: string | null) => {
    if (key != null && c) setCategory(c);
    setInstrument(key);
    setShowAll(false);
  };

  if (isLoading || !all) return null;
  // Options only when there are option trades at all
  const hasOptions = all.some((t) => t.category === 'option');
  const crumbs = [category && catLabel(category), instrument].filter(Boolean) as string[];
  const filterChip = crumbs.length > 0 && (
    <button className="chip !text-text-primary hover:border-border-hover" onClick={() => pickCategory(null)} title={tr('清除筛选', 'Clear filter')}>
      {crumbs.join(' › ')} ✕
    </button>
  );

  return (
    <>
      <section className="card overflow-hidden">
        <CardHeader
          title={tr('已平仓统计', 'Closed trades')}
          sub={tr('取自各交易所的平仓 / 成交记录（只读 API），盈亏已扣手续费', 'From each venue’s closed-position / fill history (read-only API), net of fees')}
          right={
            <>
              {filterChip}
              <div className="seg">
                {RANGES.map((r) => (
                  <button key={r.key} data-active={range === r.key} onClick={() => pickRange(r.key)}>{r.label()}</button>
                ))}
              </div>
            </>
          }
        />

        {all.length === 0 ? (
          <EmptyState>{tr('暂无平仓记录 —— 持仓关闭后会出现在这里', 'No closed trades yet — they appear here once a position is closed')}</EmptyState>
        ) : (
          <>
            {/* PnL by category + total (click to filter) */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 px-5 pb-3">
              {[{ key: null as TradeCategory | null, label: () => tr('合计', 'Total'), hint: () => tr('全部类别', 'All categories'), s: totalAll }, ...byCategory.filter((c) => c.key !== 'option' || hasOptions)].map((c) => {
                const active = category === c.key;
                const empty = c.s.n === 0;
                return (
                  <button
                    key={c.key ?? 'all'}
                    disabled={empty && c.key !== null}
                    onClick={() => pickCategory(c.key)}
                    title={c.hint()}
                    className={`text-left rounded-lg border px-3.5 py-2.5 min-w-0 transition-colors ${active ? 'border-accent/60 bg-accent/[0.06]' : 'border-border-card bg-bg-inset hover:border-border-hover'} ${empty && c.key !== null ? 'opacity-50 cursor-default' : ''}`}
                  >
                    <div className="text-[11px] text-text-muted truncate">{c.label()}</div>
                    <div className={`num text-[18px] leading-tight font-semibold mt-0.5 truncate ${empty ? 'text-text-muted' : pnlClass(c.s.pnl)}`}>{empty ? '—' : signedUsd(c.s.pnl)}</div>
                    <div className="text-[11px] text-text-muted mt-0.5 truncate">
                      {empty ? tr('无平仓', 'no closes') : tr(`${c.s.n} 笔 · 胜率 ${pct(c.s.winRate)}`, `${c.s.n} trades · ${pct(c.s.winRate)} win`)}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Headline stats for the selection */}
            <div className="px-5 pb-2 text-[12px] text-text-muted">
              {tr('当前范围', 'Showing')}: <span className="text-text-secondary">{crumbs.length ? crumbs.join(' › ') : tr('全部类别', 'All categories')}</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 px-5 pb-4">
              <Stat
                label={tr('已实现盈亏', 'Realized PnL')}
                value={<span className={pnlClass(summary.pnl)}>{signedUsd(summary.pnl)}</span>}
                foot={summary.fees ? tr(`含手续费/隔夜费 ${usd(summary.fees)}`, `incl. fees/swap ${usd(summary.fees)}`) : tr(`${summary.n} 笔`, `${summary.n} trades`)}
              />
              <Stat
                label={tr('胜率', 'Win rate')}
                value={pct(summary.winRate, 1)}
                foot={tr(`${summary.wins} 胜 / ${summary.losses} 负`, `${summary.wins} W / ${summary.losses} L`)}
              />
              <Stat
                label={tr('盈亏比', 'Payoff ratio')}
                title={tr('平均盈利 ÷ 平均亏损', 'Average win ÷ average loss')}
                value={summary.payoff == null ? '—' : summary.payoff.toFixed(2)}
                foot={summary.avgWin != null || summary.avgLoss != null
                  ? <><span className="text-profit">{summary.avgWin != null ? signedUsd(summary.avgWin) : '—'}</span> / <span className="text-loss">{summary.avgLoss != null ? signedUsd(summary.avgLoss) : '—'}</span></>
                  : undefined}
              />
              <Stat
                label={tr('利润因子', 'Profit factor')}
                title={tr('总盈利 ÷ 总亏损；> 1 即整体赚钱', 'Gross profit ÷ gross loss; > 1 means net profitable')}
                value={summary.profitFactor == null ? '—' : summary.profitFactor.toFixed(2)}
                foot={tr(`盈 ${usd(summary.grossWin)}`, `won ${usd(summary.grossWin)}`)}
              />
              <Stat
                label={tr('每笔期望', 'Expectancy / trade')}
                value={<span className={pnlClass(summary.expectancy ?? 0)}>{summary.expectancy == null ? '—' : signedUsd(summary.expectancy)}</span>}
                foot={tr('平均每笔盈亏', 'average PnL per trade')}
              />
            </div>

            <div className="px-5 pb-5">
              <TradePnlCurve trades={shown} />
            </div>
          </>
        )}
      </section>

      {all.length > 0 && (
        <CategoryTree trades={inRange} category={category} instrument={instrument} hasOptions={hasOptions}
          onCategory={pickCategory} onInstrument={pickInstrument} />
      )}

      {all.length > 0 && (
        <section className="card overflow-hidden">
          <CardHeader title={tr('平仓明细', 'Closed trades list')}
            sub={tr(`${shown.length} 笔`, `${shown.length} trades`)}
            right={filterChip || undefined} />
          {shown.length === 0 ? (
            <EmptyState>{tr('此区间没有平仓', 'No closes in this range')}</EmptyState>
          ) : (
            <div className="overflow-x-auto max-h-[560px] border-t border-border-card">
              <table className="data">
                <thead>
                  <tr>
                    <th>{tr('平仓时间', 'Closed')}</th><th>{tr('合约', 'Contract')}</th><th>{tr('类别', 'Category')}</th><th>{tr('交易所', 'Exchange')}</th><th>{tr('方向', 'Side')}</th>
                    <th className="r">{tr('开仓', 'Entry')}</th><th className="r">{tr('平仓', 'Exit')}</th><th className="r">{tr('数量', 'Qty')}</th>
                    <th className="r">{tr('盈亏', 'PnL')}</th><th className="r">{tr('持仓时长', 'Duration')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(showAll ? shown : shown.slice(0, LIST_LIMIT)).map((t) => {
                    const win = t.realizedPnl >= 0;
                    return (
                      <tr key={t.id} title={t.source === 'venue' ? undefined : tr('根据持仓变化推算：价格为最后一次轮询价，未含手续费', 'Inferred from position changes: exit = last polled price, fees not included')}>
                        <td className="num text-text-muted">
                          {new Date(t.exitTime).toLocaleString(locale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}
                        </td>
                        <td className="font-medium">
                          <button className="hover:text-accent" title={tr('只看这个品种', 'Filter to this instrument')} onClick={() => pickInstrument(t.category, instrumentKey(t))}>{t.symbol}</button>
                        </td>
                        <td className="text-text-muted text-[12px]">{catLabel(t.category)}{t.source !== 'venue' && <span className="ml-1.5 text-[10px]">{tr('推算', 'inferred')}</span>}</td>
                        <td><ExchangeTag exchange={t.exchange} /></td>
                        <td><SideBadge side={t.side} /></td>
                        <td className="r num text-text-secondary">{t.entryPrice != null ? formatPrice(t.entryPrice) : '—'}</td>
                        <td className="r num text-text-secondary">{formatPrice(t.exitPrice)}</td>
                        <td className="r num text-text-secondary">{formatQty(t.quantity)}</td>
                        <td className="r">
                          <div className={`num ${win ? 'text-profit' : 'text-loss'}`}>{signedUsd(t.realizedPnl)}</div>
                          <div className={`num text-[11px] opacity-70 ${win ? 'text-profit' : 'text-loss'}`}>{win ? '+' : ''}{t.pnlPercent.toFixed(2)}%</div>
                        </td>
                        <td className="r num text-text-muted">{formatDuration(t.durationSeconds)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!showAll && shown.length > LIST_LIMIT && (
                <button className="w-full py-2.5 text-[12px] text-text-secondary hover:text-text-primary border-t border-border-card" onClick={() => setShowAll(true)}>
                  {tr(`显示全部 ${shown.length} 笔`, `Show all ${shown.length}`)}
                </button>
              )}
            </div>
          )}
        </section>
      )}
    </>
  );
}

// ── Category → instrument breakdown ───────────────────────────────────────────

type SortKey = 'pnl' | 'n' | 'win';

interface Row { key: string; cat?: TradeCategory; s: Summary; long: number; n: number }

const rowOf = (key: string, list: ClosedTrade[], cat?: TradeCategory): Row =>
  ({ key, cat, s: summarize(list), long: list.filter((t) => t.side === 'long').length, n: list.length });

function PnlBar({ v, max }: { v: number; max: number }) {
  const w = max > 0 ? (Math.abs(v) / max) * 50 : 0;
  return (
    <div className="relative h-2 w-full min-w-[90px]">
      <div className="absolute inset-y-[-2px] left-1/2 w-px bg-border-hover" />
      {w > 0 && <div className={`absolute inset-y-0 rounded-[3px] ${v >= 0 ? 'bg-profit/80' : 'bg-loss/80'}`}
        style={v >= 0 ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }} />}
    </div>
  );
}

function CategoryTree({ trades, category, instrument, hasOptions, onCategory, onInstrument }: {
  trades: ClosedTrade[]; category: TradeCategory | null; instrument: string | null; hasOptions: boolean;
  onCategory: (c: TradeCategory | null) => void; onInstrument: (c: TradeCategory | undefined, key: string | null) => void;
}) {
  const [sort, setSort] = useState<{ k: SortKey; asc: boolean }>({ k: 'pnl', asc: false });
  const [collapsed, setCollapsed] = useState<Set<TradeCategory>>(new Set());
  const [expandedAll, setExpandedAll] = useState<Set<TradeCategory>>(new Set());
  const [hideSmall, setHideSmall] = useState(() => { try { return localStorage.getItem(HIDE_SMALL_KEY) === '1'; } catch { return false; } });
  const pickHideSmall = (v: boolean) => { setHideSmall(v); try { localStorage.setItem(HIDE_SMALL_KEY, v ? '1' : '0'); } catch { /* ignore */ } };
  const isSmall = (r: Row) => Math.abs(r.s.pnl) < SMALL_PNL;

  const cmp = (a: Row, b: Row) => {
    const d = sort.asc ? 1 : -1;
    if (sort.k === 'n') return d * (a.n - b.n) || b.s.pnl - a.s.pnl;
    if (sort.k === 'win') return d * ((a.s.winRate ?? -1) - (b.s.winRate ?? -1)) || b.n - a.n;
    return d * (a.s.pnl - b.s.pnl);
  };

  const groups = useMemo(() => CATEGORIES
    .filter((c) => c.key !== 'option' || hasOptions)
    .map((c) => {
      const list = trades.filter((t) => t.category === c.key);
      const m = new Map<string, ClosedTrade[]>();
      for (const t of list) m.set(instrumentKey(t), [...(m.get(instrumentKey(t)) ?? []), t]);
      return { c, row: rowOf(c.label(), list, c.key), items: [...m.entries()].map(([k, l]) => rowOf(k, l, c.key)) };
    })
    .filter((g) => g.row.n > 0), [trades, hasOptions]);

  if (!groups.length) return null;
  const maxCat = Math.max(...groups.map((g) => Math.abs(g.row.s.pnl)), 0);
  const maxInst = Math.max(...groups.flatMap((g) => g.items.map((r) => Math.abs(r.s.pnl))), 0);
  const total = rowOf(tr('合计', 'Total'), trades);
  const toggle = (k: TradeCategory) => setCollapsed((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const Th = ({ k, children, className = '' }: { k?: SortKey; children: ReactNode; className?: string }) => (
    <th className={`${className} ${k ? 'cursor-pointer select-none hover:text-text-secondary' : ''}`}
      onClick={k ? () => setSort((s) => ({ k, asc: s.k === k ? !s.asc : false })) : undefined}>
      {children}{k && sort.k === k && <span className="text-accent ml-1">{sort.asc ? '↑' : '↓'}</span>}
    </th>
  );

  const cells = (r: Row, max: number) => (
    <>
      <td className="r num text-text-secondary">{r.n}</td>
      <td className="r num">{pct(r.s.winRate)}</td>
      <td className="w-[22%] min-w-[150px]"><PnlBar v={r.s.pnl} max={max} /></td>
      <td className={`r num font-medium ${pnlClass(r.s.pnl)}`}>{signedUsd(r.s.pnl)}</td>
      <td className="r num text-[12px]">
        <span className="text-profit">{r.s.avgWin != null ? signedUsd(r.s.avgWin) : '—'}</span>
        <span className="text-text-muted"> / </span>
        <span className="text-loss">{r.s.avgLoss != null ? signedUsd(r.s.avgLoss) : '—'}</span>
      </td>
      <td className="r num text-text-secondary">{r.s.payoff == null ? '—' : r.s.payoff.toFixed(2)}</td>
      <td className="r num text-text-muted">{r.long} / {r.n - r.long}</td>
      <td className="r num text-text-muted">{r.s.fees ? usd(r.s.fees) : '—'}</td>
    </>
  );

  return (
    <section className="card overflow-hidden">
      <CardHeader title={tr('分类 / 品种盈亏', 'PnL by category & instrument')}
        sub={tr('点类别或品种筛选上方统计和下方明细；▸ 展开 / 收起', 'Click a category or instrument to filter the stats above and the list below; ▸ expand / collapse')}
        right={
          <button type="button" onClick={() => pickHideSmall(!hideSmall)} aria-pressed={hideSmall}
            title={tr(`隐藏盈亏绝对值小于 $${SMALL_PNL} 的品种（类别小计和合计不变）`, `Hide instruments whose |PnL| is under $${SMALL_PNL} (category subtotals and total unchanged)`)}
            className={`chip !py-1 inline-flex items-center gap-1.5 transition-colors ${hideSmall ? '!border-accent/60 !text-text-primary bg-accent/[0.08]' : 'hover:border-border-hover'}`}>
            <span className={`w-3 h-3 rounded-[3px] border grid place-items-center text-[9px] leading-none ${hideSmall ? 'bg-accent border-accent text-bg-primary' : 'border-border-hover'}`}>{hideSmall ? '✓' : ''}</span>
            {tr(`隐藏 |盈亏| < $${SMALL_PNL}`, `Hide |PnL| < $${SMALL_PNL}`)}
          </button>
        } />
      <div className="overflow-x-auto border-t border-border-card">
        <table className="data">
          <thead>
            <tr>
              <th>{tr('类别 / 品种', 'Category / instrument')}</th>
              <Th k="n" className="r">{tr('笔数', 'Trades')}</Th>
              <Th k="win" className="r">{tr('胜率', 'Win %')}</Th>
              <Th k="pnl">{tr('盈亏', 'PnL')}</Th>
              <th />
              <th className="r">{tr('平均盈 / 亏', 'Avg win / loss')}</th>
              <th className="r" title={tr('平均盈利 ÷ 平均亏损', 'Average win ÷ average loss')}>{tr('盈亏比', 'Payoff')}</th>
              <th className="r">{tr('多 / 空', 'L / S')}</th>
              <th className="r">{tr('手续费', 'Fees')}</th>
            </tr>
          </thead>
          <tbody>
            {[...groups].sort((a, b) => cmp(a.row, b.row)).map(({ c, row, items }) => {
              const open = !collapsed.has(c.key);
              const activeCat = category === c.key && !instrument;
              const dim = category != null && category !== c.key;
              return (
                <Fragment key={c.key}>
                  <tr className={`cursor-pointer bg-bg-inset/40 ${activeCat ? '!bg-accent/[0.07]' : ''} ${dim ? 'opacity-55' : ''}`}
                    onClick={() => onCategory(activeCat ? null : c.key)} title={c.hint()}>
                    <td>
                      <button className="inline-block w-4 text-text-muted hover:text-text-primary" aria-expanded={open}
                        onClick={(e) => { e.stopPropagation(); toggle(c.key); }}>{open ? '▾' : '▸'}</button>
                      <span className="font-semibold">{row.key}</span>
                      <span className="ml-2 text-[11px] text-text-muted">{tr(`${items.length} 个品种`, `${items.length} instruments`)}</span>
                    </td>
                    {cells(row, maxCat)}
                  </tr>
                  {open && (() => {
                    // Small instruments drop out when "hide small" is on (a selected one stays visible)
                    const small = hideSmall ? items.filter((r) => isSmall(r) && !(instrument === r.key && category === c.key)) : [];
                    const sorted = items.filter((r) => !small.includes(r)).sort(cmp);
                    // keep a selected instrument visible even when it is outside the top rows
                    const full = expandedAll.has(c.key) || sorted.length <= TREE_LIMIT + 1;
                    // Folded rows are the least significant ones (smallest |PnL|, or fewest trades when
                    // sorting by count), so big winners and big losers both stay visible
                    const weight = (r: Row) => (sort.k === 'pnl' ? Math.abs(r.s.pnl) : r.n);
                    const keep = new Set([...sorted].sort((a, b) => weight(b) - weight(a)).slice(0, TREE_LIMIT).map((r) => r.key));
                    const head = full ? sorted : sorted.filter((r) => keep.has(r.key) || (instrument === r.key && category === c.key));
                    const hidden = sorted.length - head.length;
                    return <>{head.map((r) => {
                    const active = instrument === r.key && category === c.key;
                    return (
                      <tr key={r.key} className={`cursor-pointer ${active ? '!bg-accent/[0.07]' : ''} ${dim ? 'opacity-55' : ''}`}
                        onClick={() => onInstrument(c.key, active ? null : r.key)}>
                        <td className="!pl-11">
                          <span className={active ? 'text-accent font-medium' : 'text-text-primary'}>{r.key}</span>
                        </td>
                        {cells(r, maxInst)}
                      </tr>
                    );
                  })}
                    {(hidden > 0 || (expandedAll.has(c.key) && sorted.length > TREE_LIMIT + 1)) && (
                      <tr className={dim ? 'opacity-55' : ''}>
                        <td colSpan={9} className="!pl-11 !py-2">
                          <button className="text-[12px] text-text-muted hover:text-text-secondary"
                            onClick={() => setExpandedAll((s) => { const n = new Set(s); if (n.has(c.key)) n.delete(c.key); else n.add(c.key); return n; })}>
                            {hidden > 0
                              ? <>▸ {tr(`其余 ${hidden} 个品种`, `${hidden} more instruments`)} <span className="num">{signedUsd(sorted.filter((r) => !head.includes(r)).reduce((s, r) => s + r.s.pnl, 0))}</span></>
                              : <>▾ {tr('收起', 'Show less')}</>}
                          </button>
                        </td>
                      </tr>
                    )}
                    {small.length > 0 && (
                      <tr className={dim ? 'opacity-55' : ''}>
                        <td colSpan={9} className="!pl-11 !py-2 text-[12px] text-text-muted">
                          {tr(`已隐藏 ${small.length} 个 |盈亏| < $${SMALL_PNL} 的品种`, `${small.length} instrument(s) with |PnL| < $${SMALL_PNL} hidden`)}
                          <span className="num ml-1.5">{signedUsd(small.reduce((s, r) => s + r.s.pnl, 0))}</span>
                        </td>
                      </tr>
                    )}
                    </>;
                  })()}
                </Fragment>
              );
            })}
            <tr className={`cursor-pointer border-t border-border-card ${category == null ? '!bg-accent/[0.04]' : ''}`} onClick={() => onCategory(null)}>
              <td className="font-semibold text-text-secondary"><span className="inline-block w-4" />{total.key}</td>
              {cells(total, Math.max(maxCat, Math.abs(total.s.pnl)))}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
