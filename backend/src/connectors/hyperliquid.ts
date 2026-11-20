import { BaseConnector, num, optional } from './base.js';
import type { AccountConfig, AccountSnapshot, HyperliquidCredentials, Position, StableBalance } from '../types.js';

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
        optional('Vaults', warnings, () => this.info<HLVaultEquity[]>('userVaultEquities'), []),
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
          assetClass: 'crypto-perp',
        });
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

  private async info<T>(type: string): Promise<T> {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, user: this.address }),
    });
    if (!res.ok) throw new Error(`${type} ${res.status}: ${(await res.text()).substring(0, 200)}`);
    return res.json() as Promise<T>;
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
