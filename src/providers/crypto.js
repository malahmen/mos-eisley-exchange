// Bitcoin price sources. All of these are public endpoints that need no API key.
// Each adapter: quote(currencies) -> [{ currency, price, changePct, high, low, volume, asOf }]
// and, where offered, history(currency, range) -> [[ms, price], ...].
import { getJson, num, mapLimit } from "./http.js";

// One table for every range the Bitcoin page offers.
export const BTC_RANGES = {
  "1d":  { ms: 86400_000,       cg: 1,   binance: ["5m", 288], kraken: 5 },
  "7d":  { ms: 7 * 86400_000,   cg: 7,   binance: ["1h", 168], kraken: 60 },
  "30d": { ms: 30 * 86400_000,  cg: 30,  binance: ["4h", 180], kraken: 240 },
  "90d": { ms: 90 * 86400_000,  cg: 90,  binance: ["1d", 90],  kraken: 1440 },
  "1y":  { ms: 365 * 86400_000, cg: 365, binance: ["1d", 365], kraken: 1440 },
};

export const coingecko = {
  id: "coingecko",
  name: "CoinGecko",
  kind: "crypto",
  needsKey: false,
  optionalKey: true, // a free "demo" key raises the rate limit
  defaultEnabled: true,
  site: "https://www.coingecko.com/en/api",
  note: "Aggregated price across exchanges, any fiat currency, and price history. Public rate limit is low; the server cache keeps within it.",
  headers: (key) => (key ? { "x-cg-demo-api-key": key } : {}),
  async quote(currencies, key) {
    const vs = currencies.map((c) => c.toLowerCase()).join(",");
    const d = await getJson(
      `https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=${vs}&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true&include_last_updated_at=true`,
      { provider: "coingecko", headers: this.headers(key) },
    );
    const b = d.bitcoin || {};
    return currencies.filter((c) => b[c.toLowerCase()] != null).map((c) => {
      const k = c.toLowerCase();
      return {
        currency: c,
        price: num(b[k]),
        changePct: num(b[`${k}_24h_change`]),
        volume: num(b[`${k}_24h_vol`]),
        marketCap: num(b[`${k}_market_cap`]),
        high: null,
        low: null,
        asOf: b.last_updated_at ? new Date(b.last_updated_at * 1000).toISOString() : new Date().toISOString(),
      };
    });
  },
  async history(currency, range, key) {
    const r = BTC_RANGES[range];
    const d = await getJson(
      `https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=${currency.toLowerCase()}&days=${r.cg}`,
      { provider: "coingecko", headers: this.headers(key) },
    );
    return (d.prices || []).filter((p) => Number.isFinite(p[1]));
  },
};

export const coinbase = {
  id: "coinbase",
  name: "Coinbase Exchange",
  kind: "crypto",
  needsKey: false,
  defaultEnabled: true,
  site: "https://docs.cdp.coinbase.com/exchange/",
  note: "Last trade and 24 h stats from the Coinbase order book (USD, EUR, GBP and a few others).",
  currencies: ["USD", "EUR", "GBP", "USDC", "CAD", "SGD"],
  async quote(currencies) {
    const list = currencies.filter((c) => this.currencies.includes(c));
    const rows = await mapLimit(list, 3, async (c) => {
      const s = await getJson(`https://api.exchange.coinbase.com/products/BTC-${c}/stats`, { provider: "coinbase" });
      const last = num(s.last), open = num(s.open);
      return {
        currency: c, price: last, changePct: open ? ((last - open) / open) * 100 : null,
        high: num(s.high), low: num(s.low), volume: num(s.volume) != null ? num(s.volume) * last : null, asOf: new Date().toISOString(),
      };
    });
    return rows;
  },
};

export const kraken = {
  id: "kraken",
  name: "Kraken",
  kind: "crypto",
  needsKey: false,
  defaultEnabled: true,
  site: "https://docs.kraken.com/api/",
  note: "Last trade from Kraken. Its change figure is since today's open (00:00 UTC), not a rolling 24 h.",
  currencies: ["USD", "EUR", "GBP", "CAD", "JPY", "CHF", "AUD"],
  async quote(currencies) {
    const list = currencies.filter((c) => this.currencies.includes(c));
    if (!list.length) return [];
    const d = await getJson(`https://api.kraken.com/0/public/Ticker?pair=${list.map((c) => `XBT${c}`).join(",")}`, { provider: "kraken" });
    if (d.error?.length) throw new Error(`Kraken: ${d.error.join(", ")}`);
    return list.map((c) => {
      const key = Object.keys(d.result || {}).find((k) => k.endsWith(c) || k.endsWith(`Z${c}`));
      const t = key && d.result[key];
      if (!t) return null;
      const last = num(t.c?.[0]), open = num(t.o);
      return {
        currency: c, price: last, changePct: open ? ((last - open) / open) * 100 : null,
        high: num(t.h?.[1]), low: num(t.l?.[1]), volume: num(t.v?.[1]) != null ? num(t.v[1]) * last : null, asOf: new Date().toISOString(),
      };
    }).filter(Boolean);
  },
  async history(currency, range) {
    if (!this.currencies.includes(currency)) throw new Error(`Kraken has no BTC/${currency} market`);
    const r = BTC_RANGES[range];
    const since = Math.floor((Date.now() - r.ms) / 1000);
    const d = await getJson(`https://api.kraken.com/0/public/OHLC?pair=XBT${currency}&interval=${r.kraken}&since=${since}`, { provider: "kraken" });
    if (d.error?.length) throw new Error(`Kraken: ${d.error.join(", ")}`);
    const key = Object.keys(d.result || {}).find((k) => k !== "last");
    return (d.result[key] || []).map((k) => [k[0] * 1000, num(k[4])]).filter((p) => p[0] >= Date.now() - r.ms);
  },
};

export const binance = {
  id: "binance",
  name: "Binance",
  kind: "crypto",
  needsKey: false,
  defaultEnabled: true, // blocked from some countries (HTTP 451): disable it there
  site: "https://developers.binance.com/docs/binance-spot-api-docs/rest-api",
  note: "Binance spot market. USD is quoted against USDT. Not reachable from every country.",
  pair: (c) => (c === "USD" ? "BTCUSDT" : `BTC${c}`),
  currencies: ["USD", "EUR", "TRY", "BRL", "JPY", "PLN", "ARS", "MXN", "ZAR", "UAH"],
  async quote(currencies) {
    const list = currencies.filter((c) => this.currencies.includes(c));
    if (!list.length) return [];
    const symbols = encodeURIComponent(JSON.stringify(list.map(this.pair)));
    const rows = await getJson(`https://api.binance.com/api/v3/ticker/24hr?symbols=${symbols}`, { provider: "binance" });
    return list.map((c) => {
      const t = rows.find((r) => r.symbol === this.pair(c));
      return t && {
        currency: c, price: num(t.lastPrice), changePct: num(t.priceChangePercent),
        high: num(t.highPrice), low: num(t.lowPrice), volume: num(t.quoteVolume), asOf: new Date(t.closeTime || Date.now()).toISOString(),
      };
    }).filter(Boolean);
  },
  async history(currency, range) {
    if (!this.currencies.includes(currency)) throw new Error(`Binance has no BTC/${currency} market`);
    const [interval, limit] = BTC_RANGES[range].binance;
    const rows = await getJson(`https://api.binance.com/api/v3/klines?symbol=${this.pair(currency)}&interval=${interval}&limit=${limit}`, { provider: "binance" });
    return rows.map((k) => [k[6], num(k[4])]);
  },
};
