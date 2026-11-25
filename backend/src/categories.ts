import type { AssetClass, TradeCategory } from './types.js';

// 'xau' = gold; other commodities and FX (none traded so far) land there too. Indices are stocks.

// Trade category by instrument. Venue metadata wins where a connector has it (Bybit symbolType,
// Binance underlyingType, OKX instCategory, Hyperliquid HIP-3 dexes); this name-based guess is
// the fallback (MT5 symbols, inferred trades, venues without metadata).

/** Commodities, metals, energy (incl. tokenised gold) */
const COMMODITIES = new Set([
  'XAU', 'XAG', 'XPT', 'XPD', 'XAUT', 'PAXG', 'GOLD', 'SILVER', 'PLATINUM', 'PALLADIUM', 'COPPER', 'XCU', 'ALUMINIUM', 'ALUMINUM',
  'NICKEL', 'ZINC', 'WTI', 'BRENT', 'USOIL', 'UKOIL', 'OIL', 'CL', 'BZ', 'NG', 'XNG', 'NATGAS', 'NGAS', 'GAS', 'COCOA', 'COFFEE',
  'SUGAR', 'WHEAT', 'CORN', 'SOYBEAN', 'COTTON', 'URANIUM',
]);
const FX = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'NZD', 'CAD', 'SGD', 'HKD', 'CNH', 'SEK', 'NOK', 'DKK', 'PLN', 'ZAR', 'MXN', 'TRY', 'HUF', 'CZK', 'BRL', 'KRW', 'INR']);
/** Stock indices (CFD / HIP-3 names) — grouped with stocks */
const INDICES = /^(US30|US500|USTEC|NAS100|US100|NDX|SPX500|SP500|DJ30|DE30|DE40|GER40|UK100|FR40|EU50|STOXX50|JP225|JPN225|HK50|HSI|AUS200|CN50|CHINA50|IN50|XYZ100|VIX|DXY|USDX)$/;
/** Crypto bases that appear on CFD / TradFi venues */
const CRYPTO = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'ADA', 'LTC', 'BCH', 'DOT', 'LINK', 'AVAX', 'TRX', 'XLM', 'TON', 'SHIB', 'UNI', 'ETC', 'XMR', 'ZEC', 'NEAR', 'HYPE']);

/** Strip venue decoration: "xyz:NVDA" → NVDA, "XAUUSDm" → XAUUSD, "NVDA-USDT-SWAP" / "NVDAUSDT" → NVDA */
function root(symbol: string): string {
  let s = symbol.replace(/^[A-Za-z0-9]+:/, '');
  s = s.replace(/\.[A-Za-z0-9]+$/, '').replace(/[a-z]+$/, '').toUpperCase();
  s = s.replace(/-(USDT|USDC|USD)-(SWAP|\d{6})$/, '').replace(/[-_]?PERP$/, '');
  return s;
}

export function guessCategory(symbol: string, assetClass?: AssetClass): TradeCategory {
  if (assetClass === 'option') return 'option';
  const s = root(symbol);
  // 1000-style / lowercase-k multipliers on crypto (1000PEPEUSDT, kPEPE); KAITO / KAS keep their K
  const kPrefixed = /^(?:[A-Za-z0-9]+:)?k[A-Z]/.test(symbol);
  const base = (kPrefixed ? s.slice(1) : s).replace(/^1000+(?=[A-Z])/, '').replace(/(USDT|USDC|USD)$/, '');
  if (COMMODITIES.has(base) || COMMODITIES.has(s)) return 'xau';
  // FX pair: two ISO currencies (EURUSD, USDJPY)
  if (s.length === 6 && FX.has(s.slice(0, 3)) && FX.has(s.slice(3))) return 'xau';
  if (/^(XAU|XAG|XPT|XPD)/.test(s)) return 'xau';
  if (INDICES.test(s) || INDICES.test(base)) return 'stock';
  if (CRYPTO.has(base)) return 'crypto';
  // HIP-3 builder dexes ("xyz:NVDA") list TradFi assets
  if (/^[A-Za-z0-9]+:/.test(symbol)) return 'stock';
  // CFDs that aren't commodities, FX or crypto are stock / index CFDs
  if (assetClass === 'cfd') return 'stock';
  return 'crypto';
}
