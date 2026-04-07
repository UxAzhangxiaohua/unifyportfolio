// === Exchange types ===

export type ExchangeType = 'ibkr' | 'binance' | 'okx' | 'hyperliquid';

export type AssetClass = 'stock' | 'etf' | 'crypto-spot' | 'crypto-perp' | 'crypto-future';

// === Config types (loaded from accounts.json) ===

export interface IBKRCredentials {
  flexQueryId: string;
  flexToken: string;
}

export interface BinanceCredentials {
  apiKey: string;
  apiSecret: string;
}

export interface OKXCredentials {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
}

export interface HyperliquidCredentials {
  walletAddress: string;
}

export type AccountCredentials =
  | IBKRCredentials
  | BinanceCredentials
  | OKXCredentials
  | HyperliquidCredentials;

export interface AccountConfig {
  id: string;
  exchange: ExchangeType;
  label: string;
  credentials: AccountCredentials;
}

export interface AppConfig {
  pollIntervalSeconds: number;
  ibkrPollIntervalSeconds: number;
  accounts: AccountConfig[];
}

// === Runtime data types ===

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
