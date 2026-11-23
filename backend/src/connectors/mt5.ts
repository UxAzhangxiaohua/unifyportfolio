import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BaseConnector } from './base.js';
import type { AccountSnapshot, CfdAccountState, MT5Credentials, Position } from '../types.js';

// MT5 accounts (investor / read-only password) via the mt5bridge Go helper
// (mt5bridge/, built on github.com/voorz/mtapi). Each poll spawns one short-lived
// process that logs in fresh, prints a JSON snapshot in USD and exits — a fresh
// login avoids the frozen-session problem of long-lived MT5 web sessions and
// keeps nothing resident. The helper never trades.

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/connectors or dist/connectors → <repo>/mt5bridge/bin/mt5snap
const BIN = process.env.MT5SNAP_BIN || resolve(__dirname, '../../../mt5bridge/bin/mt5snap');
const TIMEOUT_MS = 55_000;

interface BridgePosition {
  ticket: number;
  symbol: string;
  side: 'long' | 'short';
  volume: number;
  openPrice: number;
  price: number;
  contractSize: number;
  profitUsd: number;
  notionalUsd: number;
  sl: number;
  tp: number;
  tpPnlUsd: number | null;
  slPnlUsd: number | null;
}

interface BridgeSnapshot {
  error?: string;
  login: number;
  server: string;
  group: string;
  currency: string;
  usdRate: number;
  leverage: number;
  balanceUsd: number;
  creditUsd: number;
  equityUsd: number;
  marginUsd: number;
  marginEstimated: boolean;
  positions: BridgePosition[];
  warnings: string[];
}

function runBridge(creds: MT5Credentials): Promise<BridgeSnapshot> {
  return new Promise((resolvePromise, reject) => {
    if (!existsSync(BIN)) {
      reject(new Error(`mt5snap binary not found at ${BIN} — build it: cd mt5bridge && go build -o bin/mt5snap .`));
      return;
    }
    const child = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal) {
        reject(new Error(timedOut ? `mt5snap timed out after ${TIMEOUT_MS / 1000}s` : `mt5snap killed by ${signal}`));
        return;
      }
      let parsed: BridgeSnapshot;
      try {
        parsed = JSON.parse(out.trim().split('\n').pop() || '{}');
      } catch {
        reject(new Error(`mt5snap exit ${code}: ${(err || out).trim().substring(0, 200)}`));
        return;
      }
      if (parsed.error || code !== 0) reject(new Error(parsed.error || `mt5snap exit ${code}`));
      else resolvePromise(parsed);
    });
    // A child that fails to exec (wrong arch, no exec bit) or exits early makes stdin emit EPIPE;
    // unhandled, that would crash the whole backend. The 'error'/'close' handlers report the failure.
    child.stdin.on('error', () => { /* reported via child 'error' / 'close' */ });
    // Credentials go over stdin so the password never appears in the process list
    child.stdin.end(JSON.stringify({
      login: String(creds.login).trim(),
      password: creds.password,
      server: creds.server,
      host: creds.host ?? '',
    }));
  });
}

/**
 * The snapshot error is shown on the public page: map it to a fixed message so mtapi errors
 * that quote the server name or login never leave the server.
 */
function publicError(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes('not found at')) return 'MT5 helper binary missing — see server log';
  if (m.includes('server not found') || m.includes('no access points')) return 'MT5 server not found — check "server" in accounts.json';
  if (m.includes('authentication') || m.includes('invalid login')) return 'MT5 login rejected — check login / investor password';
  if (m.includes('timed out') || m.includes('timeout') || m.includes('deadline')) return 'MT5 request timed out';
  if (m.includes('connection')) return 'MT5 connection failed';
  return 'MT5 fetch failed — see server log';
}

export class MT5Connector extends BaseConnector {
  private running: Promise<AccountSnapshot> | null = null;

  async fetch(): Promise<AccountSnapshot> {
    // A slow login must not stack up processes
    if (!this.running) this.running = this.fetchOnce().finally(() => { this.running = null; });
    return this.running;
  }

  private async fetchOnce(): Promise<AccountSnapshot> {
    try {
      const s = await runBridge(this.account.credentials as MT5Credentials);

      const positions: Position[] = s.positions.map((p) => ({
        symbol: p.symbol,
        side: p.side,
        quantity: p.volume,
        avgPrice: p.openPrice,
        currentPrice: p.price,
        unrealizedPnl: p.profitUsd,
        marketValue: Math.abs(p.notionalUsd),
        leverage: s.leverage || null,
        liquidationPrice: null,
        sl: p.sl || null,
        tp: p.tp || null,
        tpPnl: p.tpPnlUsd ?? null,
        slPnl: p.slPnlUsd ?? null,
        assetClass: 'cfd',
      }));

      const equity = s.equityUsd;
      const used = s.marginUsd;
      const notional = positions.reduce((sum, p) => sum + p.marketValue, 0);
      const floating = equity - s.balanceUsd - s.creditUsd;

      const state: CfdAccountState = {
        // Account number / server are never sent to the page (public behind the tunnel)
        name: 'MT5',
        currency: s.currency || 'USD',
        balance: s.balanceUsd,
        equity,
        floatingPnl: floating,
        usedMargin: used,
        freeMargin: equity - used,
        marginLevel: used > 0 ? (equity / used) * 100 : null,
        leverage: s.leverage || null,
        // Not exposed by the MT5 web protocol; set per account in accounts.json if known
        marginCallLevel: this.levelOverride('marginCallLevel'),
        stopOutLevel: this.levelOverride('stopOutLevel'),
        effectiveLeverage: equity > 0 ? notional / equity : null,
        notional,
        marginEstimated: s.marginEstimated || undefined,
      };

      return {
        accountId: this.account.id,
        exchange: this.account.exchange,
        label: this.account.label,
        equity,
        availableBalance: equity - used,
        unrealizedPnl: floating,
        marginUsed: used,
        marginRatio: equity > 0 ? used / equity : null,
        positions,
        stables: [],
        fetchedAt: new Date().toISOString(),
        isDelayed: false,
        warnings: s.warnings?.length ? s.warnings : undefined,
        cfd: [state],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Full text (may quote the server name / login) stays in the server log only
      console.error(`[mt5] ${this.account.id}: ${msg}`);
      return this.makeErrorSnapshot(publicError(msg));
    }
  }

  /** Optional "marginCallLevel" / "stopOutLevel" (%) on the account entry in accounts.json */
  private levelOverride(key: 'marginCallLevel' | 'stopOutLevel'): number | null {
    const v = (this.account as unknown as Record<string, unknown>)[key];
    return typeof v === 'number' && v >= 0 ? v : null;
  }
}
