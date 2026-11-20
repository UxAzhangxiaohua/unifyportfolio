import type { ExchangeType } from '../types';

export const EXCHANGES: Record<ExchangeType, { name: string; short: string; color: string }> = {
  binance: { name: 'Binance', short: 'BN', color: '#F0B90B' },
  okx: { name: 'OKX', short: 'OKX', color: '#A3ABBD' },
  bybit: { name: 'Bybit', short: 'BB', color: '#FF6B3D' },
  bitget: { name: 'Bitget', short: 'BG', color: '#3AA8F5' },
  hyperliquid: { name: 'Hyperliquid', short: 'HL', color: '#5EEAD4' },
  ibkr: { name: 'IBKR', short: 'IB', color: '#6E8BFF' },
};

export const EXCHANGE_ORDER: ExchangeType[] = ['binance', 'okx', 'bybit', 'bitget', 'hyperliquid', 'ibkr'];

export const LOCATION_LABEL = { trading: '交易账户', funding: '资金账户', earn: '理财' } as const;
