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

async function fetchAndCache(connector: BaseConnector, accountId: string): Promise<void> {
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
    });

    console.log(`[scheduler] ${exchange}: ${group.length} account(s), interval ${intervalMs / 1000}s`);
  }
}
