import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { cacheGetAll } from './cache.js';
import { historyGet, metricsGet } from './history.js';
import { tradesGet } from './trades.js';
import { payoutsGet, transfersGet, transitAt } from './transfers.js';
import type { AccountSnapshot, ClosedTrade, ExchangeType, Position, TradeCategory } from './types.js';

// Read-only MCP server (Streamable HTTP, stateless) over the same data as the dashboard, so Claude
// can analyse the user's trading next to other MCP servers (e.g. TradingView for price data).
//
// Mounted at POST /api/mcp/<token> (accounts.json `mcp.token`; disabled without one). The path is
// reachable through the public tunnel, so the token is the only access control: keep it secret.
// Never exposes credentials, the MT5 login / server, or wallet / payout addresses.

const r2 = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });

// ---------------------------------------------------------------------------------------------
// TradingView symbol hints (best effort; resolve with TradingView's search-symbols if one fails)

const MT5_TV: Record<string, string> = {
  XAUUSD: 'OANDA:XAUUSD', XAGUSD: 'OANDA:XAGUSD', USTEC: 'PEPPERSTONE:NAS100', NAS100: 'PEPPERSTONE:NAS100', US100: 'PEPPERSTONE:NAS100',
  US500: 'PEPPERSTONE:US500', SPX500: 'PEPPERSTONE:US500', US30: 'PEPPERSTONE:US30', DE30: 'PEPPERSTONE:GER40', DE40: 'PEPPERSTONE:GER40',
  GER40: 'PEPPERSTONE:GER40', UK100: 'PEPPERSTONE:UK100', JP225: 'PEPPERSTONE:JPN225', HK50: 'PEPPERSTONE:HK50', USOIL: 'TVC:USOIL', UKOIL: 'TVC:UKOIL',
  BTCUSD: 'BITSTAMP:BTCUSD', ETHUSD: 'BITSTAMP:ETHUSD',
};
const FX = /^(USD|EUR|GBP|JPY|CHF|AUD|NZD|CAD){2}$/;

