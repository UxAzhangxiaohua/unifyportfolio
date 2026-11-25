import { usePortfolio } from './hooks/usePortfolio';
import { Header, ErrorBanner } from './components/Header';
import { PositionsPage } from './pages/PositionsPage';
import { AccountsPage } from './pages/AccountsPage';
import { TradesPage } from './pages/TradesPage';
import { tr, locale, useLang } from './lib/i18n';
import { usePage } from './lib/route';

export default function App() {
  const { data, isLoading, error, dataUpdatedAt } = usePortfolio();
  useLang(); // re-render the whole tree when the language changes
  const page = usePage();

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
    <div className="min-h-screen">
      <Header data={data} page={page} />
      {/* Only the active page renders, so history / trades are fetched only when their page is open */}
      <main className="px-4 sm:px-6 py-5 max-w-[1440px] mx-auto space-y-4">
        <ErrorBanner data={data} />
        {page === 'positions' && <PositionsPage data={data} />}
        {page === 'accounts' && <AccountsPage data={data} />}
        {page === 'trades' && <TradesPage />}
        <footer className="text-center text-text-muted text-[11px] pt-2 pb-4">
          {tr('每 15 秒自动刷新', 'Auto-refresh every 15s')}{dataUpdatedAt > 0 && <> · {new Date(dataUpdatedAt).toLocaleTimeString(locale(), { hour12: false })}</>} · {tr('只读 API', 'Read-only API')}
        </footer>
      </main>
    </div>
  );
}
