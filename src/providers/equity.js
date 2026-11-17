// Share price sources. Watchlist symbols use Yahoo notation; each adapter maps them to its own.
// Each adapter: supports(symbol), quote(symbols, key) -> { quotes: {sym: q}, errors: {sym: msg} },
// and optionally history(symbol, range, key) -> [[ms, price], ...].
// A quote: { price, currency, change, changePct, prevClose, open, high, low, volume,
//            yearHigh, yearLow, name, exchange, marketState, asOf, spark? }
import { getJson, num, mapLimit, ProviderError } from "./http.js";
import { splitSymbol, SUFFIXES } from "./markets.js";

// Yahoo throttles bursts per host: alternate query1 and query2, and switch host on a retry.
let yahooTurn = 0;
const yahooHost = (attempt) => ((yahooTurn++ + attempt) % 2 ? "query2.finance.yahoo.com" : "query1.finance.yahoo.com");

export const EQUITY_RANGES = {
  "1d":  { yahoo: ["1d", "5m"],  td: ["5min", 80] },
  "5d":  { yahoo: ["5d", "30m"], td: ["30min", 70] },
  "1mo": { yahoo: ["1mo", "1d"], td: ["1day", 23] },
  "6mo": { yahoo: ["6mo", "1d"], td: ["1day", 130] },
  "1y":  { yahoo: ["1y", "1d"],  td: ["1day", 260] },
  "5y":  { yahoo: ["5y", "1wk"], td: ["1week", 260] },
};

function marketStateFromPeriod(period, nowSec = Date.now() / 1000) {
  const reg = period?.regular;
  if (!reg) return "unknown";
  if (nowSec >= reg.start && nowSec < reg.end) return "open";
  if (period.pre && nowSec >= period.pre.start && nowSec < period.pre.end) return "pre";
  if (period.post && nowSec >= period.post.start && nowSec < period.post.end) return "post";
  return "closed";
}

export const yahoo = {
  id: "yahoo",
  name: "Yahoo Finance",
  kind: "equity",
  needsKey: false,
  defaultEnabled: true,
  history: true,
  site: "https://finance.yahoo.com",
  note: "Public chart endpoint, no key. Covers US, Europe, Shanghai, Shenzhen, Hong Kong and more. Unofficial: it can change without notice, so enable a keyed fallback too.",
  supports: () => true,
  async chart(symbol, range, interval) {
    const d = await getJson(
      (attempt) => `https://${yahooHost(attempt)}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`,
      { provider: "yahoo" },
    );
    const err = d.chart?.error;
    if (err) throw new ProviderError(`Yahoo: ${err.description || err.code}`);
    const r = d.chart?.result?.[0];
    if (!r) throw new ProviderError("Yahoo: empty answer");
    return r;
  },
  async quote(symbols) {
    const quotes = {}, errors = {};
    await mapLimit(symbols, 4, async (sym) => {
      try {
        const r = await this.chart(sym, "1d", "5m");
        const m = r.meta;
        const price = num(m.regularMarketPrice);
        if (price == null) throw new Error("no price");
        const prevClose = num(m.chartPreviousClose ?? m.previousClose);
        const change = prevClose != null ? price - prevClose : null;
        const closes = r.indicators?.quote?.[0]?.close || [];
        const opens = r.indicators?.quote?.[0]?.open || [];
        quotes[sym] = {
          price,
          currency: m.currency || "",
          change,
          changePct: num(m.regularMarketChangePercent) ?? (prevClose ? (change / prevClose) * 100 : null),
          prevClose,
          open: num(opens.find((v) => v != null)),
          high: num(m.regularMarketDayHigh),
          low: num(m.regularMarketDayLow),
          volume: num(m.regularMarketVolume),
          yearHigh: num(m.fiftyTwoWeekHigh),
          yearLow: num(m.fiftyTwoWeekLow),
          name: m.longName || m.shortName || "",
          exchange: m.fullExchangeName || m.exchangeName || "",
          marketState: marketStateFromPeriod(m.currentTradingPeriod),
          asOf: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null,
          spark: (r.timestamp || []).map((t, i) => [t * 1000, closes[i]]).filter((p) => p[1] != null),
        };
      } catch (err) {
        errors[sym] = err.message;
      }
    });
    return { quotes, errors };
  },
  async history(symbol, range) {
    const [rg, interval] = EQUITY_RANGES[range].yahoo;
    const r = await this.chart(symbol, rg, interval);
    const closes = r.indicators?.quote?.[0]?.close || [];
    return (r.timestamp || []).map((t, i) => [t * 1000, closes[i]]).filter((p) => p[1] != null);
  },
  /** Symbol lookup for the watchlist editor. */
  async search(q) {
    const d = await getJson((attempt) => `https://${yahooHost(attempt)}/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0`, { provider: "yahoo" });
    return (d.quotes || [])
      .filter((x) => x.symbol && ["EQUITY", "ETF", "INDEX", "MUTUALFUND"].includes(x.quoteType))
      .map((x) => ({
        symbol: x.symbol,
        name: x.longname || x.shortname || x.symbol,
        exchange: x.exchDisp || x.exchange || "",
        type: x.typeDisp || x.quoteType,
        sector: x.sectorDisp || x.sector || "",
      }));
  },
};

