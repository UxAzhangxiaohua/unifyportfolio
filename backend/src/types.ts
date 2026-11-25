// === Exchange types ===

export type ExchangeType = 'ibkr' | 'binance' | 'okx' | 'hyperliquid' | 'bybit' | 'bitget' | 'mt5';

/** 'cfd' = TradFi CFD (gold, forex, indices, oil) */
export type AssetClass = 'stock' | 'etf' | 'crypto-spot' | 'crypto-perp' | 'crypto-future' | 'option' | 'cfd';

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
  /**
   * Underlying units per 1 contract of `quantity` (OKX BTC-USD options: 0.01). Omitted = 1.
   * PnL per position = Δprice × quantity × contractMultiplier (× underlying price for coin premiums).
   */
  /** null = the venue has a multiplier but it could not be fetched (PnL unknown, never assume 1) */
  contractMultiplier?: number | null;
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

/** MT5 account via investor (read-only) password */
export interface MT5Credentials {
  login: string | number;
  password: string;
  /** Broker server name as shown in the MT5 terminal, e.g. "Exness-MT5Real8" */
  server: string;
  /** Optional access point "ip:port" — skips server name resolution */
  host?: string;
}

export type AccountCredentials =
  | IBKRCredentials
  | BinanceCredentials
  | OKXCredentials
  | BybitCredentials
  | BitgetCredentials
  | HyperliquidCredentials
  | MT5Credentials;

export interface AccountConfig {
  id: string;
  exchange: ExchangeType;
  label: string;
  credentials: AccountCredentials;
  /** Set to false to temporarily disable an account without deleting its credentials */
  enabled?: boolean;
}

export interface AlertsConfig {
  /** Discord webhook URL for CFD margin-level alerts */
  discordWebhook?: string;
  /** Margin-level thresholds in %, default [150, 100, 80] */
  marginLevels?: number[];
}

/**
 * Funds that existed before the dashboard started counting them (e.g. a wallet type added to a
 * connector later). `amount` is added to the account for every history point before `before`,
 * so the curve doesn't show the tracking change as a gain.
 */
export interface HistoryBackfill {
  accountId: string;
  /** ISO time or unix seconds: first sample that already includes the funds */
  before: string | number;
  amount: number;
  note?: string;
}

export interface AppConfig {
  pollIntervalSeconds: number;
  ibkrPollIntervalSeconds: number;
  /** MT5 polls log in fresh each time, so they run slower than API polls (default 60) */
  mt5PollIntervalSeconds: number;
  alerts?: AlertsConfig;
  historyBackfill?: HistoryBackfill[];
  /**
   * On-chain addresses that send on behalf of a tracked account that reports no withdrawals itself
   * (e.g. an MT5 broker's payout address): { "0xabc…": "mt5-exness" }. Deposits from them count
   * as internal transfers from that account.
   */
  transferSources?: Record<string, string>;
  /** Own cash-out addresses: withdrawals to them are recorded as payouts (出金), never paired as internal transfers */
  payoutAddresses?: string[];
  /** Read-only MCP endpoint POST /api/mcp/<token> (mcp.ts); disabled without a token (≥ 16 chars) */
  mcp?: { token: string };
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
  /** Initial margin held by this position (USD), when the venue reports it */
  margin?: number | null;
  /** Funding received (+) / paid (−) since the position was opened, USD. Absent/null = venue doesn't expose it */
  fundingPnl?: number | null;
  /** Current (predicted) funding rate for the next settlement, per interval (positive = longs pay shorts) */
  fundingRate?: number | null;
  fundingIntervalH?: number | null;
  /** Next settlement time (ms) */
  nextFundingTime?: number | null;
  /** Estimated next funding payment at the current rate and mark notional: + receive / − pay (USD) */
  nextFunding?: number | null;
  /** CFD (MT5): stop-loss / take-profit price set on the position (absent = not set) */
  sl?: number | null;
  tp?: number | null;
  /** CFD (MT5): price PnL in USD if closed at TP / SL (excl. swap & commission) */
  tpPnl?: number | null;
  slPnl?: number | null;
  assetClass: AssetClass;
  /** Present when assetClass === 'option' */
  option?: OptionDetails;
}

