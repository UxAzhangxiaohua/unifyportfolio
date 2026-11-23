import { useMemo, type ReactNode } from 'react';
import type { AccountSnapshot, Position } from '../types';
import { fmtPrice, fmtQty, fmtSigned, fmtUSD, pnlClass } from '../lib/format';
import { CardHeader, EmptyState, ExchangeTag, SideBadge } from './ui';
import { flatten } from './PositionsTable';
import { expiryMs } from '../lib/bs';
import { tr } from '../lib/i18n';

// Greeks on OptionDetails are position-level (× qty, signed for side):
//   delta/gamma in underlying units, theta = USD / calendar day, vega = USD / 1 vol pt.
const SCENARIOS = [-5, -1, 1, 5] as const;

/** $Delta: USD PnL per 1.00 (100%) move of the underlying, i.e. delta-equivalent spot exposure */
const dollarDelta = (p: Position) => {
  const o = p.option;
  return o?.delta != null && o.underlyingPrice ? o.delta * o.underlyingPrice : null;
};

/** Taylor estimate of instantaneous PnL for an underlying move of `pct` %: Δ·dS + ½Γ·dS² */
const movePnl = (p: Position, pct: number) => {
  const o = p.option;
  if (o?.delta == null || !o.underlyingPrice) return null;
  const dS = o.underlyingPrice * (pct / 100);
  return o.delta * dS + 0.5 * (o.gamma ?? 0) * dS * dS;
};

const sumOf = (rows: Position[], f: (p: Position) => number | null | undefined) => {
  let s = 0, n = 0;
  for (const p of rows) { const v = f(p); if (v != null && Number.isFinite(v)) { s += v; n++; } }
  return n ? s : null;
};

const fmtSignedOrDash = (v: number | null, opts?: { decimals?: boolean }) => (v == null ? '—' : fmtSigned(v, opts));

