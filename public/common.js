// Helpers shared by the pages: labels, small components, preferences, polling.
import { h, api, state, fmtPrice, fmtNum } from "./ui.js";

export const marketName = (m) => state.me.markets[m] || (m === "CRYPTO" ? "Crypto" : m);
export const STATE_LABEL = { open: "Open", closed: "Closed", pre: "Pre-market", post: "After hours", unknown: "Unknown", break: "Lunch break" };
export const SERIES_COLORS = ["var(--c-vehicle)", "var(--c-animal)", "var(--c-place)", "var(--c-nature)"];
export const isAdmin = () => state.me.user.role === "admin";

export function pageHead(title, subtitle) {
  return [h("h1", null, title), subtitle ? h("p", { class: "muted" }, subtitle) : null];
}
export function errorNote(err) {
  return h("div", { class: "note bad" }, err.message || String(err));
}
export function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
export function stat(label, value) {
  return h("div", null, h("dt", null, label), h("dd", null, value));
}
export function rangeBar(lo, hi, value, fmt, label = "Current price within the range") {
  if (lo == null || hi == null || value == null || hi <= lo) return null;
  const pos = Math.max(0, Math.min(100, ((value - lo) / (hi - lo)) * 100));
  return h("div", { class: "rangebar", title: label },
    h("div", { class: "track", role: "img", "aria-label": `${label}: ${pos.toFixed(0)}%` }, h("div", { class: "marker", style: { left: `${pos}%` } })),
    h("div", { class: "ends" }, h("span", null, fmt(lo)), h("span", null, fmt(hi))));
}
/** Index levels are points, not money. */
export const fmtLevel = (item, v, currency) => (item.kind === "index" ? fmtNum(v, 2) : fmtPrice(v, currency));

export function countdown(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "now";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  const hh = Math.floor(m / 60), mm = m % 60;
  if (hh < 24) return mm ? `${hh} h ${mm} min` : `${hh} h`;
  const d = Math.floor(hh / 24);
  return `${d} day${d > 1 ? "s" : ""} ${hh % 24} h`;
}

/** Text for a market clock from /api/markets. */
export function clockText(c) {
  if (!c) return "";
  if (c.state === "open") return c.breakAt ? `Lunch break in ${countdown(c.breakAt)}` : `Closes in ${countdown(c.closesAt)}`;
  if (c.state === "break") return `Lunch break · resumes in ${countdown(c.resumesAt)}`;
  if (c.opensAt) return `${c.holidayToday ? "Holiday · " : ""}Opens in ${countdown(c.opensAt)}`;
  return "Closed";
}

// ---------- preferences (saved on the server, debounced)
let pending = {}, timer = 0;
export function savePrefs(patch) {
  Object.assign(state.me.prefs, patch);
  Object.assign(pending, patch);
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const body = pending;
    pending = {};
    try {
      const r = await api("/api/account/prefs", { method: "PUT", body: { prefs: body } });
      state.me.prefs = r.prefs;
    } catch { /* keep the local copy */ }
  }, 500);
}
/** The currency shares are shown in: "" = their own. */
export function displayCurrency() {
  const p = state.me.prefs.displayCurrency;
  return p === null || p === undefined ? state.me.general.displayCurrency || "" : p;
}

// ---------- polling (paused while the tab is hidden)
export function makePoller() {
  const jobs = [];
  const onVisible = () => {
    if (document.hidden) return;
    for (const j of jobs) if (Date.now() - j.last > j.ms) j.run();
  };
  document.addEventListener("visibilitychange", onVisible);
  return {
    every(fn, seconds) {
      const job = { ms: seconds * 1000, last: Date.now(), timer: 0 };
      job.run = async () => {
        clearTimeout(job.timer);
        job.last = Date.now();
        try { await fn(); } catch { /* the page shows its own error */ }
        job.timer = setTimeout(() => (document.hidden ? null : job.run()), job.ms);
      };
      job.timer = setTimeout(job.run, job.ms);
      jobs.push(job);
    },
    stop() {
      document.removeEventListener("visibilitychange", onVisible);
      for (const j of jobs) clearTimeout(j.timer);
    },
  };
}

// ---------- client-side series maths for compare mode
export function seriesStats(points) {
  if (points.length < 2) return {};
  const first = points[0][1], last = points[points.length - 1][1];
  const r = [];
  for (let i = 1; i < points.length; i++) if (points[i - 1][1]) r.push(points[i][1] / points[i - 1][1] - 1);
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = r.length > 1 ? Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1)) : null;
  const spanDays = (points[points.length - 1][0] - points[0][0]) / 86400_000;
  const perDay = r.length / Math.max(1, spanDays);
  let peak = -Infinity, dd = 0;
  for (const [, c] of points) { peak = Math.max(peak, c); dd = Math.min(dd, c / peak - 1); }
  return {
    ret: (last / first - 1) * 100,
    // Annualised: observations per calendar day × 365 (≈252 for shares, 365 for Bitcoin).
    vol: sd != null && spanDays >= 20 ? sd * Math.sqrt(perDay * 365) * 100 : null,
    maxDD: dd * 100,
  };
}

export function correlation(a, b) {
  const key = (ms) => new Date(ms).toISOString().slice(0, 10);
  const ma = new Map(a.map(([t, c]) => [key(t), c])), mb = new Map(b.map(([t, c]) => [key(t), c]));
  const days = [...ma.keys()].filter((d) => mb.has(d)).sort();
  const ra = [], rb = [];
  for (let i = 1; i < days.length; i++) {
    const a0 = ma.get(days[i - 1]), b0 = mb.get(days[i - 1]);
    if (a0 && b0) { ra.push(ma.get(days[i]) / a0 - 1); rb.push(mb.get(days[i]) / b0 - 1); }
  }
  if (ra.length < 10) return null;
  const m = (x) => x.reduce((s, v) => s + v, 0) / x.length;
  const xa = m(ra), xb = m(rb);
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < ra.length; i++) { n += (ra[i] - xa) * (rb[i] - xb); da += (ra[i] - xa) ** 2; db += (rb[i] - xb) ** 2; }
  return da && db ? n / Math.sqrt(da * db) : null;
}
