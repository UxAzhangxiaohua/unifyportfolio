export type ExchangeType = 'ibkr' | 'binance' | 'okx' | 'hyperliquid' | 'bybit' | 'bitget' | 'mt5';

/** 'cfd' = TradFi CFD (gold, forex, indices, oil) */
export type AssetClass = 'stock' | 'etf' | 'crypto-spot' | 'crypto-perp' | 'crypto-future' | 'option' | 'cfd';

export type StableLocation = 'trading' | 'funding' | 'earn';

export interface StableBalance {
  asset: 'USDT' | 'USDC';
  location: StableLocation;
  amount: number;
  source?: string;
}

export interface OptionDetails {
  underlying: string;
  type: 'call' | 'put';
  strike: number;
  expiry: string;
  /**
   * Position-level greeks: already multiplied by quantity and signed for side
   * (a short position flips the sign). delta/gamma are in underlying units,
   * theta is USD per calendar day, vega is USD per 1 vol point (1% IV).
   */
  delta?: number | null;
  gamma?: number | null;
  theta?: number | null;
  vega?: number | null;
  /** Mark implied volatility as a decimal (0.52 = 52%) */
  iv?: number | null;
  /** Underlying / index price in USD used for $delta and scenario PnL */
  underlyingPrice?: number | null;
  /** Exact expiry/delivery time (ms epoch) when the venue reports it; else assume 08:00 UTC on `expiry` */
  expiryTs?: number | null;
  /** Order price tick size (in premium currency) when known */
  tickSize?: number | null;
  /** Set when premium/prices are quoted in a coin (e.g. BTC) rather than USD */
  premiumCcy?: string;
  /** Underlying units per contract of `quantity` (OKX BTC-USD options: 0.01). Omitted = 1 */
  /** null = the venue has a multiplier but it could not be fetched (PnL unknown, never assume 1) */
  contractMultiplier?: number | null;
}

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
  /** Initial margin held by this position (USD), when the venue reports it */
  margin?: number | null;
  /** Funding received (+) / paid (−) since open, USD; null = venue doesn't expose it */
  fundingPnl?: number | null;
  /** Predicted rate for the next settlement, per interval (positive = longs pay) */
  fundingRate?: number | null;
  fundingIntervalH?: number | null;
  nextFundingTime?: number | null;
  /** Estimated next payment: + receive / − pay (USD) */
  nextFunding?: number | null;
  /** CFD (MT5): SL / TP price; price PnL (USD) if closed there */
  sl?: number | null;
  tp?: number | null;
  tpPnl?: number | null;
  slPnl?: number | null;
  assetClass: AssetClass;
  option?: OptionDetails;
}

/** CFD / margin account metrics (Bitget CFD, Bybit TradFi). Monetary values in USD. */
export interface CfdAccountState {
  /** Display name of the CFD sub-account, e.g. "Bitget CFD" */
  name: string;
  /** Only equity is known (venue doesn't expose margin/positions, e.g. Bybit TradFi/MT5) */
  equityOnly?: boolean;
  /** Account currency as reported by the venue (values here are converted to USD) */
  currency: string;
  balance: number;
  equity: number;
  /** equity − balance */
  floatingPnl: number;
  usedMargin: number;
  freeMargin: number;
  /** equity / usedMargin × 100 (%); null when no margin is used */
  marginLevel: number | null;
  /** Account leverage setting, e.g. 2000 for 1:2000; null when unlimited/unknown */
  leverage: number | null;
  /** Raw leverage text when not numeric (e.g. "unlimited") */
  leverageText?: string;
  /** Margin-call / stop-out thresholds in margin-level % */
  marginCallLevel: number | null;
  stopOutLevel: number | null;
  /** Σ position notional (USD) / equity — the account's actual leverage */
  effectiveLeverage: number | null;
  /** Σ position notional in USD */
  notional: number;
  /** usedMargin is an estimate (Σ notional ÷ leverage) — the venue didn't report it */
  marginEstimated?: boolean;
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
  stables: StableBalance[];
  fetchedAt: string;
  isDelayed: boolean;
  error?: string;
  warnings?: string[];
  /** Present for CFD / margin-broker accounts (one per CFD sub-account) */
  cfd?: CfdAccountState[];
}

export type TransferState = 'in_transit' | 'completed' | 'external_out' | 'external_in' | 'failed';

export interface TransferView {
  id: string;
  state: TransferState;
  coin: string;
  amount: number;
  fee: number;
  fromAccount: string | null;
  toAccount: string | null;
  network: string | null;
  /** ms */
  startedAt: number;
  arrivedAt: number | null;
  /** Withdrawal to a configured cash-out address */
  payout?: boolean;
}

export interface PayoutView {
  id: string;
  account: string;
  coin: string;
  amount: number;
  fee: number;
  network: string | null;
  status: 'pending' | 'done' | 'failed';
  /** ms */
  time: number;
}

export interface PayoutsResponse {
  configured: boolean;
  payouts: PayoutView[];
}

export interface TransfersResponse {
  inTransit: number;
  transfers: TransferView[];
}

export interface PortfolioResponse {
  /** Σ account equity + funds in transit between tracked accounts */
  totalEquity: number;
  inTransit?: number;
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
  /** Trading scope: points before this unix time use an estimated earn/funding breakdown */
  estimatedBefore?: number;
  /** Total scope: points before this unix time are reconstructed (before the first recorded sample) */
  backfilledBefore?: number;
}

export interface MetricsResponse {
  sharpeRatio: number | null;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  totalEquity: number;
  changes: Record<string, { pnl: number; percent: number } | null>;
}

export type TimePeriod = '1h' | '4h' | '24h' | '1w' | '30d' | 'all';

/** xau = gold (and any other commodity / FX); stock includes index contracts (NAS100, USTEC) */
export type TradeCategory = 'stock' | 'crypto' | 'xau' | 'option';


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
  /** null when the venue's close record doesn't say when the position was opened */
  entryTime: string | null;
  exitTime: string;
  durationSeconds: number | null;
  category?: TradeCategory;
  /** venue = the venue's own trade / closed-position history (exact, net of fees); inferred = from position changes */
  source?: 'venue' | 'inferred';
  fees?: number;
}

export interface TradesResponse {
  trades: ClosedTrade[];
}
