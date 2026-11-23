import type { PortfolioResponse } from '../types';
import { EXCHANGES } from '../lib/exchanges';
import { StatusDot } from './ui';
import { timeAgo } from '../lib/format';
import { tr, locale, setLang, useLang } from '../lib/i18n';

export function Header({ data }: { data: PortfolioResponse }) {
  const errors = data.accounts.filter((a) => a.error);
  const lang = useLang();
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 pb-2">
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-[10px] bg-gradient-to-br from-accent to-[#5eead4] grid place-items-center text-[#0b0d12] font-bold text-sm shadow-[0_0_24px_rgba(139,156,255,0.25)]">
          U
        </div>
        <div>
          <div className="text-[15px] font-semibold tracking-tight">UnifyPortfolio</div>
          <div className="text-[11.5px] text-text-muted">
            {tr(`${data.accounts.length} 个账户`, `${data.accounts.length} accounts`)} · {tr('更新于', 'updated')} {new Date(data.timestamp).toLocaleTimeString(locale(), { hour12: false })}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <div className="seg mr-1" role="group" aria-label="Language">
          <button data-active={lang === 'zh'} onClick={() => setLang('zh')}>中</button>
          <button data-active={lang === 'en'} onClick={() => setLang('en')}>EN</button>
        </div>
        {[...data.accounts].sort((a, b) => b.equity - a.equity).map((a) => {
          const status = a.error ? 'error' : a.isDelayed ? 'delayed' : 'ok';
          const tip = a.error
            ? tr(`${a.label}\n错误：${a.error}\n显示的是 ${timeAgo(a.fetchedAt)} 的数据`, `${a.label}\nError: ${a.error}\nShowing data from ${timeAgo(a.fetchedAt)}`)
            : `${a.label}\n${tr('更新于', 'Updated')} ${timeAgo(a.fetchedAt)}${a.warnings?.length ? `\n\n${tr('提示：', 'Warnings:')}\n${a.warnings.join('\n')}` : ''}`;
          return (
            <span key={a.accountId} title={tip}
              className={`chip inline-flex items-center gap-1.5 ${a.error ? 'border-loss/30 text-loss bg-loss/5' : ''}`}>
              <StatusDot status={status} />
              <span style={{ color: a.error ? undefined : EXCHANGES[a.exchange].color }}>{EXCHANGES[a.exchange].short}</span>
              <span className="hidden sm:inline text-text-muted">{a.label.replace(EXCHANGES[a.exchange].name, '').trim() || ''}</span>
              {a.warnings?.length ? <span className="text-delayed">!</span> : null}
            </span>
          );
        })}
      </div>

      {errors.length > 0 && (
        <div className="w-full text-[12px] text-loss/90 bg-loss/5 border border-loss/20 rounded-lg px-3 py-2">
          {errors.map((a) => (
            <div key={a.accountId} className="truncate">
              <span className="font-medium">{a.label}</span> {tr('拉取失败：', 'fetch failed: ')}{a.error}
              <span className="text-text-muted"> {tr(`（显示 ${timeAgo(a.fetchedAt)} 的数据）`, `(showing data from ${timeAgo(a.fetchedAt)})`)}</span>
            </div>
          ))}
        </div>
      )}
    </header>
  );
}
