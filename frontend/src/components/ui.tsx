import type { ReactNode } from 'react';
import type { ExchangeType } from '../types';
import { EXCHANGES } from '../lib/exchanges';
import { tr } from '../lib/i18n';

export function ExchangeTag({ exchange, label }: { exchange: ExchangeType; label?: string }) {
  const ex = EXCHANGES[exchange];
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: ex.color }} />
      <span className="text-text-secondary truncate">{label ?? ex.name}</span>
    </span>
  );
}

export function SideBadge({ side }: { side: 'long' | 'short' | 'flat' }) {
  const cls =
    side === 'long' ? 'bg-profit/12 text-profit' :
    side === 'short' ? 'bg-loss/12 text-loss' : 'bg-white/5 text-text-secondary';
  const label = side === 'long' ? tr('多', 'L') : side === 'short' ? tr('空', 'S') : '—';
  return <span className={`inline-flex items-center justify-center w-6 h-5 rounded text-[11px] font-semibold ${cls}`}>{label}</span>;
}

export function CardHeader({ title, sub, right }: { title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4 pb-3">
      <div className="flex items-baseline gap-2.5 min-w-0">
        <h2 className="section-title">{title}</h2>
        {sub && <span className="text-[12px] text-text-muted truncate">{sub}</span>}
      </div>
      {right && <div className="flex items-center gap-2 flex-wrap">{right}</div>}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: {
  value: T; options: Array<{ value: T; label: ReactNode }>; onChange: (v: T) => void;
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.value} data-active={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="px-5 pb-8 pt-4 text-center text-[13px] text-text-muted">{children}</div>;
}

export function StatusDot({ status }: { status: 'ok' | 'delayed' | 'error' }) {
  const color = status === 'ok' ? 'bg-profit' : status === 'delayed' ? 'bg-delayed' : 'bg-loss';
  return (
    <span className="relative inline-flex w-2 h-2">
      {status === 'ok' && <span className={`absolute inset-0 rounded-full ${color} opacity-40 animate-ping`} />}
      <span className={`relative w-2 h-2 rounded-full ${color}`} />
    </span>
  );
}
