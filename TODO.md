# TODO

## Shelved: "My Trades" TradingView indicator (2026-11-25)

Show closed trades (entry ▲/▼, exit ●, dashed line, PnL tooltip) on TradingView's own charts for review.

- Code: branch `feature/tradingview-pine` (not merged into dev / main). `backend/src/pine.ts` generates a Pine v6
  script with the trades baked in; GET `/api/pine`; MCP tool `get_tradingview_pine`; "复制 TradingView 指标"
  button + TV↗ link per trade in TradesHistory; `tvSymbol` on `/api/trades`. Review fixes are committed on top.
- Matching is by underlying, not ticker (any XAUUSD / GOLD / XAUT chart shows the gold trades, any BTCUSDT.P the BTC
  trades; 1000PEPE / kPEPE scaled; index aliases only on non-crypto charts). Verified on TradingView 2026-11-25:
  the full script (536 trades, ~30 KB) compiles and runs; key matching checked on 6 charts. Not yet checked by
  eye on a real chart.
- A first version is already saved in the TradingView account as "My Trades" (static data as of 2026-11-25).

Why shelved: TradingView only replaces a saved script as a whole, so every update has to send the full code
(~30 KB, growing) through Claude: ~10k output tokens per daily run, and a digit copied wrong still compiles.

Before picking it up again, decide:
- [ ] One script, or split into "历史" (frozen, rolled monthly) + "近期" (daily, a few KB) to cut the daily cost ~90%
- [ ] Add a data checksum the script verifies itself (shows 数据校验失败) and the scheduled task checks after updating
- [ ] Skip the update on days without new trades; maybe a shorter window (`days`, default 365)
- [ ] Release to production (the connectors point at production), then a scheduled cloud task (`/schedule`) that
      calls `get_tradingview_pine` → TradingView `update_pine_script`. Local scheduled tasks can't be created from
      the SSH session.
