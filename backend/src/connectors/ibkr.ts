import { XMLParser } from 'fast-xml-parser';
import { BaseConnector } from './base.js';
import type { AccountConfig, AccountSnapshot, IBKRCredentials, Position } from '../types.js';

const FLEX_BASE = 'https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => {
    // These elements can have multiple entries
    return ['OpenPosition', 'MTMPerformanceSummaryUnderlying', 'CashReportCurrency'].includes(name);
  },
});

export class IBKRConnector extends BaseConnector {
  private flexToken: string;
  private flexQueryId: string;

  constructor(account: AccountConfig) {
    super(account);
    const creds = account.credentials as IBKRCredentials;
    this.flexToken = creds.flexToken;
    this.flexQueryId = creds.flexQueryId;
  }

  async fetch(): Promise<AccountSnapshot> {
    try {
      // Step 1: Request the flex statement
      const referenceCode = await this.sendRequest();

      // Step 2: Poll for the result with exponential backoff
      const xml = await this.pollForStatement(referenceCode);

      // Step 3: Parse the XML
      return this.parseFlexStatement(xml);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ibkr] ${this.account.id}: ${msg}`);
      return this.makeErrorSnapshot(msg);
    }
  }

  private async sendRequest(): Promise<string> {
    const url = `${FLEX_BASE}.SendRequest?t=${this.flexToken}&q=${this.flexQueryId}&v=3`;
    const res = await fetch(url);
    const text = await res.text();

    // Parse XML response to get reference code
    const parsed = xmlParser.parse(text);
    const response = parsed.FlexStatementResponse;

    if (!response) {
      throw new Error(`Unexpected IBKR response: ${text.substring(0, 200)}`);
    }

    if (response.Status === 'Success' || response.Status === 'Warn') {
      return response.ReferenceCode;
    }

    throw new Error(`IBKR SendRequest failed: ${response.ErrorMessage || response.Status}`);
  }

  private async pollForStatement(referenceCode: string): Promise<string> {
    const delays = [3000, 5000, 8000, 15000, 30000]; // Backoff schedule

    for (const delay of delays) {
      await this.sleep(delay);

      const url = `${FLEX_BASE}.GetStatement?t=${this.flexToken}&q=${referenceCode}&v=3`;
      const res = await fetch(url);
      const text = await res.text();

      // Check if it's still generating
      if (text.includes('Statement generation in progress')) {
        continue;
      }

      // Check for XML statement
      if (text.includes('FlexQueryResponse') || text.includes('FlexStatements')) {
        return text;
      }

      // Check for error
      const parsed = xmlParser.parse(text);
      if (parsed.FlexStatementResponse?.ErrorMessage) {
        throw new Error(`IBKR: ${parsed.FlexStatementResponse.ErrorMessage}`);
      }
    }

    throw new Error('IBKR: Flex Query timed out after multiple retries');
  }

  private parseFlexStatement(xml: string): AccountSnapshot {
    const parsed = xmlParser.parse(xml);

    // Navigate to the statement data
    const flexStatements = parsed.FlexQueryResponse?.FlexStatements;
    const rawStatement = flexStatements?.FlexStatement;

    if (!rawStatement) {
      throw new Error('IBKR: Could not parse FlexStatement from response');
    }

    // Flex Query may return multiple sub-accounts — normalize to array
    const statements = Array.isArray(rawStatement) ? rawStatement : [rawStatement];

    const positions: Position[] = [];
    let totalEquity = 0;
    let availableCash = 0;
    let totalUnrealizedPnl = 0;

    for (const statement of statements) {
      // Parse open positions
      const openPositions = statement.OpenPositions?.OpenPosition;
      if (openPositions) {
        const posArray = Array.isArray(openPositions) ? openPositions : [openPositions];
        for (const op of posArray) {
          const qty = parseFloat(op['@_position'] || op.position || '0');
          if (qty === 0) continue;

          const markPrice = parseFloat(op['@_markPrice'] || op.markPrice || '0');
          const costBasis = parseFloat(op['@_costBasisPrice'] || op.costBasisPrice || '0');
          const fifoPnl = parseFloat(op['@_fifoPnlUnrealized'] || op.fifoPnlUnrealized || '0');
          const mktValue = parseFloat(op['@_positionValue'] || op.positionValue || '0');
          const assetCategory = (op['@_assetCategory'] || op.assetCategory || '').toUpperCase();

          let assetClass: Position['assetClass'];
          if (assetCategory === 'STK') {
            assetClass = 'stock';
          } else if (assetCategory === 'ETF' || (op['@_description'] || '').includes('ETF')) {
            assetClass = 'etf';
          } else {
            assetClass = 'stock'; // Default for IBKR
          }

          positions.push({
            symbol: op['@_symbol'] || op.symbol || 'UNKNOWN',
            side: qty > 0 ? 'long' : 'short',
            quantity: Math.abs(qty),
            avgPrice: costBasis,
            currentPrice: markPrice,
            unrealizedPnl: fifoPnl,
            marketValue: Math.abs(mktValue),
            leverage: null,
            liquidationPrice: null,
            assetClass,
          });

          totalUnrealizedPnl += fifoPnl;
        }
      }

      // Parse cash report for equity
      const cashReport = statement.CashReport?.CashReportCurrency;
      if (cashReport) {
        const cashArray = Array.isArray(cashReport) ? cashReport : [cashReport];
        for (const cr of cashArray) {
          const currency = cr['@_currency'] || cr.currency || '';
          if (currency === 'BASE_SUMMARY') {
            totalEquity += parseFloat(cr['@_endingCash'] || cr.endingCash || '0');
            availableCash += parseFloat(cr['@_endingCash'] || cr.endingCash || '0');
          }
        }
      }
    }

    // Add position market values to equity (cash + positions = total equity)
    const positionValue = positions.reduce((s, p) => s + p.marketValue, 0);
    totalEquity += positionValue;

    return {
      accountId: this.account.id,
      exchange: 'ibkr',
      label: this.account.label,
      equity: totalEquity,
      availableBalance: availableCash,
      unrealizedPnl: totalUnrealizedPnl,
      marginUsed: null,
      marginRatio: null,
      positions,
      fetchedAt: new Date().toISOString(),
      isDelayed: true, // Flex Query data is always delayed
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
