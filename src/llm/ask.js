// "Ask the data" (#15): questions answered only from a compact pack of the app's own numbers.
// The answer is checked against the pack: unknown symbols are dropped, figures not found in the pack are flagged.
import { askJson } from "./client.js";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "symbols", "figures", "cannotAnswer"],
  properties: {
    answer: { type: "string", description: "a direct answer in 1-4 sentences, using only the data given" },
    symbols: { type: "array", items: { type: "string" }, description: "symbols the answer refers to, exactly as in the data" },
    figures: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["label", "value"], properties: { label: { type: "string" }, value: { type: "number" } } },
      description: "the key numbers used, copied from the data",
    },
    cannotAnswer: { type: "boolean", description: "true if the data does not contain what the question needs" },
  },
};

const SYSTEM = `You answer questions about a private market dashboard using ONLY the JSON data provided.
Fields: price (latest), today (% change today), week/month/quarter/ytd/year (% returns), fromHigh52/fromLow52 (% from 52-week high/low),
vol30 (annualised 30-day volatility %), market (US, EU, CN, HK), kind (equity or index).
If the data cannot answer the question (news, reasons, forecasts, advice, symbols not in the data), set cannotAnswer=true and say what is missing.
Never invent numbers. Copy figures from the data. No investment advice.`;

const LIMIT = 5, WINDOW_MS = 10 * 60_000;
const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

export function createAskService({ llm, market, watchlist, settings }) {
  const recent = new Map(); // userId -> [timestamps]
  let packCache = null;

  async function pack() {
    if (packCache && Date.now() - packCache.at < 120_000) return packCache.value;
    const general = await settings.get("general");
    const items = await watchlist.list();
    const { quotes } = await market.equities(items);
    const rows = [];
    for (const it of items) {
      const q = quotes[it.symbol];
      const s = await market.stats(it.symbol, { price: q?.price }).catch(() => null);
      rows.push({
        symbol: it.symbol, name: it.name, kind: it.kind, market: it.market, currency: q?.currency || it.currency,
        price: round(q?.price, 4), today: round(q?.changePct), week: round(s?.r1w), month: round(s?.r1m), quarter: round(s?.r3m),
        ytd: round(s?.ytd), year: round(s?.r1y), fromHigh52: round(s?.fromHigh), fromLow52: round(s?.fromLow), vol30: round(s?.vol30, 1),
        marketOpen: q?.marketState === "open",
      });
    }
    const cur = general.defaultCurrency;
    const btcQ = (await market.bitcoinPrimary())[cur];
    const btcS = await market.stats("BTC", { price: btcQ?.price, kind: "btc", currency: cur }).catch(() => null);
    const extras = await market.btcExtras().catch(() => ({}));
    rows.push({
      symbol: "BTC", name: "Bitcoin", kind: "crypto", market: "CRYPTO", currency: cur, price: round(btcQ?.price), today: round(btcQ?.changePct),
      week: round(btcS?.r1w), month: round(btcS?.r1m), quarter: round(btcS?.r3m), ytd: round(btcS?.ytd), year: round(btcS?.r1y),
      fromHigh52: round(btcS?.fromHigh), fromLow52: round(btcS?.fromLow), vol30: round(btcS?.vol30, 1),
      fearGreed: extras.fearGreed?.value ?? null, dominancePct: round(extras.dominance),
    });
    const value = { asOf: new Date().toISOString(), rows };
    packCache = { at: Date.now(), value };
    return value;
  }

  return {
    async ask(user, question) {
      if (!llm.enabled) throw Object.assign(new Error("The LLM is not configured (LLM_ENABLED is off)."), { status: 400 });
      const q = String(question || "").trim();
      if (q.length < 3) throw Object.assign(new Error("Ask a question."), { status: 400 });
      if (q.length > 300) throw Object.assign(new Error("Keep the question under 300 characters."), { status: 400 });
      const times = (recent.get(user.id) || []).filter((t) => t > Date.now() - WINDOW_MS);
      if (times.length >= LIMIT) {
        const wait = Math.ceil((times[0] + WINDOW_MS - Date.now()) / 1000);
        throw Object.assign(new Error(`You asked ${LIMIT} questions in 10 minutes. Try again in ${wait} s.`), { status: 429 });
      }
      times.push(Date.now());
      recent.set(user.id, times);

      const data = await pack();
      const { data: a, model } = await askJson(llm, {
        system: SYSTEM, user: `Data (JSON):\n${JSON.stringify(data)}\n\nQuestion: ${q}`, schema: SCHEMA, schemaName: "ask_answer",
      });
      const known = new Set(data.rows.map((r) => r.symbol));
      const symbols = [...new Set((Array.isArray(a.symbols) ? a.symbols : []).map((s) => String(s).toUpperCase()))];
      const unknown = symbols.filter((s) => !known.has(s));
      const numbers = data.rows.flatMap((r) => Object.values(r).filter((v) => typeof v === "number"));
      const figures = (Array.isArray(a.figures) ? a.figures : []).slice(0, 8).map((f) => {
        const v = Number(f.value);
        const ok = Number.isFinite(v) && numbers.some((n) => Math.abs(n - v) <= Math.max(0.051, Math.abs(n) * 0.006));
        return { label: String(f.label || ""), value: v, verified: ok };
      });
      const warnings = [];
      if (unknown.length) warnings.push(`The answer named symbols that are not in the data (${unknown.join(", ")}); they were dropped.`);
      if (figures.some((f) => !f.verified)) warnings.push("Some figures could not be matched to the data: double-check them.");
      return {
        answer: String(a.answer || ""), cannotAnswer: !!a.cannotAnswer, symbols: symbols.filter((s) => known.has(s)),
        figures, warnings, asOf: data.asOf, model,
      };
    },
  };
}
