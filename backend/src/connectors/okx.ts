import { createHmac } from 'node:crypto';
import { BaseConnector } from './base.js';
import type { AccountConfig, AccountSnapshot, OKXCredentials, Position } from '../types.js';

const BASE_URL = 'https://www.okx.com';

interface OKXBalanceDetail {
  ccy: string;
  eq: string;
  availEq: string;
  frozenBal: string;
}

interface OKXBalanceResponse {
  code: string;
  data: Array<{
    totalEq: string;
    details: OKXBalanceDetail[];
  }>;
}

interface OKXPosition {
  instId: string;
  instType: string;
  posSide: string;
  pos: string;
  avgPx: string;
  markPx: string;
  upl: string;
  lever: string;
  liqPx: string;
  notionalUsd: string;
  margin: string;
}

interface OKXPositionsResponse {
  code: string;
  data: OKXPosition[];
}

export class OKXConnector extends BaseConnector {
  private apiKey: string;
  private apiSecret: string;
  private passphrase: string;

  constructor(account: AccountConfig) {
    super(account);
    const creds = account.credentials as OKXCredentials;
    this.apiKey = creds.apiKey;
    this.apiSecret = creds.apiSecret;
    this.passphrase = creds.passphrase;
  }

  async fetch(): Promise<AccountSnapshot> {
    try {
      const [balanceData, positionsData] = await Promise.all([
        this.fetchBalance(),
        this.fetchPositions(),
      ]);

      const positions: Position[] = [];
      let totalUnrealizedPnl = 0;
      let totalMarginUsed = 0;

      for (const p of positionsData.data) {
        const pos = parseFloat(p.pos);
        if (pos === 0) continue;

        const upl = parseFloat(p.upl);
        totalUnrealizedPnl += upl;
        totalMarginUsed += parseFloat(p.margin) || 0;

        // Determine side from posSide or pos sign
        let side: 'long' | 'short' | 'flat';
        if (p.posSide === 'long' || (p.posSide === 'net' && pos > 0)) {
          side = 'long';
        } else if (p.posSide === 'short' || (p.posSide === 'net' && pos < 0)) {
          side = 'short';
        } else {
          side = 'flat';
        }

        // Determine asset class from instType
        let assetClass: Position['assetClass'];
        if (p.instType === 'SWAP') {
          assetClass = 'crypto-perp';
        } else if (p.instType === 'FUTURES') {
          assetClass = 'crypto-future';
        } else {
          assetClass = 'crypto-spot';
        }

        positions.push({
          symbol: p.instId,
          side,
          quantity: Math.abs(pos),
          avgPrice: parseFloat(p.avgPx) || 0,
          currentPrice: parseFloat(p.markPx) || 0,
          unrealizedPnl: upl,
          marketValue: Math.abs(parseFloat(p.notionalUsd)) || 0,
          leverage: parseFloat(p.lever) || null,
          liquidationPrice: parseFloat(p.liqPx) || null,
          assetClass,
        });
      }

      const totalEq = balanceData.data[0] ? parseFloat(balanceData.data[0].totalEq) : 0;

      // Calculate available balance from balance details
      const availableBalance = balanceData.data[0]?.details.reduce((sum, d) => {
        return sum + (parseFloat(d.availEq) || 0);
      }, 0) ?? 0;

      return {
        accountId: this.account.id,
        exchange: 'okx',
        label: this.account.label,
        equity: totalEq,
        availableBalance,
        unrealizedPnl: totalUnrealizedPnl,
        marginUsed: totalMarginUsed,
        marginRatio: totalEq > 0 ? totalMarginUsed / totalEq : null,
        positions,
        fetchedAt: new Date().toISOString(),
        isDelayed: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[okx] ${this.account.id}: ${msg}`);
      return this.makeErrorSnapshot(msg);
    }
  }

  private sign(timestamp: string, method: string, requestPath: string, body: string = ''): string {
    const prehash = timestamp + method + requestPath + body;
    return createHmac('sha256', this.apiSecret).update(prehash).digest('base64');
  }

  private async signedGet<T>(path: string): Promise<T> {
    const timestamp = new Date().toISOString();
    const signature = this.sign(timestamp, 'GET', path);

    const res = await fetch(`${BASE_URL}${path}`, {
      headers: {
        'OK-ACCESS-KEY': this.apiKey,
        'OK-ACCESS-SIGN': signature,
        'OK-ACCESS-TIMESTAMP': timestamp,
        'OK-ACCESS-PASSPHRASE': this.passphrase,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OKX ${path} ${res.status}: ${body}`);
    }

    const data = await res.json() as { code: string; msg: string };
    if (data.code !== '0') {
      throw new Error(`OKX ${path} error code ${data.code}: ${data.msg}`);
    }

    return data as T;
  }

  private async fetchBalance(): Promise<OKXBalanceResponse> {
    return this.signedGet<OKXBalanceResponse>('/api/v5/account/balance');
  }

  private async fetchPositions(): Promise<OKXPositionsResponse> {
    return this.signedGet<OKXPositionsResponse>('/api/v5/account/positions');
  }
}
