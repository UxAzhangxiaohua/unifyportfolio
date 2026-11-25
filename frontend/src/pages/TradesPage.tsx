import { TradesHistory } from '../components/TradesHistory';
import { EquityChart } from '../components/EquityChart';

/** 交易: closed-trade stats + cumulative realized PnL, then the trading-account equity curve and the trade list */
export function TradesPage() {
  return <TradesHistory afterSummary={<EquityChart fixedScope="trading" defaultPeriod="1w" />} />;
}
