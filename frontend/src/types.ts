export type ExchangeType = 'ibkr' | 'binance' | 'okx' | 'hyperliquid';

export type AssetClass = 'stock' | 'etf' | 'crypto-spot' | 'crypto-perp' | 'crypto-future';

export interface Position {
  symbol: string;
  side: 'long' | 'short' | 'flat';
  quantity: number;
  avgPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  marketValue: number;
  leverage: number | null;
  liquidationPrice: number | null;
  assetClass: AssetClass;
}

export interface AccountSnapshot {
  accountId: string;
  exchange: ExchangeType;
  label: string;
  equity: number;
  availableBalance: number;
  unrealizedPnl: number;
  marginUsed: number | null;
  marginRatio: number | null;
  positions: Position[];
  fetchedAt: string;
  isDelayed: boolean;
  error?: string;
}

export interface PortfolioResponse {
  totalEquity: number;
  totalUnrealizedPnl: number;
  accounts: AccountSnapshot[];
  timestamp: string;
}

export interface HistoryPoint {
  t: number; // unix seconds
  v: number; // equity value
}

export interface HistoryResponse {
  points: HistoryPoint[];
  pnl: number;
  pnlPercent: number;
  period: string;
}

export interface MetricsResponse {
  sharpeRatio: number | null;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  totalEquity: number;
  changes: Record<string, { pnl: number; percent: number } | null>;
}

export type TimePeriod = '1h' | '4h' | '24h' | '1w' | 'all';

export interface ClosedTrade {
  id: string;
  accountId: string;
  exchange: ExchangeType;
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  realizedPnl: number;
  pnlPercent: number;
  entryTime: string;
  exitTime: string;
  durationSeconds: number;
}

export interface TradeSummary {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalRealizedPnl: number;
}

export interface TradesResponse {
  trades: ClosedTrade[];
  summary: TradeSummary;
}
