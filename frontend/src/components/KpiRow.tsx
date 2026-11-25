import type { ReactNode } from 'react';
import type { AccountSnapshot, PortfolioResponse } from '../types';
import { fmtCompact, fmtSigned, fmtUSD, pnlClass } from '../lib/format';
import { EXCHANGES } from '../lib/exchanges';
import { tr } from '../lib/i18n';
import { fmtLev, isPerpLike, sumExposure } from '../lib/exposure';
import { dollarDelta, riskAccounts, riskEquity } from '../lib/risk';

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

const levHint = () => tr('实际杠杆 = 合约 + CFD 总敞口 ÷ 交易权益（总权益减去理财和资金账户；杠杆 ETF 已乘以倍数）', 'Actual leverage = perp + CFD gross exposure ÷ trading equity (total minus earn and funding wallets; leveraged ETFs × factor)');

// ── Positions page ────────────────────────────────────────────────────────────

export function RiskKpis({ accounts }: { accounts: AccountSnapshot[] }) {
  const risks = riskAccounts(accounts);
  const all = accounts.flatMap((a) => a.positions);
  const perps = all.filter(isPerpLike);
  const cfds = all.filter((p) => p.assetClass === 'cfd');
  const opts = all.filter((p) => p.assetClass === 'option');
  const x = sumExposure([...perps, ...cfds]);
  const perpX = sumExposure(perps);
  const equity = risks.reduce((s, r) => s + r.equity, 0);
  const margin = risks.reduce((s, r) => s + r.margin, 0);
  const upl = risks.reduce((s, r) => s + r.upl, 0);
  const perpUpl = perpX.upl;
  const optUpl = opts.reduce((s, p) => s + p.unrealizedPnl, 0);
  const cfdUpl = upl - perpUpl - optUpl;
  const ds = opts.map(dollarDelta).filter((d): d is number => d != null);
  const optDelta = ds.length ? ds.reduce((s, d) => s + d, 0) : null;
  const paid = perps.filter((p) => p.fundingPnl != null);
  const next = perps.filter((p) => p.nextFunding != null);
  const nextTime = next.reduce<number | null>((t, p) => (p.nextFundingTime && (t == null || p.nextFundingTime < t) ? p.nextFundingTime : t), null);
  const mins = nextTime ? Math.max(0, Math.round((nextTime - Date.now()) / 60_000)) : null;

  return (
    <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3 [&>*:first-child]:col-span-2 lg:[&>*:first-child]:col-span-1">
      <Tile label={tr('总敞口（合约 + CFD）', 'Gross exposure (perps + CFD)')} value={fmtUSD(x.gross, { decimals: false })}
        hint={tr('敞口 = 名义价值 × 杠杆 ETF 倍数；反向 ETF 的空单计为多头', 'Exposure = notional × leveraged-ETF factor; a short on an inverse ETF counts as long')}
        foot={<span>{tr('净', 'Net')} <span className={`num ${pnlClass(x.net)}`}>{fmtSigned(x.net, { decimals: false })}</span>
          {optDelta != null && <span className="text-text-muted"> · {tr('期权', 'Options')} $Δ <span className={`num ${pnlClass(optDelta)}`}>{fmtSigned(optDelta, { decimals: false })}</span></span>}</span>}>
        <SplitBar parts={[{ v: x.long, c: 'var(--color-profit)' }, { v: x.short, c: 'var(--color-loss)' }]} />
        <div className="flex gap-4 text-[12px]">
          <span>{tr('多', 'Long')} <span className="num text-profit">{fmtCompact(x.long)}</span></span>
          <span>{tr('空', 'Short')} <span className="num text-loss">{fmtCompact(x.short)}</span></span>
        </div>
      </Tile>

      <Tile label={tr('实际杠杆', 'Actual leverage')} hint={levHint()} value={equity > 0 ? fmtLev(x.gross / equity) : '—'}
        foot={<span>{tr('净杠杆', 'Net')} <span className="num">{equity > 0 ? fmtLev(Math.abs(x.net) / equity) : '—'}</span>
          <span className="text-text-muted"> · {tr('交易权益', 'Trading eq.')} <span className="num">{fmtCompact(equity)}</span></span></span>} />

      <Tile label={tr('保证金占用', 'Margin used')} value={fmtUSD(margin, { decimals: false })}
        foot={equity > 0 ? <span><span className="num">{((margin / equity) * 100).toFixed(1)}%</span> {tr('交易权益', 'of trading equity')}
          <span className="text-text-muted"> · {tr(`${risks.length} 个账户`, `${risks.length} accounts`)}</span></span> : undefined}>
        {equity > 0 && <RatioBar ratio={margin / equity} />}
      </Tile>

      <Tile label={tr('未实现盈亏', 'Unrealized PnL')} value={<span className={pnlClass(upl)}>{fmtSigned(upl, { decimals: false })}</span>}
        foot={<span className="flex flex-wrap gap-x-3">
          {perps.length > 0 && <span>{tr('合约', 'Perps')} <span className={`num ${pnlClass(perpUpl)}`}>{fmtCompact(perpUpl)}</span></span>}
          {cfds.length > 0 && <span>CFD <span className={`num ${pnlClass(cfdUpl)}`}>{fmtCompact(cfdUpl)}</span></span>}
          {opts.length > 0 && <span>{tr('期权', 'Options')} <span className={`num ${pnlClass(optUpl)}`}>{fmtCompact(optUpl)}</span></span>}
        </span>} />

      <Tile label={tr('资金费 · 下一轮预估', 'Funding · next round')}
        hint={tr('各仓位下一次结算的预估金额合计（按当前费率）；+ 收取 / − 支付', 'Sum of each position’s next estimated settlement at the current rate; + receive / − pay')}
        value={next.length ? <span className={pnlClass(next.reduce((s, p) => s + (p.nextFunding as number), 0))}>{fmtSigned(next.reduce((s, p) => s + (p.nextFunding as number), 0))}</span> : '—'}
        foot={<span>{tr('开仓以来', 'Since open')} {paid.length ? <span className={`num ${pnlClass(paid.reduce((s, p) => s + (p.fundingPnl as number), 0))}`}>{fmtSigned(paid.reduce((s, p) => s + (p.fundingPnl as number), 0))}</span> : '—'}
          {mins != null && <span className="text-text-muted num"> · {mins >= 60 ? `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m` : `${mins}m`}</span>}</span>} />
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
