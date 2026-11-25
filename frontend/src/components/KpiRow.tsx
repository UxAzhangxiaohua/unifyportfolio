import type { ReactNode } from 'react';
import type { AccountSnapshot, PortfolioResponse } from '../types';
import { fmtCompact, fmtSigned, fmtUSD, pnlClass } from '../lib/format';
import { EXCHANGES } from '../lib/exchanges';
import { tr } from '../lib/i18n';
import { fmtLev, isPerpLike } from '../lib/exposure';
import { dollarDelta, riskAccounts, riskEquity, sumGroup } from '../lib/risk';

export function Tile({ label, value, foot, children, hint }: { label: string; value: ReactNode; foot?: ReactNode; children?: ReactNode; hint?: string }) {
  return (
    <div className="card px-5 py-4 flex flex-col gap-2 min-w-0" title={hint}>
      <div className="text-[12px] text-text-muted truncate">{label}</div>
      <div className="num text-[26px] leading-none font-semibold tracking-tight truncate">{value}</div>
      {children}
      {foot && <div className="text-[12px] text-text-secondary mt-auto">{foot}</div>}
    </div>
  );
}

export function SplitBar({ parts }: { parts: Array<{ v: number; c: string }> }) {
  const total = parts.reduce((s, p) => s + Math.max(p.v, 0), 0);
  return (
    <div className="h-1.5 rounded-full overflow-hidden flex gap-px bg-bg-inset">
      {total > 0 && parts.map((p, i) => (
        <div key={i} className="h-full transition-all duration-700" style={{ width: `${(Math.max(p.v, 0) / total) * 100}%`, backgroundColor: p.c }} />
      ))}
    </div>
  );
}

/** Fill bar for a ratio (0–1); warn / danger colors past the thresholds */
function RatioBar({ ratio, warn = 0.5, danger = 0.8 }: { ratio: number; warn?: number; danger?: number }) {
  const r = Math.min(Math.max(ratio, 0), 1);
  const c = ratio >= danger ? 'bg-loss' : ratio >= warn ? 'bg-delayed' : 'bg-accent';
  return (
    <div className="h-1.5 rounded-full overflow-hidden bg-bg-inset">
      <div className={`h-full rounded-full transition-all duration-700 ${c}`} style={{ width: `${r * 100}%` }} />
    </div>
  );
}

// ── Positions page ────────────────────────────────────────────────────────────

type Group = ReturnType<typeof sumGroup>;

function KV({ k, v }: { k: ReactNode; v: ReactNode }) {
  return <div className="flex items-baseline justify-between gap-2 min-w-0"><span className="text-text-muted truncate">{k}</span><span className="num text-text-primary truncate">{v}</span></div>;
}

/** Actual leverage of one group (crypto perps or CFD) with its exposure, margin and equity base */
function LevTile({ label, hint, g, eqLabel, extra }: { label: string; hint: string; g: Group; eqLabel: string; extra?: ReactNode }) {
  const mPct = g.equity > 0 ? g.margin / g.equity : null;
  return (
    <Tile label={label} hint={hint}
      value={<>{g.lev != null ? fmtLev(g.lev) : '—'}
        {g.equity > 0 && <span className="ml-2 text-[12px] font-normal text-text-muted">{tr('净', 'net')} {fmtLev(Math.abs(g.net) / g.equity)}</span>}</>}>
      <SplitBar parts={[{ v: g.long, c: 'var(--color-profit)' }, { v: g.short, c: 'var(--color-loss)' }]} />
      <div className="flex flex-col gap-1 text-[12px]">
        <KV k={tr('敞口', 'Gross')} v={<>{fmtCompact(g.gross)} <span className="text-text-muted">(<span className="text-profit">{fmtCompact(g.long)}</span> / <span className="text-loss">{fmtCompact(g.short)}</span>)</span></>} />
        <KV k={tr('净敞口', 'Net')} v={<span className={pnlClass(g.net)}>{fmtSigned(g.net, { decimals: false })}</span>} />
        <KV k={eqLabel} v={fmtCompact(g.equity)} />
        <KV k={tr('保证金', 'Margin')} v={<>{g.marginEstimated && '≈'}{fmtCompact(g.margin)}
          {mPct != null && <span className={`ml-1.5 ${mPct >= 0.8 ? 'text-loss' : mPct >= 0.5 ? 'text-delayed' : 'text-text-muted'}`}>{(mPct * 100).toFixed(1)}%</span>}</>} />
        {extra}
      </div>
      {mPct != null && <RatioBar ratio={mPct} />}
    </Tile>
  );
}

