import type { PortfolioResponse } from '../types';
import { AssetKpis } from '../components/KpiRow';
import { AllocationPanel } from '../components/AllocationPanel';
import { EquityChart } from '../components/EquityChart';
import { MetricsRow } from '../components/MetricsRow';
import { AccountsGrid } from '../components/AccountsGrid';
import { StablesPanel } from '../components/StablesPanel';
import { OtherHoldings } from '../components/OtherHoldings';
import { TransfersPanel } from '../components/TransfersPanel';
import { PayoutsPanel } from '../components/PayoutsPanel';

/** 账户: total assets, where they sit, the equity curve, deposits / withdrawals */
export function AccountsPage({ data }: { data: PortfolioResponse }) {
  return (
    <>
      <AssetKpis data={data} />
      <EquityChart />
      <MetricsRow />
      <AllocationPanel data={data} />
      <AccountsGrid accounts={data.accounts} total={data.totalEquity} />
      <StablesPanel accounts={data.accounts} />
      <OtherHoldings accounts={data.accounts} />
      <TransfersPanel />
      <PayoutsPanel />
    </>
  );
}
