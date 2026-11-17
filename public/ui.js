// Small DOM and formatting helpers (the reference's hyperscript style, no framework).
export const state = { me: null, csrf: "" };

/** h("div", { class: "card", onclick: fn, style: { width: "3px" } }, ...children). Styles go through CSSOM (CSP-safe). */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style") Object.assign(el.style, v);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "value" || k === "checked" || k === "disabled" || k === "selected") el[k] = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
  }
  append(el, children);
  return el;
}
/** Replaces el's children; accepts nested arrays and skips null/false (native replaceChildren would print them). */
export function put(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

const SVGNS = "http://www.w3.org/2000/svg";
export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
  append(el, children);
  return el;
}

export class ApiError extends Error {}

export async function api(path, { method = "GET", body } = {}) {
  const opts = { method, credentials: "same-origin", headers: {} };
  if (method !== "GET") {
    opts.headers["Content-Type"] = "application/json";
    opts.headers["X-CSRF-Token"] = state.csrf;
    opts.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    location.href = "/login";
    throw new ApiError("Signed out.");
  }
  if (res.status === 403 && data.mustChangePassword && location.hash !== "#/account") location.hash = "#/account";
  if (!res.ok) throw Object.assign(new ApiError(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

// ---------- formatting
const fmts = new Map();
function nf(key, opts) {
  if (!fmts.has(key)) fmts.set(key, new Intl.NumberFormat(undefined, opts));
  return fmts.get(key);
}
function digitsFor(v) {
  const a = Math.abs(v);
  return a >= 1000 ? 2 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
}
export function fmtPrice(v, currency) {
  if (v == null || !Number.isFinite(v)) return "—";
  const d = digitsFor(v);
  try {
    return nf(`c:${currency}:${d}`, { style: "currency", currency: currency || "USD", minimumFractionDigits: Math.min(d, 2), maximumFractionDigits: d }).format(v);
  } catch {
    return `${nf(`n:${d}`, { minimumFractionDigits: Math.min(d, 2), maximumFractionDigits: d }).format(v)} ${currency || ""}`.trim();
  }
}
export function fmtNum(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return "—";
  return nf(`n:${digits}`, { maximumFractionDigits: digits }).format(v);
}
export function fmtCompact(v, currency) {
  if (v == null || !Number.isFinite(v)) return "—";
  try {
    return currency
      ? nf(`cc:${currency}`, { notation: "compact", style: "currency", currency, maximumFractionDigits: 2 }).format(v)
      : nf("cc", { notation: "compact", maximumFractionDigits: 2 }).format(v);
  } catch {
    return nf("cc", { notation: "compact", maximumFractionDigits: 2 }).format(v);
  }
}
export const dir = (v) => (v == null || !Number.isFinite(v) || Math.abs(v) < 0.005 ? "flat" : v > 0 ? "up" : "down");
export function fmtPct(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  const d = dir(v);
  const arrow = d === "up" ? "▲ " : d === "down" ? "▼ " : "";
  return `${arrow}${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}
/** A colored change element; the arrow glyph means color is never the only signal. */
export const pctEl = (v, extra = "") => h("span", { class: `change ${dir(v)} ${extra}` }, fmtPct(v));

export function relTime(iso) {
  if (!iso) return "—";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 0) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}
export const timeStr = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—");
export const dateTimeStr = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "—");

// ---------- small components
export function chipGroup(label, options, current, onPick) {
  return h("div", { class: "chips", role: "group", "aria-label": label },
    h("span", { class: "lab" }, label),
    options.map((o) => {
      const opt = typeof o === "string" ? { value: o, label: o } : o;
      return h("button", {
        type: "button", class: "chip", "aria-pressed": String(opt.value === current),
        onclick: () => onPick(opt.value),
      }, opt.dot ? h("span", { class: `dot ${opt.dot}` }) : null, opt.label, opt.count != null ? h("span", { class: "count" }, opt.count) : null);
    }));
}

export function notes(warnings, kind = "warn") {
  if (!warnings?.length) return null;
  if (warnings.length === 1) return h("div", { class: `note ${kind}` }, warnings[0]);
  return h("div", { class: `note ${kind}` }, h("details", null, h("summary", null, `${warnings.length} source warnings`), h("ul", null, warnings.map((w) => h("li", null, w)))));
}

export function setStatus(text, kind = "") {
  const el = document.getElementById("status");
  if (!el) return;
  el.textContent = text;
  el.className = kind ? kind === "bad" ? "status bad" : "status warn" : "";
}

/** <dialog>-based confirm/prompt. fields: [{ name, label, type, value, hint }]. Resolves to values or null. */
export function dialog({ title, text, fields = [], confirm = "OK", danger = false }) {
  return new Promise((resolve) => {
    const inputs = fields.map((f) => h("input", { type: f.type || "text", name: f.name, value: f.value || "", autocomplete: f.autocomplete || "off", required: true }));
    const msg = h("div", { class: "status bad", role: "alert" });
    const form = h("form", { method: "dialog", class: "form" },
      h("h2", null, title),
      text ? h("p", { class: "small muted" }, text) : null,
      fields.map((f, i) => h("label", { class: "field" }, h("span", null, f.label, f.hint ? h("span", { class: "hint" }, ` ${f.hint}`) : null), inputs[i])),
      msg,
      h("div", { class: "actions" },
        h("button", { type: "button", class: "btn ghost", onclick: () => { dlg.close(); resolve(null); } }, "Cancel"),
        h("button", { type: "submit", class: danger ? "btn danger" : "btn" }, confirm)));
    const dlg = h("dialog", null, form);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const values = Object.fromEntries(inputs.map((i) => [i.name, i.value]));
      dlg.close();
      resolve(values);
    });
    dlg.addEventListener("close", () => { dlg.remove(); resolve(null); });
    document.body.append(dlg);
    dlg.showModal();
    (inputs[0] || form.querySelector("button[type=submit]")).focus();
  });
}

export const store = {
  get(key, dflt) {
    try { const v = localStorage.getItem(`mex-${key}`); return v == null ? dflt : JSON.parse(v); } catch { return dflt; }
  },
  set(key, value) {
    try { localStorage.setItem(`mex-${key}`, JSON.stringify(value)); } catch { /* storage blocked */ }
  },
};
