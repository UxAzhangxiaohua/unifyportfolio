import { applyFunding, BaseConnector, cachedPublic, lower, num, stableCoin, type FundingQuote } from './base.js';
import type { AccountConfig, AccountSnapshot, ClosedTrade, FundFlow, HyperliquidCredentials, Position, StableBalance, TradeCategory } from '../types.js';
import { guessCategory } from '../categories.js';

const API_URL = 'https://api.hyperliquid.xyz/info';

interface HLMarginSummary {
  accountValue: string;
  totalMarginUsed: string;
  totalNtlPos: string;
  totalRawUsd: string;
}

interface HLAssetPosition {
  position: {
    coin: string;
    szi: string;
    entryPx: string;
    positionValue: string;
    unrealizedPnl: string;
    leverage: { type: string; value: number };
    liquidationPx: string | null;
    marginUsed?: string;
    /** Funding *paid* by the user (positive = paid) */
    cumFunding?: { allTime: string; sinceOpen: string; sinceChange: string };
  };
}

interface HLClearinghouseState {
  marginSummary: HLMarginSummary;
  assetPositions: HLAssetPosition[];
}

interface HLSpotBalance {
  coin: string;
  hold: string;
  total: string;
  entryNtl: string;
  token: number;
}

interface HLSpotState {
  balances: HLSpotBalance[];
  /** Only present for unified / portfolio-margin accounts, where spot USDC backs perps */
  tokenToAvailableAfterMaintenance?: unknown;
}

interface HLVaultEquity { vaultAddress: string; equity: string }

interface HLLedgerUpdate {
  time: number;
  hash: string;
  delta: { type: string; usdc?: string; fee?: string; token?: string; amount?: string; usdcValue?: string; user?: string; destination?: string; nonce?: number };
}

// USDT0 is Hyperliquid's bridged USDT
const HL_STABLES: Record<string, 'USDT' | 'USDC'> = { USDC: 'USDC', USDT0: 'USDT', USDT: 'USDT' };

export class HyperliquidConnector extends BaseConnector {
  private address: string;

  constructor(account: AccountConfig) {
    super(account);
    this.address = (account.credentials as HyperliquidCredentials).walletAddress;
  }

