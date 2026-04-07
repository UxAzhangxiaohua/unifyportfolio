# UnifyPortfolio

Multi-exchange trading portfolio dashboard.
Exchanges: IBKR (stocks/ETFs), Hyperliquid (perps/spot), Binance (spot/perps/futures), OKX (spot/perps/futures).

## Architecture
- Backend: backend/ (Fastify, Node 22, TypeScript, port 3001)
- Frontend: frontend/ (Vite, React 18, Tailwind, port 8188)

## Key files
- backend/src/connectors/ — one file per exchange
- backend/src/types.ts — all shared TypeScript interfaces
- backend/src/config.ts — loads accounts.json
- backend/src/scheduler.ts — staggered per-exchange polling
- backend/src/cache.ts — in-memory TTL cache
- accounts.json — multi-account credentials (gitignored)

## Rules
- Never add order placement code
- All API keys are read-only
- IBKR uses Flex Query HTTP polling (not OAuth, not TWS)
- Keep each connector isolated; errors in one must not affect others
- No database; in-memory cache only
- Frontend port: 8188, Backend port: 3001
- USDT ≈ USD for display purposes
