import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart, BaselineSeries, ColorType, LineStyle, LineType, TickMarkType,
  type IChartApi, type ISeriesApi, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import type { ClosedTrade } from '../types';
import { fmtCompact, fmtSigned, pnlClass } from '../lib/format';
import { locale, tr } from '../lib/i18n';

// Cumulative realized PnL of closed trades — trading performance alone, unaffected by deposits,
// withdrawals or transfers. Follows the trade filters (range / category / instrument) of TradesHistory.

const PROFIT = '#2ecc8f';
const LOSS = '#f2545b';
const MUTED = '#5d6475';

const asDate = (t: Time) => new Date((t as number) * 1000);
const fmtTick = (t: Time, type: TickMarkType) => {
  const d = asDate(t);
  if (type === TickMarkType.Year) return String(d.getFullYear());
  if (type === TickMarkType.Month || type === TickMarkType.DayOfMonth) return d.toLocaleDateString(locale(), { month: 'numeric', day: 'numeric' });
  return d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', hour12: false });
};
const fmtFull = (t: number) => new Date(t * 1000).toLocaleString(locale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

interface Pt { t: number; v: number; d: number; n: number }
interface Hover { x: number; y: number; p: Pt }

export function TradePnlCurve({ trades }: { trades: ClosedTrade[] }) {
  // One point per second with closes (lightweight-charts needs strictly increasing times)
  const points = useMemo<Pt[]>(() => {
    const sorted = [...trades].sort((a, b) => Date.parse(a.exitTime) - Date.parse(b.exitTime));
    const out: Pt[] = [];
    let cum = 0;
    for (const x of sorted) {
      const t = Math.floor(Date.parse(x.exitTime) / 1000);
      cum += x.realizedPnl;
      const last = out[out.length - 1];
      if (last && last.t === t) { last.v = cum; last.d += x.realizedPnl; last.n++; } else out.push({ t, v: cum, d: x.realizedPnl, n: 1 });
    }
    if (out.length) out.unshift({ t: out[0].t - 1, v: 0, d: 0, n: 0 }); // start at zero
    return out;
  }, [trades]);
  const byTime = useMemo(() => new Map(points.map((p) => [p.t, p])), [points]);

  const stats = useMemo(() => {
    if (points.length < 2) return null;
    let peak = 0, dd = 0, hi = 0, lo = 0;
    for (const p of points) {
      peak = Math.max(peak, p.v); hi = Math.max(hi, p.v); lo = Math.min(lo, p.v);
      dd = Math.max(dd, peak - p.v);
    }
    return { end: points[points.length - 1].v, dd, hi, lo };
  }, [points]);

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Baseline'> | null>(null);
  const byTimeRef = useRef(byTime);
  byTimeRef.current = byTime;
  const [hover, setHover] = useState<Hover | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: MUTED, fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 11, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: 'rgba(29,34,45,0.7)' } },
      crosshair: {
        vertLine: { color: 'rgba(144,151,168,0.35)', width: 1, style: LineStyle.Solid, labelVisible: false },
        horzLine: { visible: false, labelVisible: false },
      },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, tickMarkFormatter: (t: Time, type: TickMarkType) => fmtTick(t, type) },
      localization: { timeFormatter: (t: Time) => fmtFull(t as number), priceFormatter: (p: number) => fmtCompact(p) },
      handleScroll: false,
      handleScale: false,
    });
    const series = chart.addSeries(BaselineSeries, {
      baseValue: { type: 'price', price: 0 },
      topLineColor: PROFIT, topFillColor1: 'rgba(46,204,143,0.20)', topFillColor2: 'rgba(46,204,143,0.02)',
      bottomLineColor: LOSS, bottomFillColor1: 'rgba(242,84,91,0.02)', bottomFillColor2: 'rgba(242,84,91,0.20)',
      lineWidth: 2, lineType: LineType.WithSteps, priceLineVisible: false, lastValueVisible: true,
      crosshairMarkerRadius: 4, crosshairMarkerBorderColor: '#11141b', crosshairMarkerBorderWidth: 2,
      priceFormat: { type: 'custom', formatter: (p: number) => fmtCompact(p), minMove: 0.01 },
    });
    series.createPriceLine({ price: 0, color: MUTED, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' });
    chart.subscribeCrosshairMove((param) => {
      const p = param.point && param.time != null ? byTimeRef.current.get(param.time as number) : undefined;
      if (!param.point || !p) { setHover(null); return; }
      setHover({ x: param.point.x, y: param.point.y, p });
    });
    chartRef.current = chart;
    seriesRef.current = series;
    const ro = new ResizeObserver((entries) => { for (const e of entries) chart.applyOptions({ width: e.contentRect.width, height: e.contentRect.height }); });
    ro.observe(el);
    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; seriesRef.current = null; };
  }, []);

  useEffect(() => {
    const series = seriesRef.current, chart = chartRef.current;
    if (!series || !chart) return;
    series.setData(points.map((p) => ({ time: p.t as UTCTimestamp, value: p.v })));
    chart.timeScale().fitContent();
  }, [points]);

  return (
    <div className="rounded-lg border border-border-card bg-bg-inset/40 overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-3.5 pt-2.5 pb-1 text-[12px] text-text-muted">
        <span className="text-text-secondary font-medium">
          {tr('累计已实现盈亏', 'Cumulative realized PnL')}
          <span className="font-normal text-text-muted"> · {tr('每次平仓一个台阶，不受充提和转账影响', 'one step per close, unaffected by deposits and transfers')}</span>
        </span>
        {stats && (
          <span className="flex flex-wrap gap-x-5">
            <span>{tr('最高', 'High')} <span className="num text-text-secondary">{fmtSigned(stats.hi)}</span></span>
            <span>{tr('最低', 'Low')} <span className="num text-text-secondary">{fmtSigned(stats.lo)}</span></span>
            <span>{tr('最大回撤', 'Max drawdown')} <span className={`num ${stats.dd > 0 ? 'text-loss' : 'text-text-secondary'}`}>{stats.dd > 0 ? fmtSigned(-stats.dd) : '—'}</span></span>
          </span>
        )}
      </div>
      <div className="relative">
        <div ref={containerRef} className="w-full h-[240px]" />
        {hover && (
          <div className="pointer-events-none absolute z-10 card !rounded-lg px-3 py-2 text-[12px] shadow-lg whitespace-nowrap"
            style={{ left: Math.min(Math.max(hover.x + 14, 8), (containerRef.current?.clientWidth ?? 0) - 190), top: Math.max(hover.y - 70, 4) }}>
            <div className="text-text-muted num">{fmtFull(hover.p.t)}</div>
            <div className={`num text-[14px] font-semibold ${pnlClass(hover.p.v)}`}>{fmtSigned(hover.p.v)}</div>
            {hover.p.n > 0 && (
              <div className="text-text-muted">
                {hover.p.n > 1 ? tr(`${hover.p.n} 笔平仓`, `${hover.p.n} closes`) : tr('本笔', 'This close')} <span className={`num ${pnlClass(hover.p.d)}`}>{fmtSigned(hover.p.d)}</span>
              </div>
            )}
          </div>
        )}
        {points.length < 2 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span className="text-text-muted text-sm">{tr('此区间没有平仓', 'No closes in this range')}</span>
          </div>
        )}
      </div>
    </div>
  );
}
