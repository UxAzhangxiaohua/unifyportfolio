import { useMemo, useState, type ReactNode } from 'react';
import { useTrades } from '../hooks/usePortfolio';
import type { ClosedTrade, TradeCategory } from '../types';
import { ExchangeTag, SideBadge, CardHeader, EmptyState } from './ui';
import { tr, locale } from '../lib/i18n';
import { fmtSigned, pnlClass } from '../lib/format';
import { instrumentKey, summarize } from '../lib/tradeStats';
import { TradePnlCurve } from './TradePnlCurve';

type Range = '24h' | '3d' | '7d' | '30d' | 'all';
const RANGES: { key: Range; label: () => string; ms: number }[] = [
  { key: '24h', label: () => '24H', ms: 86_400_000 },
  { key: '3d', label: () => tr('3天', '3D'), ms: 3 * 86_400_000 },
  { key: '7d', label: () => tr('7天', '7D'), ms: 7 * 86_400_000 },
  { key: '30d', label: () => tr('30天', '30D'), ms: 30 * 86_400_000 },
  { key: 'all', label: () => tr('全部', 'All'), ms: Infinity },
];
const RANGE_KEY = 'unify.tradesRange';

// XAU = gold (incl. gold-backed tokens; any other commodity / FX would land here too);
// Stock includes index contracts such as NAS100 / USTEC
const CATEGORIES: { key: TradeCategory; label: () => string; hint: () => string }[] = [
  { key: 'xau', label: () => 'XAU', hint: () => tr('黄金：XAUUSD、XAUT、PAXG 等', 'Gold: XAUUSD, XAUT, PAXG, …') },
  { key: 'stock', label: () => 'Stock', hint: () => tr('股票、ETF 与股指合约（NAS100、USTEC 等）', 'Stocks, ETFs and index contracts (NAS100, USTEC, …)') },
  { key: 'crypto', label: () => 'Crypto', hint: () => tr('加密货币合约', 'Crypto contracts') },
  { key: 'option', label: () => tr('期权', 'Options'), hint: () => tr('期权', 'Options') },
];
const catLabel = (c: TradeCategory | undefined) => CATEGORIES.find((x) => x.key === c)?.label() ?? '—';
const LIST_LIMIT = 200;

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

