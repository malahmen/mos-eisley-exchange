import { coingecko, coinbase, kraken, binance } from "./crypto.js";
import { yahoo, twelvedata, finnhub, alphavantage } from "./equity.js";
import { yahooFx, frankfurter } from "./fx.js";
import { feargreed, cgglobal, mempool } from "./btcextra.js";

// Listed in default priority order, per kind.
export const PROVIDERS = {
  equity: [yahoo, twelvedata, finnhub, alphavantage],
  crypto: [coingecko, coinbase, kraken, binance],
  fx: [yahooFx, frankfurter],
  btcextra: [feargreed, cgglobal, mempool],
};
export const KINDS = Object.keys(PROVIDERS);
export const CRYPTO_PROVIDERS = PROVIDERS.crypto;
export const EQUITY_PROVIDERS = PROVIDERS.equity;
export const ALL_PROVIDERS = KINDS.flatMap((k) => PROVIDERS[k]);
export const providerById = (id) => ALL_PROVIDERS.find((p) => p.id === id);
