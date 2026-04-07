import { useQuery } from '@tanstack/react-query';
import { fetchPortfolio, fetchHistory, fetchMetrics } from '../lib/api';
import type { TimePeriod } from '../types';

export function usePortfolio() {
  return useQuery({
    queryKey: ['portfolio'],
    queryFn: fetchPortfolio,
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
}

export function useHistory(period: TimePeriod) {
  return useQuery({
    queryKey: ['history', period],
    queryFn: () => fetchHistory(period),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

export function useMetrics() {
  return useQuery({
    queryKey: ['metrics'],
    queryFn: fetchMetrics,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}