  async fetch(): Promise<AccountSnapshot> {
    const warnings: string[] = [];
    try {
      const [perpState, spotState, vaults] = await Promise.all([
        this.fetchPerps(),
        this.fetchSpot(),
        this.sticky('Vaults', warnings, () => this.info<HLVaultEquity[]>('userVaultEquities'), []),
      ]);

      const positions: Position[] = [];
      for (const ap of perpState.assetPositions) {
        const p = ap.position;
        const size = num(p.szi);
        if (size === 0) continue;
        positions.push({
          symbol: p.coin,
          side: size > 0 ? 'long' : 'short',
          quantity: Math.abs(size),
          avgPrice: num(p.entryPx),
          currentPrice: num(p.positionValue) / Math.abs(size),
          unrealizedPnl: num(p.unrealizedPnl),
          marketValue: Math.abs(num(p.positionValue)),
          leverage: p.leverage.value,
          liquidationPrice: p.liquidationPx ? num(p.liquidationPx) : null,
          margin: num(p.marginUsed) || null,
          // HL reports funding paid as positive; we use + received / − paid
          fundingPnl: p.cumFunding ? -num(p.cumFunding.sinceOpen) : null,
          assetClass: 'crypto-perp',
        });
      }
      if (positions.length) {
        const quotes = await this.sticky('Funding rates', warnings, () => this.fundingQuotes(), new Map<string, FundingQuote>(), true);
        for (const p of positions) applyFunding(p, quotes.get(p.symbol));
      }

      const unified = spotState.tokenToAvailableAfterMaintenance !== undefined;
      const perpValue = num(perpState.marginSummary.accountValue);
      const stables: StableBalance[] = [];

      for (const bal of spotState.balances) {
        const asset = HL_STABLES[bal.coin];
        const total = num(bal.total);
        if (asset && Math.abs(total) >= 0.01) {
          stables.push({ asset, location: unified ? 'trading' : 'funding', amount: total, source: unified ? 'Unified account' : 'Spot' });
        }
      }
      // Standard (non-unified) accounts keep perp collateral separately from spot.
      // accountValue includes uPnL, so record collateral as accountValue - uPnL.
      const perpUpl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
      if (!unified && Math.abs(perpValue - perpUpl) >= 0.01) {
        stables.push({ asset: 'USDC', location: 'trading', amount: perpValue - perpUpl, source: 'Perp margin' });
      }
      for (const v of vaults) {
        const eq = num(v.equity);
        if (eq >= 0.01) stables.push({ asset: 'USDC', location: 'earn', amount: eq, source: `Vault ${v.vaultAddress.slice(0, 6)}…` });
      }

      const marginUsed = num(perpState.marginSummary.totalMarginUsed);
      const stableTotal = stables.reduce((s, b) => s + b.amount, 0);
      const equity = stableTotal + perpUpl;
      const tradingEquity = stables.filter((b) => b.location === 'trading').reduce((s, b) => s + b.amount, 0) + perpUpl;

      return {
        accountId: this.account.id,
        exchange: 'hyperliquid',
        label: this.account.label,
        equity,
        availableBalance: num((perpState as { withdrawable?: string }).withdrawable) || Math.max(tradingEquity - marginUsed, 0),
        unrealizedPnl: perpUpl,
        marginUsed,
        marginRatio: tradingEquity > 0 ? marginUsed / tradingEquity : null,
        positions,
        stables,
        fetchedAt: new Date().toISOString(),
        isDelayed: false,
        warnings: warnings.length ? warnings : undefined,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[hyperliquid] ${this.account.id}: ${msg}`);
      return this.makeErrorSnapshot(msg);
    }
  }

  /**
   * Bridge deposits/withdrawals plus stablecoin sends to/from other addresses. Moves inside this
   * address (perp↔spot, vaults, staking) stay within the tracked equity and are ignored.
   * A withdrawal lands at this same address on Arbitrum, hence `address` = own address.
   */
  async fetchFlows(sinceMs: number, untilMs?: number): Promise<FundFlow[]> {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'userNonFundingLedgerUpdates', user: this.address, startTime: sinceMs, ...(untilMs ? { endTime: untilMs } : {}) }),
    });
    if (!res.ok) throw new Error(`ledger ${res.status}: ${(await res.text()).substring(0, 200)}`);
    const rows = (await res.json()) as HLLedgerUpdate[];
    const self = this.address.toLowerCase();
    const flows: FundFlow[] = [];
    for (const r of rows) {
      const d = r.delta;
      const id = `${r.time}:${d.type}:${r.hash}`;
      const base = { txId: null, network: 'Hyperliquid', time: r.time, doneTime: r.time, status: 'done' as const };
      if (d.type === 'deposit') {
        flows.push({ ...base, id: `in:${id}`, direction: 'in', coin: 'USDC', amount: num(d.usdc), fee: 0, address: self });
      } else if (d.type === 'withdraw') {
        flows.push({ ...base, id: `out:${id}`, direction: 'out', coin: 'USDC', amount: num(d.usdc) - num(d.fee), fee: num(d.fee), address: self, network: 'Arbitrum' });
      } else if (d.type === 'send' || d.type === 'spotTransfer' || d.type === 'internalTransfer') {
        const coin = d.type === 'internalTransfer' ? 'USDC' : stableCoin(d.token ?? '');
        const from = lower(d.user), to = lower(d.destination);
        if (!coin || from === to) continue;
        const amount = d.type === 'internalTransfer' ? num(d.usdc) : num(d.amount);
        if (from === self) flows.push({ ...base, id: `out:${id}`, direction: 'out', coin, amount, fee: num(d.fee), address: to });
        else if (to === self) flows.push({ ...base, id: `in:${id}`, direction: 'in', coin, amount, fee: 0, address: self });
      }
    }
    return flows;
  }

  /**
   * Closed trades from perp fills (userFillsByTime, 2000 per page): closing fills ("Close Long",
   * "Close Short", the closing part of a flip, liquidations) grouped per order. closedPnl excludes
   * fees; entry = exit − closedPnl ÷ size.
   */
  async fetchClosedTrades(sinceMs: number): Promise<ClosedTrade[]> {
    const fills: HLFill[] = [];
    let start = sinceMs;
    for (let page = 0; page < 20; page++) {
      const batch = await this.post<HLFill[]>({ type: 'userFillsByTime', user: this.address, startTime: start, aggregateByTime: false });
      fills.push(...batch);
      if (batch.length < 2000) break;
      start = batch[batch.length - 1].time + 1;
    }
    const groups = new Map<string, HLFill[]>();
    for (const f of fills) {
      if (f.coin.startsWith('@') || !f.dir) continue; // spot
      const closing = f.dir.startsWith('Close') || f.dir.includes('>') || !!f.liquidation;
      if (!closing || f.dir.startsWith('Open')) continue;
      const k = `${f.coin}|${f.oid}`;
      groups.set(k, [...(groups.get(k) ?? []), f]);
    }

    const out: ClosedTrade[] = [];
    for (const [k, g] of groups) {
      const f0 = g[0];
      const side: 'long' | 'short' = /^Close Long|^Long >/.test(f0.dir) ? 'long' : /^Close Short|^Short >/.test(f0.dir) ? 'short'
        : num(f0.startPosition) > 0 ? 'long' : 'short';
      // A flip fill closes only the previous position
      const closedSz = (f: HLFill) => (f.dir.includes('>') ? Math.min(num(f.sz), Math.abs(num(f.startPosition))) : num(f.sz));
      const qty = g.reduce((s, f) => s + closedSz(f), 0);
      if (!(qty > 0)) continue;
      const exit = g.reduce((s, f) => s + num(f.px) * closedSz(f), 0) / qty;
      const gross = g.reduce((s, f) => s + num(f.closedPnl), 0);
      const fees = -g.reduce((s, f) => s + num(f.fee), 0);
      const dir = side === 'long' ? 1 : -1;
      const time = Math.max(...g.map((f) => f.time));
      out.push(this.trade({
        id: `hl:${k}`,
        symbol: f0.coin,
        side,
        entryPrice: exit - gross / (qty * dir),
        exitPrice: exit,
        quantity: qty,
        pnl: gross + fees,
        fees,
        entryTime: null,
        exitTime: time,
        category: hlCategory(f0.coin),
      }));
    }
    return out;
  }

  /**
   * Account value history from the `portfolio` endpoint (exact, incl. unrealized PnL): allTime is
   * weekly, month / week / day get finer, so each range is taken from the finest series covering it.
   */
  async fetchEquityHistory(): Promise<Array<{ t: number; v: number }>> {
    type Series = { accountValueHistory: Array<[number, string]> };
    const rows = await this.post<Array<[string, Series]>>({ type: 'portfolio', user: this.address });
    const by = new Map(rows.map(([name, s]) => [name, (s.accountValueHistory ?? []).map(([t, v]) => ({ t, v: num(v) }))]));
    const out: Array<{ t: number; v: number }> = [];
    let until = Infinity;
    for (const name of ['day', 'week', 'month', 'allTime']) {
      const list = by.get(name) ?? [];
      const part = list.filter((p) => p.t < until && Number.isFinite(p.v));
      out.unshift(...part);
      if (list.length) until = Math.min(until, list[0].t);
    }
    return out;
  }

  private async post<T>(body: Record<string, unknown>): Promise<T> {
    const res = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${body.type} ${res.status}: ${(await res.text()).substring(0, 200)}`);
    return res.json() as Promise<T>;
  }

  private async info<T>(type: string): Promise<T> {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, user: this.address }),
    });
    if (!res.ok) throw new Error(`${type} ${res.status}: ${(await res.text()).substring(0, 200)}`);
    return res.json() as Promise<T>;
  }

  /** Main-dex funding rates (hourly settlement on the hour) */
  private async fundingQuotes(): Promise<Map<string, FundingQuote>> {
    const [meta, ctxs] = await cachedPublic('hl:metaAndAssetCtxs', 60_000, async () => {
      const res = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs' }) });
      if (!res.ok) throw new Error(`metaAndAssetCtxs ${res.status}`);
      return res.json() as Promise<[{ universe: Array<{ name: string }> }, Array<{ funding: string }>]>;
    });
    const nextHour = Math.ceil(Date.now() / 3_600_000) * 3_600_000;
    const out = new Map<string, FundingQuote>();
    meta.universe.forEach((u, i) => { if (ctxs[i]) out.set(u.name, { rate: num(ctxs[i].funding), nextTime: nextHour, intervalH: 1 }); });
    return out;
  }

  private async fetchPerps(): Promise<HLClearinghouseState> {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'clearinghouseState', user: this.address }),
    });
    if (!res.ok) throw new Error(`Perps API ${res.status}: ${await res.text()}`);
    return res.json() as Promise<HLClearinghouseState>;
  }

  private async fetchSpot(): Promise<HLSpotState> {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'spotClearinghouseState', user: this.address }),
    });
    if (!res.ok) throw new Error(`Spot API ${res.status}: ${await res.text()}`);
    return res.json() as Promise<HLSpotState>;
  }
}

interface HLFill {
  coin: string; px: string; sz: string; side: 'A' | 'B'; time: number; startPosition: string; dir: string;
  closedPnl: string; oid: number; fee: string; liquidation?: unknown;
}
/** HIP-3 builder dexes ("xyz:NVDA") list stocks, indices and a few commodities; the main dex is crypto */
function hlCategory(coin: string): TradeCategory {
  if (!coin.includes(':')) return guessCategory(coin) === 'xau' ? 'xau' : 'crypto';
  return guessCategory(coin) === 'xau' ? 'xau' : 'stock';
}
