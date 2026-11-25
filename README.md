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

## Features

- **Overview** — total equity, per-account equity, stablecoins by wallet (trading / funding / earn), perps, options (greeks, exit calculator), MT5 CFD positions with SL/TP
- **Equity curve** — 1H … ALL, total or trading-wallets only. Samples every 30 s, persisted every 30 min. Internal transfers between your accounts are bridged so they don't show as a dip. Before recording started the curve is reconstructed (grey): Hyperliquid from its own account-value history, other accounts walked back from closed trades + stablecoin deposits/withdrawals (≈ 90 days)
- **Closed trades** — from each venue's own history (Bybit, Binance incl. options, OKX, Hyperliquid, Bitget, MT5 deals), split into XAU / Stock / Crypto / Option with PnL, win rate, payoff ratio, profit factor and per-instrument stats for 24H / 3D / 7D / 30D / All
- **Deposits, withdrawals and cash-outs** — recent transfers with in-transit tracking, and all withdrawals to your own cash-out address(es)
- **MCP server** — read-only interface so Claude can analyse the portfolio (see below)
- **Margin alerts** — Discord alerts for CFD margin levels

## Architecture

| Layer    | Stack                          | Port |
|----------|--------------------------------|------|
| Backend  | Fastify, Node 22, TypeScript   | 8189 |
| Frontend | Vite, React 18, Tailwind CSS   | 8188 |

- One connector per exchange (`backend/src/connectors/`)
- Staggered per-exchange polling scheduler
- In-memory TTL cache; SQLite (`data/history.db`) for equity history, deposit/withdrawal records and closed trades
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

### Deposits, transfers and cash-outs

```json
"payoutAddresses": ["0x..."],
"transferSources": { "0x...": "mt5-main" }
```

- `payoutAddresses` — your own cash-out address(es). Withdrawals there are listed under 出金记录 / Cash-outs and are never treated as transfers between your accounts.
- `transferSources` — on-chain sender address → account id, for accounts that don't report their own withdrawals (MT5): a deposit from that address counts as an internal transfer.
- Keep real addresses only in `accounts.json` (gitignored).

## MCP server (Claude)

The backend serves a read-only [MCP](https://modelcontextprotocol.io) server so Claude can read the portfolio and, together with the TradingView MCP, analyse trades against price action. Enable it with a random token (at least 16 characters):

```json
"mcp": { "token": "a-long-random-string" }
```

Endpoint: `POST /api/mcp/<token>` (Streamable HTTP, stateless). Without a token configured the route answers 404. The token is the only access control — anyone with the URL can read your positions and trades, so keep it private.

- **Claude Code** (same machine):
  ```bash
  claude mcp add --transport http --scope user unify-portfolio http://127.0.0.1:8189/api/mcp/<token>
  ```
- **claude.ai** (web / desktop): Settings → Connectors → Add custom connector, URL `https://<your domain>/api/mcp/<token>` (through the frontend, which proxies `/api/*`), no authentication.

| Tool | Returns |
|------|---------|
| `get_portfolio` | Total equity; per account equity, trading equity, unrealized PnL, margin, stablecoins by wallet, MT5 margin state |
| `get_positions` | Open positions (perps, options, CFDs, optionally spot) with entry / mark, notional, PnL, leverage, liquidation, funding, TP/SL |
| `get_closed_trades` | Closed trades filtered by time, category, symbol, account, side — with a summary |
| `get_trade_stats` | Win rate, payoff, profit factor, expectancy, holding time — grouped by category / instrument / account / side / weekday / hour / day / holding time (any time zone) |
| `get_equity_history` | Equity curve (reconstructed part flagged) |
| `get_performance` | Period changes and max drawdown |
| `get_transfers` | Recent deposits / withdrawals and all cash-outs |

Trades and positions carry `tvSymbol`, a TradingView `EXCHANGE:TICKER` hint (e.g. `OANDA:XAUUSD`, `PEPPERSTONE:NAS100`, `BYBIT:BTCUSDT.P`), so Claude can fetch the candles around an entry or exit. Times are UTC. Credentials, the MT5 login / server and wallet addresses are never returned.

Example prompt: *"Use unify-portfolio to find my 5 worst XAU trades this month, then pull 15-minute candles around each from TradingView — did I chase the move or close too early?"*

## Development workflow

- `main` is what runs in production; `dev` is where work happens (a separate worktree, e.g. `git worktree add ../unifyportfolio-dev dev`).
- Test a dev build beside production: `scripts/dev.sh start` in the dev worktree (loopback ports 8288 / 8289, production `accounts.json`, a copy of the history DB, alerts off); `scripts/dev.sh stop` afterwards.
- Release: merge `dev` into `main` (`git merge --no-ff dev`), build, `pm2 restart unify-backend unify-frontend`.

## Notes

- USDT ≈ USD for display purposes
- IBKR uses Flex Query HTTP polling (not OAuth, not TWS)
- Errors in one connector do not affect others
- Read-only by design: no order placement anywhere (the MT5 helper never trades)
