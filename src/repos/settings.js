// Runtime settings kept in the database (edited in Admin), as JSON per name.
// Infrastructure settings (database, LLM endpoint, port, secrets) stay in env vars, as in death-star-audit.
import { PROVIDERS, KINDS } from "../providers/registry.js";
import { DEFAULT_HOLIDAYS, SCHEDULES } from "../providers/markets.js";
import { parseSlot } from "../jobs.js";

export const DEFAULTS = {
  general: {
    refreshSeconds: 60,          // how often open pages poll for prices
    cryptoCurrencies: ["USD", "EUR"], // reference currencies: Bitcoin quotes and share conversion
    defaultCurrency: "USD",
    displayCurrency: "",         // "" = show shares in their own currency (users can override)
    snapshotMinutes: 5,
    retention: { rawDays: 7, hourlyDays: 180, dailyYears: 0 }, // dailyYears 0 = forever
    holidays: DEFAULT_HOLIDAYS,
    digest: { enabled: true, schedule: "MON 08:00", email: true },
    viewerAlerts: false,
  },
  providers: {
    cacheTtlSeconds: 60,         // how long the server reuses one answer from a provider
    ...Object.fromEntries(KINDS.map((k) => [k, PROVIDERS[k].map((p) => ({ id: p.id, enabled: p.defaultEnabled }))])),
    keys: {},                    // id -> key (sealed with SECRET_KEY when set)
  },
  notifications: {
    email: { enabled: false, host: "", port: 587, tls: "starttls", user: "", pass: "", from: "", allowSelfSigned: false },
    ntfy: { enabled: false, url: "", token: "" },
    telegram: { enabled: false, botToken: "", chatId: "" },
    webhook: { enabled: false, url: "", secret: "" },
  },
};

/** Keeps the stored order, drops unknown providers and appends new ones (enabled if they default to it). */
function mergeList(stored, known) {
  const ids = new Set(known.map((p) => p.id));
  const list = (Array.isArray(stored) ? stored : []).filter((e) => e && ids.has(e.id)).map((e) => ({ id: e.id, enabled: !!e.enabled }));
  for (const p of known) if (!list.some((e) => e.id === p.id)) list.push({ id: p.id, enabled: p.defaultEnabled });
  return list;
}

function clamp(n, lo, hi, dflt) {
  n = Math.round(Number(n));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}
const str = (v, max = 300) => String(v ?? "").trim().slice(0, max);

function normalize(name, value) {
  const d = DEFAULTS[name];
  const v = { ...structuredClone(d), ...(value || {}) };
  if (name === "providers") {
    for (const k of KINDS) v[k] = mergeList(value?.[k], PROVIDERS[k]);
    v.keys = { ...(value?.keys || {}) };
    v.cacheTtlSeconds = clamp(v.cacheTtlSeconds, 15, 3600, d.cacheTtlSeconds);
  }
  if (name === "general") {
    v.refreshSeconds = clamp(v.refreshSeconds, 15, 3600, d.refreshSeconds);
    v.cryptoCurrencies = [...new Set((Array.isArray(v.cryptoCurrencies) ? v.cryptoCurrencies : d.cryptoCurrencies)
      .map((c) => String(c).trim().toUpperCase()).filter((c) => /^[A-Z]{3}$/.test(c)))].slice(0, 6);
    if (!v.cryptoCurrencies.length) v.cryptoCurrencies = [...d.cryptoCurrencies];
    v.defaultCurrency = String(v.defaultCurrency || "").toUpperCase();
    if (!v.cryptoCurrencies.includes(v.defaultCurrency)) v.defaultCurrency = v.cryptoCurrencies[0];
    v.displayCurrency = String(v.displayCurrency || "").toUpperCase();
    if (v.displayCurrency && !v.cryptoCurrencies.includes(v.displayCurrency)) v.displayCurrency = "";
    v.snapshotMinutes = clamp(v.snapshotMinutes, 1, 60, d.snapshotMinutes);
    const r = { ...d.retention, ...(value?.retention || {}) };
    v.retention = {
      rawDays: clamp(r.rawDays, 1, 90, d.retention.rawDays),
      hourlyDays: clamp(r.hourlyDays, 30, 3650, d.retention.hourlyDays),
      dailyYears: clamp(r.dailyYears, 0, 50, 0),
    };
    const h = value?.holidays && typeof value.holidays === "object" ? value.holidays : d.holidays;
    v.holidays = Object.fromEntries(Object.keys(SCHEDULES).map((m) => [m,
      [...new Set((Array.isArray(h[m]) ? h[m] : d.holidays[m] || []).map(String).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)))].sort()]));
    const dg = { ...d.digest, ...(value?.digest || {}) };
    v.digest = { enabled: !!dg.enabled, schedule: parseSlot(dg.schedule) ? String(dg.schedule).toUpperCase().trim() : d.digest.schedule, email: !!dg.email };
    v.viewerAlerts = !!v.viewerAlerts;
  }
  if (name === "notifications") {
    const n = value || {};
    const e = { ...d.email, ...(n.email || {}) };
    v.email = {
      enabled: !!e.enabled, host: str(e.host, 200), port: clamp(e.port, 1, 65535, 587),
      tls: ["none", "starttls", "tls"].includes(e.tls) ? e.tls : "starttls",
      user: str(e.user, 200), pass: str(e.pass, 2000), from: str(e.from, 200), allowSelfSigned: !!e.allowSelfSigned,
    };
    const ny = { ...d.ntfy, ...(n.ntfy || {}) };
    v.ntfy = { enabled: !!ny.enabled, url: str(ny.url, 300), token: str(ny.token, 2000) };
    const t = { ...d.telegram, ...(n.telegram || {}) };
    v.telegram = { enabled: !!t.enabled, botToken: str(t.botToken, 2000), chatId: str(t.chatId, 64) };
    const w = { ...d.webhook, ...(n.webhook || {}) };
    v.webhook = { enabled: !!w.enabled, url: str(w.url, 500), secret: str(w.secret, 2000) };
  }
  return v;
}

export function createSettingsRepo(db) {
  const cache = new Map();
  return {
    async get(name) {
      if (!DEFAULTS[name]) throw new Error(`Unknown setting ${name}`);
      if (!cache.has(name)) {
        const row = await db.get("SELECT value FROM settings WHERE name = ?", [name]);
        let stored = null;
        try { stored = row ? JSON.parse(row.value) : null; } catch { /* corrupt row: fall back to defaults */ }
        cache.set(name, normalize(name, stored));
      }
      return structuredClone(cache.get(name));
    },
    async set(name, value) {
      const v = normalize(name, value);
      await db.upsert("settings", "name", { name, value: JSON.stringify(v), updated_at: new Date().toISOString() });
      cache.set(name, v);
      return structuredClone(v);
    },
    /** Raw stored flags (e.g. one-time seeding markers) without normalisation. */
    async flag(name) {
      const row = await db.get("SELECT value FROM settings WHERE name = ?", [`flag:${name}`]);
      return row ? JSON.parse(row.value) : null;
    },
    async setFlag(name, value) {
      await db.upsert("settings", "name", { name: `flag:${name}`, value: JSON.stringify(value), updated_at: new Date().toISOString() });
    },
  };
}
