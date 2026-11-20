# UnifyPortfolio

Multi-exchange trading portfolio dashboard.
Exchanges: IBKR (stocks/ETFs), Hyperliquid (perps/spot), Binance (spot/perps/futures), OKX (spot/perps/futures).
Also Bybit (V5 unified account: spot + linear perps + options) and Bitget (V2 classic account: spot + USDT/USDC-M futures + Earn).
IBKR is currently disabled (`"enabled": false` in accounts.json) — set to true / remove the flag to re-enable.

## Architecture
- Backend: backend/ (Fastify, Node 22, TypeScript, port 8189)
- Frontend: frontend/ (Vite dev / serve.cjs prod, React 18, Tailwind, port 8188)
- Deployment: PM2 via ecosystem.config.cjs (two processes: unify-backend, unify-frontend)
- Cloudflare Tunnel: your-domain.example → localhost:8188

## Deployment
- `frontend/serve.cjs` — lightweight Node HTTP server for production: serves static files from `frontend/dist/`, proxies `/api/*` to `http://127.0.0.1:8189`, SPA fallback
- `ecosystem.config.cjs` — PM2 config with two apps: unify-backend (port 8189), unify-frontend (port 8188)
- Build: `cd backend && npm run build` then `cd frontend && npm run build`
- Deploy: `pm2 restart all`

## Backend key files
- backend/src/index.ts — Fastify server, API routes (/api/health, /api/portfolio, /api/history, /api/metrics, /api/trades, /api/portfolio/:accountId)
- backend/src/connectors/ — one file per exchange (base.ts, binance.ts, okx.ts, hyperliquid.ts, ibkr.ts, bybit.ts, bitget.ts)
- backend/src/types.ts — all shared TypeScript interfaces (Position, AccountSnapshot, StableBalance, OptionDetails, PortfolioResponse, ClosedTrade)
- Each AccountSnapshot carries `stables` (USDT/USDC by location: trading / funding / earn) and optional `warnings` (non-fatal sub-request failures, e.g. earn endpoint not permitted). Use `optional()` from connectors/base.ts for non-critical endpoints
- Options use assetClass 'option' + `option` details; `parseOptionSymbol()` in base.ts handles OKX/Binance/Bybit symbol formats
- cache.ts: an error snapshot never overwrites last good data (error is attached instead) and never triggers trade tracking
- `MOCK=1` env forces mock data (for UI previews)
- backend/src/config.ts — loads accounts.json
- backend/src/scheduler.ts — staggered per-exchange polling, creates connectors, calls cacheSet
- backend/src/cache.ts — in-memory TTL cache (stale-while-revalidate), also triggers trade tracking on each cacheSet
- backend/src/history.ts — in-memory ring buffer (25k points, ~8.5 days at 30s), equity sampling, Sharpe ratio, max drawdown, period PnL
- backend/src/trades.ts — position-diff trade detection: compares snapshots to detect closed/reduced positions, records as ClosedTrade (up to 500 trades in memory)
- accounts.json — multi-account credentials (gitignored); accounts with placeholder creds ("YOUR_...") or `"enabled": false` are skipped at startup

## Frontend key files
- frontend/src/App.tsx — main layout: Header → KpiRow → AccountsGrid → StablesPanel → PositionsTable (perps/futures) → OptionsTable → EquityChart + MetricsRow → OtherHoldings (spot/stocks, collapsed) → TradesHistory
- UI language is Chinese. User focus: derivatives + stablecoins (incl. earn); spot is secondary
- frontend/src/components/ — ui.tsx (shared primitives), Header, KpiRow, AccountsGrid, StablesPanel, PositionsTable, OptionsTable, OtherHoldings, EquityChart (lightweight-charts v5), MetricsRow, TradesHistory
- frontend/src/lib/format.ts (number/time formatters), lib/exchanges.ts (exchange names/colors/order)
- frontend/src/hooks/usePortfolio.ts — React Query hooks: usePortfolio (15s), useHistory (30s), useMetrics (30s), useTrades (30s)
- frontend/src/lib/api.ts — fetch functions for all API endpoints
- frontend/src/types.ts — frontend type definitions mirroring backend types
- frontend/src/index.css — Tailwind v4 @theme tokens + shared classes (.card, .num, .seg, .chip, table.data)

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