export function RiskKpis({ accounts }: { accounts: AccountSnapshot[] }) {
  const risks = riskAccounts(accounts);
  const perpG = sumGroup(risks, 'perp');
  const cfdG = sumGroup(risks, 'cfd');
  const all = accounts.flatMap((a) => a.positions);
  const perps = all.filter(isPerpLike);
  const opts = all.filter((p) => p.assetClass === 'option');
  const upl = risks.reduce((s, r) => s + r.upl, 0);
  const optUpl = opts.reduce((s, p) => s + p.unrealizedPnl, 0);
  // Straight from the perps: sumGroup's perp upl folds in options only for accounts that also
  // carry perp exposure / margin, so subtracting all options from it was wrong for options-only accounts
  const perpUpl = perps.reduce((s, p) => s + p.unrealizedPnl, 0);
  const ds = opts.map(dollarDelta).filter((d): d is number => d != null);
  const optDelta = ds.length ? ds.reduce((s, d) => s + d, 0) : null;
  const paid = perps.filter((p) => p.fundingPnl != null);
  const next = perps.filter((p) => p.nextFunding != null);
  const nextSum = next.reduce((s, p) => s + (p.nextFunding as number), 0);
  const paidSum = paid.reduce((s, p) => s + (p.fundingPnl as number), 0);
  const nextTime = next.reduce<number | null>((t, p) => (p.nextFundingTime && (t == null || p.nextFundingTime < t) ? p.nextFundingTime : t), null);
  const mins = nextTime ? Math.max(0, Math.round((nextTime - Date.now()) / 60_000)) : null;
  const cfdRisks = risks.filter((r) => r.cfd && (r.cfd.x.gross > 0 || r.cfd.margin > 0));
  const mt5Only = cfdRisks.length > 0 && cfdRisks.every((r) => r.a.exchange === 'mt5');
  const levels = cfdRisks.map((r) => r.marginLevel).filter((v): v is number => v != null);
  const minLevel = levels.length ? Math.min(...levels) : null;
  const totLong = perpG.long + cfdG.long;
  const totShort = perpG.short + cfdG.short;

  return (
    <div className={`grid grid-cols-1 sm:grid-cols-2 gap-3 ${cfdG.n ? 'lg:grid-cols-3 xl:grid-cols-5' : 'lg:grid-cols-4'}`}>
      <Tile label={cfdG.n ? tr('总敞口（合约 + CFD）', 'Gross exposure (perps + CFD)') : tr('总敞口', 'Gross exposure')} value={fmtUSD(totLong + totShort, { decimals: false })}
        hint={tr('加密合约与 CFD 的敞口合计（杠杆 ETF 已乘以倍数，反向 ETF 的空单计为多头）；杠杆在右侧分开计算', 'Crypto perps + CFD exposure (leveraged ETFs × factor, a short on an inverse ETF counts as long); leverage is computed per group on the right')}>
        <SplitBar parts={[{ v: totLong, c: 'var(--color-profit)' }, { v: totShort, c: 'var(--color-loss)' }]} />
        <div className="flex flex-col gap-1 text-[12px]">
          <KV k={<><span className="text-profit">{tr('多', 'Long')}</span> / <span className="text-loss">{tr('空', 'Short')}</span></>} v={<><span className="text-profit">{fmtCompact(totLong)}</span> / <span className="text-loss">{fmtCompact(totShort)}</span></>} />
          <KV k={tr('净敞口', 'Net')} v={<span className={pnlClass(totLong - totShort)}>{fmtSigned(totLong - totShort, { decimals: false })}</span>} />
          {cfdG.n > 0 && <KV k={<>{tr('加密合约', 'Crypto perps')} / {mt5Only ? 'MT5' : 'CFD'}</>} v={<>{fmtCompact(perpG.gross)} / {fmtCompact(cfdG.gross)}</>} />}
          {optDelta != null && <KV k={tr('期权 $Delta', 'Options $Delta')} v={<span className={pnlClass(optDelta)}>{fmtSigned(optDelta, { decimals: false })}</span>} />}
        </div>
      </Tile>

      <LevTile label={tr('加密合约 · 实际杠杆', 'Crypto perps · actual leverage')} g={perpG} eqLabel={tr('交易权益', 'Trading eq.')}
        hint={tr('永续 / 交割合约敞口 ÷ 交易账户权益（总权益减去理财、资金账户和 CFD 子账户；杠杆 ETF 已乘以倍数）', 'Perp / futures exposure ÷ trading-account equity (total minus earn, funding and CFD sub-accounts; leveraged ETFs × factor)')} />

      {cfdG.n > 0 && (
        <LevTile label={mt5Only ? tr('MT5 · 实际杠杆', 'MT5 · actual leverage') : tr('CFD / MT5 · 实际杠杆', 'CFD / MT5 · actual leverage')} g={cfdG} eqLabel={tr('账户权益', 'Equity')}
          hint={tr('CFD 持仓名义价值 ÷ CFD 账户权益（MT5、Bitget CFD 子账户），与加密合约分开计算', 'CFD notional ÷ CFD account equity (MT5, Bitget CFD sub-account), computed apart from crypto perps')}
          extra={minLevel != null ? <KV k={tr('保证金率', 'Margin lvl')} v={`${minLevel >= 10000 ? minLevel.toFixed(0) : minLevel.toFixed(1)}%`} /> : undefined} />
      )}

      <Tile label={tr('未实现盈亏', 'Unrealized PnL')} value={<span className={pnlClass(upl)}>{fmtSigned(upl, { decimals: false })}</span>}
        foot={<div className="flex flex-col gap-1 text-[12px]">
          {perps.length > 0 && <KV k={tr('加密合约', 'Crypto perps')} v={<span className={pnlClass(perpUpl)}>{fmtSigned(perpUpl)}</span>} />}
          {cfdG.n > 0 && <KV k={mt5Only ? 'MT5' : 'CFD'} v={<span className={pnlClass(cfdG.upl)}>{fmtSigned(cfdG.upl)}</span>} />}
          {opts.length > 0 && <KV k={tr('期权', 'Options')} v={<span className={pnlClass(optUpl)}>{fmtSigned(optUpl)}</span>} />}
        </div>} />

      <Tile label={tr('资金费 · 下一轮预估', 'Funding · next round')}
        hint={tr('各仓位下一次结算的预估金额合计（按当前费率）；+ 收取 / − 支付', 'Sum of each position’s next estimated settlement at the current rate; + receive / − pay')}
        value={next.length ? <span className={pnlClass(nextSum)}>{fmtSigned(nextSum)}</span> : '—'}
        foot={<div className="flex flex-col gap-1 text-[12px]">
          <KV k={tr('开仓以来', 'Since open')} v={paid.length ? <span className={pnlClass(paidSum)}>{fmtSigned(paidSum)}</span> : '—'} />
          {mins != null && <KV k={tr('下次结算', 'Next settlement')} v={mins >= 60 ? `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m` : `${mins}m`} />}
        </div>} />
    </div>
  );
}