// Twelve Data: free tier (8 requests/min, 800/day). Non-US symbols are sent with their exchange MIC.
export const twelvedata = {
  id: "twelvedata",
  name: "Twelve Data",
  kind: "equity",
  needsKey: true,
  defaultEnabled: false,
  history: true,
  site: "https://twelvedata.com/pricing",
  note: "Free key: 8 requests/min, 800/day. US and many exchanges (some markets need a paid plan).",
  map(symbol) {
    const { base, suffix } = splitSymbol(symbol);
    const mic = SUFFIXES[suffix]?.mic;
    if (/[=^]/.test(symbol) || mic === undefined) return null;
    // Hong Kong codes are listed without leading zeros there (0700 -> 700).
    return { symbol: suffix === "HK" ? base.replace(/^0+/, "") : base, mic };
  },
  supports(symbol) {
    return !!this.map(symbol);
  },
  params(symbol, key) {
    const m = this.map(symbol);
    return `symbol=${encodeURIComponent(m.symbol)}${m.mic ? `&mic_code=${m.mic}` : ""}&apikey=${encodeURIComponent(key)}`;
  },
  async quote(symbols, key) {
    const quotes = {}, errors = {};
    await mapLimit(symbols, 2, async (sym) => {
      try {
        const q = await getJson(`https://api.twelvedata.com/quote?${this.params(sym, key)}`, { provider: "twelvedata", retries: 0 });
        if (q.status === "error") throw new ProviderError(`Twelve Data: ${q.message}`, { rateLimited: q.code === 429 });
        quotes[sym] = {
          price: num(q.close), currency: q.currency || "", change: num(q.change), changePct: num(q.percent_change),
          prevClose: num(q.previous_close), open: num(q.open), high: num(q.high), low: num(q.low), volume: num(q.volume),
          yearHigh: num(q.fifty_two_week?.high), yearLow: num(q.fifty_two_week?.low),
          name: q.name || "", exchange: q.exchange || "",
          marketState: q.is_market_open === true ? "open" : q.is_market_open === false ? "closed" : "unknown",
          asOf: q.timestamp ? new Date(q.timestamp * 1000).toISOString() : null,
        };
      } catch (err) {
        errors[sym] = err.message;
      }
    });
    return { quotes, errors };
  },
  async history(symbol, range, key) {
    const [interval, size] = EQUITY_RANGES[range].td;
    const d = await getJson(`https://api.twelvedata.com/time_series?${this.params(symbol, key)}&interval=${interval}&outputsize=${size}&order=asc&timezone=UTC`, { provider: "twelvedata", retries: 0 });
    if (d.status === "error") throw new ProviderError(`Twelve Data: ${d.message}`);
    return (d.values || []).map((v) => [Date.parse(v.datetime.replace(" ", "T") + "Z"), num(v.close)]).filter((p) => p[1] != null);
  },
};

// Finnhub: free tier quotes are US-listed only (60 requests/min).
export const finnhub = {
  id: "finnhub",
  name: "Finnhub",
  kind: "equity",
  needsKey: true,
  defaultEnabled: false,
  history: false,
  site: "https://finnhub.io/pricing",
  note: "Free key: 60 requests/min, real-time US quotes only (no history on the free plan).",
  supports(symbol) {
    return !/[=^.]/.test(symbol);
  },
  async quote(symbols, key) {
    const quotes = {}, errors = {};
    await mapLimit(symbols, 4, async (sym) => {
      try {
        const q = await getJson(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${encodeURIComponent(key)}`, { provider: "finnhub" });
        if (!q || !q.c) throw new Error("Finnhub: unknown symbol or no data");
        quotes[sym] = {
          price: num(q.c), currency: "USD", change: num(q.d), changePct: num(q.dp), prevClose: num(q.pc), open: num(q.o),
          high: num(q.h), low: num(q.l), volume: null, yearHigh: null, yearLow: null, name: "", exchange: "",
          marketState: "unknown", asOf: q.t ? new Date(q.t * 1000).toISOString() : null,
        };
      } catch (err) {
        errors[sym] = err.message;
      }
    });
    return { quotes, errors };
  },
};

// Alpha Vantage: free tier is 25 requests/day, so it only makes sense as a last resort.
export const alphavantage = {
  id: "alphavantage",
  name: "Alpha Vantage",
  kind: "equity",
  needsKey: true,
  defaultEnabled: false,
  history: false,
  site: "https://www.alphavantage.co/support/#api-key",
  note: "Free key: 25 requests/day. End-of-day style quotes for US, London, Xetra, Shanghai, Shenzhen, Toronto and a few more.",
  map(symbol) {
    const { base, suffix } = splitSymbol(symbol);
    const av = SUFFIXES[suffix]?.av;
    if (/[=^]/.test(symbol) || av == null) return null;
    return av ? `${base}.${av}` : base;
  },
  supports(symbol) {
    return !!this.map(symbol);
  },
  async quote(symbols, key) {
    const quotes = {}, errors = {};
    await mapLimit(symbols, 1, async (sym) => {
      try {
        const d = await getJson(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(this.map(sym))}&apikey=${encodeURIComponent(key)}`, { provider: "alphavantage", retries: 0 });
        if (d.Note || d.Information) throw new ProviderError("Alpha Vantage: daily request limit reached", { rateLimited: true });
        const q = d["Global Quote"];
        if (!q || !q["05. price"]) throw new Error("Alpha Vantage: unknown symbol");
        quotes[sym] = {
          price: num(q["05. price"]), currency: "", change: num(q["09. change"]), changePct: num(q["10. change percent"]),
          prevClose: num(q["08. previous close"]), open: num(q["02. open"]), high: num(q["03. high"]), low: num(q["04. low"]),
          volume: num(q["06. volume"]), yearHigh: null, yearLow: null, name: "", exchange: "",
          marketState: "unknown", asOf: q["07. latest trading day"] ? `${q["07. latest trading day"]}T00:00:00Z` : null,
        };
      } catch (err) {
        errors[sym] = err.message;
      }
    });
    return { quotes, errors };
  },
};
