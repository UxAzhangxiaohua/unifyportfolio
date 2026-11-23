import type { AccountSnapshot, AlertsConfig } from './types.js';

// CFD margin-level alerts → Discord webhook.
// Each CFD sub-account sits in a tier = how many thresholds its margin level is below
// (default thresholds 150 / 100 / 80 %). An alert fires when the tier worsens; it goes back
// to a better tier only once the level is HYSTERESIS points above that threshold, so a level
// hovering around a line doesn't spam. Recovering above all thresholds sends one all-clear.
// State is in memory: after a restart an account already below a threshold alerts once more.

const HYSTERESIS = 5;
const DEFAULT_LEVELS = [150, 100, 80];

let webhook: string | null = null;
let levels: number[] = DEFAULT_LEVELS;
const tiers = new Map<string, number>();

export function initAlerts(cfg: AlertsConfig | undefined): void {
  webhook = cfg?.discordWebhook?.trim() || null;
  if (Array.isArray(cfg?.marginLevels) && cfg.marginLevels.length) {
    levels = cfg.marginLevels.filter((n) => typeof n === 'number' && n > 0).sort((a, b) => b - a);
  }
  console.log(webhook
    ? `[alerts] Discord margin-level alerts on: < ${levels.join('% / < ')}%`
    : '[alerts] no alerts.discordWebhook configured — margin-level alerts off');
}

const tierOf = (lvl: number | null) => (lvl == null ? 0 : levels.filter((t) => lvl < t).length);

export function checkMarginAlerts(s: AccountSnapshot): void {
  if (!webhook || s.error) return;
  for (const c of s.cfd ?? []) {
    if (c.equityOnly) continue;
    const key = `${s.accountId}|${c.name}`;
    const prev = tiers.get(key) ?? 0;
    const lvl = c.marginLevel;
    let tier = tierOf(lvl);
    if (tier < prev) {
      // Improve only past the hysteresis band of the threshold being left
      const line = levels[prev - 1];
      if (lvl != null && lvl < line + HYSTERESIS) tier = prev;
    }
    if (tier === prev) continue;
    tiers.set(key, tier);
    const kind = tier > prev ? 'worse' : tier === 0 ? 'clear' : null;
    // A failed send rolls the tier back so the next poll retries it
    if (kind) void send(s, c, tier, kind).then((ok) => { if (!ok && tiers.get(key) === tier) tiers.set(key, prev); });
  }
}

const fmt = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function send(s: AccountSnapshot, c: NonNullable<AccountSnapshot['cfd']>[number], tier: number, kind: 'worse' | 'clear'): Promise<boolean> {
  const lvl = c.marginLevel;
  const lvlText = lvl == null ? '—' : `${lvl.toFixed(1)}%`;
  const severe = tier === levels.length;
  const title = kind === 'clear'
    ? `✅ 保证金率已恢复 ${lvlText}（≥ ${levels[0]}%）`
    : `${severe ? '🚨' : '⚠️'} 保证金率 ${lvlText} < ${levels[tier - 1]}%`;
  const color = kind === 'clear' ? 0x22c55e : severe ? 0xef4444 : tier >= 2 ? 0xf97316 : 0xeab308;
  const body = {
    content: severe && kind === 'worse' ? '@here' : undefined,
    allowed_mentions: { parse: severe && kind === 'worse' ? ['everyone'] : [] },
    embeds: [{
      title,
      description: `**${s.label}**${c.name && c.name !== 'MT5' ? ` · ${c.name}` : ''}`,
      color,
      fields: [
        { name: '权益', value: fmt(c.equity), inline: true },
        { name: `已用保证金${c.marginEstimated ? '（估算）' : ''}`, value: fmt(c.usedMargin), inline: true },
        { name: '浮动盈亏', value: `${c.floatingPnl >= 0 ? '+' : ''}${fmt(c.floatingPnl)}`, inline: true },
        { name: '实际杠杆', value: c.effectiveLeverage == null ? '—' : `${c.effectiveLeverage.toFixed(1)}x`, inline: true },
        { name: '名义敞口', value: fmt(c.notional), inline: true },
      ],
      timestamp: new Date().toISOString(),
    }],
  };
  try {
    const res = await fetch(webhook!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'unifyportfolio-alerts' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`[alerts] Discord webhook HTTP ${res.status}: ${(await res.text()).substring(0, 200)}`);
      return false;
    }
    console.log(`[alerts] sent: ${s.accountId} ${title}`);
    return true;
  } catch (err) {
    console.error(`[alerts] Discord webhook failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
