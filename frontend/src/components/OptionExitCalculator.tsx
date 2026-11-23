import { useEffect, useMemo, useState } from 'react';
import type { AccountSnapshot } from '../types';
import { bsPrice, expiryMs, impliedVol, yearsBetween } from '../lib/bs';
import { fmtPrice, fmtSigned, pnlClass } from '../lib/format';
import { tr } from '../lib/i18n';
import { CardHeader, ExchangeTag, SideBadge } from './ui';
import { flatten } from './PositionsTable';

// Target-price exit calculator: "if BTC is at X in H hours, what is each option worth,
// and where should I rest my closing limit order?" Pure calculation — never places orders.

const HORIZONS = [0, 2, 6, 12, 24, 48];
const STORE = 'unify.optcalc';

interface Saved { targets: Record<string, string>; hours: number; ivShift: number; buffer: number }
function load(): Saved {
  const d: Saved = { targets: {}, hours: 0, ivShift: 0, buffer: 2 };
  try { return { ...d, ...JSON.parse(localStorage.getItem(STORE) ?? '{}') }; } catch { return d; }
}

const floorTo = (x: number, tick: number) => Math.floor(x / tick + 1e-9) * tick;
const ceilTo = (x: number, tick: number) => Math.ceil(x / tick - 1e-9) * tick;
const decimalsOf = (tick: number) => Math.max(0, -Math.floor(Math.log10(tick) + 1e-9));

function NumInput({ value, onChange, step, width = 'w-24', suffix }: {
  value: string | number; onChange: (v: string) => void; step?: number; width?: string; suffix?: string;
}) {
  return (
    <span className="inline-flex items-center bg-bg-inset border border-border-card rounded-lg focus-within:border-border-hover">
      <input type="number" inputMode="decimal" value={value} step={step} onChange={(e) => onChange(e.target.value)}
        className={`num ${width} bg-transparent px-2.5 py-1 text-[13px] text-text-primary outline-none`} />
      {suffix && <span className="pr-2.5 text-[11px] text-text-muted">{suffix}</span>}
    </span>
  );
}