export function OptionsTable({ accounts }: { accounts: AccountSnapshot[] }) {
  const rows = useMemo(() => {
    const r = flatten(accounts, (p) => p.assetClass === 'option');
    // Nearest expiry first, then strike; positions without parsed details go last
    const exp = (p: Position) => (p.option ? expiryMs(p.option.expiry, p.option.expiryTs) : Infinity);
    return r.sort((a, b) => exp(a) - exp(b) || (a.option?.strike ?? 0) - (b.option?.strike ?? 0));
  }, [accounts]);

  const upl = rows.reduce((s, p) => s + p.unrealizedPnl, 0);
  // Net premium value: long options are assets, short options liabilities
  const net = rows.reduce((s, p) => s + (p.side === 'short' ? -1 : 1) * p.marketValue, 0);

  const byUnderlying = useMemo(() => {
    const m = new Map<string, Position[]>();
    for (const p of rows) {
      const u = p.option?.underlying ?? '?';
      m.set(u, [...(m.get(u) ?? []), p]);
    }
    return [...m.entries()];
  }, [rows]);

  const thetaDay = sumOf(rows, (p) => p.option?.theta);
  const vega = sumOf(rows, (p) => p.option?.vega);
  const dDelta = sumOf(rows, dollarDelta);
  const missingGreeks = rows.filter((p) => p.option?.theta == null || p.option?.delta == null).length;

  return (
    <section className="card overflow-hidden">
      <CardHeader
        title={tr('期权持仓', 'Options')}
        sub={rows.length ? <>{rows.length} {tr('个', 'positions')} · {tr('净权利金价值', 'Net premium')} <span className="num">{fmtSigned(net, { decimals: false })}</span> · {tr('盈亏', 'PnL')} <span className={`num ${pnlClass(upl)}`}>{fmtSigned(upl)}</span></> : undefined}
      />
      {rows.length === 0 ? <EmptyState>{tr('当前没有期权持仓', 'No option positions')}</EmptyState> : (
        <>
          {/* Greeks summary */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-border-card border-y border-border-card">
            <Stat label={tr('Theta 损耗 / 小时', 'Theta decay / hour')} hint={tr('theta ÷ 24（瞬时速率；临近到期会加速）', 'theta ÷ 24 (instantaneous rate; accelerates near expiry)')}
              value={<span className={pnlClass(thetaDay ?? 0)}>{fmtSignedOrDash(thetaDay == null ? null : thetaDay / 24, { decimals: true })}</span>}
              foot={<>{tr('每天', 'Per day')} <span className={`num ${pnlClass(thetaDay ?? 0)}`}>{fmtSignedOrDash(thetaDay, { decimals: true })}</span></>} />
            <Stat label={tr('净 $Delta（等效现货敞口）', 'Net $Delta (spot-equivalent exposure)')} hint={tr('Σ delta × 标的价格；标的涨 1% ≈ 此值 × 1%', 'Σ delta × underlying price; a 1% move ≈ this × 1%')}
              value={<span className={pnlClass(dDelta ?? 0)}>{fmtSignedOrDash(dDelta, { decimals: false })}</span>}
              foot={byUnderlying.map(([u, ps]) => {
                const d = sumOf(ps, (p) => p.option?.delta);
                return d == null ? null : <span key={u} className="mr-3">{u} <span className="num text-text-primary">{d >= 0 ? '+' : '−'}{Math.abs(d).toFixed(4)}</span></span>;
              })} />
            <Stat label={tr('标的涨跌 → 期权盈亏估算', 'Underlying move → est. option PnL')} hint={tr('Δ·dS + ½Γ·dS²，各标的按自身价格同幅度变动', 'Δ·dS + ½Γ·dS², every underlying moved by the same %')}
              value={<ScenarioGrid rows={rows} />} />
            <Stat label={tr('Vega（IV 变动 1 个点）', 'Vega (per 1 vol point)')} hint={tr('隐含波动率 +1% 时的盈亏', 'PnL if implied vol rises by 1 point')}
              value={<span className={pnlClass(vega ?? 0)}>{fmtSignedOrDash(vega, { decimals: true })}</span>}
              foot={missingGreeks ? <span className="text-delayed">{tr(`${missingGreeks} 个持仓缺少希腊值`, `${missingGreeks} position(s) missing greeks`)}</span> : <span>{tr('每 15 秒随持仓刷新', 'Refreshes with positions every 15s')}</span>} />
          </div>

          <div className="overflow-x-auto">
            <table className="data">
              <thead>
                <tr>
                  <th>{tr('账户', 'Account')}</th>
                  <th>{tr('标的', 'Underlying')}</th>
                  <th>{tr('类型', 'Type')}</th>
                  <th className="r">{tr('行权价', 'Strike')}</th>
                  <th>{tr('到期', 'Expiry')}</th>
                  <th>{tr('方向', 'Side')}</th>
                  <th className="r">{tr('数量', 'Qty')}</th>
                  <th className="r">{tr('开仓价', 'Entry')}</th>
                  <th className="r">{tr('标记价', 'Mark')}</th>
                  <th className="r">{tr('价值', 'Value')}</th>
                  <th className="r">{tr('未实现盈亏', 'uPnL')}</th>
                  <th className="r">IV</th>
                  <th className="r" title={tr('持仓 delta（已乘数量，空头取反），单位：标的币', 'Position delta (× qty, negated for shorts), in underlying units')}>Delta</th>
                  <th className="r" title={tr('delta × 标的价格', 'delta × underlying price')}>$Delta</th>
                  <th className="r" title={tr('标的 ±1% 时的估算盈亏（含 gamma）', 'Estimated PnL for a ±1% underlying move (incl. gamma)')}>±1%</th>
                  <th className="r" title="theta ÷ 24">{tr('Θ / 小时', 'Θ / hour')}</th>
                  <th className="r">{tr('Θ / 天', 'Θ / day')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p, i) => {
                  const o = p.option;
                  const dte = o?.expiry ? (expiryMs(o.expiry, o.expiryTs) - Date.now()) / 86_400_000 : null;
                  const ccy = o?.premiumCcy;
                  const dd = dollarDelta(p);
                  const up = movePnl(p, 1);
                  const down = movePnl(p, -1);
                  return (
                    <tr key={`${p.accountId}-${p.symbol}-${i}`} title={p.symbol}>
                      <td className="max-w-[160px]"><ExchangeTag exchange={p.exchange} label={p.accountLabel} /></td>
                      <td className="font-semibold">{o?.underlying ?? p.symbol}</td>
                      <td>
                        {o ? (
                          <span className={`text-[11px] font-semibold px-1.5 py-0.5 rounded ${o.type === 'call' ? 'bg-profit/10 text-profit' : 'bg-loss/10 text-loss'}`}>
                            {o.type === 'call' ? 'CALL' : 'PUT'}
                          </span>
                        ) : <span className="text-text-muted">—</span>}
                      </td>
                      <td className="r num">{o ? o.strike.toLocaleString('en-US') : '—'}</td>
                      <td>
                        <span className="num">{o?.expiry ? o.expiry.slice(2) : '—'}</span>
                        {dte != null && (
                          <span className={`num text-[11px] ml-2 ${dte < 2 ? 'text-loss' : dte < 7 ? 'text-delayed' : 'text-text-muted'}`}>
                            {dte < 1 ? `${Math.max(dte * 24, 0).toFixed(0)}h` : `${dte.toFixed(0)}d`}
                          </span>
                        )}
                      </td>
                      <td><SideBadge side={p.side} /></td>
                      <td className="r num">{fmtQty(p.quantity)}</td>
                      <td className="r num text-text-secondary">{fmtPrice(p.avgPrice)}{ccy && <span className="text-text-muted text-[10px] ml-1">{ccy}</span>}</td>
                      <td className="r num">{fmtPrice(p.currentPrice)}{ccy && <span className="text-text-muted text-[10px] ml-1">{ccy}</span>}</td>
                      <td className="r num">{fmtUSD(p.marketValue)}</td>
                      <td className={`r num font-medium ${pnlClass(p.unrealizedPnl)}`}>{fmtSigned(p.unrealizedPnl)}</td>
                      <td className="r num text-text-secondary">{o?.iv != null ? `${(o.iv * 100).toFixed(1)}%` : '—'}</td>
                      <td className="r num text-text-secondary">{o?.delta != null ? o.delta.toFixed(4) : '—'}</td>
                      <td className={`r num ${pnlClass(dd ?? 0)}`}>{fmtSignedOrDash(dd, { decimals: false })}</td>
                      <td className="r num text-[12px] whitespace-nowrap">
                        {up == null || down == null ? '—' : (
                          <><span className={pnlClass(up)}>{fmtSigned(up)}</span><span className="text-text-muted"> / </span><span className={pnlClass(down)}>{fmtSigned(down)}</span></>
                        )}
                      </td>
                      <td className={`r num font-medium ${pnlClass(o?.theta ?? 0)}`}>{fmtSignedOrDash(o?.theta == null ? null : o.theta / 24, { decimals: true })}</td>
                      <td className={`r num ${pnlClass(o?.theta ?? 0)}`}>{fmtSignedOrDash(o?.theta ?? null, { decimals: true })}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function Stat({ label, hint, value, foot }: { label: string; hint?: string; value: ReactNode; foot?: ReactNode }) {
  return (
    <div className="bg-bg-card px-5 py-3.5 flex flex-col gap-1.5 min-w-0" title={hint}>
      <div className="text-[12px] text-text-muted truncate">{label}</div>
      <div className="num text-[20px] leading-tight font-semibold tracking-tight">{value}</div>
      {foot && <div className="text-[12px] text-text-secondary truncate">{foot}</div>}
    </div>
  );
}

function ScenarioGrid({ rows }: { rows: Position[] }) {
  return (
    <div className="grid grid-cols-4 gap-x-3 text-[12px] font-normal">
      {SCENARIOS.map((pct) => {
        const v = sumOf(rows, (p) => movePnl(p, pct));
        return (
          <div key={pct} className="flex flex-col">
            <span className="text-text-muted">{pct > 0 ? '+' : '−'}{Math.abs(pct)}%</span>
            <span className={`num text-[14px] font-semibold ${pnlClass(v ?? 0)}`}>{v == null ? '—' : fmtSigned(v, { decimals: Math.abs(v) < 1000 })}</span>
          </div>
        );
      })}
    </div>
  );
}
