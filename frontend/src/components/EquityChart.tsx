import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart, BaselineSeries, ColorType, LineStyle, LineType, TickMarkType,
  type IChartApi, type IPriceLine, type ISeriesApi, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import { useHistory, useHistoryAccounts } from '../hooks/usePortfolio';
import type { TimePeriod } from '../types';
import { fmtCompact, fmtPct, fmtSigned, fmtUSD, pnlClass } from '../lib/format';
import { locale, tr } from '../lib/i18n';

const PERIODS: { key: TimePeriod; label: string }[] = [
  { key: '1h', label: '1H' },
  { key: '4h', label: '4H' },
  { key: '24h', label: '24H' },
  { key: '1w', label: '1W' },
  { key: '30d', label: '1M' },
  { key: 'all', label: 'ALL' },
];

// Theme tokens (lightweight-charts draws on canvas, so CSS vars must be resolved to literals)
const PROFIT = '#2ecc8f';
const LOSS = '#f2545b';
const MUTED = '#5d6475';
const EST_LINE = '#8a91a3';
const EST_FILL = 'rgba(144,151,168,0.12)';

// lightweight-charts renders UTCTimestamp as UTC; format in the viewer's local time instead
const asDate = (t: Time) => new Date((t as number) * 1000);
const fmtTick = (t: Time, type: TickMarkType) => {
  const d = asDate(t);
  if (type === TickMarkType.Year) return String(d.getFullYear());
  if (type === TickMarkType.Month || type === TickMarkType.DayOfMonth) return d.toLocaleDateString(locale(), { month: 'numeric', day: 'numeric' });
  return d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', hour12: false });
};
const fmtFull = (t: number) => new Date(t * 1000).toLocaleString(locale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

const SCOPE_KEY = 'unify.chartScope';

interface Hover { x: number; y: number; t: number; v: number }

// Stable reference while history loads, so effects keyed on `points` don't re-run every render
const EMPTY: Array<{ t: number; v: number }> = [];

export function EquityChart() {
  const [period, setPeriod] = useState<TimePeriod>('24h');
  const [selectedAccount, setSelectedAccount] = useState<string | undefined>(undefined);
  // 'trading' = equity minus earn + funding wallets (CFD/MT5 count as trading)
  const [scope, setScope] = useState<'total' | 'trading'>(() => {
    try { return localStorage.getItem(SCOPE_KEY) === 'trading' ? 'trading' : 'total'; } catch { return 'total'; }
  });
  useEffect(() => { try { localStorage.setItem(SCOPE_KEY, scope); } catch { /* ignore */ } }, [scope]);
  const { data: history } = useHistory(period, selectedAccount, scope);
  const { data: accounts } = useHistoryAccounts();

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Baseline'> | null>(null);
  const baseLineRef = useRef<IPriceLine | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  const points = history?.points ?? EMPTY;
  const stats = useMemo(() => {
    if (!points.length) return null;
    const start = points[0].v;
    const end = points[points.length - 1].v;
    let hi = -Infinity, lo = Infinity, peak = -Infinity, dd = 0, ddPct = 0;
    for (const p of points) {
      hi = Math.max(hi, p.v); lo = Math.min(lo, p.v);
      peak = Math.max(peak, p.v);
      if (peak - p.v > dd) { dd = peak - p.v; ddPct = peak > 0 ? (dd / peak) * 100 : 0; }
    }
    return { start, end, hi, lo, dd, ddPct, from: points[0].t };
  }, [points, history?.backfilledBefore]);

  // Create chart once
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: MUTED,
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: 'rgba(29,34,45,0.7)' } },
      crosshair: {
        vertLine: { color: 'rgba(144,151,168,0.35)', width: 1, style: LineStyle.Solid, labelVisible: false },
        horzLine: { visible: false, labelVisible: false },
      },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (t: Time, type: TickMarkType) => fmtTick(t, type),
      },
      localization: { timeFormatter: (t: Time) => fmtFull(t as number), priceFormatter: (p: number) => fmtCompact(p) },
      handleScroll: false,
      handleScale: false,
    });

    // Baseline at the period's opening equity: green above, red below
    const series = chart.addSeries(BaselineSeries, {
      baseValue: { type: 'price', price: 0 },
      topLineColor: PROFIT,
      topFillColor1: 'rgba(46,204,143,0.20)',
      topFillColor2: 'rgba(46,204,143,0.02)',
      bottomLineColor: LOSS,
      bottomFillColor1: 'rgba(242,84,91,0.02)',
      bottomFillColor2: 'rgba(242,84,91,0.20)',
      lineWidth: 2,
      lineType: LineType.Simple, // curved interpolation overshoots and invents values
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerRadius: 4,
      crosshairMarkerBorderColor: '#11141b',
      crosshairMarkerBorderWidth: 2,
      priceFormat: { type: 'custom', formatter: (p: number) => fmtCompact(p), minMove: 0.01 },
    });

    chart.subscribeCrosshairMove((param) => {
      const d = param.point && param.time != null ? param.seriesData.get(series) as { value?: number } | undefined : undefined;
      if (!param.point || d?.value == null) { setHover(null); return; }
      setHover({ x: param.point.x, y: param.point.y, t: param.time as number, v: d.value });
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const ro = new ResizeObserver((entries) => {
      for (const e of entries) chart.applyOptions({ width: e.contentRect.width, height: e.contentRect.height });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      baseLineRef.current = null;
    };
  }, []);

  // Push data + move the baseline to the period's opening value
  useEffect(() => {
    const series = seriesRef.current, chart = chartRef.current;
    if (!series || !chart) return;
    if (baseLineRef.current) { series.removePriceLine(baseLineRef.current); baseLineRef.current = null; }
    if (!points.length) { series.setData([]); return; }

    const start = points[0].v;
    series.applyOptions({ baseValue: { type: 'price', price: start } });
    // Reconstructed points (before the first recorded sample) are drawn muted
    const estBefore = history?.backfilledBefore ?? 0;
    series.setData(points.map((p) => (p.t < estBefore
      ? { time: p.t as UTCTimestamp, value: p.v, topLineColor: EST_LINE, bottomLineColor: EST_LINE, topFillColor1: EST_FILL, topFillColor2: 'rgba(144,151,168,0.01)', bottomFillColor1: 'rgba(144,151,168,0.01)', bottomFillColor2: EST_FILL }
      : { time: p.t as UTCTimestamp, value: p.v })));
    baseLineRef.current = series.createPriceLine({
      price: start, color: MUTED, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '',
    });
    chart.timeScale().fitContent();
  }, [points]);

  const acctLabel = selectedAccount ? accounts?.find((a) => a.accountId === selectedAccount)?.label ?? selectedAccount : null;
  const title = scope === 'trading'
    ? (acctLabel ? `${acctLabel} · ${tr('交易账户', 'Trading')}` : tr('交易账户走势', 'Trading equity'))
    : acctLabel ?? tr('资产走势', 'Equity');
  const pnl = history?.pnl ?? 0;
  const spanH = stats && points.length > 1 ? (points[points.length - 1].t - stats.from) / 3600 : 0;

  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4 pb-2">
        <div className="flex items-baseline gap-3 min-w-0">
          <h2 className="section-title">{title}</h2>
          {stats && (
            <span className={`num text-[13px] font-medium ${pnlClass(pnl)}`}>
              {fmtSigned(pnl)}<span className="ml-1.5 opacity-75">{fmtPct(history?.pnlPercent ?? 0)}</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="seg" title={tr('交易账户 = 权益 − 理财 − 资金账户余额（CFD/MT5 计入交易账户）', 'Trading = equity − earn − funding wallets (CFD/MT5 count as trading)')}>
            <button data-active={scope === 'total'} onClick={() => setScope('total')}>{tr('总权益', 'Total')}</button>
            <button data-active={scope === 'trading'} onClick={() => setScope('trading')}>{tr('交易账户', 'Trading')}</button>
          </div>
          {accounts && accounts.length > 1 && (
            <select
              value={selectedAccount ?? ''}
              onChange={(e) => setSelectedAccount(e.target.value || undefined)}
              className="text-[12px] bg-bg-inset border border-border-card rounded-lg px-2.5 py-1 text-text-secondary outline-none focus:border-border-hover"
            >
              <option value="">{tr('全部账户', 'All accounts')}</option>
              {accounts.map((acc) => <option key={acc.accountId} value={acc.accountId}>{acc.label}</option>)}
            </select>
          )}
          <div className="seg">
            {PERIODS.map(({ key, label }) => (
              <button key={key} data-active={period === key} onClick={() => setPeriod(key)}>{label}</button>
            ))}
          </div>
        </div>
      </div>

      {stats && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 px-5 pb-2 text-[12px] text-text-muted">
          <span>{tr('期初', 'Open')} <span className="num text-text-secondary">{fmtUSD(stats.start, { decimals: false })}</span></span>
          <span>{tr('当前', 'Now')} <span className="num text-text-primary">{fmtUSD(stats.end, { decimals: false })}</span></span>
          <span>{tr('最高', 'High')} <span className="num text-text-secondary">{fmtUSD(stats.hi, { decimals: false })}</span></span>
          <span>{tr('最低', 'Low')} <span className="num text-text-secondary">{fmtUSD(stats.lo, { decimals: false })}</span></span>
          <span>{tr('区间最大回撤', 'Max drawdown')} <span className={`num ${stats.dd > 0 ? 'text-loss' : 'text-text-secondary'}`}>{stats.dd > 0 ? `${fmtSigned(-stats.dd)} (${fmtPct(-stats.ddPct)})` : '—'}</span></span>
        </div>
      )}

      <div className="relative">
        <div ref={containerRef} className="w-full h-[280px]" />

        {hover && stats && (
          <div
            className="pointer-events-none absolute z-10 card !rounded-lg px-3 py-2 text-[12px] shadow-lg whitespace-nowrap"
            style={{
              left: Math.min(Math.max(hover.x + 14, 8), (containerRef.current?.clientWidth ?? 0) - 190),
              top: Math.max(hover.y - 70, 4),
            }}
          >
            <div className="text-text-muted num">
              {fmtFull(hover.t)}
              {history?.backfilledBefore != null && hover.t < history.backfilledBefore && <span className="ml-1.5 text-delayed">{tr('估算', 'estimate')}</span>}
            </div>
            <div className="num text-[14px] font-semibold text-text-primary">{fmtUSD(hover.v)}</div>
            <div className={`num ${pnlClass(hover.v - stats.start)}`}>
              {fmtSigned(hover.v - stats.start)} · {fmtPct(stats.start > 0 ? ((hover.v - stats.start) / stats.start) * 100 : 0)}
              <span className="text-text-muted"> {tr('较期初', 'vs open')}</span>
            </div>
          </div>
        )}

        {!points.length && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span className="text-text-muted text-sm">{scope === 'trading'
              ? tr('交易账户曲线从本次更新开始记录，正在采集…', 'Trading-equity history starts with this update — collecting…')
              : tr('正在采集数据…', 'Collecting data…')}</span>
          </div>
        )}
      </div>

      {stats && scope === 'trading' && history?.estimatedBefore != null && (
        <div className="px-5 pb-1 -mt-1 text-[11px] text-text-muted">
          {tr(
            `${fmtFull(history.estimatedBefore)} 之前的交易账户值为估算（理财 + 资金账户余额按最早记录值扣除）`,
            `Trading equity before ${fmtFull(history.estimatedBefore)} is estimated (earn + funding taken at their earliest recorded value)`,
          )}
        </div>
      )}

      {stats && scope === 'total' && history?.backfilledBefore != null && (
        <div className="px-5 pb-1 -mt-1 text-[11px] text-text-muted">
          <span className="inline-block w-3 h-[2px] align-middle mr-1.5" style={{ background: EST_LINE }} />
          {tr(
            `${fmtFull(history.backfilledBefore)} 之前（灰色）为补全的估算值：Hyperliquid 用交易所自带的账户价值历史，其余账户由平仓盈亏 + 稳定币充提倒推（不含当时持仓的浮盈亏、资金费和理财利息）`,
            `Before ${fmtFull(history.backfilledBefore)} (grey) the curve is reconstructed: Hyperliquid from its own account-value history, other accounts walked back from closed-trade PnL + stablecoin deposits/withdrawals (excl. unrealized PnL at the time, funding and earn interest)`,
          )}
        </div>
      )}

      {stats && (period === '1w' || period === '30d' || period === 'all') && (
        <div className="px-5 pb-3 -mt-1 text-[11px] text-text-muted">
          {tr(
            `近期为 30 秒精度，更早的数据每 30 分钟一个点（本地 SQLite 保存，重启不丢失）· 覆盖 ${spanH < 48 ? `${spanH.toFixed(1)} 小时` : `${(spanH / 24).toFixed(1)} 天`}`,
            `Recent data at 30s resolution, older data one point per 30 min (stored in local SQLite, survives restarts) · covering ${spanH < 48 ? `${spanH.toFixed(1)} h` : `${(spanH / 24).toFixed(1)} d`}`,
          )}
        </div>
      )}
    </section>
  );
}
