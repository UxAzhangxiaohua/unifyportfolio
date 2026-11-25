import { TradesHistory } from '../components/TradesHistory';
import { EquityChart } from '../components/EquityChart';

/** 交易: category tiles → stats + cumulative realized PnL → category / instrument breakdown → trade list; trading-account equity at the end */
export function TradesPage() {
  return (
    <>
      <TradesHistory />
      <EquityChart fixedScope="trading" defaultPeriod="1w" />
    </>
  );
}
