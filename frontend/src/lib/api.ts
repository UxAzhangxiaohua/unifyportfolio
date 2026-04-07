import type { PortfolioResponse, HistoryResponse, MetricsResponse, TradesResponse, TimePeriod } from '../types';

export async function fetchPortfolio(): Promise<PortfolioResponse> {
  const res = await fetch('/api/portfolio');
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export async function fetchHistory(period: TimePeriod, accountId?: string): Promise<HistoryResponse> {
  const params = new URLSearchParams({ period });
  if (accountId) params.set('accountId', accountId);
  const res = await fetch(`/api/history?${params}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export interface AccountOption {
  accountId: string;
  label: string;
  exchange: string;
}

export async function fetchHistoryAccounts(): Promise<AccountOption[]> {
  const res = await fetch('/api/history/accounts');
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export async function fetchMetrics(): Promise<MetricsResponse> {
  const res = await fetch('/api/metrics');
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export async function fetchTrades(): Promise<TradesResponse> {
  const res = await fetch('/api/trades');
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}
