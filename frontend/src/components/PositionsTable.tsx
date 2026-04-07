import { useState, useMemo } from 'react';
import type { AccountSnapshot, ExchangeType } from '../types';

const EXCHANGE_NAMES: Record<ExchangeType, string> = {
  ibkr: 'IBKR',
  hyperliquid: 'HL',
  binance: 'Binance',
  okx: 'OKX',
};

function formatNum(n: number, decimals = 2): string {
  if (n === 0) return '-';
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function formatUSD(n: number): string {
  if (n === 0) return '-';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatPnl(n: number): string {
  if (n === 0) return '-';
  return (n >= 0 ? '+' : '') + formatUSD(n);
}

type SortKey = 'exchange' | 'symbol' | 'side' | 'value' | 'pnl' | 'leverage';

interface FlatPosition {
  symbol: string;
  side: 'long' | 'short' | 'flat';
  quantity: number;
  avgPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  marketValue: number;
  leverage: number | null;
  liquidationPrice: number | null;
  assetClass: string;
  accountLabel: string;
  exchange: ExchangeType;
}

export function PositionsTable({ accounts }: { accounts: AccountSnapshot[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('value');
  const [sortAsc, setSortAsc] = useState(false);
  const [filterExchange, setFilterExchange] = useState<ExchangeType | 'all'>('all');

  const allPositions: FlatPosition[] = useMemo(() => {
    return accounts.flatMap((a) =>
      a.positions.map((p) => ({
        ...p,
        accountLabel: a.label,
        exchange: a.exchange,
      }))
    );
  }, [accounts]);

  const filtered = useMemo(() => {
    if (filterExchange === 'all') return allPositions;
    return allPositions.filter(p => p.exchange === filterExchange);
  }, [allPositions, filterExchange]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    const dir = sortAsc ? 1 : -1;
    arr.sort((a, b) => {
      switch (sortKey) {
        case 'exchange': return dir * a.exchange.localeCompare(b.exchange);
        case 'symbol': return dir * a.symbol.localeCompare(b.symbol);
        case 'side': return dir * a.side.localeCompare(b.side);
        case 'value': return dir * (a.marketValue - b.marketValue);
        case 'pnl': return dir * (a.unrealizedPnl - b.unrealizedPnl);
        case 'leverage': return dir * ((a.leverage ?? 0) - (b.leverage ?? 0));
        default: return 0;
      }
    });
    return arr;
  }, [filtered, sortKey, sortAsc]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(false); }
  };

  const exchanges = [...new Set(allPositions.map(p => p.exchange))];
  if (allPositions.length === 0) return null;

  const SortHeader = ({ label, k, right }: { label: string; k: SortKey; right?: boolean }) => (
    <th
      className={`p-3 font-medium cursor-pointer hover:text-text-primary transition-colors select-none ${right ? 'text-right' : 'text-left'}`}
      onClick={() => handleSort(k)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {sortKey === k && (
          <span className="text-accent">{sortAsc ? '\u2191' : '\u2193'}</span>
        )}
      </span>
    </th>
  );

  return (
    <div className="bg-bg-card border border-border-card rounded-xl overflow-hidden">
      <div className="p-4 border-b border-border-card flex items-center justify-between">
        <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">
          Positions
          <span className="ml-2 text-text-muted font-normal">{filtered.length}</span>
        </h3>
        <div className="flex gap-1">
          <button
            className={`text-[10px] px-2.5 py-1 rounded-md font-medium transition-all ${
              filterExchange === 'all' ? 'bg-accent/15 text-accent' : 'text-text-muted hover:text-text-secondary'
            }`}
            onClick={() => setFilterExchange('all')}
          >
            ALL
          </button>
          {exchanges.map(ex => (
            <button
              key={ex}
              className={`text-[10px] px-2.5 py-1 rounded-md font-medium transition-all ${
                filterExchange === ex ? 'bg-accent/15 text-accent' : 'text-text-muted hover:text-text-secondary'
              }`}
              onClick={() => setFilterExchange(ex)}
            >
              {EXCHANGE_NAMES[ex]}
            </button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-text-muted text-[10px] uppercase tracking-wider">
              <SortHeader label="Exchange" k="exchange" />
              <SortHeader label="Symbol" k="symbol" />
              <SortHeader label="Side" k="side" />
              <th className="p-3 text-right font-medium">Size</th>
              <th className="p-3 text-right font-medium">Entry</th>
              <th className="p-3 text-right font-medium">Mark</th>
              <SortHeader label="PnL" k="pnl" right />
              <SortHeader label="Value" k="value" right />
              <SortHeader label="Lev" k="leverage" right />
              <th className="p-3 text-right font-medium">Liq Price</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((p, i) => {
              const pnlPct = p.avgPrice > 0 && p.quantity > 0
                ? ((p.currentPrice - p.avgPrice) / p.avgPrice * 100 * (p.side === 'short' ? -1 : 1))
                : 0;

              return (
                <tr
                  key={`${p.exchange}-${p.symbol}-${i}`}
                  className="border-t border-border-card hover:bg-bg-card-hover transition-colors"
                >
                  <td className="p-3 text-text-muted text-xs">{EXCHANGE_NAMES[p.exchange]}</td>
                  <td className="p-3 font-semibold">{p.symbol}</td>
                  <td className="p-3">
                    <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                      p.side === 'long' ? 'bg-profit/10 text-profit' :
                      p.side === 'short' ? 'bg-loss/10 text-loss' :
                      'text-text-secondary'
                    }`}>
                      {p.side.toUpperCase()}
                    </span>
                  </td>
                  <td className="p-3 text-right tabular-nums">{formatNum(p.quantity, p.quantity < 1 ? 4 : 2)}</td>
                  <td className="p-3 text-right tabular-nums text-text-secondary">{formatNum(p.avgPrice)}</td>
                  <td className="p-3 text-right tabular-nums">{formatNum(p.currentPrice)}</td>
                  <td className="p-3 text-right">
                    <div className={`tabular-nums font-medium ${
                      p.unrealizedPnl > 0 ? 'text-profit' :
                      p.unrealizedPnl < 0 ? 'text-loss' :
                      'text-text-secondary'
                    }`}>
                      {formatPnl(p.unrealizedPnl)}
                    </div>
                    {pnlPct !== 0 && (
                      <div className={`text-[10px] tabular-nums ${
                        pnlPct > 0 ? 'text-profit/70' : 'text-loss/70'
                      }`}>
                        {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
                      </div>
                    )}
                  </td>
                  <td className="p-3 text-right tabular-nums text-text-secondary">{formatUSD(p.marketValue)}</td>
                  <td className="p-3 text-right tabular-nums text-text-secondary">
                    {p.leverage ? `${p.leverage}x` : '-'}
                  </td>
                  <td className="p-3 text-right tabular-nums text-text-muted">
                    {p.liquidationPrice ? formatNum(p.liquidationPrice) : '-'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
