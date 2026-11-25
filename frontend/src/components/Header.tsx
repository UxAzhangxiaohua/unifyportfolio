import { useEffect, useRef, useState } from 'react';
import type { PortfolioResponse } from '../types';
import { EXCHANGES } from '../lib/exchanges';
import { StatusDot } from './ui';
import { timeAgo } from '../lib/format';
import { tr, locale, setLang, useLang } from '../lib/i18n';
import { goTo, type Page } from '../lib/route';

const TABS: Array<{ key: Page; label: () => string }> = [
  { key: 'positions', label: () => tr('仓位', 'Positions') },
  { key: 'accounts', label: () => tr('账户', 'Accounts') },
  { key: 'trades', label: () => tr('交易', 'Trades') },
];

/** Sticky top bar: logo · page tabs · account status · language */
export function Header({ data, page }: { data: PortfolioResponse; page: Page }) {
  const lang = useLang();
  return (
    <header className="sticky top-0 z-30 border-b border-border-card bg-bg-primary/85 backdrop-blur-md">
      <div className="max-w-[1440px] mx-auto px-4 sm:px-6 h-14 flex items-center gap-2 sm:gap-6">
        <a href="#/positions" className="flex items-center gap-2.5 shrink-0" onClick={(e) => { e.preventDefault(); goTo('positions'); }}>
          <div className="w-7 h-7 rounded-[9px] bg-gradient-to-br from-accent to-[#5eead4] grid place-items-center text-[#0b0d12] font-bold text-[13px] shadow-[0_0_24px_rgba(139,156,255,0.25)]">
            U
          </div>
          <span className="hidden md:inline text-[14px] font-semibold tracking-tight">UnifyPortfolio</span>
        </a>

        <nav className="flex items-center gap-1 overflow-x-auto" aria-label={tr('页面', 'Pages')}>
          {TABS.map((t) => {
            const active = t.key === page;
            return (
              <a key={t.key} href={`#/${t.key}`} aria-current={active ? 'page' : undefined}
                onClick={(e) => { e.preventDefault(); goTo(t.key); }}
                className={`relative px-2.5 sm:px-3.5 h-14 inline-flex items-center text-[13.5px] font-medium whitespace-nowrap transition-colors ${active ? 'text-text-primary' : 'text-text-muted hover:text-text-secondary'}`}>
                {t.label()}
                {active && <span className="absolute inset-x-2.5 bottom-0 h-[2px] rounded-full bg-accent" />}
              </a>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2 shrink-0">
          <AccountStatus data={data} />
          <div className="seg" role="group" aria-label="Language">
            <button data-active={lang === 'zh'} onClick={() => setLang('zh')}>中</button>
            <button data-active={lang === 'en'} onClick={() => setLang('en')}>EN</button>
          </div>
        </div>
      </div>
    </header>
  );
}

/** "N accounts · updated hh:mm:ss" chip; click for every account's status */
function AccountStatus({ data }: { data: PortfolioResponse }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  const errors = data.accounts.filter((a) => a.error).length;
  const delayed = data.accounts.filter((a) => !a.error && (a.isDelayed || a.warnings?.length)).length;
  const status = errors ? 'error' : delayed ? 'delayed' : 'ok';

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className={`chip !py-1 inline-flex items-center gap-2 hover:border-border-hover ${errors ? '!border-loss/30 !text-loss' : ''}`}>
        <StatusDot status={status} />
        <span className={errors ? '' : 'hidden sm:inline'}>{errors ? tr(`${errors} 个账户出错`, `${errors} failing`) : tr(`${data.accounts.length} 个账户`, `${data.accounts.length} accounts`)}</span>
        <span className="hidden sm:inline num text-text-muted">{new Date(data.timestamp).toLocaleTimeString(locale(), { hour12: false })}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 w-[300px] max-h-[70vh] overflow-y-auto card shadow-2xl p-1.5 z-40">
          {[...data.accounts].sort((a, b) => b.equity - a.equity).map((a) => {
            const st = a.error ? 'error' : a.isDelayed ? 'delayed' : 'ok';
            return (
              <div key={a.accountId} className="px-2.5 py-2 rounded-lg hover:bg-white/[0.02] text-[12px]">
                <div className="flex items-center gap-2">
                  <StatusDot status={st} />
                  <span className="font-medium" style={{ color: EXCHANGES[a.exchange].color }}>{EXCHANGES[a.exchange].short}</span>
                  <span className="text-text-secondary truncate">{a.label}</span>
                  <span className="ml-auto text-text-muted whitespace-nowrap">{timeAgo(a.fetchedAt)}</span>
                </div>
                {a.error && <div className="mt-1 pl-4 text-loss/90 break-words">{a.error}</div>}
                {!a.error && a.warnings?.map((w, i) => <div key={i} className="mt-1 pl-4 text-delayed/90 break-words">{w}</div>)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Failing accounts, shown on every page under the bar */
export function ErrorBanner({ data }: { data: PortfolioResponse }) {
  const errors = data.accounts.filter((a) => a.error);
  if (!errors.length) return null;
  return (
    <div className="text-[12px] text-loss/90 bg-loss/5 border border-loss/20 rounded-lg px-3 py-2">
      {errors.map((a) => (
        <div key={a.accountId} className="truncate">
          <span className="font-medium">{a.label}</span> {tr('拉取失败：', 'fetch failed: ')}{a.error}
          <span className="text-text-muted"> {tr(`（显示 ${timeAgo(a.fetchedAt)} 的数据）`, `(showing data from ${timeAgo(a.fetchedAt)})`)}</span>
        </div>
      ))}
    </div>
  );
}
