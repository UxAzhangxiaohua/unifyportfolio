import { BaseConnector } from './base.js';
import type { AccountConfig, AccountSnapshot, HyperliquidCredentials, Position } from '../types.js';

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
}

export class HyperliquidConnector extends BaseConnector {
  private address: string;

  constructor(account: AccountConfig) {
    super(account);
    this.address = (account.credentials as HyperliquidCredentials).walletAddress;
  }

  async fetch(): Promise<AccountSnapshot> {
    try {
      const [perpState, spotState] = await Promise.all([
        this.fetchPerps(),
        this.fetchSpot(),
      ]);

      const positions: Position[] = [];

      // Perp positions
      for (const ap of perpState.assetPositions) {
        const p = ap.position;
        const size = parseFloat(p.szi);
        if (size === 0) continue;

        positions.push({
          symbol: p.coin,
          side: size > 0 ? 'long' : 'short',
          quantity: Math.abs(size),
          avgPrice: parseFloat(p.entryPx),
          currentPrice: parseFloat(p.positionValue) / Math.abs(size),
          unrealizedPnl: parseFloat(p.unrealizedPnl),
          marketValue: Math.abs(parseFloat(p.positionValue)),
          leverage: p.leverage.value,
          liquidationPrice: p.liquidationPx ? parseFloat(p.liquidationPx) : null,
          assetClass: 'crypto-perp',
        });
      }

      // Spot balances (only include non-zero, non-USDC)
      for (const bal of spotState.balances) {
        const total = parseFloat(bal.total);
        if (total === 0 || bal.coin === 'USDC') continue;

        positions.push({
          symbol: bal.coin,
          side: 'long',
          quantity: total,
          avgPrice: parseFloat(bal.entryNtl) / total || 0,
          currentPrice: 0, // Spot doesn't return mark price directly
          unrealizedPnl: 0,
          marketValue: total, // Will be approximate
          leverage: null,
          liquidationPrice: null,
          assetClass: 'crypto-spot',
        });
      }

      const marginUsed = parseFloat(perpState.marginSummary.totalMarginUsed);
      const totalUnrealizedPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);

      // For unified accounts, spot USDC total is the source of truth for
      // account balance across both spot and perps (per Hyperliquid docs)
      const usdcBalance = spotState.balances.find(b => b.coin === 'USDC');
      const equity = usdcBalance ? parseFloat(usdcBalance.total) : 0;

      return {
        accountId: this.account.id,
        exchange: 'hyperliquid',
        label: this.account.label,
        equity,
        availableBalance: equity - marginUsed,
        unrealizedPnl: totalUnrealizedPnl,
        marginUsed,
        marginRatio: equity > 0 ? marginUsed / equity : null,
        positions,
        fetchedAt: new Date().toISOString(),
        isDelayed: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[hyperliquid] ${this.account.id}: ${msg}`);
      return this.makeErrorSnapshot(msg);
    }
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
