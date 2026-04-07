# UnifyPortfolio

Multi-exchange trading portfolio dashboard that aggregates positions and balances across multiple exchanges into a single view.

## Supported Exchanges

- **IBKR** — Stocks, ETFs (via Flex Query)
- **Hyperliquid** — Perpetuals, Spot
- **Binance** — Spot, Perpetuals, Futures
- **OKX** — Spot, Perpetuals, Futures

## Architecture

| Layer    | Stack                          | Port |
|----------|--------------------------------|------|
| Backend  | Fastify, Node 22, TypeScript   | 8189 |
| Frontend | Vite, React 18, Tailwind CSS   | 8188 |

- One connector per exchange (`backend/src/connectors/`)
- Staggered per-exchange polling scheduler
- In-memory TTL cache (no database)
- All API keys are **read-only** — no order placement

## Getting Started

### Prerequisites

- Node.js 22+
- npm

### Setup

```bash
# Install dependencies
npm install

# Copy and configure credentials
cp accounts.example.json accounts.json
# Edit accounts.json with your read-only API keys

# Start backend
cd backend && npm run dev

# Start frontend (in another terminal)
cd frontend && npm run dev
```

The frontend will be available at `http://localhost:8188` and the backend API at `http://localhost:8189`.

## Configuration

Account credentials are stored in `accounts.json` (gitignored). Each account entry specifies the exchange, a label, and the required credentials for that exchange.

## Notes

- USDT ≈ USD for display purposes
- IBKR uses Flex Query HTTP polling (not OAuth, not TWS)
- Errors in one connector do not affect others
