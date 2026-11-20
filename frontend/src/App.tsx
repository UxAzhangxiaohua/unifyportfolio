import { usePortfolio } from './hooks/usePortfolio';
import { Header } from './components/Header';
import { KpiRow } from './components/KpiRow';
import { EquityChart } from './components/EquityChart';
import { MetricsRow } from './components/MetricsRow';
import { AccountsGrid } from './components/AccountsGrid';
import { StablesPanel } from './components/StablesPanel';
import { PositionsTable } from './components/PositionsTable';
import { OptionsTable } from './components/OptionsTable';
import { OtherHoldings } from './components/OtherHoldings';
import { TradesHistory } from './components/TradesHistory';

export default function App() {
  const { data, isLoading, error, dataUpdatedAt } = usePortfolio();

  if (isLoading) {
    return (
      <div className="min-h-screen grid place-items-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-7 h-7 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          <span className="text-text-secondary text-sm">加载中…</span>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen grid place-items-center px-4">
        <div className="card px-6 py-5 text-center max-w-md">
          <div className="text-loss font-semibold mb-1">无法加载数据</div>
          <div className="text-text-muted text-sm">{error?.message ?? '未知错误'}</div>
          <div className="text-text-muted text-xs mt-2">请确认后端 (端口 8189) 正在运行</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen px-4 sm:px-6 py-5 max-w-[1440px] mx-auto space-y-4">
      <Header data={data} />
      <KpiRow data={data} />
      <AccountsGrid accounts={data.accounts} total={data.totalEquity} />
      <StablesPanel accounts={data.accounts} />
      <PositionsTable accounts={data.accounts} />
      <OptionsTable accounts={data.accounts} />
      <div className="grid grid-cols-1 gap-4">
        <EquityChart />
        <MetricsRow />
      </div>
      <OtherHoldings accounts={data.accounts} />
      <TradesHistory />
      <footer className="text-center text-text-muted text-[11px] pb-4">
        每 15 秒自动刷新{dataUpdatedAt > 0 && <> · {new Date(dataUpdatedAt).toLocaleTimeString('zh-CN', { hour12: false })}</>} · 只读 API
      </footer>
    </div>
  );
}
