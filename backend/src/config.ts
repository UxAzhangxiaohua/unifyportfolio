import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig, ExchangeType, AccountConfig } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const VALID_EXCHANGES: ExchangeType[] = ['ibkr', 'binance', 'okx', 'hyperliquid'];

const REQUIRED_CREDENTIAL_FIELDS: Record<ExchangeType, string[]> = {
  ibkr: ['flexQueryId', 'flexToken'],
  binance: ['apiKey', 'apiSecret'],
  okx: ['apiKey', 'apiSecret', 'passphrase'],
  hyperliquid: ['walletAddress'],
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

  const accounts = parsed.accounts.map((a, i) => validateAccount(a, i));

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
    accounts,
  };

  console.log(`Loaded ${accounts.length} account(s) from ${configPath}`);
  for (const a of accounts) {
    console.log(`  - ${a.id} (${a.exchange}): ${a.label}`);
  }

  return Object.freeze(config) as AppConfig;
}
