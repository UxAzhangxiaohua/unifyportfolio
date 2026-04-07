import type { AccountSnapshot } from './types.js';
import { trackSnapshot } from './trades.js';

interface CacheEntry {
  snapshot: AccountSnapshot;
  expiresAt: number;
}

const store = new Map<string, CacheEntry>();

const TTL: Record<string, number> = {
  ibkr: 600_000,       // 10 min
  binance: 120_000,    // 2 min
  okx: 120_000,
  hyperliquid: 120_000,
};

export function cacheSet(snapshot: AccountSnapshot): void {
  const ttl = TTL[snapshot.exchange] ?? 120_000;
  store.set(snapshot.accountId, {
    snapshot,
    expiresAt: Date.now() + ttl,
  });
  try { trackSnapshot(snapshot); } catch {}
}

export function cacheGet(accountId: string): AccountSnapshot | null {
  const entry = store.get(accountId);
  if (!entry) return null;
  // Stale-while-revalidate: always return last known data
  return entry.snapshot;
}

export function cacheGetAll(): AccountSnapshot[] {
  return Array.from(store.values()).map((e) => e.snapshot);
}

export function cacheGetHealth(): Array<{ accountId: string; status: 'fresh' | 'stale' | 'error'; fetchedAt: string }> {
  const now = Date.now();
  return Array.from(store.entries()).map(([id, entry]) => ({
    accountId: id,
    status: entry.snapshot.error ? 'error' : entry.expiresAt > now ? 'fresh' : 'stale',
    fetchedAt: entry.snapshot.fetchedAt,
  }));
}