/** afterSummary renders between the stats card and the trade-list card */
export function TradesHistory({ afterSummary }: { afterSummary?: ReactNode } = {}) {
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
  const pickCategory = (c: TradeCategory | null) => { setCategory(c); setInstrument(null); };

  const summary = useMemo(() => summarize(shown), [shown]);

  const bySymbol = useMemo(() => {
    const m = new Map<string, ClosedTrade[]>();
    for (const t of inCategory) m.set(instrumentKey(t), [...(m.get(instrumentKey(t)) ?? []), t]);
    return [...m.entries()]
      .map(([key, list]) => ({ key, list, s: summarize(list), long: list.filter((t) => t.side === 'long').length, cat: list[0].category }))
      .sort((a, b) => b.list.length - a.list.length || Math.abs(b.s.pnl) - Math.abs(a.s.pnl));
  }, [inCategory]);

  if (isLoading || !all) return <>{afterSummary}</>;
  // Options tile only when there are option trades at all
  const hasOptions = all.some((t) => t.category === 'option');

  return (
    <>
    <section className="card overflow-hidden">
      <CardHeader
        title={tr('已平仓统计', 'Closed trades')}
        sub={tr('取自各交易所的平仓 / 成交记录（只读 API），盈亏已扣手续费', 'From each venue’s closed-position / fill history (read-only API), net of fees')}
        right={
          <>
            {instrument && (
              <button className="chip !text-text-primary hover:border-border-hover" onClick={() => setInstrument(null)} title={tr('清除品种筛选', 'Clear instrument filter')}>
                {instrument} ✕
              </button>
            )}
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

          {/* Headline stats (for the selected category / instrument) */}
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

          <div className="px-5 pb-4">
            <TradePnlCurve trades={shown} />
          </div>

          <div className="px-5 pb-4">
            {/* Per instrument */}
            <div className="rounded-lg border border-border-card overflow-hidden min-w-0">
              <div className="px-3.5 py-2.5 text-[12px] font-medium text-text-secondary border-b border-border-card">
                {tr('按品种', 'By instrument')} <span className="text-text-muted font-normal">· {tr('点击筛选', 'click to filter')}</span>
              </div>
              {bySymbol.length === 0 ? (
                <div className="px-3.5 py-4 text-[12px] text-text-muted">{tr('此区间没有平仓', 'No closes in this range')}</div>
              ) : (
                <div className="overflow-x-auto max-h-[300px]">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>{tr('品种', 'Instrument')}</th>
                        <th className="r">{tr('笔数', 'Trades')}</th>
                        <th className="r">{tr('胜率', 'Win %')}</th>
                        <th className="r">{tr('盈亏', 'PnL')}</th>
                        <th className="r">{tr('平均盈 / 亏', 'Avg win / loss')}</th>
                        <th className="r">{tr('多 / 空', 'L / S')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bySymbol.map(({ key, list, s, long, cat }) => (
                        <tr
                          key={key}
                          className={`cursor-pointer ${instrument === key ? 'bg-white/[0.04]' : ''}`}
                          onClick={() => setInstrument(instrument === key ? null : key)}
                        >
                          <td className="font-medium">{key}{!category && <span className="ml-1.5 text-[10px] text-text-muted font-normal">{catLabel(cat)}</span>}</td>
                          <td className="r num text-text-secondary">{list.length}</td>
                          <td className="r num">{pct(s.winRate)}</td>
                          <td className={`r num ${pnlClass(s.pnl)}`}>{signedUsd(s.pnl)}</td>
                          <td className="r num text-[12px]">
                            <span className="text-profit">{s.avgWin != null ? fmtSigned(s.avgWin) : '—'}</span>
                            <span className="text-text-muted"> / </span>
                            <span className="text-loss">{s.avgLoss != null ? fmtSigned(s.avgLoss) : '—'}</span>
                          </td>
                          <td className="r num text-text-muted">{long} / {list.length - long}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

          </div>

        </>
      )}
    </section>

    {afterSummary}

    {all.length > 0 && (
      <section className="card overflow-hidden">
          <CardHeader title={tr('平仓明细', 'Closed trades list')}
            sub={<>{tr(`${shown.length} 笔`, `${shown.length} trades`)}{(category || instrument) && <> · {[category && catLabel(category), instrument].filter(Boolean).join(' · ')}</>}</>} />
          {/* Trade list */}
          {shown.length === 0 ? (
            <EmptyState>{tr('此区间没有平仓', 'No closes in this range')}</EmptyState>
          ) : (
            <div className="overflow-x-auto max-h-[560px] border-t border-border-card">
              <table className="data">
                <thead>
                  <tr>
                    <th>{tr('平仓时间', 'Closed')}</th><th>{tr('合约', 'Contract')}</th><th>{tr('交易所', 'Exchange')}</th><th>{tr('方向', 'Side')}</th>
                    <th className="r">{tr('开仓', 'Entry')}</th><th className="r">{tr('平仓', 'Exit')}</th><th className="r">{tr('数量', 'Qty')}</th>
                    <th className="r">{tr('盈亏', 'PnL')}</th><th>{tr('类别', 'Category')}</th><th className="r">{tr('持仓时长', 'Duration')}</th>
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
                        <td className="font-medium">{t.symbol}</td>
                        <td><ExchangeTag exchange={t.exchange} /></td>
                        <td><SideBadge side={t.side} /></td>
                        <td className="r num text-text-secondary">{t.entryPrice != null ? formatPrice(t.entryPrice) : '—'}</td>
                        <td className="r num text-text-secondary">{formatPrice(t.exitPrice)}</td>
                        <td className="r num text-text-secondary">{formatQty(t.quantity)}</td>
                        <td className="r">
                          <div className={`num ${win ? 'text-profit' : 'text-loss'}`}>{signedUsd(t.realizedPnl)}</div>
                          <div className={`num text-[11px] opacity-70 ${win ? 'text-profit' : 'text-loss'}`}>{win ? '+' : ''}{t.pnlPercent.toFixed(2)}%</div>
                        </td>
                        <td className="text-text-muted text-[12px]">{catLabel(t.category)}{t.source !== 'venue' && <span className="ml-1.5 text-[10px]">{tr('推算', 'inferred')}</span>}</td>
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
