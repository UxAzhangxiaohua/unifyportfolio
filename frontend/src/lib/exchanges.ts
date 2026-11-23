import type { ExchangeType } from '../types';
import { tr } from './i18n';

export const EXCHANGES: Record<ExchangeType, { name: string; short: string; color: string }> = {
  binance: { name: 'Binance', short: 'BN', color: '#F0B90B' },
  okx: { name: 'OKX', short: 'OKX', color: '#A3ABBD' },
  bybit: { name: 'Bybit', short: 'BB', color: '#FF6B3D' },
  bitget: { name: 'Bitget', short: 'BG', color: '#3AA8F5' },
  hyperliquid: { name: 'Hyperliquid', short: 'HL', color: '#5EEAD4' },
  ibkr: { name: 'IBKR', short: 'IB', color: '#6E8BFF' },
  mt5: { name: 'MT5', short: 'MT5', color: '#C084FC' },
};

export const EXCHANGE_ORDER: ExchangeType[] = ['binance', 'okx', 'bybit', 'bitget', 'hyperliquid', 'mt5', 'ibkr'];

export const locationLabel = (l: 'trading' | 'funding' | 'earn') =>
  ({ trading: tr('交易账户', 'Trading'), funding: tr('资金账户', 'Funding'), earn: tr('理财', 'Earn') })[l];
