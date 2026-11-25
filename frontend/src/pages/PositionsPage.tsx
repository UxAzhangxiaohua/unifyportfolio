import type { PortfolioResponse } from '../types';
import { RiskKpis } from '../components/KpiRow';
import { AccountRiskCards } from '../components/AccountRiskCards';
import { ExposureByUnderlying } from '../components/ExposureByUnderlying';
import { PositionsTable } from '../components/PositionsTable';
import { CfdPanel } from '../components/CfdPanel';
import { OptionsTable } from '../components/OptionsTable';
import { OptionExitCalculator } from '../components/OptionExitCalculator';

/** 仓位: open derivatives and their risk */
export function PositionsPage({ data }: { data: PortfolioResponse }) {
  const accounts = data.accounts;
  const hasOptions = accounts.some((a) => a.positions.some((p) => p.assetClass === 'option'));
  return (
    <>
      <RiskKpis accounts={accounts} />
      <AccountRiskCards accounts={accounts} />
      <ExposureByUnderlying accounts={accounts} />
      <PositionsTable accounts={accounts} />
      <CfdPanel accounts={accounts} />
      {hasOptions && <OptionsTable accounts={accounts} />}
      <OptionExitCalculator accounts={accounts} />
    </>
  );
}
