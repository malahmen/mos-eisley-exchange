// Exchange rates for showing every share in one currency.
// Each adapter: rates(base, currencies) -> { [currency]: { rate, prevRate, asOf } }, where `rate`
// converts 1 unit of `currency` into `base` (price_in_base = price × rate).
import { getJson, num, mapLimit } from "./http.js";

export const yahooFx = {
  id: "yahoo-fx",
  name: "Yahoo Finance FX",
  kind: "fx",
  needsKey: false,
  defaultEnabled: true,
  site: "https://finance.yahoo.com/currencies",
  note: "Live currency pairs (e.g. HKDEUR=X) with the previous close, so the day's FX move can be included.",
  async rates(base, currencies) {
    const out = {};
    let turn = 0;
    await mapLimit(currencies.filter((c) => c !== base), 2, async (c) => {
      const pair = `${c}${base}=X`;
      const d = await getJson(
        (attempt) => `https://${(turn++ + attempt) % 2 ? "query2" : "query1"}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(pair)}?range=1d&interval=1d`,
        { provider: "yahoo-fx" },
      );
      const m = d.chart?.result?.[0]?.meta;
      const rate = num(m?.regularMarketPrice);
      if (rate == null) throw new Error(`Yahoo FX: no rate for ${pair}`);
      out[c] = { rate, prevRate: num(m.chartPreviousClose ?? m.previousClose), asOf: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null };
    });
    return out;
  },
};

export const frankfurter = {
  id: "frankfurter",
  name: "Frankfurter (ECB)",
  kind: "fx",
  needsKey: false,
  defaultEnabled: true,
  site: "https://frankfurter.dev",
  note: "European Central Bank reference rates, published once per working day. No previous close: the FX move is not included.",
  async rates(base, currencies) {
    const want = currencies.filter((c) => c !== base);
    if (!want.length) return {};
    // Frankfurter answers "1 base = x currency"; invert to get "1 currency = y base".
    const d = await getJson(`https://api.frankfurter.dev/v1/latest?base=${base}&symbols=${want.join(",")}`, { provider: "frankfurter" });
    const out = {};
    for (const c of want) {
      const x = num(d.rates?.[c]);
      if (x) out[c] = { rate: 1 / x, prevRate: null, asOf: d.date ? `${d.date}T16:00:00Z` : null };
    }
    return out;
  },
};

/** Converts a quote's price and change into `base` with an FX entry. includeFx folds in the day's FX move. */
export function convertQuote(q, fx, includeFx = false) {
  if (!q || !fx) return null;
  const price = q.price != null ? q.price * fx.rate : null;
  let changePct = q.changePct;
  if (includeFx && fx.prevRate && q.changePct != null) {
    const rFx = fx.rate / fx.prevRate - 1;
    changePct = ((1 + q.changePct / 100) * (1 + rFx) - 1) * 100;
  }
  return { price, changePct, rate: fx.rate, fxChangePct: fx.prevRate ? (fx.rate / fx.prevRate - 1) * 100 : null, asOf: fx.asOf };
}
