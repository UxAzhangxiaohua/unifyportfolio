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
