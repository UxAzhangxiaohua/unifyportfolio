import { useSyncExternalStore } from 'react';

// Hash routing for the three top-level pages (#/positions, #/accounts, #/trades) — no router
// dependency; the hash survives a reload and works behind serve.cjs / any static host.
export type Page = 'positions' | 'accounts' | 'trades';
export const PAGES: Page[] = ['positions', 'accounts', 'trades'];

function parse(): Page {
  const h = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  return (PAGES as string[]).includes(h) ? (h as Page) : 'positions';
}

export function usePage(): Page {
  return useSyncExternalStore(
    (cb) => { window.addEventListener('hashchange', cb); return () => window.removeEventListener('hashchange', cb); },
    parse,
  );
}

export function goTo(p: Page) {
  if (parse() === p && location.hash) return;
  location.hash = `/${p}`;
  window.scrollTo({ top: 0 });
}
