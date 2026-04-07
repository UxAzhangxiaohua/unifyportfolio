import Fastify from 'fastify';
import cors from '@fastify/cors';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { startScheduler } from './scheduler.js';
import { cacheGetAll, cacheGet, cacheGetHealth } from './cache.js';
import { startHistorySampler, historyGet, metricsGet } from './history.js';
import type { PortfolioResponse } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BACKEND_PORT) || 8189;

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: true, // Allow all origins in dev; in production use nginx reverse proxy
});

// Try to load config and start scheduler
const configPath = process.env.CONFIG_PATH || resolve(__dirname, '../../accounts.json');
let configLoaded = false;

if (existsSync(configPath)) {
  try {
    const config = loadConfig();
    startScheduler(config);
    startHistorySampler(() => cacheGetAll(), 30_000);
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
  const totalEquity = accounts.reduce((s, a) => s + a.equity, 0);
  const totalUnrealizedPnl = accounts.reduce((s, a) => s + a.unrealizedPnl, 0);

  return {
    totalEquity,
    totalUnrealizedPnl,
    accounts,
    timestamp: new Date().toISOString(),
  };
});

// Equity history
app.get<{ Querystring: { period?: string } }>('/api/history', async (request) => {
  const period = request.query.period ?? '24h';
  return historyGet(period);
});

// Performance metrics
app.get('/api/metrics', async () => {
  return metricsGet();
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

// Mock data fallback when no accounts.json
function getMockData(): PortfolioResponse {
  return {
    totalEquity: 150000,
    totalUnrealizedPnl: 3200,
    accounts: [
      {
        accountId: 'ibkr-main',
        exchange: 'ibkr',
        label: 'IBKR US Stocks',
        equity: 80000,
        availableBalance: 25000,
        unrealizedPnl: 1200,
        marginUsed: null,
        marginRatio: null,
        positions: [
          { symbol: 'AAPL', side: 'long', quantity: 100, avgPrice: 175.5, currentPrice: 182.3, unrealizedPnl: 680, marketValue: 18230, leverage: null, liquidationPrice: null, assetClass: 'stock' },
          { symbol: 'SPY', side: 'long', quantity: 50, avgPrice: 520, currentPrice: 530.4, unrealizedPnl: 520, marketValue: 26520, leverage: null, liquidationPrice: null, assetClass: 'etf' },
        ],
        fetchedAt: new Date().toISOString(),
        isDelayed: true,
      },
      {
        accountId: 'hl-main',
        exchange: 'hyperliquid',
        label: 'Hyperliquid Main',
        equity: 25000,
        availableBalance: 12000,
        unrealizedPnl: 800,
        marginUsed: 13000,
        marginRatio: 0.52,
        positions: [
          { symbol: 'ETH', side: 'long', quantity: 5, avgPrice: 3200, currentPrice: 3360, unrealizedPnl: 800, marketValue: 16800, leverage: 3, liquidationPrice: 2800, assetClass: 'crypto-perp' },
        ],
        fetchedAt: new Date().toISOString(),
        isDelayed: false,
      },
      {
        accountId: 'binance-main',
        exchange: 'binance',
        label: 'Binance Main',
        equity: 30000,
        availableBalance: 15000,
        unrealizedPnl: 950,
        marginUsed: 15000,
        marginRatio: 0.5,
        positions: [
          { symbol: 'BTCUSDT', side: 'long', quantity: 0.5, avgPrice: 62000, currentPrice: 63900, unrealizedPnl: 950, marketValue: 31950, leverage: 5, liquidationPrice: 55000, assetClass: 'crypto-perp' },
        ],
        fetchedAt: new Date().toISOString(),
        isDelayed: false,
      },
      {
        accountId: 'okx-main',
        exchange: 'okx',
        label: 'OKX Trading',
        equity: 15000,
        availableBalance: 8000,
        unrealizedPnl: 250,
        marginUsed: 7000,
        marginRatio: 0.47,
        positions: [
          { symbol: 'SOL-USDT-SWAP', side: 'short', quantity: 100, avgPrice: 148.5, currentPrice: 146.0, unrealizedPnl: 250, marketValue: 14600, leverage: 10, liquidationPrice: 165, assetClass: 'crypto-perp' },
        ],
        fetchedAt: new Date().toISOString(),
        isDelayed: false,
      },
    ],
    timestamp: new Date().toISOString(),
  };
}
