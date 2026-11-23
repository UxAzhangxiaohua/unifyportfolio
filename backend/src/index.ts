import Fastify from 'fastify';
import cors from '@fastify/cors';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { startScheduler } from './scheduler.js';
import { cacheGetAll, cacheGet, cacheGetHealth } from './cache.js';
import { startHistorySampler, historyGet, historyAccounts, metricsGet, historyInit } from './history.js';
import { historyDbClose } from './db.js';
import { tradesGet } from './trades.js';
import { transfersGet, transfersInit, transitAt } from './transfers.js';
import type { HyperliquidCredentials, PortfolioResponse, TransfersResponse } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BACKEND_PORT) || 8189;

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: true, // Allow all origins in dev; in production use nginx reverse proxy
});

// Try to load config and start scheduler
const configPath = process.env.CONFIG_PATH || resolve(__dirname, '../../accounts.json');
let configLoaded = false;

if (process.env.MOCK === '1') {
  console.warn('MOCK=1 — serving mock data');
} else if (existsSync(configPath)) {
  try {
    const config = loadConfig();
    // History store must be open before transfers load their records and the scheduler starts
    await historyInit();
    transfersInit({
      // A Hyperliquid withdrawal lands at the same address on Arbitrum, so it's one of "our" addresses
      ownAddresses: config.accounts.filter((a) => a.exchange === 'hyperliquid').map((a) => (a.credentials as HyperliquidCredentials).walletAddress),
      labels: Object.fromEntries(config.accounts.map((a) => [a.id, a.label])),
    });
    startScheduler(config);
    startHistorySampler(() => cacheGetAll(), 30_000, config.accounts.map((a) => a.id));
    configLoaded = true;
  } catch (err) {
    console.error('Failed to load config:', err instanceof Error ? err.message : err);
    console.error('Running in mock mode. Create accounts.json to enable live data.');
  }
} else {
  console.warn(`No accounts.json found at ${configPath}. Running in mock mode.`);
  console.warn('Copy accounts.example.json to accounts.json and fill in your credentials.');
}

// Health check
app.get('/api/health', async () => {
  if (!configLoaded) {
    return { status: 'mock', message: 'No accounts.json — serving mock data', timestamp: new Date().toISOString() };
  }
  return {
    status: 'ok',
    accounts: cacheGetHealth(),
    timestamp: new Date().toISOString(),
  };
});

// Portfolio data
app.get('/api/portfolio', async (): Promise<PortfolioResponse> => {
  if (!configLoaded) {
    return getMockData();
  }

  const accounts = cacheGetAll();
  const inTransit = transitAt(Date.now());
  const totalEquity = accounts.reduce((s, a) => s + a.equity, 0) + inTransit;
  const totalUnrealizedPnl = accounts.reduce((s, a) => s + a.unrealizedPnl, 0);

  return {
    totalEquity,
    inTransit,
    totalUnrealizedPnl,
    accounts,
    timestamp: new Date().toISOString(),
  };
});

// Equity history
app.get<{ Querystring: { period?: string; accountId?: string; scope?: string } }>('/api/history', async (request) => {
  const period = request.query.period ?? '24h';
  const accountId = request.query.accountId || undefined;
  return historyGet(period, accountId, request.query.scope === 'trading' ? 'trading' : 'total');
});

// Account list for history filter
app.get('/api/history/accounts', async () => {
  const accounts = cacheGetAll();
  return [...accounts].sort((a, b) => b.equity - a.equity).map((a) => ({ accountId: a.accountId, label: a.label, exchange: a.exchange }));
});

// Performance metrics
app.get('/api/metrics', async () => {
  return metricsGet();
});

// Trade history
app.get('/api/trades', async () => {
  return tradesGet();
});

// Deposits/withdrawals and internal transfers (last 14 days)
app.get('/api/transfers', async (): Promise<TransfersResponse> => {
  if (!configLoaded) return { inTransit: 0, transfers: [] };
  return transfersGet();
});

// Single account
app.get<{ Params: { accountId: string } }>('/api/portfolio/:accountId', async (request, reply) => {
  if (!configLoaded) {
    reply.status(503).send({ error: 'Running in mock mode' });
    return;
  }

  const snapshot = cacheGet(request.params.accountId);
  if (!snapshot) {
    reply.status(404).send({ error: `Account "${request.params.accountId}" not found` });
    return;
  }
  return snapshot;
});

app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});