/** CFD / margin account metrics (Bitget CFD, Bybit TradFi, MT5). Monetary values in USD. */
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
  /** USDT/USDC balances across trading, funding and earn wallets */
  stables: StableBalance[];
  fetchedAt: string;
  isDelayed: boolean;
  /** Last fetch failed; data shown is from the last successful fetch (if any) */
  error?: string;
  /** Non-fatal problems, e.g. earn endpoint not permitted for this API key */
  warnings?: string[];
  /** Present for CFD / margin-broker accounts (one per CFD sub-account) */
  cfd?: CfdAccountState[];
}

/**
 * One on-chain / off-chain deposit or withdrawal of a stablecoin, as reported by the venue.
 * Used to detect transfers between tracked accounts so the total curve doesn't dip while funds are in transit.
 */
export interface FundFlow {
  /** Unique within the account, e.g. "out:<withdrawId>" */
  id: string;
  direction: 'in' | 'out';
  coin: 'USDT' | 'USDC';
  /** out: amount the recipient should receive (fee excluded); in: amount credited */
  amount: number;
  /** Fee charged on top of `amount` (out only; 0 when unknown) */
  fee: number;
  /** Lower-cased on-chain tx hash when known (same on both sides of a transfer) */
  txId: string | null;
  /** out: destination address; in: our deposit address (lower-cased) */
  address: string | null;
  network: string | null;
  /** in only: on-chain sender address (lower-cased) when the venue reports it */
  from?: string | null;
  /** Venue timestamp (ms): out = requested, in = record created */
  time: number;
  /** Venue timestamp (ms) when completed / credited, if reported */
  doneTime: number | null;
  status: 'pending' | 'done' | 'failed';
}

export type TransferState = 'in_transit' | 'completed' | 'external_out' | 'external_in' | 'failed';

export interface TransferView {
  id: string;
  state: TransferState;
  coin: string;
  /** Amount received (or expected to be received) */
  amount: number;
  fee: number;
  fromAccount: string | null;
  toAccount: string | null;
  network: string | null;
  /** ms: when the money left the source (or arrived, for external deposits) */
  startedAt: number;
  /** ms: when it was credited at the destination */
  arrivedAt: number | null;
  /** Withdrawal to a configured cash-out address */
  payout?: boolean;
}

export interface PayoutView {
  id: string;
  account: string;
  coin: string;
  /** Amount sent to the cash-out address (fee excluded) */
  amount: number;
  fee: number;
  network: string | null;
  status: 'pending' | 'done' | 'failed';
  /** ms */
  time: number;
}

export interface PayoutsResponse {
  /** false when no payoutAddresses are configured */
  configured: boolean;
  payouts: PayoutView[];
}

export interface TransfersResponse {
  /** USD currently in transit between tracked accounts (already included in totalEquity) */
  inTransit: number;
  transfers: TransferView[];
}

export interface PortfolioResponse {
  /** Σ account equity + funds in transit between tracked accounts */
  totalEquity: number;
  /** Part of totalEquity that is in transit (withdrawn, not yet credited at the destination) */
  inTransit?: number;
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
  /** null when the venue's close record doesn't say when the position was opened */
  entryTime: string | null;
  exitTime: string;
  durationSeconds: number | null;
  /** Stock / index, crypto, XAU (gold, other commodities / FX), or option */
  category?: TradeCategory;
  /** venue = from the venue's own trade / closed-position history (exact); inferred = from position changes (approx.) */
  source?: 'venue' | 'inferred';
  /** Fees / commission / swap / funding included in realizedPnl (negative = cost; venue trades) */
  fees?: number;
}

/** xau = gold (plus any other commodity / FX contract); indices (NAS100, USTEC…) count as stock */
export type TradeCategory = 'stock' | 'crypto' | 'xau' | 'option';

