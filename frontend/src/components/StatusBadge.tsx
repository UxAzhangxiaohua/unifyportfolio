import type { AccountSnapshot } from '../types';

export function StatusBadge({ accounts }: { accounts: AccountSnapshot[] }) {
  const hasError = accounts.some(a => a.error);
  const isDelayed = accounts.some(a => a.isDelayed);

  if (hasError) return <span className="text-[10px] px-1.5 py-0.5 rounded bg-loss/15 text-loss font-medium">ERROR</span>;
  if (isDelayed) return <span className="text-[10px] px-1.5 py-0.5 rounded bg-delayed/15 text-delayed font-medium">DELAYED</span>;
  return <span className="text-[10px] px-1.5 py-0.5 rounded bg-profit/15 text-profit font-medium">LIVE</span>;
}
