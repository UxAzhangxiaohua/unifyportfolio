import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync as DatabaseSyncT, StatementSync } from 'node:sqlite';

// Lightweight persistence for long-term equity history: one row every ~30 min.
// Uses Node's built-in SQLite (node:sqlite, no native deps). If it can't open,
// the app keeps working with in-memory history only.

export interface StoredPoint {
  t: number; // unix seconds
  total: number;
  accounts: Record<string, number>;
  /** Per-account USD outside the trading wallets (earn + funding stables); absent on old rows */
  off?: Record<string, number>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.HISTORY_DB || resolve(__dirname, '../../data/history.db');

let db: DatabaseSyncT | null = null;
let insertStmt: StatementSync | null = null;
let flowStmt: StatementSync | null = null;

export async function historyDbOpen(): Promise<boolean> {
  try {
    // Imported lazily so a Node build without sqlite only disables persistence
    const { DatabaseSync } = await import('node:sqlite');
    mkdirSync(dirname(DB_PATH), { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS equity_snapshots (
        t        INTEGER PRIMARY KEY,  -- unix seconds
        total    REAL    NOT NULL,     -- total equity, USD
        accounts TEXT    NOT NULL      -- JSON { accountId: equity }
      );
      -- Stablecoin deposits/withdrawals per account, used to bridge internal transfers (transfers.ts)
      CREATE TABLE IF NOT EXISTS fund_flows (
        key  TEXT PRIMARY KEY,         -- accountId + flow id
        data TEXT NOT NULL             -- JSON StoredFlow
      );
    `);
    // Added later: per-account earn/funding amounts, for the trading-accounts curve
    try { db.exec('ALTER TABLE equity_snapshots ADD COLUMN off TEXT'); } catch { /* already there */ }
    flowStmt = db.prepare('INSERT OR REPLACE INTO fund_flows (key, data) VALUES (?, ?)');
    insertStmt = db.prepare('INSERT OR REPLACE INTO equity_snapshots (t, total, accounts, off) VALUES (?, ?, ?, ?)');
    console.log(`[db] history store: ${DB_PATH}`);
    return true;
  } catch (err) {
    console.error(`[db] persistence disabled: ${err instanceof Error ? err.message : err}`);
    db = null;
    return false;
  }
}

export function historyDbLoad(): StoredPoint[] {
  if (!db) return [];
  try {
    const rows = db.prepare('SELECT t, total, accounts, off FROM equity_snapshots ORDER BY t').all() as Array<{ t: number; total: number; accounts: string; off: string | null }>;
    return rows.map((r) => ({ t: Number(r.t), total: Number(r.total), accounts: JSON.parse(r.accounts), ...(r.off ? { off: JSON.parse(r.off) } : {}) }));
  } catch (err) {
    console.error(`[db] load failed: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

export function historyDbInsert(p: StoredPoint): void {
  if (!insertStmt) return;
  try {
    insertStmt.run(p.t, p.total, JSON.stringify(p.accounts), p.off ? JSON.stringify(p.off) : null);
  } catch (err) {
    console.error(`[db] insert failed: ${err instanceof Error ? err.message : err}`);
  }
}

export function flowsDbLoad<T>(): T[] {
  if (!db) return [];
  try {
    const rows = db.prepare('SELECT data FROM fund_flows').all() as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data) as T);
  } catch (err) {
    console.error(`[db] flows load failed: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

export function flowsDbUpsert(key: string, data: unknown): void {
  if (!flowStmt) return;
  try {
    flowStmt.run(key, JSON.stringify(data));
  } catch (err) {
    console.error(`[db] flow upsert failed: ${err instanceof Error ? err.message : err}`);
  }
}

export function historyDbClose(): void {
  try { db?.close(); } catch { /* ignore */ }
  db = null;
  insertStmt = null;
  flowStmt = null;
}
