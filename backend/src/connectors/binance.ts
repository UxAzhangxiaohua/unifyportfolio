import { createHmac } from 'node:crypto';
import { BaseConnector } from './base.js';
import type { AccountConfig, AccountSnapshot, BinanceCredentials, Position } from '../types.js';

const SPOT_BASE = 'https://api.binance.com';
const FUTURES_BASE = 'https://fapi.binance.com';

interface BinanceSpotBalance {
  asset: string;
  free: string;
  locked: string;
}

interface BinanceSpotAccount {
  balances: BinanceSpotBalance[];
}

interface BinanceFuturesPosition {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  leverage: string;
  liquidationPrice: string;
  notional: string;
  positionSide: string;
}

interface BinanceFuturesAccount {
  totalWalletBalance: string;
  totalUnrealizedProfit: string;
  totalMarginBalance: string;
  availableBalance: string;
  totalInitialMargin: string;
  positions: BinanceFuturesPosition[];
}

export class BinanceConnector extends BaseConnector {
  private apiKey: string;
  private apiSecret: string;

  constructor(account: AccountConfig) {
    super(account);
    const creds = account.credentials as BinanceCredentials;
    this.apiKey = creds.apiKey;
    this.apiSecret = creds.apiSecret;
  }

  async fetch(): Promise<AccountSnapshot> {
    try {
      const [spotData, futuresData] = await Promise.all([
        this.fetchSpot(),
        this.fetchFutures(),
      ]);

      const positions: Position[] = [];

      // Spot balances (non-zero, non-stablecoin for positions list)
      const stables = new Set(['USDT', 'USDC', 'BUSD', 'TUSD', 'FDUSD']);
      let spotEquity = 0;

      for (const bal of spotData.balances) {
        const total = parseFloat(bal.free) + parseFloat(bal.locked);
        if (total === 0) continue;

        if (stables.has(bal.asset)) {
          spotEquity += total;
          continue;
        }

        positions.push({
          symbol: bal.asset,
          side: 'long',
          quantity: total,
          avgPrice: 0,
          currentPrice: 0,
          unrealizedPnl: 0,
          marketValue: 0, // Would need price feed for accurate value
          leverage: null,
          liquidationPrice: null,
          assetClass: 'crypto-spot',
        });
      }

      // Futures positions
      for (const fp of futuresData.positions) {
        const posAmt = parseFloat(fp.positionAmt);
        if (posAmt === 0) continue;

        positions.push({
          symbol: fp.symbol,
          side: posAmt > 0 ? 'long' : 'short',
          quantity: Math.abs(posAmt),
          avgPrice: parseFloat(fp.entryPrice),
          currentPrice: parseFloat(fp.markPrice),
          unrealizedPnl: parseFloat(fp.unRealizedProfit),
          marketValue: Math.abs(parseFloat(fp.notional)),
          leverage: parseInt(fp.leverage, 10),
          liquidationPrice: parseFloat(fp.liquidationPrice) || null,
          assetClass: 'crypto-perp',
        });
      }

      const futuresWallet = parseFloat(futuresData.totalWalletBalance);
      const futuresUnrealizedPnl = parseFloat(futuresData.totalUnrealizedProfit);
      const futuresMargin = parseFloat(futuresData.totalInitialMargin);
      const futuresAvailable = parseFloat(futuresData.availableBalance);
      const totalEquity = spotEquity + futuresWallet + futuresUnrealizedPnl;

      return {
        accountId: this.account.id,
        exchange: 'binance',
        label: this.account.label,
        equity: totalEquity,
        availableBalance: spotEquity + futuresAvailable,
        unrealizedPnl: futuresUnrealizedPnl,
        marginUsed: futuresMargin,
        marginRatio: futuresWallet > 0 ? futuresMargin / futuresWallet : null,
        positions,
        fetchedAt: new Date().toISOString(),
        isDelayed: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[binance] ${this.account.id}: ${msg}`);
      return this.makeErrorSnapshot(msg);
    }
  }

  private sign(queryString: string): string {
    return createHmac('sha256', this.apiSecret).update(queryString).digest('hex');
  }

  private async signedGet<T>(baseUrl: string, path: string, params: Record<string, string> = {}): Promise<T> {
    const timestamp = Date.now().toString();
    const allParams = { ...params, timestamp, recvWindow: '10000' };
    const queryString = new URLSearchParams(allParams).toString();
    const signature = this.sign(queryString);
    const url = `${baseUrl}${path}?${queryString}&signature=${signature}`;

    const res = await fetch(url, {
      headers: { 'X-MBX-APIKEY': this.apiKey },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Binance ${path} ${res.status}: ${body}`);
    }

    return res.json() as Promise<T>;
  }

  private async fetchSpot(): Promise<BinanceSpotAccount> {
    return this.signedGet<BinanceSpotAccount>(SPOT_BASE, '/api/v3/account');
  }

  private async fetchFutures(): Promise<BinanceFuturesAccount> {
    return this.signedGet<BinanceFuturesAccount>(FUTURES_BASE, '/fapi/v3/account');
  }
}
