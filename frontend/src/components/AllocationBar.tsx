import type { AccountSnapshot, ExchangeType } from '../types';

const EXCHANGE_COLORS: Record<ExchangeType, string> = {
  ibkr: '#3b82f6',
  hyperliquid: '#10b981',
  binance: '#eab308',
  okx: '#a855f7',
};

const EXCHANGE_NAMES: Record<ExchangeType, string> = {
  ibkr: 'IBKR',
  hyperliquid: 'Hyperliquid',
  binance: 'Binance',
  okx: 'OKX',
};

interface Allocation {
  exchange: ExchangeType;
  equity: number;
  percent: number;
}

export function AllocationBar({ accounts }: { accounts: AccountSnapshot[] }) {
  const totalEquity = accounts.reduce((s, a) => s + a.equity, 0);
  if (totalEquity <= 0) return null;

  // Group by exchange
  const byExchange = new Map<ExchangeType, number>();
  for (const a of accounts) {
    byExchange.set(a.exchange, (byExchange.get(a.exchange) ?? 0) + a.equity);
  }

  const allocations: Allocation[] = Array.from(byExchange.entries())
    .map(([exchange, equity]) => ({
      exchange,
      equity,
      percent: (equity / totalEquity) * 100,
    }))
    .filter((a) => a.percent > 0)
    .sort((a, b) => b.percent - a.percent);

  return (
    <div className="bg-bg-card border border-border-card rounded-xl px-5 py-3">
      <div className="flex items-center justify-between mb-2.5">
        <span className="text-[10px] text-text-muted uppercase tracking-wider font-semibold">Allocation</span>
        <div className="flex gap-4">
          {allocations.map((a) => (
            <div key={a.exchange} className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: EXCHANGE_COLORS[a.exchange] }} />
              <span className="text-[10px] text-text-secondary">
                {EXCHANGE_NAMES[a.exchange]} {a.percent.toFixed(1)}%
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Stacked bar */}
      <div className="h-2 rounded-full overflow-hidden flex bg-bg-primary">
        {allocations.map((a) => (
          <div
            key={a.exchange}
            className="h-full transition-all duration-700 first:rounded-l-full last:rounded-r-full"
            style={{
              width: `${a.percent}%`,
              backgroundColor: EXCHANGE_COLORS[a.exchange],
              opacity: 0.85,
            }}
          />
        ))}
      </div>
    </div>
  );
}
