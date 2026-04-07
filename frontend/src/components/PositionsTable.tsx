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
  const [sortKey, setSortKey] = useState<SortKey>('pnl');
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
    let result = allPositions;
    if (filterExchange !== 'all') {
      result = result.filter(p => p.exchange === filterExchange);
    }
    return result;
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
    if (sortKey === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortKey(key);
      setSortAsc(false);
    }
  };

  const exchanges = [...new Set(allPositions.map(p => p.exchange))];

  if (allPositions.length === 0) return null;

  const SortHeader = ({ label, sortKeyVal, align = 'left' }: { label: string; sortKeyVal: SortKey; align?: string }) => (
    <th
      className={`p-3 font-medium cursor-pointer hover:text-text-primary transition-colors ${align === 'right' ? 'text-right' : 'text-left'}`}
      onClick={() => handleSort(sortKeyVal)}
    >
      {label}
      {sortKey === sortKeyVal && (
        <span className="ml-1">{sortAsc ? '\u2191' : '\u2193'}</span>
      )}
    </th>
  );

  return (
    <div className="bg-bg-card border border-border-card rounded-lg overflow-hidden">
      <div className="p-4 border-b border-border-card flex items-center justify-between">
        <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">
          Positions ({filtered.length})
        </h3>
        <div className="flex gap-1">
          <button
            className={`text-[10px] px-2 py-0.5 rounded ${filterExchange === 'all' ? 'bg-text-secondary/20 text-text-primary' : 'text-text-muted hover:text-text-secondary'}`}
            onClick={() => setFilterExchange('all')}
          >
            ALL
          </button>
          {exchanges.map(ex => (
            <button
              key={ex}
              className={`text-[10px] px-2 py-0.5 rounded ${filterExchange === ex ? 'bg-text-secondary/20 text-text-primary' : 'text-text-muted hover:text-text-secondary'}`}
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
              <SortHeader label="Exchange" sortKeyVal="exchange" />
              <SortHeader label="Symbol" sortKeyVal="symbol" />
              <SortHeader label="Side" sortKeyVal="side" />
              <th className="p-3 text-right font-medium">Size</th>
              <th className="p-3 text-right font-medium">Entry</th>
              <th className="p-3 text-right font-medium">Mark</th>
              <SortHeader label="PnL" sortKeyVal="pnl" align="right" />
              <SortHeader label="Value" sortKeyVal="value" align="right" />
              <SortHeader label="Lev" sortKeyVal="leverage" align="right" />
              <th className="p-3 text-right font-medium">Liq Price</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((p, i) => (
              <tr
                key={`${p.exchange}-${p.symbol}-${i}`}
                className="border-t border-border-card hover:bg-bg-card-hover transition-colors"
              >
                <td className="p-3 text-text-muted text-xs">{EXCHANGE_NAMES[p.exchange]}</td>
                <td className="p-3 font-semibold">{p.symbol}</td>
                <td className="p-3">
                  <span className={
                    p.side === 'long' ? 'text-profit' :
                    p.side === 'short' ? 'text-loss' :
                    'text-text-secondary'
                  }>
                    {p.side.toUpperCase()}
                  </span>
                </td>
                <td className="p-3 text-right tabular-nums">{formatNum(p.quantity, p.quantity < 1 ? 4 : 2)}</td>
                <td className="p-3 text-right tabular-nums text-text-secondary">{formatNum(p.avgPrice)}</td>
                <td className="p-3 text-right tabular-nums">{formatNum(p.currentPrice)}</td>
                <td className={`p-3 text-right tabular-nums font-medium ${
                  p.unrealizedPnl > 0 ? 'text-profit' :
                  p.unrealizedPnl < 0 ? 'text-loss' :
                  'text-text-secondary'
                }`}>
                  {formatPnl(p.unrealizedPnl)}
                </td>
                <td className="p-3 text-right tabular-nums text-text-secondary">{formatUSD(p.marketValue)}</td>
                <td className="p-3 text-right tabular-nums text-text-secondary">
                  {p.leverage ? `${p.leverage}x` : '-'}
                </td>
                <td className="p-3 text-right tabular-nums text-text-muted">
                  {p.liquidationPrice ? formatNum(p.liquidationPrice) : '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
