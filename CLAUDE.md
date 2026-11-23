# UnifyPortfolio

Multi-exchange trading portfolio dashboard.
Exchanges: IBKR (stocks/ETFs), Hyperliquid (perps/spot), Binance (spot/perps/futures), OKX (spot/perps/futures).
Also Bybit (V5 unified account: spot + linear perps + options; TradFi/MT5 CFD account equity via /v5/asset/asset-overview — equity only, no CFD positions) and Bitget (V2 classic account: spot + USDT/USDC-M futures + Earn; Unified (UTA) accounts auto-detected via 40085 → V3 API, Earn via /api/v3/earn/savings/assets (V2 earn rejects UTA keys) + /api/v3/earn/sharkfin/assets; CFD/TradFi via /api/v3/cfd/account/fund-detail + /api/v3/cfd/trade/current-positions → assetClass 'cfd'. CFD position field names unverified — connector logs the first raw row per symbol).
Also MT5 (any broker, `exchange: "mt5"`, investor/read-only password): see MT5 below.
IBKR is currently disabled (`"enabled": false` in accounts.json) — set to true / remove the flag to re-enable.

## Architecture
- Backend: backend/ (Fastify, Node 22, TypeScript, port 8189)
- Frontend: frontend/ (Vite dev / serve.cjs prod, React 18, Tailwind, port 8188)
- Deployment: PM2 via ecosystem.config.cjs (two processes: unify-backend, unify-frontend)
- Cloudflare Tunnel: <public domain> → localhost:8188 (never write the real domain into the repo; Vite dev reads extra hosts from `ALLOWED_HOSTS`)

## Deployment
- `frontend/serve.cjs` — lightweight Node HTTP server for production: serves static files from `frontend/dist/`, proxies `/api/*` to `http://127.0.0.1:8189`, SPA fallback
- `ecosystem.config.cjs` — PM2 config with two apps: unify-backend (port 8189), unify-frontend (port 8188)
- Build: `cd backend && npm run build` then `cd frontend && npm run build`
- Deploy: `pm2 restart unify-backend unify-frontend` (NOT `pm2 restart all` — the same PM2 also runs unrelated sites and a Discord bot)

