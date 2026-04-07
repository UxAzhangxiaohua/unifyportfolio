import { useEffect, useRef, useState } from 'react';
import { createChart, AreaSeries, type IChartApi, type ISeriesApi, ColorType, LineType, type UTCTimestamp } from 'lightweight-charts';
import { useHistory } from '../hooks/usePortfolio';
import type { TimePeriod } from '../types';

const PERIODS: { key: TimePeriod; label: string }[] = [
  { key: '1h', label: '1H' },
  { key: '4h', label: '4H' },
  { key: '24h', label: '24H' },
  { key: '1w', label: '1W' },
  { key: 'all', label: 'ALL' },
];

function formatUSD(n: number, compact = false): string {
  if (compact && Math.abs(n) >= 1000) {
    return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function EquityChart() {
  const [period, setPeriod] = useState<TimePeriod>('24h');
  const { data: history } = useHistory(period);

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);

  const isPositive = (history?.pnl ?? 0) >= 0;
  const lineColor = isPositive ? '#00ff88' : '#ff4455';
  const topColor = isPositive ? 'rgba(0,255,136,0.15)' : 'rgba(255,68,85,0.15)';
  const bottomColor = 'rgba(0,0,0,0)';

  // Create chart once
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#71717a',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(30,30,46,0.5)' },
        horzLines: { color: 'rgba(30,30,46,0.5)' },
      },
      crosshair: {
        vertLine: { color: 'rgba(99,102,241,0.4)', width: 1, labelBackgroundColor: '#1e1e2e' },
        horzLine: { color: 'rgba(99,102,241,0.4)', width: 1, labelBackgroundColor: '#1e1e2e' },
      },
      rightPriceScale: {
        borderColor: 'rgba(30,30,46,0.5)',
        scaleMargins: { top: 0.1, bottom: 0.05 },
      },
      timeScale: {
        borderColor: 'rgba(30,30,46,0.5)',
        timeVisible: true,
        secondsVisible: false,
      },
      handleScroll: false,
      handleScale: false,
    });

    const series = chart.addSeries(AreaSeries, {
      lineColor,
      topColor,
      bottomColor,
      lineWidth: 2,
      lineType: LineType.Curved,
      priceFormat: { type: 'custom', formatter: (p: number) => formatUSD(p, true) },
      crosshairMarkerRadius: 4,
      crosshairMarkerBackgroundColor: lineColor,
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        chart.applyOptions({ width: entry.contentRect.width });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update series data + colors when history or period changes
  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) return;

    seriesRef.current.applyOptions({
      lineColor,
      topColor,
      bottomColor,
      crosshairMarkerBackgroundColor: lineColor,
    });

    if (history?.points?.length) {
      const data = history.points.map((p) => ({
        time: p.t as UTCTimestamp,
        value: p.v,
      }));
      seriesRef.current.setData(data);
      chartRef.current.timeScale().fitContent();
    } else {
      seriesRef.current.setData([]);
    }
  }, [history, lineColor, topColor, bottomColor]);

  return (
    <div className="bg-bg-card border border-border-card rounded-xl overflow-hidden relative">
      {/* Chart header */}
      <div className="flex items-center justify-between px-5 pt-4 pb-2">
        <div className="flex items-center gap-4">
          <span className="text-xs text-text-secondary uppercase tracking-wider font-semibold">
            Portfolio Value
          </span>
          {history && history.points.length > 0 && (
            <div className="flex items-center gap-2">
              <span className={`text-sm font-bold tabular-nums ${isPositive ? 'text-profit' : 'text-loss'}`}>
                {isPositive ? '+' : ''}{formatUSD(history.pnl)}
              </span>
              <span className={`text-xs tabular-nums px-1.5 py-0.5 rounded ${isPositive ? 'bg-profit/10 text-profit' : 'bg-loss/10 text-loss'}`}>
                {isPositive ? '+' : ''}{history.pnlPercent.toFixed(2)}%
              </span>
            </div>
          )}
        </div>
        <div className="flex gap-1">
          {PERIODS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setPeriod(key)}
              className={`text-[11px] px-2.5 py-1 rounded-md font-medium transition-all ${
                period === key
                  ? 'bg-accent/15 text-accent'
                  : 'text-text-muted hover:text-text-secondary hover:bg-bg-card-hover'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Chart container */}
      <div ref={containerRef} className="w-full h-[300px]" />

      {/* No data overlay */}
      {(!history || history.points.length === 0) && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="text-text-muted text-sm">Collecting data...</span>
        </div>
      )}
    </div>
  );
}
