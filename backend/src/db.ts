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
let tradeStmt: StatementSync | null = null;


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
      -- Closed trades (trades.ts): MT5 from the broker's deal history, other venues inferred
      CREATE TABLE IF NOT EXISTS trades (
        id   TEXT PRIMARY KEY,
        exit INTEGER NOT NULL,         -- unix ms of the close
        data TEXT NOT NULL             -- JSON ClosedTrade
      );
      -- Small key/value store (backfill coverage markers)
      CREATE TABLE IF NOT EXISTS meta (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
      -- Former TP/SL plan store (feature removed)
      DROP TABLE IF EXISTS trade_plans;
    `);
    // Added later: per-account earn/funding amounts, for the trading-accounts curve
    try { db.exec('ALTER TABLE equity_snapshots ADD COLUMN off TEXT'); } catch { /* already there */ }
    tradeStmt = db.prepare('INSERT OR REPLACE INTO trades (id, exit, data) VALUES (?, ?, ?)');
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

export function tradesDbLoad<T>(sinceMs: number): T[] {
  if (!db) return [];
  try {
    const rows = db.prepare('SELECT data FROM trades WHERE exit >= ? ORDER BY exit DESC').all(sinceMs) as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data) as T);
  } catch (err) {
    console.error(`[db] trades load failed: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

export function tradesDbUpsert(id: string, exitMs: number, data: unknown): void {
  if (!tradeStmt) return;
  try { tradeStmt.run(id, exitMs, JSON.stringify(data)); } catch (err) {
    console.error(`[db] trade upsert failed: ${err instanceof Error ? err.message : err}`);
  }
}

export function tradesDbDelete(id: string): void {
  try { db?.prepare('DELETE FROM trades WHERE id = ?').run(id); } catch (err) {
    console.error(`[db] trade delete failed: ${err instanceof Error ? err.message : err}`);
  }
}

export function metaGet(k: string): string | null {
  try {
    const row = db?.prepare('SELECT v FROM meta WHERE k = ?').get(k) as { v: string } | undefined;
    return row?.v ?? null;
  } catch { return null; }
}

export function metaSet(k: string, v: string): void {
  try { db?.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run(k, v); } catch (err) {
    console.error(`[db] meta set failed: ${err instanceof Error ? err.message : err}`);
  }
}

export function historyDbClose(): void {
  try { db?.close(); } catch { /* ignore */ }
  db = null;
  insertStmt = null;
  flowStmt = null;
  tradeStmt = null;
}
