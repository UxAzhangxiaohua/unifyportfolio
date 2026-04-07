import type { PortfolioResponse } from '../types';

export async function fetchPortfolio(): Promise<PortfolioResponse> {
  const res = await fetch('/api/portfolio');
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}
