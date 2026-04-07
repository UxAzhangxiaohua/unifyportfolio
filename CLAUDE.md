# UnifyPortfolio

Multi-exchange trading portfolio dashboard.
Exchanges: IBKR (stocks/ETFs), Hyperliquid (perps/spot), Binance (spot/perps/futures), OKX (spot/perps/futures).

## Architecture
- Backend: backend/ (Fastify, Node 22, TypeScript, port 8189)
- Frontend: frontend/ (Vite dev / serve.cjs prod, React 18, Tailwind, port 8188)
- Deployment: PM2 via ecosystem.config.cjs (two processes: unify-backend, unify-frontend)
- Cloudflare Tunnel: pf.zsy.ch → localhost:8188

## Deployment
- `frontend/serve.cjs` — lightweight Node HTTP server for production: serves static files from `frontend/dist/`, proxies `/api/*` to `http://127.0.0.1:8189`, SPA fallback
- `ecosystem.config.cjs` — PM2 config with two apps: unify-backend (port 8189), unify-frontend (port 8188)
- Build: `cd backend && npm run build` then `cd frontend && npm run build`
- Deploy: `pm2 restart all`

## Backend key files
- backend/src/index.ts — Fastify server, API routes (/api/health, /api/portfolio, /api/history, /api/metrics, /api/trades, /api/portfolio/:accountId)
- backend/src/connectors/ — one file per exchange (base.ts, binance.ts, okx.ts, hyperliquid.ts, ibkr.ts)
- backend/src/types.ts — all shared TypeScript interfaces (Position, AccountSnapshot, PortfolioResponse, ClosedTrade)
- backend/src/config.ts — loads accounts.json
- backend/src/scheduler.ts — staggered per-exchange polling, creates connectors, calls cacheSet
- backend/src/cache.ts — in-memory TTL cache (stale-while-revalidate), also triggers trade tracking on each cacheSet
- backend/src/history.ts — in-memory ring buffer (25k points, ~8.5 days at 30s), equity sampling, Sharpe ratio, max drawdown, period PnL
- backend/src/trades.ts — position-diff trade detection: compares snapshots to detect closed/reduced positions, records as ClosedTrade (up to 500 trades in memory)
- accounts.json — multi-account credentials (gitignored)

## Frontend key files
- frontend/src/App.tsx — main layout: Header → EquityChart → MetricsRow → AllocationBar → ExchangeCards → PositionsTable → TradesHistory → Footer
- frontend/src/components/ — Header, EquityChart (lightweight-charts v5), MetricsRow, AllocationBar, ExchangeCard, PositionsTable, TradesHistory, StatusBadge, AccountRow
- frontend/src/hooks/usePortfolio.ts — React Query hooks: usePortfolio (15s), useHistory (30s), useMetrics (30s), useTrades (30s)
- frontend/src/lib/api.ts — fetch functions for all API endpoints
- frontend/src/types.ts — frontend type definitions mirroring backend types
- frontend/src/index.css — Tailwind + custom dark theme (bg-surface, accent indigo, custom scrollbar)

## Charting
- Uses lightweight-charts v5 (TradingView) — v5 API: `chart.addSeries(AreaSeries, options)` NOT the old `chart.addAreaSeries()`
- Import: `import { createChart, AreaSeries, type IChartApi, type ISeriesApi, ColorType, LineType, type UTCTimestamp } from 'lightweight-charts'`

## Rules
- Never add order placement code
- All API keys are read-only
- IBKR uses Flex Query HTTP polling (not OAuth, not TWS)
- Keep each connector isolated; errors in one must not affect others
- No database; in-memory cache only (history + trades reset on restart)
- Frontend port: 8188, Backend port: 8189 (do NOT change these)
- USDT ≈ USD for display purposes
