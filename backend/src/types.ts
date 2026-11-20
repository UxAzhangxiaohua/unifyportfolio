// === Exchange types ===

export type ExchangeType = 'ibkr' | 'binance' | 'okx' | 'hyperliquid' | 'bybit' | 'bitget';

export type AssetClass = 'stock' | 'etf' | 'crypto-spot' | 'crypto-perp' | 'crypto-future' | 'option';

/** Where a stablecoin balance sits inside an exchange account */
export type StableLocation = 'trading' | 'funding' | 'earn';

export interface StableBalance {
  asset: 'USDT' | 'USDC';
  location: StableLocation;
  amount: number;
  /** Optional detail, e.g. "Simple Earn Flexible", "Futures wallet" */
  source?: string;
}

export interface OptionDetails {
  underlying: string;
  type: 'call' | 'put';
  strike: number;
  /** ISO date (YYYY-MM-DD) */
  expiry: string;
  delta?: number | null;
  /** Set when premium/prices are quoted in a coin (e.g. BTC) rather than USD */
  premiumCcy?: string;
}

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

export interface BybitCredentials {
  apiKey: string;
  apiSecret: string;
}

export interface BitgetCredentials {
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
  | BybitCredentials
  | BitgetCredentials
  | HyperliquidCredentials;

export interface AccountConfig {
  id: string;
  exchange: ExchangeType;
  label: string;
  credentials: AccountCredentials;
  /** Set to false to temporarily disable an account without deleting its credentials */
  enabled?: boolean;
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
  /** Present when assetClass === 'option' */
  option?: OptionDetails;
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
  /** USDT/USDC balances across trading, funding and earn wallets */
  stables: StableBalance[];
  fetchedAt: string;
  isDelayed: boolean;
  /** Last fetch failed; data shown is from the last successful fetch (if any) */
  error?: string;
  /** Non-fatal problems, e.g. earn endpoint not permitted for this API key */
  warnings?: string[];
}

export interface PortfolioResponse {
  totalEquity: number;
  totalUnrealizedPnl: number;
  accounts: AccountSnapshot[];
  timestamp: string;
}

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
