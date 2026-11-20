import { createHmac } from 'node:crypto';
import { BaseConnector, num, optional, parseOptionSymbol } from './base.js';
import type { AccountConfig, AccountSnapshot, OKXCredentials, Position, StableBalance } from '../types.js';

const BASE_URL = 'https://www.okx.com';
const STABLES = new Set(['USDT', 'USDC']);

interface OKXBalance {
  totalEq: string;
  adjEq: string;
  imr: string;
  details: Array<{ ccy: string; eq: string; cashBal: string; upl: string; availEq: string }>;
}
interface OKXPosition {
  instId: string;
  instType: 'SWAP' | 'FUTURES' | 'OPTION' | 'MARGIN';
  posSide: string;
  pos: string;
  avgPx: string;
  markPx: string;
  upl: string;
  lever: string;
  liqPx: string;
  notionalUsd: string;
  imr: string;
  margin: string;
  ccy: string;
  usdPx?: string;
  idxPx?: string;
  deltaBS?: string;
  deltaPA?: string;
}
interface OKXFunding { ccy: string; bal: string }
interface OKXSavings { ccy: string; amt: string }
interface OKXStakingOrder { ccy: string; investData: Array<{ ccy: string; amt: string }> }

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
    const warnings: string[] = [];
    try {
      const [balance, positionsRaw] = await Promise.all([
        this.signedGet<OKXBalance[]>('/api/v5/account/balance'),
        this.signedGet<OKXPosition[]>('/api/v5/account/positions'),
      ]);
      const [funding, savings, staking] = await Promise.all([
        optional('Funding', warnings, () => this.signedGet<OKXFunding[]>('/api/v5/asset/balances?ccy=USDT,USDC'), []),
        optional('Simple Earn', warnings, () => this.signedGet<OKXSavings[]>('/api/v5/finance/savings/balance'), []),
        optional('On-chain Earn', warnings, () => this.signedGet<OKXStakingOrder[]>('/api/v5/finance/staking-defi/orders-active'), [], true),
      ]);

      const acct = balance[0];
      const stables: StableBalance[] = [];
      const add = (ccy: string, location: StableBalance['location'], amount: number, source: string) => {
        if (STABLES.has(ccy) && Math.abs(amount) >= 0.01) stables.push({ asset: ccy as 'USDT' | 'USDC', location, amount, source });
      };
      // Trading account: cash balance (excl. uPnL, which is counted on positions)
      for (const d of acct?.details ?? []) add(d.ccy, 'trading', num(d.cashBal), 'Trading account');
      for (const f of funding) add(f.ccy, 'funding', num(f.bal), 'Funding account');
      for (const s of savings) add(s.ccy, 'earn', num(s.amt), 'Simple Earn');
      for (const o of staking) for (const i of o.investData ?? []) add(i.ccy, 'earn', num(i.amt), 'On-chain Earn');

      const positions: Position[] = [];
      for (const p of positionsRaw) {
        const pos = num(p.pos);
        if (pos === 0 || p.instType === 'MARGIN') continue;
        const side: Position['side'] =
          p.posSide === 'long' || (p.posSide === 'net' && pos > 0) ? 'long'
          : p.posSide === 'short' || (p.posSide === 'net' && pos < 0) ? 'short'
          : 'flat';

        // Coin-margined contracts (incl. BTC-USD options) report uPnL in the margin coin
        const coinPx = STABLES.has(p.ccy) || !p.ccy ? 1 : num(p.usdPx) || num(p.idxPx) || 0;
        const base: Position = {
          symbol: p.instId,
          side,
          quantity: Math.abs(pos),
          avgPrice: num(p.avgPx),
          currentPrice: num(p.markPx),
          unrealizedPnl: num(p.upl) * coinPx,
          marketValue: Math.abs(num(p.notionalUsd)),
          leverage: num(p.lever) || null,
          liquidationPrice: num(p.liqPx) || null,
          assetClass: p.instType === 'SWAP' ? 'crypto-perp' : p.instType === 'FUTURES' ? 'crypto-future' : 'option',
        };

        if (p.instType === 'OPTION') {
          const parsed = parseOptionSymbol(p.instId);
          base.leverage = null;
          if (parsed) {
            base.option = {
              ...parsed,
              delta: p.deltaBS != null && p.deltaBS !== '' ? num(p.deltaBS) : null,
              premiumCcy: STABLES.has(p.ccy) ? undefined : p.ccy,
            };
          }
        }
        positions.push(base);
      }

      const totalEq = num(acct?.totalEq);
      const offTrading = stables.filter((s) => s.location !== 'trading').reduce((s, b) => s + b.amount, 0);
      const upl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
      const marginUsed = num(acct?.imr) || positionsRaw.reduce((s, p) => s + (num(p.imr) || num(p.margin)), 0);
      const adjEq = num(acct?.adjEq) || totalEq;

      return {
        accountId: this.account.id,
        exchange: 'okx',
        label: this.account.label,
        // Trading account total equity (USD, incl. uPnL) + funding/earn stables
        equity: totalEq + offTrading,
        availableBalance: (acct?.details ?? []).filter((d) => STABLES.has(d.ccy)).reduce((s, d) => s + num(d.availEq), 0),
        unrealizedPnl: upl,
        marginUsed,
        marginRatio: adjEq > 0 ? marginUsed / adjEq : null,
        positions,
        stables,
        fetchedAt: new Date().toISOString(),
        isDelayed: false,
        warnings: warnings.length ? warnings : undefined,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[okx] ${this.account.id}: ${msg}`);
      return this.makeErrorSnapshot(msg);
    }
  }

  private async signedGet<T>(path: string): Promise<T> {
    const timestamp = new Date().toISOString();
    const signature = createHmac('sha256', this.apiSecret).update(timestamp + 'GET' + path).digest('base64');

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
      throw new Error(`OKX ${path} ${res.status}: ${(await res.text()).substring(0, 200)}`);
    }
    const body = (await res.json()) as { code: string; msg: string; data: T };
    if (body.code !== '0') {
      throw new Error(`OKX ${path} error code ${body.code}: ${body.msg}`);
    }
    return body.data;
  }
}