// Mock data fallback when no accounts.json (also used by MOCK=1 for UI previews)
function getMockData(): PortfolioResponse {
  const now = new Date().toISOString();
  const accounts: PortfolioResponse['accounts'] = [
    {
      accountId: 'binance-main', exchange: 'binance', label: 'Binance Main',
      equity: 58420, availableBalance: 21000, unrealizedPnl: 1840, marginUsed: 9200, marginRatio: 0.21,
      stables: [
        { asset: 'USDT', location: 'trading', amount: 24300, source: 'USDⓈ-M Futures' },
        { asset: 'USDT', location: 'earn', amount: 25000, source: 'Simple Earn Flexible' },
        { asset: 'USDC', location: 'earn', amount: 6000, source: 'Simple Earn Flexible' },
        { asset: 'USDT', location: 'funding', amount: 1280, source: 'Funding wallet' },
      ],
      positions: [
        { symbol: 'BTCUSDT', side: 'long', quantity: 0.45, avgPrice: 91200, currentPrice: 94800, unrealizedPnl: 1620, marketValue: 42660, leverage: 5, liquidationPrice: 74100, assetClass: 'crypto-perp' },
        { symbol: 'SOLUSDT', side: 'short', quantity: 120, avgPrice: 182.4, currentPrice: 180.6, unrealizedPnl: 216, marketValue: 21672, leverage: 3, liquidationPrice: 236.5, assetClass: 'crypto-perp' },
        { symbol: 'BTC-261226-100000-C', side: 'long', quantity: 0.5, avgPrice: 2450, currentPrice: 2410, unrealizedPnl: -20, marketValue: 1205, leverage: null, liquidationPrice: null, assetClass: 'option',
          option: { underlying: 'BTC', type: 'call', strike: 100000, expiry: '2026-12-26', delta: 0.19, gamma: 0.0000045, theta: -38.5, vega: 52.1, iv: 0.52, underlyingPrice: 94800 } },
      ],
      fetchedAt: now, isDelayed: false,
    },
    {
      accountId: 'okx-main', exchange: 'okx', label: 'OKX Main',
      equity: 31250, availableBalance: 14000, unrealizedPnl: -412, marginUsed: 6400, marginRatio: 0.2,
      stables: [
        { asset: 'USDT', location: 'trading', amount: 16800, source: 'Trading account' },
        { asset: 'USDC', location: 'earn', amount: 12000, source: 'Simple Earn' },
        { asset: 'USDT', location: 'funding', amount: 2862, source: 'Funding account' },
      ],
      positions: [
        { symbol: 'ETH-USDT-SWAP', side: 'long', quantity: 8, avgPrice: 3420, currentPrice: 3371, unrealizedPnl: -392, marketValue: 26968, leverage: 10, liquidationPrice: 3080, assetClass: 'crypto-perp' },
        { symbol: 'ETH-USD-261227-3000-P', side: 'short', quantity: 2, avgPrice: 0.021, currentPrice: 0.024, unrealizedPnl: -20, marketValue: 6742, leverage: null, liquidationPrice: null, assetClass: 'option',
          option: { underlying: 'ETH', type: 'put', strike: 3000, expiry: '2026-12-27', delta: 0.42, gamma: -0.0011, theta: 9.8, vega: -6.4, underlyingPrice: 3371, premiumCcy: 'ETH' } },
      ],
      fetchedAt: now, isDelayed: false,
    },
    {
      accountId: 'bybit-main', exchange: 'bybit', label: 'Bybit Main',
      equity: 18900, availableBalance: 12100, unrealizedPnl: 310, marginUsed: 2900, marginRatio: 0.15,
      stables: [
        { asset: 'USDT', location: 'trading', amount: 8590, source: 'Unified Trading' },
        { asset: 'USDT', location: 'earn', amount: 10000, source: 'Flexible Savings' },
      ],
      positions: [
        { symbol: 'HYPEUSDT', side: 'long', quantity: 400, avgPrice: 38.2, currentPrice: 38.975, unrealizedPnl: 310, marketValue: 15590, leverage: 5, liquidationPrice: 31.4, assetClass: 'crypto-perp' },
      ],
      fetchedAt: now, isDelayed: false,
    },
    {
      accountId: 'hl-main', exchange: 'hyperliquid', label: 'Hyperliquid Main',
      equity: 12480, availableBalance: 7600, unrealizedPnl: 480, marginUsed: 4400, marginRatio: 0.35,
      stables: [
        { asset: 'USDC', location: 'trading', amount: 7000, source: 'Perp margin' },
        { asset: 'USDC', location: 'earn', amount: 5000, source: 'Vault HLP' },
      ],
      positions: [
        { symbol: 'ETH', side: 'short', quantity: 6.5, avgPrice: 3445, currentPrice: 3371, unrealizedPnl: 480, marketValue: 21911, leverage: 5, liquidationPrice: 3890, assetClass: 'crypto-perp' },
      ],
      fetchedAt: now, isDelayed: false,
    },
    {
      accountId: 'ibkr-main', exchange: 'ibkr', label: 'IBKR Main',
      equity: 42000, availableBalance: 30000, unrealizedPnl: 0, marginUsed: null, marginRatio: null, stables: [],
      positions: [
        { symbol: 'SPY 261218P00580000', side: 'short', quantity: 2, avgPrice: 6.1, currentPrice: 4.85, unrealizedPnl: 250, marketValue: 970, leverage: null, liquidationPrice: null, assetClass: 'option',
          option: { underlying: 'SPY', type: 'put', strike: 580, expiry: '2026-12-18' } },
      ],
      fetchedAt: now, isDelayed: true, error: 'IBKR SendRequest failed (1025): Too many failed attempts.',
    },
  ];
  return {
    totalEquity: accounts.reduce((s, a) => s + a.equity, 0),
    totalUnrealizedPnl: accounts.reduce((s, a) => s + a.unrealizedPnl, 0),
    accounts,
    timestamp: now,
  };
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { historyDbClose(); process.exit(0); });
}
