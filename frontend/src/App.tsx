import { usePortfolio } from './hooks/usePortfolio';
import { Header } from './components/Header';
import { ExchangeCard } from './components/ExchangeCard';
import { PositionsTable } from './components/PositionsTable';
import type { AccountSnapshot, ExchangeType } from './types';

const EXCHANGE_ORDER: ExchangeType[] = ['ibkr', 'hyperliquid', 'binance', 'okx'];

export default function App() {
  const { data, isLoading, error, dataUpdatedAt } = usePortfolio();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-text-secondary">Loading portfolio...</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center flex-col gap-4">
        <div className="text-loss text-lg">Failed to load portfolio</div>
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
    <div className="min-h-screen p-6 max-w-7xl mx-auto">
      <Header data={data} />

      {/* Exchange Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {EXCHANGE_ORDER.map((ex) => {
          const accounts = grouped.get(ex);
          if (!accounts) return null;
          return <ExchangeCard key={ex} exchange={ex} accounts={accounts} />;
        })}
      </div>

      {/* Positions Table */}
      <PositionsTable accounts={data.accounts} />

      {/* Footer */}
      <div className="mt-6 text-center text-text-muted text-[10px]">
        Auto-refreshes every 15s
        {dataUpdatedAt > 0 && (
          <> &middot; Query at {new Date(dataUpdatedAt).toLocaleTimeString()}</>
        )}
      </div>
    </div>
  );
}
