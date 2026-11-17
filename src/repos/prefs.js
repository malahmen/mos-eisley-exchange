// Per-user view preferences (#5). The admin watchlist stays the master list; users choose a subset.
export const PREF_DEFAULTS = {
  pinned: [],
  displayCurrency: null,   // null = follow the admin default; "" = local currency; "EUR" ...
  includeFx: false,
  defaultPage: "dashboard",
  hiddenMarkets: [],
  extraColumn: "",         // "" | r1w | r1m | ytd | r1y
  sharesFilters: {},
  btc: {},
  compare: [],
};
const PAGES = ["dashboard", "bitcoin", "shares", "compare"];
const COLUMNS = ["", "r1w", "r1m", "r3m", "ytd", "r1y"];

export function normalizePrefs(v, { symbols = [], currencies = [] } = {}) {
  const p = { ...PREF_DEFAULTS, ...(v && typeof v === "object" ? v : {}) };
  const known = new Set(symbols);
  p.pinned = [...new Set((Array.isArray(p.pinned) ? p.pinned : []).map(String))].filter((s) => !symbols.length || known.has(s)).slice(0, 100);
  p.compare = [...new Set((Array.isArray(p.compare) ? p.compare : []).map(String))].slice(0, 4);
  if (p.displayCurrency !== null) {
    p.displayCurrency = String(p.displayCurrency || "").toUpperCase();
    if (p.displayCurrency && currencies.length && !currencies.includes(p.displayCurrency)) p.displayCurrency = null;
  }
  p.includeFx = !!p.includeFx;
  if (!PAGES.includes(p.defaultPage)) p.defaultPage = "dashboard";
  p.hiddenMarkets = (Array.isArray(p.hiddenMarkets) ? p.hiddenMarkets : []).map(String).slice(0, 10);
  if (!COLUMNS.includes(p.extraColumn)) p.extraColumn = "";
  for (const k of ["sharesFilters", "btc"]) {
    p[k] = p[k] && typeof p[k] === "object" && !Array.isArray(p[k]) ? p[k] : {};
    if (JSON.stringify(p[k]).length > 2000) p[k] = {};
  }
  return p;
}

export function createPrefsRepo(db) {
  return {
    async get(userId, ctx) {
      const row = await db.get("SELECT value FROM user_prefs WHERE user_id = ?", [userId]);
      let v = null;
      try { v = row ? JSON.parse(row.value) : null; } catch { /* reset */ }
      return normalizePrefs(v, ctx);
    },
    async set(userId, value, ctx) {
      const v = normalizePrefs(value, ctx);
      await db.upsert("user_prefs", "user_id", { user_id: userId, value: JSON.stringify(v), updated_at: new Date().toISOString() });
      return v;
    },
  };
}