export function OptionExitCalculator({ accounts }: { accounts: AccountSnapshot[] }) {
  const options = useMemo(() => flatten(accounts, (p) => p.assetClass === 'option' && !!p.option)
    .sort((a, b) => expiryMs(a.option!.expiry, a.option!.expiryTs) - expiryMs(b.option!.expiry, b.option!.expiryTs) || a.option!.strike - b.option!.strike), [accounts]);
  const underlyings = useMemo(() => [...new Set(options.map((p) => p.option!.underlying))], [options]);

  const [saved, setSaved] = useState<Saved>(load);
  const [u, setU] = useState<string>('');
  const und = underlyings.includes(u) ? u : underlyings[0] ?? '';
  useEffect(() => { try { localStorage.setItem(STORE, JSON.stringify(saved)); } catch { /* ignore */ } }, [saved]);

  if (!options.length) return null;

  const rows = options.filter((p) => p.option!.underlying === und);
  const spot = rows.find((p) => p.option!.underlyingPrice)?.option!.underlyingPrice ?? null;
  const targetStr = saved.targets[und] ?? '';
  const target = Number(targetStr);
  const hasTarget = Number.isFinite(target) && target > 0;
  const { hours, ivShift, buffer } = saved;
  const now = Date.now();
  const set = (patch: Partial<Saved>) => setSaved((s) => ({ ...s, ...patch }));

  const calc = rows.map((p) => {
    const o = p.option!;
    const S0 = o.underlyingPrice ?? 0;
    const exp = expiryMs(o.expiry, o.expiryTs);
    const coin = !!o.premiumCcy;
    const markUsd = coin ? p.currentPrice * S0 : p.currentPrice;
    // Calibrate vol so the model reproduces today's mark exactly; fall back to the venue's mark IV
    const vol0 = S0 ? impliedVol(markUsd, S0, o.strike, yearsBetween(now, exp), o.type) ?? o.iv ?? null : null;
    const vol = vol0 == null ? null : Math.max(vol0 + ivShift / 100, 0.01);
    const tick = o.tickSize || (coin ? 0.0001 : 0.01);
    const sign = p.side === 'short' ? -1 : 1;

    const priceAt = (h: number) => {
      if (vol == null || !hasTarget) return null;
      const usd = bsPrice(target, o.strike, yearsBetween(now + h * 3_600_000, exp), vol, o.type);
      return coin ? usd / target : usd;
    };
    const est = priceAt(hours);
    // Long → sell to close, shade below estimate so it fills; short → buy to close, shade above
    const limit = est == null ? null : sign > 0 ? floorTo(est * (1 - buffer / 100), tick) : ceilTo(est * (1 + buffer / 100), tick);
    // quantity is in contracts; contractMultiplier converts to underlying units (OKX coin-margined: 0.01 BTC)
    const pnl = limit == null ? null : (limit - p.avgPrice) * p.quantity * (o.contractMultiplier ?? 1) * sign * (coin ? target : 1);
    const expired = now + hours * 3_600_000 >= exp;
    return { p, o, vol0, vol, tick, sign, est, limit, pnl, expired, priceAt, exp, knownTick: !!o.tickSize };
  });

  // Expired rows show no PnL, so keep them out of the total as well
  const totalPnl = calc.reduce((s, c) => s + (c.expired ? 0 : c.pnl ?? 0), 0);
  const horizons = HORIZONS.filter((h) => calc.some((c) => now + h * 3_600_000 < c.exp));

  return (
    <section className="card overflow-hidden">
      <CardHeader
        title={tr('目标价平仓计算器', 'Target-price exit calculator')}
        sub={tr('输入标的目标价，估算期权价格与建议挂单价 · 只计算，不下单', 'Enter an underlying target to estimate option prices and closing limit prices · calculation only, no orders')}
        right={underlyings.length > 1 ? (
          <div className="seg">{underlyings.map((x) => <button key={x} data-active={x === und} onClick={() => setU(x)}>{x}</button>)}</div>
        ) : undefined}
      />

      <div className="flex flex-wrap items-end gap-x-6 gap-y-3 px-5 pb-4 text-[12px] text-text-muted">
        <label className="flex flex-col gap-1.5">
          <span>{tr(`${und} 目标价`, `${und} target`)}{spot ? <span className="ml-1.5">{tr('现价', 'now')} <span className="num text-text-secondary">{fmtPrice(spot)}</span></span> : null}</span>
          <span className="inline-flex items-center gap-2">
            <NumInput value={targetStr} width="w-28" step={100} onChange={(v) => set({ targets: { ...saved.targets, [und]: v } })} />
            {hasTarget && spot ? <span className={`num ${pnlClass(target - spot)}`}>{target >= spot ? '+' : '−'}{Math.abs((target / spot - 1) * 100).toFixed(2)}%</span> : null}
          </span>
        </label>

        <div className="flex flex-col gap-1.5">
          <span>{tr('预计多久后到达', 'Expected time to reach')}</span>
          <span className="inline-flex items-center gap-2">
            <div className="seg">
              {[0, 2, 6, 12, 24].map((h) => (
                <button key={h} data-active={hours === h} onClick={() => set({ hours: h })}>{h === 0 ? tr('立即', 'Now') : `${h}h`}</button>
              ))}
            </div>
            <NumInput value={hours} width="w-14" step={1} suffix="h" onChange={(v) => set({ hours: Math.max(0, Number(v) || 0) })} />
          </span>
        </div>

        <label className="flex flex-col gap-1.5" title={tr('标的下跌时 put 的 IV 通常上升，上涨时 call 的 IV 可能上升', 'Put IV usually rises when the underlying falls; call IV may rise on rallies')}>
          <span>{tr('IV 调整（波动率点）', 'IV shift (vol pts)')}</span>
          <NumInput value={ivShift} width="w-16" step={1} onChange={(v) => set({ ivShift: Number(v) || 0 })} />
        </label>

        <label className="flex flex-col gap-1.5" title={tr('挂单价相对估值让出的比例，提高成交概率', 'How far the limit is shaded from the estimate to improve the chance of a fill')}>
          <span>{tr('成交缓冲', 'Fill buffer')}</span>
          <NumInput value={buffer} width="w-14" step={0.5} suffix="%" onChange={(v) => set({ buffer: Math.max(0, Number(v) || 0) })} />
        </label>
      </div>

      {!hasTarget ? (
        <div className="px-5 pb-6 text-[13px] text-text-muted">{tr('填写目标价后显示每个期权的估值和建议挂单价', 'Enter a target price to see each option’s estimated value and suggested limit')}</div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="data">
              <thead>
                <tr>
                  <th>{tr('账户', 'Account')}</th>
                  <th>{tr('合约', 'Contract')}</th>
                  <th>{tr('方向', 'Side')}</th>
                  <th className="r">{tr('数量', 'Qty')}</th>
                  <th className="r">{tr('开仓价', 'Entry')}</th>
                  <th className="r">{tr('当前标记', 'Mark now')}</th>
                  <th className="r" title={tr('由当前标记价反推的 IV + 调整', 'IV implied from the current mark + shift')}>IV</th>
                  <th className="r">{tr('目标时估值', 'Est. at target')}</th>
                  <th className="r">{tr('建议挂单', 'Suggested limit')}</th>
                  <th className="r">{tr('预计盈亏', 'Est. PnL')}</th>
                  {horizons.map((h) => <th key={h} className={`r ${h === hours ? '!text-text-primary' : ''}`}>{h === 0 ? tr('立即', 'Now') : `+${h}h`}</th>)}
                </tr>
              </thead>
              <tbody>
                {calc.map((c) => {
                  const ccy = c.o.premiumCcy ?? 'USDT';
                  const dp = decimalsOf(c.tick);
                  const fmt = (x: number) => x.toLocaleString('en-US', { minimumFractionDigits: Math.min(dp, 4), maximumFractionDigits: Math.max(dp, 2) });
                  const chg = c.est != null && c.p.currentPrice ? (c.est / c.p.currentPrice - 1) * 100 : null;
                  return (
                    <tr key={`${c.p.accountId}-${c.p.symbol}`} title={c.p.symbol}>
                      <td><ExchangeTag exchange={c.p.exchange} label={c.p.accountLabel} /></td>
                      <td className="font-medium">
                        {c.o.expiry.slice(5)} {c.o.strike.toLocaleString('en-US')}
                        <span className={`ml-1.5 text-[11px] font-semibold ${c.o.type === 'call' ? 'text-profit' : 'text-loss'}`}>{c.o.type === 'call' ? 'C' : 'P'}</span>
                      </td>
                      <td><SideBadge side={c.p.side} /></td>
                      <td className="r num">{c.p.quantity}</td>
                      <td className="r num text-text-secondary">{fmtPrice(c.p.avgPrice)}</td>
                      <td className="r num">{fmtPrice(c.p.currentPrice)}</td>
                      <td className="r num text-text-secondary">{c.vol != null ? `${(c.vol * 100).toFixed(1)}%` : '—'}</td>
                      <td className="r num">
                        {c.est == null ? '—' : <>{fmt(c.est)}{chg != null && <span className={`ml-1.5 text-[11px] ${pnlClass(chg * c.sign)}`}>{chg >= 0 ? '+' : '−'}{Math.abs(chg).toFixed(0)}%</span>}</>}
                      </td>
                      <td className="r">
                        {c.expired ? <span className="text-delayed text-[12px]">{tr('届时已到期', 'Expired by then')}</span>
                          : c.limit == null ? '—' : (
                          <span className="inline-flex items-center gap-1.5">
                            <span className={`text-[11px] px-1.5 py-0.5 rounded ${c.sign > 0 ? 'bg-loss/10 text-loss' : 'bg-profit/10 text-profit'}`}>
                              {c.sign > 0 ? tr('卖出平仓', 'Sell to close') : tr('买入平仓', 'Buy to close')}
                            </span>
                            <span className="num font-semibold text-[14px] text-text-primary">{fmt(c.limit)}</span>
                            <span className="text-[10px] text-text-muted">{ccy}</span>
                          </span>
                        )}
                        {!c.knownTick && !c.expired && c.limit != null && <div className="text-[10px] text-text-muted">{tr('tick 未知，请按交易所规则取整', 'tick unknown — round per venue rules')}</div>}
                      </td>
                      <td className={`r num font-medium ${pnlClass(c.pnl ?? 0)}`}>{c.pnl == null || c.expired ? '—' : fmtSigned(c.pnl)}</td>
                      {horizons.map((h) => {
                        const v = now + h * 3_600_000 < c.exp ? c.priceAt(h) : null;
                        return <td key={h} className={`r num text-[12px] ${h === hours ? 'text-text-primary font-medium' : 'text-text-secondary'}`}>{v == null ? '—' : fmt(v)}</td>;
                      })}
                    </tr>
                  );
                })}
              </tbody>
              {calc.length > 1 && (
                <tfoot>
                  <tr>
                    <td colSpan={9} className="!pl-5 py-3 text-[12px] text-text-secondary">{tr('合计（按建议挂单价全部成交）', 'Total (if all fill at the suggested limits)')}</td>
                    <td className={`r num font-semibold py-3 ${pnlClass(totalPnl)}`}>{fmtSigned(totalPnl)}</td>
                    <td colSpan={horizons.length} />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <div className="px-5 py-3 text-[11.5px] leading-relaxed text-text-muted border-t border-border-card space-y-1">
            <p>{tr(
              '估值 = Black-Scholes（IV 由当前标记价反推，r = 0）。右侧各列为同一目标价在不同时间点的估值：时间越晚，时间价值损耗越多，期权越便宜。',
              'Estimate = Black-Scholes (IV implied from the current mark, r = 0). The right-hand columns show the same target at later times — the later it arrives, the more time value has decayed.',
            )}</p>
            <p>{tr(
              '挂单提示：现在挂限价单，期权价格先到挂单价就会成交（IV 飙升时可能在标的到目标前就成交）；若标的到达目标的时间晚于预期，期权价格会低于挂单价而不成交——想确保成交，请按最晚预计到达时间计算。',
              'Order note: a resting limit fills as soon as the option trades at that price (an IV spike can fill it before the underlying reaches the target). If the target is reached later than assumed, the option will be cheaper and may not fill — use your latest expected arrival time to be safe.',
            )}</p>
          </div>
        </>
      )}
    </section>
  );
}
