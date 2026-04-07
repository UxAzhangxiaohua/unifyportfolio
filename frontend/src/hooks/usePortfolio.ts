import { useQuery } from '@tanstack/react-query';
import { fetchPortfolio, fetchHistory, fetchMetrics, fetchTrades, fetchHistoryAccounts } from '../lib/api';
import type { TimePeriod } from '../types';

export function usePortfolio() {
  return useQuery({
    queryKey: ['portfolio'],
    queryFn: fetchPortfolio,
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
}

export function useHistory(period: TimePeriod, accountId?: string) {
  return useQuery({
    queryKey: ['history', period, accountId ?? 'total'],
    queryFn: () => fetchHistory(period, accountId),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

export function useHistoryAccounts() {
  return useQuery({
    queryKey: ['history-accounts'],
    queryFn: fetchHistoryAccounts,
    refetchInterval: 60_000,
    staleTime: 30_000,
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

export function useTrades() {
  return useQuery({
    queryKey: ['trades'],
    queryFn: fetchTrades,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}
