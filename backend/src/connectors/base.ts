import type { AccountConfig, AccountSnapshot } from '../types.js';

export abstract class BaseConnector {
  constructor(protected account: AccountConfig) {}

  abstract fetch(): Promise<AccountSnapshot>;

  protected makeErrorSnapshot(error: string): AccountSnapshot {
    return {
      accountId: this.account.id,
      exchange: this.account.exchange,
      label: this.account.label,
      equity: 0,
      availableBalance: 0,
      unrealizedPnl: 0,
      marginUsed: null,
      marginRatio: null,
      positions: [],
      fetchedAt: new Date().toISOString(),
      isDelayed: false,
      error,
    };
  }
}

export function createConnector(account: AccountConfig): BaseConnector {
  // Dynamic import would create circular deps, so we use a registry pattern.
  // This is populated by the scheduler after importing all connectors.
  throw new Error(`No connector registered for exchange: ${account.exchange}`);
}
