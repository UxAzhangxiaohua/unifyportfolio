import type { PortfolioResponse, HistoryResponse, MetricsResponse, TimePeriod } from '../types';

export async function fetchPortfolio(): Promise<PortfolioResponse> {
  const res = await fetch('/api/portfolio');
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export async function fetchHistory(period: TimePeriod): Promise<HistoryResponse> {
  const res = await fetch(`/api/history?period=${period}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export async function fetchMetrics(): Promise<MetricsResponse> {
  const res = await fetch('/api/metrics');
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}
