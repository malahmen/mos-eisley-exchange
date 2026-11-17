// Market data for any signed-in user: Bitcoin, shares and indices, FX, stats, market clocks.
import { fail } from "../http/core.js";
import { marketClock, SCHEDULES } from "../providers/markets.js";
import { convertQuote } from "../providers/fx.js";

export function marketRoutes({ route }, app) {
  const { market, settings, watchlist } = app;

  route("GET", "/api/quotes/bitcoin", "user", async () => market.bitcoin());

  route("GET", "/api/history/bitcoin", "user", async ({ url }) => {
    const { cryptoCurrencies } = await settings.get("general");
    const currency = String(url.searchParams.get("currency") || cryptoCurrencies[0]).toUpperCase();
    if (!cryptoCurrencies.includes(currency)) fail(400, "That currency is not configured.");
    return market.bitcoinHistory(currency, url.searchParams.get("range") || "1d");
  });

  route("GET", "/api/bitcoin/extras", "user", async ({ url }) => {
    const general = await settings.get("general");
    const currency = String(url.searchParams.get("currency") || general.defaultCurrency).toUpperCase();
    const [extras, btc] = await Promise.all([market.btcExtras(), market.bitcoin()]);
    const prices = btc.sources.map((s) => s.quotes.find((q) => q.currency === currency)?.price).filter(Number.isFinite).sort((a, b) => a - b);
    let spread = null;
    if (prices.length >= 2) {
      const med = prices.length % 2 ? prices[(prices.length - 1) / 2] : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2;
      spread = { pct: ((prices[prices.length - 1] - prices[0]) / med) * 100, min: prices[0], max: prices[prices.length - 1], currency, sources: prices.length };
    }
    return { ...extras, spread };
  });

  /** Shares and indices; with ?display=EUR each share also gets a converted price. */
  async function equitySnapshot({ display = "", includeFx = false } = {}) {
    const items = await watchlist.list();
    const { quotes, warnings } = await market.equities(items);
    let fx = { rates: {}, warnings: [] };
    if (display) {
      const currencies = items.filter((i) => i.kind === "equity").map((i) => quotes[i.symbol]?.currency || i.currency);
      fx = await market.fx(display, currencies);
    }
    const rows = items.map((it) => {
      const q = quotes[it.symbol];
      if (q && (!it.currency || it.name === it.symbol)) watchlist.enrich(it.symbol, q).catch(() => {});
      const currency = q?.currency || it.currency;
      let converted = null;
      if (display && q && it.kind === "equity") {
        converted = currency === display
          ? { price: q.price, changePct: q.changePct, rate: 1, fxChangePct: 0, currency: display }
          : fx.rates[currency] ? { ...convertQuote(q, fx.rates[currency], includeFx), currency: display, stale: !!fx.rates[currency].stale } : null;
      }
      return {
        ...it,
        name: it.name !== it.symbol ? it.name : q?.name || it.symbol,
        exchange: it.exchange || q?.exchange || "",
        currency,
        quote: q || null,
        converted,
      };
    });
    return { items: rows, warnings: [...warnings, ...fx.warnings], display: display || null };
  }
  app.equitySnapshot = equitySnapshot;

  route("GET", "/api/quotes/equities", "user", async ({ url }) => {
    const { cryptoCurrencies } = await settings.get("general");
    let display = String(url.searchParams.get("display") || "").toUpperCase();
    if (display && !cryptoCurrencies.includes(display)) display = "";
    const snap = await equitySnapshot({ display, includeFx: url.searchParams.get("includeFx") === "1" });
    const markets = {};
    for (const r of snap.items) {
      const m = (markets[r.market] ||= { open: 0, total: 0, up: 0, down: 0 });
      m.total++;
      if (r.quote?.marketState === "open") m.open++;
      if (r.quote?.changePct > 0) m.up++;
      if (r.quote?.changePct < 0) m.down++;
    }
    return { ...snap, markets, fetchedAt: new Date().toISOString() };
  });

  route("GET", "/api/history/equity/:symbol", "user", async ({ url, params }) => {
    const symbol = params.symbol.toUpperCase();
    if (!(await watchlist.bySymbol(symbol))) fail(404, "That symbol is not on the watchlist.");
    return market.equityHistory(symbol, url.searchParams.get("range") || "1mo");
  });

  route("GET", "/api/stats", "user", async ({ url }) => {
    const general = await settings.get("general");
    const want = String(url.searchParams.get("symbols") || "").toUpperCase().split(",").filter(Boolean).slice(0, 60);
    const items = await watchlist.list();
    const known = new Map(items.map((i) => [i.symbol, i]));
    const list = want.length ? want.filter((s) => known.has(s) || s === "BTC") : items.map((i) => i.symbol);
    const { quotes } = await market.equities(list.filter((s) => s !== "BTC").map((s) => known.get(s)));
    const out = {};
    for (const s of list) {
      try {
        if (s === "BTC") {
          const cur = general.defaultCurrency;
          const p = (await market.bitcoinPrimary())[cur];
          out[s] = await market.stats("BTC", { price: p?.price, kind: "btc", currency: cur });
        } else {
          out[s] = await market.stats(s, { price: quotes[s]?.price });
        }
      } catch (err) {
        out[s] = { error: err.message };
      }
    }
    return { stats: out };
  });

  route("GET", "/api/markets", "user", async () => {
    const { holidays } = await settings.get("general");
    return {
      now: new Date().toISOString(),
      clocks: Object.fromEntries(Object.keys(SCHEDULES).map((m) => [m, marketClock(m, Date.now(), holidays[m] || [])])),
    };
  });

  route("GET", "/api/fx", "user", async ({ url }) => {
    const general = await settings.get("general");
    const base = String(url.searchParams.get("base") || general.defaultCurrency).toUpperCase();
    if (!general.cryptoCurrencies.includes(base)) fail(400, "That currency is not configured.");
    const items = await watchlist.list("equity");
    return market.fx(base, items.map((i) => i.currency).filter(Boolean));
  });
}
