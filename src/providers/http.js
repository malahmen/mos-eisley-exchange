// Shared HTTP helper for market-data providers:
// - a token bucket and in-flight cap per provider (free tiers have strict limits),
// - an optional daily quota (Alpha Vantage: 25/day),
// - retries on 429/503 honouring Retry-After (2 s, 4 s, 8 s otherwise), optionally on another host,
// - every call recorded in the health panel.
// Error messages name only the host and status, never the URL: some providers take the key in the query.
import { createHealth } from "./health.js";

const UA = "Mozilla/5.0 (compatible; mos-eisley-exchange/0.1)";
export const health = createHealth();

export class ProviderError extends Error {
  constructor(message, { status, rateLimited = false } = {}) {
    super(message);
    this.status = status;
    this.rateLimited = rateLimited;
  }
}

// Limits per provider id. ratePerSec: refill speed; burst: bucket size; inflight: concurrent requests.
export const LIMITS = {
  yahoo:        { ratePerSec: 2,     burst: 4, inflight: 4 },
  "yahoo-fx":   { ratePerSec: 2,     burst: 4, inflight: 2 },
  coingecko:    { ratePerSec: 0.4,   burst: 3, inflight: 2 },
  coinbase:     { ratePerSec: 3,     burst: 6, inflight: 3 },
  kraken:       { ratePerSec: 1,     burst: 3, inflight: 2 },
  binance:      { ratePerSec: 3,     burst: 6, inflight: 3 },
  twelvedata:   { ratePerSec: 8 / 60, burst: 8, inflight: 2 },
  finnhub:      { ratePerSec: 1,     burst: 5, inflight: 3 },
  alphavantage: { ratePerSec: 1 / 15, burst: 1, inflight: 1, perDay: 25 },
  frankfurter:  { ratePerSec: 1,     burst: 3, inflight: 2 },
  feargreed:    { ratePerSec: 0.5,   burst: 2, inflight: 1 },
  mempool:      { ratePerSec: 1,     burst: 3, inflight: 2 },
  default:      { ratePerSec: 2,     burst: 4, inflight: 3 },
};
const MAX_WAIT_MS = 20_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const buckets = new Map();
function bucket(id) {
  if (!buckets.has(id)) {
    const l = LIMITS[id] || LIMITS.default;
    buckets.set(id, { ...l, tokens: l.burst, last: Date.now(), active: 0, waiters: [] });
  }
  return buckets.get(id);
}

async function acquire(id) {
  const b = bucket(id);
  if (b.perDay && health.dayCount(id) >= b.perDay) {
    throw new ProviderError(`${id}: daily limit of ${b.perDay} requests reached`, { rateLimited: true });
  }
  const deadline = Date.now() + MAX_WAIT_MS;
  for (;;) {
    const now = Date.now();
    b.tokens = Math.min(b.burst, b.tokens + ((now - b.last) / 1000) * b.ratePerSec);
    b.last = now;
    if (b.tokens >= 1 && b.active < b.inflight) {
      b.tokens -= 1;
      b.active++;
      return () => { b.active--; };
    }
    if (now > deadline) throw new ProviderError(`${id}: local rate limit, try again shortly`, { rateLimited: true });
    const waitTokens = b.tokens >= 1 ? 50 : ((1 - b.tokens) / b.ratePerSec) * 1000;
    await sleep(Math.min(1000, Math.max(50, waitTokens)));
  }
}

/**
 * GET JSON. `url` may be a function (attempt) => url, to rotate hosts between retries.
 * opts: { provider, headers, timeoutMs, retries }
 */
export async function getJson(url, { provider = "default", headers = {}, timeoutMs = 10000, retries = 2, text = false } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const href = typeof url === "function" ? url(attempt) : url;
    const host = new URL(href).host;
    const release = await acquire(provider);
    const started = Date.now();
    let res, body;
    try {
      res = await fetch(href, { headers: { "User-Agent": UA, Accept: text ? "*/*" : "application/json", ...headers }, signal: AbortSignal.timeout(timeoutMs) });
      body = await res.text();
    } catch (err) {
      const why = err?.name === "TimeoutError" ? `no answer within ${timeoutMs / 1000} s` : err?.cause?.code || err.message;
      lastErr = new ProviderError(`${host}: ${why}`);
      health.record(provider, { ok: false, ms: Date.now() - started, error: lastErr.message });
      release();
      if (attempt < retries) { await sleep(1000 * 2 ** attempt); continue; }
      throw lastErr;
    }
    release();
    const ms = Date.now() - started;
    if (res.ok) {
      if (text) {
        health.record(provider, { ok: true, ms, status: res.status });
        return body;
      }
      try {
        const data = JSON.parse(body);
        health.record(provider, { ok: true, ms, status: res.status });
        return data;
      } catch {
        lastErr = new ProviderError(`${host} did not return JSON`);
        health.record(provider, { ok: false, ms, status: res.status, error: lastErr.message });
        throw lastErr;
      }
    }
    const retryable = res.status === 429 || res.status === 503 || res.status === 502;
    lastErr = new ProviderError(`${host} answered ${res.status}${res.status === 429 ? " (rate limited)" : ""}`, {
      status: res.status, rateLimited: res.status === 429,
    });
    health.record(provider, { ok: false, ms, status: res.status, error: lastErr.message });
    if (!retryable || attempt >= retries) throw lastErr;
    const ra = Number(res.headers.get("retry-after"));
    await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 10) * 1000 : 2000 * 2 ** attempt);
  }
  throw lastErr;
}

/** Runs fn over items with at most `limit` in flight. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export const num = (v) => {
  const n = typeof v === "string" ? parseFloat(v.replace("%", "")) : v;
  return Number.isFinite(n) ? n : null;
};
