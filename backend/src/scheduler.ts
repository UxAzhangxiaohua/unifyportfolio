import type { AppConfig, AccountConfig, ExchangeType } from './types.js';
import { BaseConnector } from './connectors/base.js';
import { HyperliquidConnector } from './connectors/hyperliquid.js';
import { BinanceConnector } from './connectors/binance.js';
import { OKXConnector } from './connectors/okx.js';
import { IBKRConnector } from './connectors/ibkr.js';
import { BybitConnector } from './connectors/bybit.js';
import { BitgetConnector } from './connectors/bitget.js';
import { MT5Connector } from './connectors/mt5.js';
import { cacheSet } from './cache.js';
import { checkMarginAlerts, initAlerts } from './alerts.js';
import { STALE_MARKER } from './connectors/base.js';
import { transfersObserve, transfersSince } from './transfers.js';
import { tradesObserveVenue, tradesSince } from './trades.js';
import { BACKFILL_DAYS, backfillSetNative, coverageGet, coverageMark } from './backfill.js';

function createConnector(account: AccountConfig): BaseConnector {
  switch (account.exchange) {
    case 'hyperliquid': return new HyperliquidConnector(account);
    case 'binance': return new BinanceConnector(account);
    case 'okx': return new OKXConnector(account);
    case 'ibkr': return new IBKRConnector(account);
    case 'bybit': return new BybitConnector(account);
    case 'bitget': return new BitgetConnector(account);
    case 'mt5': return new MT5Connector(account);
    default: throw new Error(`Unknown exchange: ${account.exchange}`);
  }
}

const flowErrors = new Map<string, string>();
const fetchRunning = new Set<string>();

/**
 * One poll at a time per account: a venue request that hangs (no client timeout; undici gives up
 * after minutes) must not stack further polls, and an old poll finishing late must not overwrite
 * the newer snapshot / observe its flows out of order.
 */
async function fetchAndCache(connector: BaseConnector, accountId: string): Promise<void> {
  if (fetchRunning.has(accountId)) return;
  fetchRunning.add(accountId);
  try {
    await fetchAndCacheOnce(connector, accountId);
  } catch (err) {
    // Called fire-and-forget from timers: never let it become an unhandled rejection
    console.error(`[scheduler] ${accountId}: ${err instanceof Error ? err.message : err}`);
  } finally {
    fetchRunning.delete(accountId);
  }
}

async function fetchAndCacheOnce(connector: BaseConnector, accountId: string): Promise<void> {
  // Balances and deposit/withdrawal records are fetched together so a debit and its withdrawal
  // record are observed in the same cycle (see transfers.ts)
  const [snapshot, flows] = await Promise.all([
    connector.fetch(),
    connector.fetchFlows(transfersSince(accountId)).then(
      (f) => { flowErrors.delete(accountId); return f; },
      (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (flowErrors.get(accountId) !== msg) console.error(`[transfers] ${accountId}: ${msg}`);
        flowErrors.set(accountId, msg);
        return null;
      }),
  ]);
  // When any balance in this snapshot was served from sticky()'s stale cache (pre-debit), observing a
  // new withdrawal now would count it twice (stale balance + in transit). Leave the flows for the
  // next cycle: they are re-fetched (rolling window) and observed once the balances are fresh.
  const staleBalances = snapshot.warnings?.some((w) => w.includes(STALE_MARKER)) ?? false;
  if (flows && !snapshot.error && !staleBalances) transfersObserve(accountId, flows);
  const flowErr = flowErrors.get(accountId);
  if (flowErr && !snapshot.error) {
    snapshot.warnings = [...(snapshot.warnings ?? []), `Deposit/withdrawal history: ${flowErr}`.substring(0, 300)];
  }
  cacheSet(snapshot);
  checkMarginAlerts(snapshot);
}

const TRADES_INTERVAL_MS = 5 * 60_000;
const tradeErrors = new Map<string, string>();
const tradesRunning = new Set<string>();