// ── Accounts page ─────────────────────────────────────────────────────────────

export function AssetKpis({ data }: { data: PortfolioResponse }) {
  const accounts = data.accounts;
  const stables = accounts.flatMap((a) => a.stables ?? []);
  const usdt = stables.filter((s) => s.asset === 'USDT').reduce((s, b) => s + b.amount, 0);
  const usdc = stables.filter((s) => s.asset === 'USDC').reduce((s, b) => s + b.amount, 0);
  const earn = stables.filter((s) => s.location === 'earn').reduce((s, b) => s + b.amount, 0);
  const funding = stables.filter((s) => s.location === 'funding').reduce((s, b) => s + b.amount, 0);
  const stableTotal = usdt + usdc;
  const spot = accounts.flatMap((a) => a.positions).filter((p) => ['crypto-spot', 'stock', 'etf'].includes(p.assetClass)).reduce((s, p) => s + Math.abs(p.marketValue), 0);
  const inTransit = data.inTransit ?? 0;
  const trading = accounts.reduce((s, a) => s + riskEquity(a), 0);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
      <Tile label={tr('总资产', 'Total equity')} value={fmtUSD(data.totalEquity, { decimals: false })} foot={<AllocationMini accounts={accounts} total={data.totalEquity} />}>
        {Math.abs(inTransit) >= 0.01 && (
          <div className="text-[12px] text-delayed" title={tr('已从一个账户转出、尚未到账另一个账户的资金，已计入总资产', 'Withdrawn from one tracked account and not yet credited at another — included in the total')}>
            {tr('含转账在途', 'Incl. in transit')} <span className="num">{fmtUSD(inTransit)}</span>
          </div>
        )}
      </Tile>

      <Tile label={tr('稳定币总额 (USDT + USDC)', 'Stablecoins (USDT + USDC)')} value={fmtUSD(stableTotal, { decimals: false })}
        foot={data.totalEquity > 0 ? <span><span className="num">{((stableTotal / data.totalEquity) * 100).toFixed(0)}%</span> {tr('总资产', 'of total equity')}</span> : undefined}>
        <SplitBar parts={[{ v: usdt, c: 'var(--color-usdt)' }, { v: usdc, c: 'var(--color-usdc)' }]} />
        <div className="flex gap-4 text-[12px]">
          <span className="inline-flex items-center gap-1.5"><i className="w-2 h-2 rounded-sm bg-usdt" />USDT <span className="num text-text-primary">{fmtCompact(usdt)}</span></span>
          <span className="inline-flex items-center gap-1.5"><i className="w-2 h-2 rounded-sm bg-usdc" />USDC <span className="num text-text-primary">{fmtCompact(usdc)}</span></span>
        </div>
      </Tile>

      <Tile label={tr('理财', 'Earn')} value={<span className="text-earn">{fmtUSD(earn, { decimals: false })}</span>}
        foot={<span>{stableTotal > 0 && <><span className="num">{((earn / stableTotal) * 100).toFixed(0)}%</span> {tr('稳定币', 'of stables')} · </>}
          {tr('资金账户', 'Funding')} <span className="num">{fmtCompact(funding)}</span></span>} />

      <Tile label={tr('交易账户权益', 'Trading equity')} value={fmtUSD(trading, { decimals: false })}
        hint={tr('总权益减去理财和资金账户余额（CFD / MT5 计入交易账户）', 'Total equity minus earn and funding wallets (CFD / MT5 count as trading)')}
        foot={<span>{data.totalEquity > 0 && <><span className="num">{((trading / data.totalEquity) * 100).toFixed(0)}%</span> {tr('总资产', 'of total')}</>}
          {spot >= 1 && <> · {tr('现货', 'Spot')} <span className="num">{fmtCompact(spot)}</span></>}</span>} />
    </div>
  );
}

function AllocationMini({ accounts, total }: { accounts: AccountSnapshot[]; total: number }) {
  if (total <= 0) return <span className="text-text-muted">—</span>;
  const by = new Map<string, number>();
  for (const a of accounts) by.set(a.exchange, (by.get(a.exchange) ?? 0) + Math.max(a.equity, 0));
  const parts = [...by.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  return (
    <div className="flex flex-col gap-2">
      <SplitBar parts={parts.map(([ex, v]) => ({ v, c: EXCHANGES[ex as keyof typeof EXCHANGES].color }))} />
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {parts.map(([ex, v]) => (
          <span key={ex} className="inline-flex items-center gap-1.5 text-[11.5px]">
            <i className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: EXCHANGES[ex as keyof typeof EXCHANGES].color }} />
            {EXCHANGES[ex as keyof typeof EXCHANGES].short}
            <span className="num text-text-muted">{((v / total) * 100).toFixed(0)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}
