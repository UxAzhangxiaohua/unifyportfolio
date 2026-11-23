import { useSyncExternalStore } from 'react';

// Minimal i18n: strings live inline as tr('中文', 'English').
// App subscribes via useLang(); since no component is React.memo'd, a language
// change re-renders the whole tree and every tr() call picks up the new value.
export type Lang = 'zh' | 'en';

const KEY = 'unify.lang';

function initial(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch { /* storage blocked */ }
  return navigator.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

let current: Lang = initial();
const listeners = new Set<() => void>();
const apply = () => { document.documentElement.lang = current === 'zh' ? 'zh-CN' : 'en'; };
apply();

export function setLang(l: Lang) {
  if (l === current) return;
  current = l;
  try { localStorage.setItem(KEY, l); } catch { /* ignore */ }
  apply();
  listeners.forEach((f) => f());
}

export const getLang = () => current;

export function useLang(): Lang {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => current,
  );
}

/** Pick the string for the current language */
export const tr = (zh: string, en: string) => (current === 'en' ? en : zh);

/** Locale tag for Date/Intl formatting */
export const locale = () => (current === 'en' ? 'en-US' : 'zh-CN');