export function tvSymbol(exchange: ExchangeType, symbol: string, assetClass?: string): string | null {
  if (assetClass === 'option') return null;
  const s = symbol.toUpperCase();
  switch (exchange) {
    case 'mt5': {
      const root = symbol.replace(/\.[A-Za-z0-9]+$/, '').replace(/[a-z]+$/, '').toUpperCase();
      return MT5_TV[root] ?? (FX.test(root) && root.length === 6 ? `OANDA:${root}` : null);
    }
    case 'bybit': return /USDT$|USDC$|PERP$/.test(s) ? `BYBIT:${s.replace(/PERP$/, 'USDC')}.P` : null;
    case 'binance': return /USDT$|USDC$/.test(s) ? `BINANCE:${s}.P` : null;
    case 'bitget': return /USDT$|USDC$/.test(s) ? `BITGET:${s}.P` : null;
    case 'okx': {
      const m = s.match(/^([A-Z0-9]+)-(USDT|USDC|USD)-SWAP$/);
      return m ? `OKX:${m[1]}${m[2]}.P` : null;
    }
    case 'hyperliquid':
      // HIP-3 dex assets (xyz:NVDA) have no direct TradingView listing
      // TradingView keeps the k of ×1000 coins (kPEPE → KPEPEUSDC.P), so the name is used as is
      return /:/.test(symbol) ? null : `HYPERLIQUID:${s}USDC.P`;
    default: return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Trades

function instrumentKey(t: ClosedTrade): string {
  if (t.exchange === 'mt5') return t.symbol.replace(/\.[A-Za-z0-9]+$/, '').replace(/[a-z]+$/, '') || t.symbol;
  let s = t.symbol.toUpperCase().replace(/^[A-Z0-9]+:/, '');
  s = s.replace(/-(USDT|USDC|USD)-SWAP$/, '').replace(/[-_]?(USDT|USDC|USD)?[-_]?PERP$/, '');
  const dated = s.match(/^(.*?)[-_]?(USDT|USDC|USD)?[-_](\d{6}|\d{1,2}[A-Z]{3}\d{2})$/);
  if (dated) return `${dated[1].replace(/[-_]/g, '')}-${dated[3]}`;
  return s.replace(/[-_]?(USDT|USDC|USD)$/, '').replace(/[-_]/g, '') || t.symbol;
}

function summarize(list: ClosedTrade[]) {
  let wins = 0, losses = 0, gw = 0, gl = 0, fees = 0, hold = 0, holdN = 0;
  let best: ClosedTrade | null = null, worst: ClosedTrade | null = null;
  for (const t of list) {
    if (t.realizedPnl > 0) { wins++; gw += t.realizedPnl; } else if (t.realizedPnl < 0) { losses++; gl += t.realizedPnl; }
    fees += t.fees ?? 0;
    if (t.durationSeconds != null) { hold += t.durationSeconds; holdN++; }
    if (!best || t.realizedPnl > best.realizedPnl) best = t;
    if (!worst || t.realizedPnl < worst.realizedPnl) worst = t;
  }
  const n = list.length, decided = wins + losses;
  const avgWin = wins ? gw / wins : null, avgLoss = losses ? gl / losses : null;
  return {
    trades: n, wins, losses,
    winRatePct: decided ? r2((wins / decided) * 100, 1) : null,
    pnl: r2(gw + gl), grossWin: r2(gw), grossLoss: r2(gl),
    avgWin: r2(avgWin), avgLoss: r2(avgLoss),
    payoffRatio: avgWin != null && avgLoss ? r2(avgWin / Math.abs(avgLoss)) : null,
    profitFactor: gl ? r2(gw / Math.abs(gl)) : null,
    expectancy: n ? r2((gw + gl) / n) : null,
    fees: r2(fees),
    avgHoldMinutes: holdN ? r2(hold / holdN / 60, 1) : null,
    best: best ? { symbol: best.symbol, pnl: r2(best.realizedPnl), exitTime: best.exitTime } : null,
    worst: worst ? { symbol: worst.symbol, pnl: r2(worst.realizedPnl), exitTime: worst.exitTime } : null,
  };
}

const CATEGORIES = ['xau', 'stock', 'crypto', 'option'] as const;

const tradeFilter = {
  days: z.number().positive().optional().describe('Trades closed in the last N days (default 30). Ignored when `since` is given'),
  since: z.string().optional().describe('ISO time, inclusive (e.g. 2026-11-01 or 2026-11-01T08:00:00Z)'),
  until: z.string().optional().describe('ISO time, exclusive'),
  category: z.enum(CATEGORIES).optional().describe('xau = gold (and other commodities / FX), stock = stocks / ETFs / index CFDs (NAS100, USTEC…), crypto, option'),
  symbol: z.string().optional().describe('Case-insensitive match on the symbol or instrument (e.g. XAUUSD, BTC, NAS100)'),
  account: z.string().optional().describe('Account id or label (see get_portfolio)'),
  side: z.enum(['long', 'short']).optional(),
};
type TradeFilter = { days?: number; since?: string; until?: string; category?: TradeCategory; symbol?: string; account?: string; side?: 'long' | 'short' };

function labelMap(): Map<string, string> {
  return new Map(cacheGetAll().map((a) => [a.accountId, a.label]));
}

function filterTrades(f: TradeFilter): { list: ClosedTrade[]; from: string; to: string } {
  const now = Date.now();
  const from = f.since ? Date.parse(f.since) : now - (f.days ?? 30) * 86_400_000;
  const to = f.until ? Date.parse(f.until) : Infinity;
  if (!Number.isFinite(from) || Number.isNaN(to)) throw new Error('since / until must be ISO dates');
  const labels = labelMap();
  const acct = f.account?.toLowerCase();
  const sym = f.symbol?.toUpperCase().replace(/[-_/]/g, '');
  const list = tradesGet().trades.filter((t) => {
    const x = Date.parse(t.exitTime);
    if (x < from || x >= to) return false;
    if (f.category && (t.category ?? 'crypto') !== f.category) return false;
    if (f.side && t.side !== f.side) return false;
    if (acct && t.accountId.toLowerCase() !== acct && (labels.get(t.accountId) ?? '').toLowerCase() !== acct) return false;
    if (sym && !t.symbol.toUpperCase().replace(/[-_/]/g, '').includes(sym) && !instrumentKey(t).toUpperCase().includes(sym)) return false;
    return true;
  });
  return { list, from: new Date(from).toISOString(), to: Number.isFinite(to) ? new Date(to).toISOString() : new Date(now).toISOString() };
}

function tradeView(t: ClosedTrade, labels: Map<string, string>) {
  return {
    id: t.id,
    account: labels.get(t.accountId) ?? t.accountId,
    exchange: t.exchange,
    symbol: t.symbol,
    instrument: instrumentKey(t),
    tvSymbol: tvSymbol(t.exchange, t.symbol, t.category === 'option' ? 'option' : undefined),
    category: t.category ?? 'crypto',
    side: t.side,
    quantity: t.quantity,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    entryTime: t.entryTime,
    exitTime: t.exitTime,
    holdMinutes: t.durationSeconds != null ? r2(t.durationSeconds / 60, 1) : null,
    pnl: r2(t.realizedPnl),
    fees: r2(t.fees ?? null),
    source: t.source ?? 'venue',
  };
}

function groupKey(t: ClosedTrade, by: string, tz: string, labels: Map<string, string>): string {
  const d = new Date(t.exitTime);
  switch (by) {
    case 'category': return t.category ?? 'crypto';
    case 'instrument': return instrumentKey(t);
    case 'account': return labels.get(t.accountId) ?? t.accountId;
    case 'side': return t.side;
    case 'weekday': return d.toLocaleDateString('en-US', { weekday: 'short', timeZone: tz });
    case 'hour': return d.toLocaleTimeString('en-GB', { hour: '2-digit', hour12: false, timeZone: tz }).slice(0, 2);
    case 'day': return d.toLocaleDateString('en-CA', { timeZone: tz });
    case 'holding_time': {
      const m = t.durationSeconds == null ? null : t.durationSeconds / 60;
      return m == null ? 'unknown' : m < 5 ? '<5m' : m < 30 ? '5-30m' : m < 120 ? '30m-2h' : m < 720 ? '2-12h' : m < 2880 ? '12-48h' : '>48h';
    }
    default: return 'all';
  }
}

// ---------------------------------------------------------------------------------------------
// Portfolio

const offTrading = (a: AccountSnapshot) => (a.stables ?? []).filter((s) => s.location !== 'trading').reduce((s, b) => s + b.amount, 0);

function positionView(a: AccountSnapshot, p: Position) {
  return {
    account: a.label,
    exchange: a.exchange,
    symbol: p.symbol,
    tvSymbol: tvSymbol(a.exchange, p.symbol, p.assetClass),
    assetClass: p.assetClass,
    side: p.side,
    quantity: p.quantity,
    entryPrice: p.avgPrice,
    markPrice: p.currentPrice,
    notionalUsd: r2(p.marketValue),
    unrealizedPnl: r2(p.unrealizedPnl),
    leverage: p.leverage,
    marginUsd: r2(p.margin ?? null),
    liquidationPrice: p.liquidationPrice,
    ...(p.tp != null || p.sl != null ? { tp: p.tp ?? null, sl: p.sl ?? null, pnlAtTp: r2(p.tpPnl ?? null), pnlAtSl: r2(p.slPnl ?? null) } : {}),
    ...(p.fundingRate != null ? { fundingRate: p.fundingRate, fundingIntervalH: p.fundingIntervalH ?? null, fundingPnlSinceOpen: r2(p.fundingPnl ?? null), nextFundingUsd: r2(p.nextFunding ?? null) } : {}),
    ...(p.option ? { option: p.option } : {}),
  };
}

// ---------------------------------------------------------------------------------------------

function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'unify-portfolio', version: '1.0.0' },
    {
      instructions:
        "Read-only view of the user's multi-exchange trading portfolio (Binance, Bybit, OKX, Bitget, Hyperliquid, MT5 CFD). " +
        'All money values are USD (USDT ≈ USD). Times are ISO UTC. Trades and positions carry `tvSymbol`, a TradingView ' +
        'EXCHANGE:TICKER hint, so price action around an entry / exit can be pulled from a TradingView MCP (get-ohlcv) — ' +
        'if a hint fails, resolve it with TradingView search-symbols. Categories: xau (gold), stock (stocks + index CFDs ' +
        'like NAS100 / USTEC), crypto, option. Equity history before the first recorded sample is a reconstruction (flagged).',
    },
  );

  server.registerTool('get_portfolio', {
    title: 'Portfolio overview',
    description: 'Total equity, funds in transit, and per account: equity, trading equity (excl. earn / funding wallets), unrealized PnL, margin, stablecoins by wallet, CFD margin state, position counts and errors.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    const accounts = cacheGetAll();
    const inTransit = transitAt(Date.now());
    return json({
      asOf: new Date().toISOString(),
      totalEquity: r2(accounts.reduce((s, a) => s + a.equity, 0) + inTransit),
      inTransit: r2(inTransit),
      totalUnrealizedPnl: r2(accounts.reduce((s, a) => s + a.unrealizedPnl, 0)),
      accounts: [...accounts].sort((a, b) => b.equity - a.equity).map((a) => {
        const stables: Record<string, number> = {};
        for (const s of a.stables ?? []) stables[s.location] = r2((stables[s.location] ?? 0) + s.amount)!;
        const cfd = (a.cfd ?? [])[0];
        return {
          id: a.accountId, label: a.label, exchange: a.exchange,
          equity: r2(a.equity),
          tradingEquity: r2(a.equity - offTrading(a)),
          unrealizedPnl: r2(a.unrealizedPnl),
          marginUsed: r2(a.marginUsed),
          stablesByWallet: stables,
          positions: a.positions.length,
          ...(cfd ? { cfd: { balance: r2(cfd.balance), equity: r2(cfd.equity), floatingPnl: r2(cfd.floatingPnl), usedMargin: r2(cfd.usedMargin), marginLevelPct: r2(cfd.marginLevel), leverageSetting: cfd.leverage, effectiveLeverage: r2(cfd.effectiveLeverage), marginEstimated: !!cfd.marginEstimated } } : {}),
          ...(a.error ? { error: a.error } : {}),
          fetchedAt: a.fetchedAt,
        };
      }),
    });
  });

  server.registerTool('get_positions', {
    title: 'Open positions',
    description: 'Open positions across all accounts: perps / futures, options (with greeks), MT5 CFDs (with TP / SL and PnL at TP / SL), optionally spot. Includes entry, mark, notional, unrealized PnL, leverage, margin, liquidation price, funding.',
    inputSchema: {
      asset_class: z.enum(['derivatives', 'perp', 'option', 'cfd', 'spot', 'all']).optional().describe('Default derivatives (perps, futures, options, CFDs)'),
      account: z.string().optional().describe('Account id or label'),
      symbol: z.string().optional().describe('Case-insensitive substring of the symbol'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ asset_class = 'derivatives', account, symbol }) => {
    const want = (p: Position) => {
      const c = p.assetClass;
      switch (asset_class) {
        case 'perp': return c === 'crypto-perp' || c === 'crypto-future';
        case 'option': return c === 'option';
        case 'cfd': return c === 'cfd';
        case 'spot': return c === 'crypto-spot' || c === 'stock' || c === 'etf';
        case 'all': return true;
        default: return c === 'crypto-perp' || c === 'crypto-future' || c === 'option' || c === 'cfd';
      }
    };
    const acct = account?.toLowerCase();
    const sym = symbol?.toUpperCase();
    const out = [];
    for (const a of cacheGetAll()) {
      if (acct && a.accountId.toLowerCase() !== acct && a.label.toLowerCase() !== acct) continue;
      for (const p of a.positions) {
        if (!want(p) || (sym && !p.symbol.toUpperCase().includes(sym))) continue;
        out.push(positionView(a, p));
      }
    }
    out.sort((x, y) => (y.notionalUsd ?? 0) - (x.notionalUsd ?? 0));
    return json({ asOf: new Date().toISOString(), count: out.length, positions: out });
  });

  server.registerTool('get_closed_trades', {
    title: 'Closed trades',
    description: 'Closed trades from the venues\' own histories (exact; MT5 from broker deals), newest first, with entry / exit price and time, holding time, net PnL (fees included) and a summary of the selection. Kept for ~90 days back from when each venue was connected.',
    inputSchema: { ...tradeFilter, limit: z.number().int().positive().max(2000).optional().describe('Max trades returned (default 200); the summary covers all matches') },
    annotations: { readOnlyHint: true },
  }, async ({ limit = 200, ...f }) => {
    const { list, from, to } = filterTrades(f);
    const labels = labelMap();
    return json({ from, to, summary: summarize(list), returned: Math.min(limit, list.length), trades: list.slice(0, limit).map((t) => tradeView(t, labels)) });
  });

  server.registerTool('get_trade_stats', {
    title: 'Trade statistics',
    description: 'Win rate, PnL, payoff ratio, profit factor, expectancy, average holding time, best / worst trade — overall and grouped (by category, instrument, account, side, weekday, hour of day, day, or holding-time bucket).',
    inputSchema: {
      ...tradeFilter,
      group_by: z.enum(['category', 'instrument', 'account', 'side', 'weekday', 'hour', 'day', 'holding_time']).optional().describe('Default category'),
      tz: z.string().optional().describe('IANA time zone for weekday / hour / day grouping (default UTC), e.g. Asia/Shanghai'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ group_by = 'category', tz = 'UTC', ...f }) => {
    try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { throw new Error(`Unknown time zone ${tz}`); }
    const { list, from, to } = filterTrades(f);
    const labels = labelMap();
    const groups = new Map<string, ClosedTrade[]>();
    for (const t of list) {
      const k = groupKey(t, group_by, tz, labels);
      groups.set(k, [...(groups.get(k) ?? []), t]);
    }
    const rows = [...groups.entries()].map(([key, ts]) => ({ key, ...summarize(ts) }));
    rows.sort((a, b) => ['weekday', 'hour', 'day', 'holding_time'].includes(group_by) ? a.key.localeCompare(b.key) : (b.pnl ?? 0) - (a.pnl ?? 0));
    return json({ from, to, groupBy: group_by, tz, overall: summarize(list), groups: rows });
  });

  server.registerTool('get_equity_history', {
    title: 'Equity curve',
    description: 'Equity over time (USD), downsampled. scope total = everything incl. earn / funding wallets (internal transfers bridged); trading = trading wallets only. Points before `reconstructedBefore` are estimates rebuilt from venue history / trades + deposits.',
    inputSchema: {
      period: z.enum(['1h', '4h', '24h', '1w', '30d', 'all']).optional().describe('Default 30d'),
      scope: z.enum(['total', 'trading']).optional(),
      account: z.string().optional().describe('Account id (see get_portfolio)'),
      max_points: z.number().int().positive().max(500).optional().describe('Default 150'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ period = '30d', scope = 'total', account, max_points = 150 }) => {
    const h = historyGet(period, account, scope);
    const step = Math.max(1, Math.ceil(h.points.length / max_points));
    const pts = h.points.filter((_, i) => i % step === 0 || i === h.points.length - 1);
    return json({
      period, scope, account: account ?? 'all',
      change: r2(h.pnl), changePct: r2(h.pnlPercent),
      ...(h.backfilledBefore ? { reconstructedBefore: new Date(h.backfilledBefore * 1000).toISOString() } : {}),
      points: pts.map((p) => ({ t: new Date(p.t * 1000).toISOString(), equity: r2(p.v) })),
    });
  });

  server.registerTool('get_performance', {
    title: 'Performance metrics',
    description: 'Current total equity, change over 1h / 4h / 24h / 1w / 30d, max drawdown (over the stored curve, incl. reconstruction; withdrawals count as drops) and a session Sharpe ratio.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => json(metricsGet()));

  server.registerTool('get_transfers', {
    title: 'Deposits, withdrawals, cash-outs',
    description: 'Stablecoin deposits / withdrawals of the last 14 days (internal transfers between the user\'s accounts are paired), plus all cash-outs to the user\'s own payout address.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    const t = transfersGet();
    const p = payoutsGet();
    return json({
      inTransit: r2(t.inTransit),
      transfers: t.transfers.map((x) => ({ ...x, startedAt: new Date(x.startedAt).toISOString(), arrivedAt: x.arrivedAt ? new Date(x.arrivedAt).toISOString() : null })),
      cashOuts: p.payouts.map((x) => ({ ...x, time: new Date(x.time).toISOString() })),
    });
  });

  return server;
}

/** Register POST /api/mcp/:token. No token configured → the route answers 404 */
export function registerMcp(app: FastifyInstance, token: string | undefined): void {
  const ok = (given: string) => {
    if (!token || token.length < 16) return false;
    const a = Buffer.from(given), b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  app.route<{ Params: { token: string } }>({
    method: ['GET', 'POST', 'DELETE'],
    url: '/api/mcp/:token',
    handler: async (req, reply) => {
      if (!ok(req.params.token)) return reply.status(404).send({ error: 'Not found' });
      if (req.method !== 'POST') {
        // Stateless server: no SSE stream / sessions
        return reply.status(405).header('Allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
      }
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      reply.hijack();
      reply.raw.on('close', () => { transport.close(); server.close(); });
      try {
        await server.connect(transport);
        await transport.handleRequest(req.raw, reply.raw, req.body);
      } catch (err) {
        req.log.error(err, 'mcp request failed');
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
          reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }));
        }
      }
    },
  });
}