/** Closed-trade history from the venue (exact fills / closed positions); see trades.ts */
async function fetchTrades(connector: BaseConnector, accountId: string): Promise<void> {
  if (tradesRunning.has(accountId)) return;
  tradesRunning.add(accountId);
  try {
    const since = tradesSince(accountId);
    const list = await connector.fetchClosedTrades(since);
    if (list) tradesObserveVenue(accountId, list, since);
    if (tradeErrors.has(accountId)) console.log(`[trades] ${accountId}: closed-trade history recovered`);
    tradeErrors.delete(accountId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (tradeErrors.get(accountId) !== msg) console.error(`[trades] ${accountId}: ${msg.substring(0, 300)}`);
    tradeErrors.set(accountId, msg);
  } finally {
    tradesRunning.delete(accountId);
  }
}

const DAY_MS = 86_400_000;

/**
 * One-time deep read of deposits/withdrawals (BACKFILL_DAYS, in 7-day windows — Bybit's limit) so
 * the equity backfill can walk balances back (backfill.ts). Persisted: runs again only if the
 * account was never read that far back.
 */
async function deepFlows(connector: BaseConnector, accountId: string): Promise<void> {
  const now = Date.now();
  const target = now - BACKFILL_DAYS * DAY_MS;
  const have = coverageGet('flows', accountId);
  if (have != null && have <= target + DAY_MS) return;
  try {
    let n = 0;
    for (let end = now; end > target; end -= 7 * DAY_MS) {
      const start = Math.max(target, end - 7 * DAY_MS + 60_000);
      const list = await connector.fetchFlows(start, end);
      if (list == null) return; // venue has no flow history
      transfersObserve(accountId, list, Date.now(), true);
      n += list.length;
    }
    coverageMark('flows', accountId, target);
    console.log(`[backfill] ${accountId}: deposits/withdrawals read ${BACKFILL_DAYS} d back (${n} record(s))`);
  } catch (err) {
    console.error(`[backfill] ${accountId}: deep flow read failed: ${err instanceof Error ? err.message : err}`);
  }
}

/** Venue account-value history (where available), refreshed every few hours */
async function equityHistory(connector: BaseConnector, accountId: string): Promise<void> {
  try {
    const pts = await connector.fetchEquityHistory();
    if (pts?.length) backfillSetNative(accountId, pts);
  } catch (err) {
    console.error(`[backfill] ${accountId}: equity history failed: ${err instanceof Error ? err.message : err}`);
  }
}

export function startScheduler(config: AppConfig): void {
  initAlerts(config.alerts);
  const connectors = config.accounts.map((a) => ({
    connector: createConnector(a),
    exchange: a.exchange,
    id: a.id,
  }));

  // Group by exchange for staggered scheduling
  const grouped = new Map<ExchangeType, Array<{ connector: BaseConnector; id: string }>>();
  for (const { connector, exchange, id } of connectors) {
    const list = grouped.get(exchange) ?? [];
    list.push({ connector, id });
    grouped.set(exchange, list);
  }

  for (const [exchange, group] of grouped) {
    const intervalMs = (exchange === 'ibkr' ? config.ibkrPollIntervalSeconds
      : exchange === 'mt5' ? config.mt5PollIntervalSeconds
      : config.pollIntervalSeconds) * 1000;

    // Stagger accounts within the same exchange by 2 seconds
    group.forEach(({ connector, id }, i) => {
      const staggerMs = i * 2000;

      // Initial fetch (staggered)
      setTimeout(() => {
        fetchAndCache(connector, id);

        // Then repeat at interval
        setInterval(() => fetchAndCache(connector, id), intervalMs);
      }, staggerMs);

      // Closed trades: after the first balance fetch (connectors detect their account mode there)
      if (exchange !== 'mt5' && exchange !== 'ibkr') {
        setTimeout(() => {
          fetchTrades(connector, id);
          setInterval(() => fetchTrades(connector, id), TRADES_INTERVAL_MS);
        }, 20_000 + staggerMs * 3);
        // Equity backfill inputs (backfill.ts)
        setTimeout(() => deepFlows(connector, id), 40_000 + staggerMs * 5);
        setTimeout(() => {
          equityHistory(connector, id);
          setInterval(() => equityHistory(connector, id), 3 * 3_600_000);
        }, 10_000 + staggerMs);
      }
    });

    console.log(`[scheduler] ${exchange}: ${group.length} account(s), interval ${intervalMs / 1000}s`);
  }
}