## Backend key files
- backend/src/index.ts — Fastify server, API routes (/api/health, /api/portfolio, /api/history, /api/metrics, /api/trades, /api/transfers, /api/portfolio/:accountId)
- backend/src/connectors/ — one file per exchange (base.ts, binance.ts, okx.ts, hyperliquid.ts, ibkr.ts, bybit.ts, bitget.ts, mt5.ts)
- backend/src/types.ts — all shared TypeScript interfaces (Position, AccountSnapshot, StableBalance, OptionDetails, PortfolioResponse, ClosedTrade)
- Each AccountSnapshot carries `stables` (USDT/USDC by location: trading / funding / earn) and optional `warnings` (non-fatal sub-request failures, e.g. earn endpoint not permitted). Use `this.sticky()` (BaseConnector) for non-critical sub-requests: on failure it serves the last good result for up to 15 min (with a warning) so a transient error doesn't make equity dip or positions look closed (fake trades); `quiet=true` for products often not enabled
- Options use assetClass 'option' + `option` details; `parseOptionSymbol()` in base.ts handles OKX/Binance/Bybit symbol formats
- cache.ts: an error snapshot never overwrites last good data (error is attached instead) and never triggers trade tracking
- `MOCK=1` env forces mock data (for UI previews)
- backend/src/config.ts — loads accounts.json
- backend/src/scheduler.ts — staggered per-exchange polling, creates connectors, calls cacheSet
- backend/src/cache.ts — in-memory TTL cache (stale-while-revalidate), also triggers trade tracking on each cacheSet
- backend/src/history.ts — 30s in-memory ring buffer (25k points) + long-term points persisted every 30 min to SQLite (backend/src/db.ts, node:sqlite, file data/history.db, gitignored; override with HISTORY_DB). Sampler waits until all accounts reported before recording; an account still missing after 3 min is carried forward at its last recorded equity (never dropped from the total). Sharpe uses session 30s samples; drawdown/period changes use persisted + session series. Each point also stores `off` = per-account earn + funding stables (SQLite column `off`, added via ALTER TABLE; old rows lack it). `/api/history?scope=trading` returns equity − off (raw, no transit lift; only points that have `off`) — EquityChart's 总权益 / 交易账户 toggle (localStorage `unify.chartScope`)
- backend/src/transfers.ts — internal-transfer bridging. Each connector implements `fetchFlows(since)` (stablecoin deposits/withdrawals; verified live on Binance/OKX/Bybit/Bitget UTA/Hyperliquid), polled together with fetch() in scheduler.ts. A withdrawal is paired with a deposit at another tracked account (txId, else coin + amount within fee tolerance, ≤48h); the total is lifted by the in-transit amount between the *observed* debit and credit. Unpaired withdrawals to a known own address (any address we've received deposits at, or the HL wallet) count as in transit ≤24h, otherwise external. Raw equity is persisted; the adjustment is applied when history/metrics are read (so later pairings fix the past curve). Flows persist in SQLite table fund_flows. Per-account history stays raw
- Funding: perps carry `fundingPnl` (since open, + received / − paid), `fundingRate`, `fundingIntervalH`, `nextFundingTime`, `nextFunding` (est. next payment = −side × notional × rate, via `applyFunding()` in base.ts; public rates cached 60s by `cachedPublic()`). Since-open sources: Bybit = sum of SETTLEMENT rows in /v5/account/transaction-log after max(createdTime, last flat entry) — in-memory ledger, 30d back-fill, refreshed every 5 min (verified = curRealisedPnl); HL = −cumFunding.sinceOpen; OKX = position fundingFee; Binance/Bitget = rate + next only (no since-open)
- backend/src/trades.ts — position-diff trade detection: compares snapshots to detect closed/reduced positions, records as ClosedTrade (up to 500 trades in memory). Positions are first aggregated per symbol + side (MT5 hedging accounts hold several orders per key; entry = qty-weighted avg). CFD PnL is scaled by units per lot (notional ÷ (lots × price)), since CFD quantity is in lots
- accounts.json — multi-account credentials (gitignored); accounts with placeholder creds ("YOUR_...") or `"enabled": false` are skipped at startup

## Frontend key files
- frontend/src/App.tsx — main layout: Header → KpiRow → AccountsGrid → StablesPanel → PositionsTable (perps/futures) → OptionsTable → OptionExitCalculator (target-price BS estimate + suggested closing limit; lib/bs.ts) → EquityChart + MetricsRow → TransfersPanel (deposits/withdrawals, in-transit; total tile shows "含转账在途") → OtherHoldings (spot/stocks, collapsed) → TradesHistory
- UI is bilingual (中 / EN toggle in Header, saved in localStorage `unify.lang`). Write every UI string as `tr('中文', 'English')` from lib/i18n.ts; use `locale()` for Date formatting. App calls `useLang()` so a switch re-renders the tree — don't React.memo components that render text. User focus: derivatives + stablecoins (incl. earn); spot is secondary
- Perp exposure: frontend/src/lib/exposure.ts — `LEVERAGED_ETFS` (SOXL/SOXS/TQQQ/SQQQ/SNXX/MUU/KORU with signed factor); exposure = |notional| × |factor|, direction flips for inverse funds (short SOXS = long). `baseSymbol()` normalizes venue symbols. PositionsTable has 按账户 / 按仓位 views (account header: equity, margin, long/short/net, actual lev = gross exposure ÷ trading equity — `tradingEquity()` = equity − earn/funding stables − CFD sub-accounts); KpiRow exposure tile uses the same helper. `Position.margin` = venue initial margin (Bybit positionIM, OKX imr/margin, Binance account positions[].initialMargin, Bitget marginSize, HL marginUsed); UI falls back to notional ÷ leverage (shown with ≈)
- CFD accounts carry `AccountSnapshot.cfd: CfdAccountState[]` (margin level, leverage setting, actual leverage = Σ notional / equity); positions use assetClass 'cfd' and render only in CfdPanel (after PositionsTable), not in PositionsTable. CfdPanel: no margin-call / stop-out risk display (the user exits via TP/SL); cards show "if all TP / SL hit" totals (Position.tp/sl/tpPnl/slPnl, MT5 only). Position table groups account + symbol + side into a collapsed summary row (Σ lots, lot-weighted avg entry, Σ PnL, ×N chip; `*` = some orders lack TP/SL); click ▸ or "全部展开" to show the single orders
- AccountsGrid: MT5 (CFD-only) cards show Stables + Margin and "持仓 N · X 手" instead of Earn and Perps/Options counts; other cards add a CFD count when they hold CFD positions. Folds accounts with |equity| < $10 behind a "显示 N 个…" toggle (localStorage `unify.foldSmallAccounts`); accounts in error are never folded
- frontend/src/components/ — ui.tsx (shared primitives), Header, KpiRow, AccountsGrid, StablesPanel, PositionsTable, CfdPanel, OptionsTable, OtherHoldings, EquityChart (lightweight-charts v5), MetricsRow, TradesHistory
- frontend/src/lib/format.ts (number/time formatters), lib/exchanges.ts (exchange names/colors/order)
- frontend/src/hooks/usePortfolio.ts — React Query hooks: usePortfolio (15s), useHistory (30s), useMetrics (30s), useTrades (30s)
- frontend/src/lib/api.ts — fetch functions for all API endpoints
- frontend/src/types.ts — frontend type definitions mirroring backend types
- frontend/src/index.css — Tailwind v4 @theme tokens + shared classes (.card, .num, .seg, .chip, table.data)

## MT5
- `mt5bridge/` — tiny Go helper (`mt5snap`, built on github.com/voorz/mtapi, pinned in go.mod). Build: `cd mt5bridge && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o bin/mt5snap .` (bin/ is gitignored; override path with `MT5SNAP_BIN`)
- backend/src/connectors/mt5.ts spawns it once per poll (`mt5PollIntervalSeconds`, default 60): credentials go over stdin, it logs in fresh (long MT5 web sessions freeze position data on some brokers), prints a USD JSON snapshot and exits. Never trades — keep it that way. Privacy: the page is public behind the tunnel — the MT5 account number and server name must never reach the API/page (CfdAccountState.name is just 'MT5' and is not rendered for mt5)
- Docker: backend/Dockerfile does not build or ship mt5snap yet — MT5 works under PM2 only
- accounts.json entry: `{"id","exchange":"mt5","label","credentials":{"login","password","server","host?"},"marginCallLevel?","stopOutLevel?"}` — call/stop-out levels aren't exposed by the protocol, set them per account if you want the buffer tiles
- Account balance (excl. floating PnL and credit) is reported as a USDT `trading` stable (USD ≈ USDT, same as Bitget CFD), so it counts in the stables totals
- Snapshot errors shown on the page are fixed messages (publicError in mt5.ts); raw mtapi text can quote the server name and only goes to the server log
- Output → `AccountSnapshot.cfd[0]` + positions with assetClass 'cfd' (rendered in CfdPanel). Notional = lots × contract size × price, converted via symbol-name currencies (non-pair symbols like US30 assumed USD-quoted). If the server reports margin 0 (Exness), margin = Σ notional ÷ leverage, flagged `marginEstimated` (shown with ≈). USC (cent) accounts are ÷100. Positions carry `sl`/`tp` (null = unset) and `tpPnl`/`slPnl` = Δprice × lots × contract size → USD at the current FX rate, excl. swap/commission

## Alerts
- backend/src/alerts.ts — CFD margin-level alerts to a Discord webhook (`alerts.discordWebhook` + `alerts.marginLevels`, default [150,100,80], in accounts.json). Fires when an account drops into a worse tier (lowest tier pings @here); improving needs +5 pts past the line (hysteresis); one all-clear when back above the top line. Called from scheduler after cacheSet; state in memory (restart re-alerts an account already below a line); a failed webhook send rolls the tier back so the next poll retries. MT5 Exness margin is estimated (notional ÷ leverage), so its margin level is too

## Charting
- Uses lightweight-charts v5 (TradingView) — v5 API: `chart.addSeries(AreaSeries, options)` NOT the old `chart.addAreaSeries()`
- Import: `import { createChart, AreaSeries, type IChartApi, type ISeriesApi, ColorType, LineType, type UTCTimestamp } from 'lightweight-charts'`

## Rules
- Never add order placement code
- All API keys are read-only
- IBKR uses Flex Query HTTP polling (not OAuth, not TWS)
- Keep each connector isolated; errors in one must not affect others
- Only persistence: SQLite equity history (30-min points) + fund_flows (deposit/withdrawal records for transfer bridging). Snapshot cache and trades stay in memory (reset on restart)
- Frontend port: 8188, Backend port: 8189 (do NOT change these)
- USDT ≈ USD for display purposes
