import type { AppConfig, AccountConfig, ExchangeType } from './types.js';
import { BaseConnector } from './connectors/base.js';
import { HyperliquidConnector } from './connectors/hyperliquid.js';
import { BinanceConnector } from './connectors/binance.js';
import { OKXConnector } from './connectors/okx.js';
import { IBKRConnector } from './connectors/ibkr.js';
import { cacheSet } from './cache.js';

function createConnector(account: AccountConfig): BaseConnector {
  switch (account.exchange) {
    case 'hyperliquid': return new HyperliquidConnector(account);
    case 'binance': return new BinanceConnector(account);
    case 'okx': return new OKXConnector(account);
    case 'ibkr': return new IBKRConnector(account);
    default: throw new Error(`Unknown exchange: ${account.exchange}`);
  }
}

async function fetchAndCache(connector: BaseConnector): Promise<void> {
  const snapshot = await connector.fetch();
  cacheSet(snapshot);
}

export function startScheduler(config: AppConfig): void {
  const connectors = config.accounts.map((a) => ({
    connector: createConnector(a),
    exchange: a.exchange,
  }));

  // Group by exchange for staggered scheduling
  const grouped = new Map<ExchangeType, BaseConnector[]>();
  for (const { connector, exchange } of connectors) {
    const list = grouped.get(exchange) ?? [];
    list.push(connector);
    grouped.set(exchange, list);
  }

  for (const [exchange, group] of grouped) {
    const intervalMs = exchange === 'ibkr'
      ? config.ibkrPollIntervalSeconds * 1000
      : config.pollIntervalSeconds * 1000;

    // Stagger accounts within the same exchange by 2 seconds
    group.forEach((connector, i) => {
      const staggerMs = i * 2000;

      // Initial fetch (staggered)
      setTimeout(() => {
        fetchAndCache(connector);

        // Then repeat at interval
        setInterval(() => fetchAndCache(connector), intervalMs);
      }, staggerMs);
    });

    console.log(`[scheduler] ${exchange}: ${group.length} account(s), interval ${intervalMs / 1000}s`);
  }
}
