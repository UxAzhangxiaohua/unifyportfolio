import { usePortfolio } from './hooks/usePortfolio';
import { Header } from './components/Header';
import { EquityChart } from './components/EquityChart';
import { MetricsRow } from './components/MetricsRow';
import { AllocationBar } from './components/AllocationBar';
import { ExchangeCard } from './components/ExchangeCard';
import { PositionsTable } from './components/PositionsTable';
import type { AccountSnapshot, ExchangeType } from './types';

const EXCHANGE_ORDER: ExchangeType[] = ['ibkr', 'hyperliquid', 'binance', 'okx'];

export default function App() {
  const { data, isLoading, error, dataUpdatedAt } = usePortfolio();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          <span className="text-text-secondary text-sm">Loading portfolio...</span>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center flex-col gap-4">
        <div className="text-loss text-lg font-semibold">Failed to load portfolio</div>
        <div className="text-text-muted text-sm">{error?.message ?? 'Unknown error'}</div>
        <div className="text-text-muted text-xs">Make sure the backend is running on port 3001</div>
      </div>
    );
  }

  // Group accounts by exchange
  const grouped = new Map<ExchangeType, AccountSnapshot[]>();
  for (const account of data.accounts) {
    const list = grouped.get(account.exchange) ?? [];
    list.push(account);
    grouped.set(account.exchange, list);
  }

  return (
    <div className="min-h-screen p-6 max-w-7xl mx-auto space-y-4">
      {/* Header */}
      <Header data={data} />

      {/* Equity Chart */}
      <EquityChart />

      {/* Metrics Row */}
      <MetricsRow />

      {/* Allocation Bar */}
      <AllocationBar accounts={data.accounts} />

      {/* Exchange Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {EXCHANGE_ORDER.map((ex) => {
          const accounts = grouped.get(ex);
          if (!accounts) return null;
          return (
            <ExchangeCard
              key={ex}
              exchange={ex}
              accounts={accounts}
              totalPortfolio={data.totalEquity}
            />
          );
        })}
      </div>

      {/* Positions Table */}
      <PositionsTable accounts={data.accounts} />

      {/* Footer */}
      <div className="text-center text-text-muted text-[10px] pb-4">
        Auto-refreshes every 15s
        {dataUpdatedAt > 0 && (
          <> &middot; {new Date(dataUpdatedAt).toLocaleTimeString()}</>
        )}
      </div>
    </div>
  );
}
