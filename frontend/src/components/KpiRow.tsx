import type { ReactNode } from 'react';
import type { AccountSnapshot, PortfolioResponse } from '../types';
import { fmtCompact, fmtSigned, fmtUSD, pnlClass } from '../lib/format';
import { EXCHANGES } from '../lib/exchanges';

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

const isDeriv = (c: string) => c === 'crypto-perp' || c === 'crypto-future' || c === 'option';

export function KpiRow({ data }: { data: PortfolioResponse }) {
  const accounts = data.accounts;
  const stables = accounts.flatMap((a) => a.stables ?? []);
  const usdt = stables.filter((s) => s.asset === 'USDT').reduce((s, b) => s + b.amount, 0);
  const usdc = stables.filter((s) => s.asset === 'USDC').reduce((s, b) => s + b.amount, 0);
  const earn = stables.filter((s) => s.location === 'earn').reduce((s, b) => s + b.amount, 0);
  const stableTotal = usdt + usdc;

  const derivs = accounts.flatMap((a) => a.positions.filter((p) => isDeriv(p.assetClass)));
  const perps = derivs.filter((p) => p.assetClass !== 'option');
  const longN = perps.filter((p) => p.side === 'long').reduce((s, p) => s + p.marketValue, 0);
  const shortN = perps.filter((p) => p.side === 'short').reduce((s, p) => s + p.marketValue, 0);
  const derivUpl = derivs.reduce((s, p) => s + p.unrealizedPnl, 0);
  const optCount = derivs.length - perps.length;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
      <Tile label="总资产" value={fmtUSD(data.totalEquity, { decimals: false })} foot={<AllocationMini accounts={accounts} total={data.totalEquity} />} />

      <Tile label="稳定币总额 (USDT + USDC)" value={fmtUSD(stableTotal, { decimals: false })}
        foot={<span>其中理财 <span className="num text-earn">{fmtCompact(earn)}</span>
          {stableTotal > 0 && <span className="text-text-muted"> · {((earn / stableTotal) * 100).toFixed(0)}%</span>}</span>}>
        <SplitBar parts={[{ v: usdt, c: 'var(--color-usdt)' }, { v: usdc, c: 'var(--color-usdc)' }]} />
        <div className="flex gap-4 text-[12px]">
          <span className="inline-flex items-center gap-1.5"><i className="w-2 h-2 rounded-sm bg-usdt" />USDT <span className="num text-text-primary">{fmtCompact(usdt)}</span></span>
          <span className="inline-flex items-center gap-1.5"><i className="w-2 h-2 rounded-sm bg-usdc" />USDC <span className="num text-text-primary">{fmtCompact(usdc)}</span></span>
        </div>
      </Tile>

      <Tile label="衍生品未实现盈亏" value={<span className={pnlClass(derivUpl)}>{fmtSigned(derivUpl, { decimals: false })}</span>}
        foot={<span>{perps.length} 个合约 · {optCount} 个期权</span>} />

      <Tile label="合约名义敞口" value={fmtUSD(longN + shortN, { decimals: false })}
        foot={<span>净敞口 <span className={`num ${pnlClass(longN - shortN)}`}>{fmtSigned(longN - shortN, { decimals: false })}</span></span>}>
        <SplitBar parts={[{ v: longN, c: 'var(--color-profit)' }, { v: shortN, c: 'var(--color-loss)' }]} />
        <div className="flex gap-4 text-[12px]">
          <span>多 <span className="num text-profit">{fmtCompact(longN)}</span></span>
          <span>空 <span className="num text-loss">{fmtCompact(shortN)}</span></span>
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
