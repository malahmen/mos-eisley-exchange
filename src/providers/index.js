// Market data service: picks providers from the admin settings, caches every answer on the server
// (so ten open browsers make one upstream call), coalesces identical requests in flight,
// falls back down the priority list, serves the last good value (marked stale) when all fail,
// and reads stored history (history.js) when it covers the requested range.
import { PROVIDERS, KINDS, providerById } from "./registry.js";
import { BTC_RANGES } from "./crypto.js";
import { EQUITY_RANGES, yahoo } from "./equity.js";
import { health } from "./http.js";
import { computeStats } from "../stats.js";

const HISTORY_TTL = { "1d": 120, "7d": 600, "30d": 1800, "90d": 3600, "1y": 3600, "5d": 600, "1mo": 1800, "6mo": 3600, "5y": 6 * 3600 };
const RANGE_MS = { "1d": 1, "5d": 5, "7d": 7, "1mo": 30, "30d": 30, "90d": 90, "6mo": 182, "1y": 365, "5y": 1826 };
const ERROR_TTL_MS = 30_000;
const DAY = 86400_000;

export function createMarket({ settings, envKeys, secrets, history }) {
  const cache = new Map();    // key -> { value, error, at, expires }
  const inflight = new Map(); // key -> Promise
  const lastGood = new Map(); // key -> { value, at }

  /** Memoizes fn() under key for ttlMs; failures are remembered briefly so a dead provider is not hammered. */
  async function cached(key, ttlMs, fn) {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) {
      if (hit.error) throw hit.error;
      return hit.value;
    }
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      try {
        const value = await fn();
        cache.set(key, { value, at: Date.now(), expires: Date.now() + ttlMs });
        lastGood.set(key, { value, at: Date.now() });
        return value;
      } catch (error) {
        cache.set(key, { error, at: Date.now(), expires: Date.now() + Math.min(ERROR_TTL_MS, ttlMs) });
        throw error;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  }

  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of cache) if (v.expires < now - 3600_000) cache.delete(k);
  }, 10 * 60_000).unref();

  async function keyFor(id) {
    if (envKeys[id]) return envKeys[id];
    const p = await settings.get("providers");
    try { return secrets.open(p.keys[id] || ""); } catch { return ""; }
  }

  /** Enabled providers of a kind, in priority order, skipping those that need a key and have none. */
  async function chain(kind) {
    const cfg = await settings.get("providers");
    const list = [];
    for (const e of cfg[kind]) {
      const p = providerById(e.id);
      if (!p || !e.enabled) continue;
      const key = await keyFor(p.id);
      if (p.needsKey && !key) continue;
      list.push({ p, key });
    }
    return { list, ttlMs: cfg.cacheTtlSeconds * 1000 };
  }

  async function retention() {
    return (await settings.get("general")).retention;
  }

  const service = {
    clearCache() {
      cache.clear();
    },

    /** BTC from every enabled source, in every configured currency. */
    async bitcoin() {
      const { cryptoCurrencies } = await settings.get("general");
      const { list, ttlMs } = await chain("crypto");
      const warnings = [];
      if (!list.length) warnings.push("No Bitcoin price source is enabled (Admin → Providers).");
      const sources = await Promise.all(list.map(async ({ p, key }) => {
        const ck = `btc:${p.id}:${cryptoCurrencies.join(",")}`;
        try {
          const quotes = await cached(ck, ttlMs, () => p.quote(cryptoCurrencies, key));
          return { id: p.id, name: p.name, quotes, fetchedAt: new Date(cache.get(ck)?.at || Date.now()).toISOString() };
        } catch (err) {
          const old = lastGood.get(ck);
          warnings.push(`${p.name}: ${err.message}${old ? " (showing the last price received)" : ""}`);
          return old
            ? { id: p.id, name: p.name, quotes: old.value, stale: true, fetchedAt: new Date(old.at).toISOString() }
            : { id: p.id, name: p.name, quotes: [], error: err.message };
        }
      }));
      return { currencies: cryptoCurrencies, sources, warnings };
    },

    /** Headline BTC quote per currency: the first source (priority order) that has one. */
    async bitcoinPrimary() {
      const btc = await service.bitcoin();
      const out = {};
      for (const c of btc.currencies) {
        for (const s of btc.sources) {
          const q = s.quotes.find((x) => x.currency === c);
          if (q?.price != null) { out[c] = { ...q, source: s.name, stale: !!s.stale }; break; }
        }
      }
      return out;
    },

    async bitcoinHistory(currency, range) {
      if (!BTC_RANGES[range]) throw Object.assign(new Error("Unknown range"), { status: 400 });
      const symbol = `BTC-${currency}`;
      const fromMs = Date.now() - RANGE_MS[range] * DAY;
      const fromDb = async () => {
        const c = await history.covered(symbol, fromMs, await retention());
        return c && { source: `Stored history (${c.bucket})`, currency, range, points: c.points, warnings: [] };
      };
      if (RANGE_MS[range] >= 30) {
        const stored = await fromDb();
        if (stored) return stored;
      }
      const { list } = await chain("crypto");
      const errors = [];
      for (const { p, key } of list.filter((x) => typeof x.p.history === "function")) {
        try {
          const points = await cached(`btch:${p.id}:${currency}:${range}`, (HISTORY_TTL[range] || 600) * 1000, () => p.history(currency, range, key));
          if (points.length) return { source: p.name, currency, range, points, warnings: errors };
        } catch (err) {
          errors.push(`${p.name}: ${err.message}`);
        }
      }
      const stored = await fromDb();
      if (stored) return { ...stored, warnings: errors };
      return { source: null, currency, range, points: [], warnings: errors.length ? errors : ["No enabled source offers Bitcoin history."] };
    },

    /** Quotes for watchlist items, each from the first provider in the chain that answers for it. */
    async equities(items) {
      const { list, ttlMs } = await chain("equity");
      const warnings = [];
      if (!list.length) warnings.push("No share price source is enabled (Admin → Providers).");
      const result = {};
      let remaining = items.map((i) => i.symbol);
      for (const { p, key } of list) {
        if (!remaining.length) break;
        const mine = remaining.filter((s) => p.supports(s));
        if (!mine.length) continue;
        const toFetch = [];
        for (const s of mine) {
          const hit = cache.get(`eq:${p.id}:${s}`);
          if (hit && hit.expires > Date.now()) {
            if (hit.value) result[s] = { ...hit.value, source: p.name };
          } else toFetch.push(s);
        }
        if (toFetch.length) {
          try {
            const { quotes, errors } = await cached(`eqb:${p.id}:${toFetch.join(",")}`, 1000, () => p.quote(toFetch, key));
            for (const s of toFetch) {
              if (quotes[s]) {
                cache.set(`eq:${p.id}:${s}`, { value: quotes[s], at: Date.now(), expires: Date.now() + ttlMs });
                lastGood.set(`eq:${s}`, { value: { ...quotes[s], source: p.name }, at: Date.now() });
                result[s] = { ...quotes[s], source: p.name };
              } else {
                cache.set(`eq:${p.id}:${s}`, { value: null, at: Date.now(), expires: Date.now() + ERROR_TTL_MS });
                if (errors[s]) warnings.push(`${p.name} · ${s}: ${errors[s]}`);
              }
            }
          } catch (err) {
            warnings.push(`${p.name}: ${err.message}`);
          }
        }
        remaining = remaining.filter((s) => !result[s]);
      }
      for (const s of remaining) {
        const old = lastGood.get(`eq:${s}`);
        if (old) result[s] = { ...old.value, stale: true, staleSince: new Date(old.at).toISOString() };
      }
      const none = remaining.filter((s) => !result[s]);
      if (none.length) warnings.push(`No price for ${none.join(", ")} from any enabled source.`);
      return { quotes: result, warnings: [...new Set(warnings)] };
    },

    async equityHistory(symbol, range) {
      if (!EQUITY_RANGES[range]) throw Object.assign(new Error("Unknown range"), { status: 400 });
      const fromMs = Date.now() - RANGE_MS[range] * DAY;
      const fromDb = async () => {
        const c = await history.covered(symbol, fromMs, await retention());
        return c && { source: `Stored history (${c.bucket})`, symbol, range, points: c.points, warnings: [] };
      };
      // Long ranges: stored history first (it is complete once the app has run long enough).
      if (RANGE_MS[range] >= 30) {
        const stored = await fromDb();
        if (stored) return stored;
      }
      const { list } = await chain("equity");
      const errors = [];
      for (const { p, key } of list.filter((x) => x.p.history && x.p.supports(symbol))) {
        try {
          const points = await cached(`eqh:${p.id}:${symbol}:${range}`, (HISTORY_TTL[range] || 600) * 1000, () => p.history(symbol, range, key));
          if (points.length) return { source: p.name, symbol, range, points, warnings: errors };
        } catch (err) {
          errors.push(`${p.name}: ${err.message}`);
        }
      }
      const stored = await fromDb();
      if (stored) return { ...stored, warnings: errors };
      return { source: null, symbol, range, points: [], warnings: errors.length ? errors : ["No enabled source offers history for this symbol."] };
    },

    /** Stats from a 1-year daily series (stored daily rollups when they cover it, else provider history). */
    async stats(symbol, { price, kind = "equity", currency } = {}) {
      const key = `stats:${symbol}:${currency || ""}`;
      const series = await cached(key, 3600_000, async () => {
        const dbSymbol = kind === "btc" ? `BTC-${currency}` : symbol;
        const stored = await history.series(dbSymbol, Date.now() - 366 * DAY, "day");
        if (stored.length >= 200 && stored[0][0] < Date.now() - 330 * DAY) return { points: stored, source: "Stored history" };
        const h = kind === "btc" ? await service.bitcoinHistory(currency, "1y") : await service.equityHistory(symbol, "1y");
        return { points: h.points, source: h.source };
      });
      if (!series.points.length) return null;
      return { ...computeStats(series.points, { price, tradingDays: kind === "btc" ? 365 : 252 }), source: series.source };
    },

    /** Exchange rates converting each currency into `base`, from the first FX provider that answers. */
    async fx(base, currencies) {
      const want = [...new Set(currencies.filter((c) => c && c !== base))].sort();
      if (!want.length) return { base, rates: {}, warnings: [] };
      const { list } = await chain("fx");
      const rates = {}, warnings = [];
      let remaining = want;
      for (const { p, key } of list) {
        if (!remaining.length) break;
        try {
          const got = await cached(`fx:${p.id}:${base}:${remaining.join(",")}`, 5 * 60_000, () => p.rates(base, remaining, key));
          for (const [c, v] of Object.entries(got)) rates[c] = { ...v, source: p.name };
          for (const c of Object.keys(got)) lastGood.set(`fx:${c}${base}`, { value: { ...got[c], source: p.name }, at: Date.now() });
        } catch (err) {
          warnings.push(`${p.name}: ${err.message}`);
        }
        remaining = remaining.filter((c) => !rates[c]);
      }
      for (const c of remaining) {
        const old = lastGood.get(`fx:${c}${base}`);
        if (old) rates[c] = { ...old.value, stale: true };
        else warnings.push(`No exchange rate for ${c}→${base}.`);
      }
      return { base, rates, warnings };
    },

    /** Bitcoin market context from every enabled btcextra source, merged. */
    async btcExtras() {
      const { list } = await chain("btcextra");
      const out = { warnings: [] };
      await Promise.all(list.map(async ({ p }) => {
        try {
          Object.assign(out, await cached(`btcx:${p.id}`, 15 * 60_000, () => p.fetch()), {});
        } catch (err) {
          const old = lastGood.get(`btcx:${p.id}`);
          if (old) Object.assign(out, old.value);
          out.warnings.push(`${p.name}: ${err.message}`);
        }
      }));
      return out;
    },

    async searchSymbols(q) {
      return cached(`search:${q.toLowerCase()}`, 3600_000, () => yahoo.search(q));
    },

    /** One live call to a provider, bypassing the cache (Admin → Providers → Test). */
    async test(id, keyOverride) {
      const p = providerById(id);
      if (!p) throw Object.assign(new Error("Unknown provider"), { status: 404 });
      const key = keyOverride || (await keyFor(id));
      if (p.needsKey && !key) throw Object.assign(new Error(`${p.name} needs an API key.`), { status: 400 });
      const started = Date.now();
      const done = (sample) => ({ ok: true, ms: Date.now() - started, sample });
      if (p.kind === "crypto") {
        const quotes = await p.quote(["USD", "EUR"], key);
        if (!quotes.length) throw new Error("No quotes returned.");
        return done(`BTC ${quotes.map((q) => `${q.price} ${q.currency}`).join(" · ")}`);
      }
      if (p.kind === "fx") {
        const r = await p.rates("EUR", ["USD", "HKD"], key);
        return done(Object.entries(r).map(([c, v]) => `1 ${c} = ${v.rate.toFixed(4)} EUR`).join(" · "));
      }
      if (p.kind === "btcextra") {
        const r = await p.fetch();
        return done(JSON.stringify(r).slice(0, 120));
      }
      const sym = p.supports("AAPL") ? "AAPL" : "0700.HK";
      const { quotes, errors } = await p.quote([sym], key);
      if (!quotes[sym]) throw new Error(errors[sym] || "No quote returned.");
      return done(`${sym} ${quotes[sym].price} ${quotes[sym].currency}`);
    },

    async describeProviders() {
      const cfg = await settings.get("providers");
      const stats = health.snapshot();
      const describe = (kind) =>
        cfg[kind].map((e) => {
          const p = PROVIDERS[kind].find((k) => k.id === e.id);
          let stored = "";
          try { stored = secrets.open(cfg.keys[p.id] || ""); } catch { stored = "(cannot decrypt)"; }
          return {
            id: p.id, name: p.name, kind: p.kind, enabled: e.enabled, needsKey: !!p.needsKey, optionalKey: !!p.optionalKey,
            history: !!p.history, site: p.site, note: p.note,
            keySource: envKeys[p.id] ? "env" : stored ? "db" : "none",
            keyHint: envKeys[p.id] ? mask(envKeys[p.id]) : stored ? mask(stored) : "",
            health: stats[p.id] || null,
          };
        });
      return { cacheTtlSeconds: cfg.cacheTtlSeconds, ...Object.fromEntries(KINDS.map((k) => [k, describe(k)])) };
    },

    health: () => health.snapshot(),
  };
  return service;
}

const mask = (k) => (k.length <= 4 ? "••••" : `••••${k.slice(-4)}`);
