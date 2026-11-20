import { useEffect, useRef, useState } from 'react';
import { createChart, AreaSeries, type IChartApi, type ISeriesApi, ColorType, LineType, type UTCTimestamp } from 'lightweight-charts';
import { useHistory, useHistoryAccounts } from '../hooks/usePortfolio';
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
  const [selectedAccount, setSelectedAccount] = useState<string | undefined>(undefined);
  const { data: history } = useHistory(period, selectedAccount);
  const { data: accounts } = useHistoryAccounts();

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);

  const isPositive = (history?.pnl ?? 0) >= 0;
  const lineColor = isPositive ? '#2ecc8f' : '#f2545b';
  const topColor = isPositive ? 'rgba(46,204,143,0.18)' : 'rgba(242,84,91,0.18)';
  const bottomColor = 'rgba(0,0,0,0)';

  // Create chart once
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#5d6475',
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: 'rgba(29,34,45,0.7)' },
      },
      crosshair: {
        vertLine: { color: 'rgba(139,156,255,0.35)', width: 1, labelBackgroundColor: '#1d222d' },
        horzLine: { color: 'rgba(139,156,255,0.35)', width: 1, labelBackgroundColor: '#1d222d' },
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.1, bottom: 0.05 },
      },
      timeScale: {
        borderVisible: false,
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
    <section className="card overflow-hidden relative">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4 pb-1">
        <div className="flex items-baseline gap-3 min-w-0">
          <h2 className="section-title">
            {selectedAccount ? accounts?.find((a) => a.accountId === selectedAccount)?.label ?? selectedAccount : '资产走势'}
          </h2>
          {history && history.points.length > 0 && (
            <span className={`num text-[13px] font-medium ${isPositive ? 'text-profit' : 'text-loss'}`}>
              {isPositive ? '+' : ''}{formatUSD(history.pnl)}
              <span className="ml-1.5 opacity-75">{isPositive ? '+' : ''}{history.pnlPercent.toFixed(2)}%</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {accounts && accounts.length > 1 && (
            <select
              value={selectedAccount ?? ''}
              onChange={(e) => setSelectedAccount(e.target.value || undefined)}
              className="text-[12px] bg-bg-inset border border-border-card rounded-lg px-2.5 py-1 text-text-secondary outline-none focus:border-border-hover"
            >
              <option value="">全部账户</option>
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

      <div ref={containerRef} className="w-full h-[260px]" />

      {(!history || history.points.length === 0) && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="text-text-muted text-sm">正在采集数据…</span>
        </div>
      )}
    </section>
  );
}
