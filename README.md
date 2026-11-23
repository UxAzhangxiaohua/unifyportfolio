# UnifyPortfolio

Multi-exchange trading portfolio dashboard that aggregates positions and balances across multiple exchanges into a single view.

## Supported Exchanges

- **IBKR** — Stocks, ETFs (via Flex Query)
- **Hyperliquid** — Perpetuals, Spot
- **Binance** — Spot, Perpetuals, Futures
- **OKX** — Spot, Perpetuals, Futures
- **Bybit** — Spot, Perpetuals, Options (TradFi/MT5 sub-account: equity only)
- **Bitget** — Spot, USDT/USDC-M Futures, Earn, CFD (TradFi)
- **MT5** — any MetaTrader 5 broker, via the account's investor (read-only) password: equity, margin, leverage, CFD positions with SL/TP

## Architecture

| Layer    | Stack                          | Port |
|----------|--------------------------------|------|
| Backend  | Fastify, Node 22, TypeScript   | 8189 |
| Frontend | Vite, React 18, Tailwind CSS   | 8188 |

- One connector per exchange (`backend/src/connectors/`)
- Staggered per-exchange polling scheduler
- In-memory TTL cache; SQLite only for equity history and deposit/withdrawal records
- MT5 via a small Go helper (`mt5bridge/`, see below)
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

### Docker

```bash
# Copy and configure credentials
cp accounts.example.json accounts.json
# Edit accounts.json with your read-only API keys

# Build and start
docker compose up -d --build
```

Frontend at `http://localhost:8188`, backend API at `http://localhost:8189`.

### PM2 (Production)

```bash
cd backend && npm install && npm run build
cd ../frontend && npm install && npm run build
cd ../mt5bridge && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o bin/mt5snap .   # only if you track MT5 accounts
pm2 start ecosystem.config.cjs
```

To redeploy, restart the two apps by name (`pm2 restart unify-backend unify-frontend`) rather than `pm2 restart all` if the same PM2 runs other services.

## Configuration

Account credentials are stored in `accounts.json` (gitignored). Each account entry specifies the exchange, a label, and the required credentials for that exchange. See `accounts.example.json`.

### MT5 accounts

MT5 accounts are read with the account's **investor (read-only) password** through `mt5bridge/`, a small Go program built on [github.com/voorz/mtapi](https://github.com/voorz/mtapi) (pure Go, no MetaTrader terminal). Build it once (Go 1.23+):

```bash
cd mt5bridge && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o bin/mt5snap .
```

```json
{
  "id": "mt5-main",
  "exchange": "mt5",
  "label": "MT5 CFD",
  "credentials": { "login": "12345678", "password": "INVESTOR_PASSWORD", "server": "Broker-Server" }
}
```

- `server` is the server name shown in the MT5 terminal; optional `host` (`ip:port`) skips name resolution.
- Polled every `mt5PollIntervalSeconds` (default 60). Each poll is a fresh login: long-lived MT5 web sessions can keep serving stale positions.
- Shown in the CFD panel: equity, balance, floating PnL, margin, margin level, leverage setting, actual leverage (Σ notional ÷ equity), and each position's SL/TP with the projected PnL if they are hit. Orders on the same symbol and side are grouped (expand to see each order).
- Some brokers (e.g. Exness) don't report used margin over this protocol; it is then estimated as notional ÷ leverage and shown with `≈`.
- The account number and server name are not shown on the page.
- Docker images don't include the MT5 helper yet; use PM2 for MT5.

### Margin-level alerts (Discord)

```json
"alerts": {
  "discordWebhook": "https://discord.com/api/webhooks/...",
  "marginLevels": [150, 100, 80]
}
```

A CFD account whose margin level drops below a threshold posts one alert per threshold (the lowest pings `@here`), and one all-clear once it is back above the highest one. A threshold counts as recovered only 5 points above the line, so a level hovering around it doesn't spam.

## Notes

- USDT ≈ USD for display purposes
- IBKR uses Flex Query HTTP polling (not OAuth, not TWS)
- Errors in one connector do not affect others
- Read-only by design: no order placement anywhere (the MT5 helper never trades)
