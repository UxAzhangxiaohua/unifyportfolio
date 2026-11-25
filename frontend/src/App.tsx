import { usePortfolio } from './hooks/usePortfolio';
import { Header } from './components/Header';
import { KpiRow } from './components/KpiRow';
import { EquityChart } from './components/EquityChart';
import { MetricsRow } from './components/MetricsRow';
import { AccountsGrid } from './components/AccountsGrid';
import { StablesPanel } from './components/StablesPanel';
import { PositionsTable } from './components/PositionsTable';
import { OptionsTable } from './components/OptionsTable';
import { CfdPanel } from './components/CfdPanel';
import { OptionExitCalculator } from './components/OptionExitCalculator';
import { OtherHoldings } from './components/OtherHoldings';
import { TradesHistory } from './components/TradesHistory';
import { PayoutsPanel } from './components/PayoutsPanel';
import { TransfersPanel } from './components/TransfersPanel';
import { tr, locale, useLang } from './lib/i18n';

export default function App() {
  const { data, isLoading, error, dataUpdatedAt } = usePortfolio();
  useLang(); // re-render the whole tree when the language changes

  if (isLoading) {
    return (
      <div className="min-h-screen grid place-items-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-7 h-7 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          <span className="text-text-secondary text-sm">{tr('加载中…', 'Loading…')}</span>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen grid place-items-center px-4">
        <div className="card px-6 py-5 text-center max-w-md">
          <div className="text-loss font-semibold mb-1">{tr('无法加载数据', 'Failed to load data')}</div>
          <div className="text-text-muted text-sm">{error?.message ?? tr('未知错误', 'Unknown error')}</div>
          <div className="text-text-muted text-xs mt-2">{tr('请确认后端 (端口 8189) 正在运行', 'Make sure the backend (port 8189) is running')}</div>
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
      <CfdPanel accounts={data.accounts} />
      <OptionsTable accounts={data.accounts} />
      <OptionExitCalculator accounts={data.accounts} />
      <div className="grid grid-cols-1 gap-4">
        <EquityChart />
        <MetricsRow />
      </div>
      <TransfersPanel />
      <OtherHoldings accounts={data.accounts} />
      <TradesHistory />
      <PayoutsPanel />
      <footer className="text-center text-text-muted text-[11px] pb-4">
        {tr('每 15 秒自动刷新', 'Auto-refresh every 15s')}{dataUpdatedAt > 0 && <> · {new Date(dataUpdatedAt).toLocaleTimeString(locale(), { hour12: false })}</>} · {tr('只读 API', 'Read-only API')}
      </footer>
    </div>
  );
}
