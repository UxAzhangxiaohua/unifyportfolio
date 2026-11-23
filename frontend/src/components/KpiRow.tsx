import type { ReactNode } from 'react';
import type { AccountSnapshot, PortfolioResponse } from '../types';
import { fmtCompact, fmtSigned, fmtUSD, pnlClass } from '../lib/format';
import { EXCHANGES } from '../lib/exchanges';
import { tr } from '../lib/i18n';
import { sumExposure } from '../lib/exposure';

function Tile({ label, value, foot, children }: { label: string; value: ReactNode; foot?: ReactNode; children?: ReactNode }) {
  return (
    <div className="card px-5 py-4 flex flex-col gap-2 min-w-0">
      <div className="text-[12px] text-text-muted">{label}</div>
      <div className="num text-[26px] leading-none font-semibold tracking-tight truncate">{value}</div>
      {children}
      {foot && <div className="text-[12px] text-text-secondary mt-auto">{foot}</div>}
    </div>
  );
}

const isDeriv = (c: string) => c === 'crypto-perp' || c === 'crypto-future' || c === 'cfd' || c === 'option';

export function KpiRow({ data }: { data: PortfolioResponse }) {
  const accounts = data.accounts;
  const stables = accounts.flatMap((a) => a.stables ?? []);
  const usdt = stables.filter((s) => s.asset === 'USDT').reduce((s, b) => s + b.amount, 0);
  const usdc = stables.filter((s) => s.asset === 'USDC').reduce((s, b) => s + b.amount, 0);
  const earn = stables.filter((s) => s.location === 'earn').reduce((s, b) => s + b.amount, 0);
  const stableTotal = usdt + usdc;

  const derivs = accounts.flatMap((a) => a.positions.filter((p) => isDeriv(p.assetClass)));
  // CFDs have their own panel: keep them out of the crypto perp exposure/count
  const perps = derivs.filter((p) => p.assetClass === 'crypto-perp' || p.assetClass === 'crypto-future');
  // Effective exposure: leveraged ETFs × factor, a short on an inverse ETF counts as long
  const { long: longN, short: shortN } = sumExposure(perps);
  // CFD floating PnL comes from the account-level figure (authoritative), not the parsed position rows
  const cfdUpl = accounts.flatMap((a) => a.cfd ?? []).reduce((s, c) => s + c.floatingPnl, 0);
  const derivUpl = derivs.filter((p) => p.assetClass !== 'cfd').reduce((s, p) => s + p.unrealizedPnl, 0) + cfdUpl;
  const optCount = derivs.filter((p) => p.assetClass === 'option').length;
  const cfdCount = derivs.length - perps.length - optCount;
  const inTransit = data.inTransit ?? 0;

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
        foot={<span>{tr('其中理财', 'In earn')} <span className="num text-earn">{fmtCompact(earn)}</span>
          {stableTotal > 0 && <span className="text-text-muted"> · {((earn / stableTotal) * 100).toFixed(0)}%</span>}</span>}>
        <SplitBar parts={[{ v: usdt, c: 'var(--color-usdt)' }, { v: usdc, c: 'var(--color-usdc)' }]} />
        <div className="flex gap-4 text-[12px]">
          <span className="inline-flex items-center gap-1.5"><i className="w-2 h-2 rounded-sm bg-usdt" />USDT <span className="num text-text-primary">{fmtCompact(usdt)}</span></span>
          <span className="inline-flex items-center gap-1.5"><i className="w-2 h-2 rounded-sm bg-usdc" />USDC <span className="num text-text-primary">{fmtCompact(usdc)}</span></span>
        </div>
      </Tile>

      <Tile label={tr('衍生品未实现盈亏', 'Derivatives uPnL')} value={<span className={pnlClass(derivUpl)}>{fmtSigned(derivUpl, { decimals: false })}</span>}
        foot={<span>{tr(`${perps.length} 个合约 · ${optCount} 个期权`, `${perps.length} perps · ${optCount} options`)}{cfdCount > 0 && tr(` · ${cfdCount} 个 CFD`, ` · ${cfdCount} CFD`)}</span>} />

      <Tile label={tr('合约敞口（含杠杆 ETF 倍数）', 'Perp exposure (incl. leveraged ETFs)')} value={fmtUSD(longN + shortN, { decimals: false })}
        foot={<span>{tr('净敞口', 'Net')} <span className={`num ${pnlClass(longN - shortN)}`}>{fmtSigned(longN - shortN, { decimals: false })}</span></span>}>
        <SplitBar parts={[{ v: longN, c: 'var(--color-profit)' }, { v: shortN, c: 'var(--color-loss)' }]} />
        <div className="flex gap-4 text-[12px]">
          <span>{tr('多', 'Long')} <span className="num text-profit">{fmtCompact(longN)}</span></span>
          <span>{tr('空', 'Short')} <span className="num text-loss">{fmtCompact(shortN)}</span></span>
        </div>
      </Tile>
    </div>
  );
}

function SplitBar({ parts }: { parts: Array<{ v: number; c: string }> }) {
  const total = parts.reduce((s, p) => s + Math.max(p.v, 0), 0);
  return (
    <div className="h-1.5 rounded-full overflow-hidden flex gap-px bg-bg-inset">
      {total > 0 && parts.map((p, i) => (
        <div key={i} className="h-full transition-all duration-700" style={{ width: `${(Math.max(p.v, 0) / total) * 100}%`, backgroundColor: p.c }} />
      ))}
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
