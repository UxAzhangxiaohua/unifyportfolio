import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig, ExchangeType, AccountConfig } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const VALID_EXCHANGES: ExchangeType[] = ['ibkr', 'binance', 'okx', 'hyperliquid', 'bybit', 'bitget', 'mt5'];

const REQUIRED_CREDENTIAL_FIELDS: Record<ExchangeType, string[]> = {
  ibkr: ['flexQueryId', 'flexToken'],
  binance: ['apiKey', 'apiSecret'],
  okx: ['apiKey', 'apiSecret', 'passphrase'],
  hyperliquid: ['walletAddress'],
  bybit: ['apiKey', 'apiSecret'],
  bitget: ['apiKey', 'apiSecret', 'passphrase'],
  mt5: ['password', 'server'],
};

function validateAccount(account: unknown, index: number): AccountConfig {
  const a = account as Record<string, unknown>;

  if (!a.id || typeof a.id !== 'string') {
    throw new Error(`accounts[${index}]: missing or invalid "id"`);
  }
  if (!a.exchange || !VALID_EXCHANGES.includes(a.exchange as ExchangeType)) {
    throw new Error(`accounts[${index}] (${a.id}): invalid "exchange" — must be one of: ${VALID_EXCHANGES.join(', ')}`);
  }
  if (!a.label || typeof a.label !== 'string') {
    throw new Error(`accounts[${index}] (${a.id}): missing or invalid "label"`);
  }
  if (!a.credentials || typeof a.credentials !== 'object') {
    throw new Error(`accounts[${index}] (${a.id}): missing "credentials"`);
  }

  const exchange = a.exchange as ExchangeType;
  const creds = a.credentials as Record<string, unknown>;
  const requiredFields = REQUIRED_CREDENTIAL_FIELDS[exchange];

  for (const field of requiredFields) {
    if (!creds[field] || typeof creds[field] !== 'string') {
      throw new Error(`accounts[${index}] (${a.id}): credentials missing "${field}" for ${exchange}`);
    }
  }
  if (exchange === 'mt5' && !/^\d+$/.test(String(creds.login ?? '').trim())) {
    throw new Error(`accounts[${index}] (${a.id}): credentials "login" must be the numeric MT5 account number`);
  }

  return a as unknown as AccountConfig;
}

export function loadConfig(): AppConfig {
  const configPath = process.env.CONFIG_PATH || resolve(__dirname, '../../accounts.json');

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    throw new Error(
      `Cannot read config file at ${configPath}. ` +
      `Copy accounts.example.json to accounts.json and fill in your credentials.`
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in config file: ${configPath}`);
  }

  if (!Array.isArray(parsed.accounts) || parsed.accounts.length === 0) {
    throw new Error('Config must have a non-empty "accounts" array');
  }

  // Skip accounts whose credentials are still placeholders (e.g. "YOUR_API_KEY")
  const isPlaceholder = (a: Record<string, unknown>) =>
    Object.entries((a.credentials ?? {}) as Record<string, unknown>).some(([k, v]) => k !== 'host' && (
        typeof v === 'string' && (v.trim() === '' || v.startsWith('YOUR_') || v.startsWith('0xYOUR_'))),
    );
  const accounts = (parsed.accounts as Record<string, unknown>[])
    .filter((a) => {
      if (a.enabled === false) {
        console.log(`  - skipping ${String(a.id)}: disabled ("enabled": false)`);
        return false;
      }
      if (isPlaceholder(a)) {
        console.log(`  - skipping ${String(a.id)}: credentials not filled in`);
        return false;
      }
      return true;
    })
    .map((a, i) => validateAccount(a, i));

  if (accounts.length === 0) {
    throw new Error('No accounts with filled-in credentials');
  }

  // Check for duplicate IDs
  const ids = new Set<string>();
  for (const a of accounts) {
    if (ids.has(a.id)) {
      throw new Error(`Duplicate account ID: "${a.id}"`);
    }
    ids.add(a.id);
  }

  const config: AppConfig = {
    pollIntervalSeconds: typeof parsed.pollIntervalSeconds === 'number' ? parsed.pollIntervalSeconds : 30,
    ibkrPollIntervalSeconds: typeof parsed.ibkrPollIntervalSeconds === 'number' ? parsed.ibkrPollIntervalSeconds : 300,
    mt5PollIntervalSeconds: typeof parsed.mt5PollIntervalSeconds === 'number' ? parsed.mt5PollIntervalSeconds : 60,
    alerts: parsed.alerts && typeof parsed.alerts === 'object' ? (parsed.alerts as AppConfig['alerts']) : undefined,
    accounts,
  };

  console.log(`Loaded ${accounts.length} account(s) from ${configPath}`);
  for (const a of accounts) {
    console.log(`  - ${a.id} (${a.exchange}): ${a.label}`);
  }

  return Object.freeze(config) as AppConfig;
}
