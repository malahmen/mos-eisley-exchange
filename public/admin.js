// Admin: users, providers, watchlist, settings, notifications, health, audit log.
import { h, put, api, state, dialog, chipGroup, relTime, dateTimeStr, setStatus, fmtCompact } from "./ui.js";
import { sparkline } from "./charts.js";

const TABS = [
  { id: "users", label: "Users" }, { id: "providers", label: "Providers" }, { id: "watchlist", label: "Watchlist" },
  { id: "settings", label: "Settings" }, { id: "notifications", label: "Notifications" }, { id: "health", label: "Health" },
  { id: "audit", label: "Audit log" },
];
const statusEl = () => h("div", { class: "status", role: "status", "aria-live": "polite" });
const say = (el, text, kind = "") => { el.textContent = text; el.className = `status ${kind}`; };
const field = (label, control, hint) => h("label", { class: "field" }, h("span", null, label, hint ? h("span", { class: "hint" }, ` ${hint}`) : null), control);
const row = (k, v) => h("div", null, h("dt", null, k), h("dd", null, v));

export async function adminPage(root, rest) {
  const tabsNav = h("nav", { class: "tabs", "aria-label": "Admin sections" });
  const body = h("div");
  put(root, h("h1", null, "Admin"), h("p", { class: "muted" }, "Users, data sources, notifications and settings. Changes are recorded in the audit log."), tabsNav, body);
  async function show(tab) {
    tab = TABS.some((t) => t.id === tab) ? tab : "users";
    put(tabsNav, TABS.map((t) => h("a", { href: `#/admin/${t.id}`, "aria-current": t.id === tab ? "page" : null }, t.label)));
    put(body, h("p", { class: "skeleton" }, "Loading…"));
    setStatus("");
    try {
      await { users, providers, watchlist, settings, notifications, health, audit }[tab](body);
    } catch (err) {
      put(body, h("div", { class: "note bad" }, err.message));
    }
  }
  await show(rest[0]);
  return { update: (next) => show(next[0]) };
}

// ---------------------------------------------------------------- users
async function users(body) {
  const { users: list } = await api("/api/admin/users");
  const msg = statusEl();
  const me = state.me.user;
  async function act(fn, ok) {
    try { await fn(); await users(body); setStatus(ok); } catch (err) { say(msg, err.message, "bad"); }
  }
  async function showSessions(u) {
    const r = await api(`/api/admin/users/${u.id}/sessions`);
    const dlg = h("dialog", { class: "wide" },
      h("h2", null, `Sessions of ${u.username}`),
      r.sessions.length ? h("table", { class: "data" }, h("tbody", null, r.sessions.map((s) => h("tr", null,
        h("td", null, s.device), h("td", { class: "small mono" }, s.ip || ""), h("td", { class: "small muted" }, `last seen ${relTime(s.lastSeenAt)}`))))) : h("p", { class: "small muted" }, "No active sessions."),
      h("div", { class: "actions" },
        r.sessions.length ? h("button", { class: "btn danger", type: "button", onclick: () => act(() => api(`/api/admin/users/${u.id}/sessions`, { method: "DELETE" }), `Signed ${u.username} out everywhere.`).then(() => dlg.close()) }, "Sign out everywhere") : null,
        h("button", { class: "btn ghost", type: "button", onclick: () => dlg.close() }, "Close")));
    dlg.addEventListener("close", () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }
  const create = h("form", { class: "addrow", novalidate: true },
    h("input", { type: "text", name: "username", placeholder: "username", autocomplete: "off", autocapitalize: "none", "aria-label": "New username" }),
    h("input", { type: "password", name: "password", placeholder: "temporary password (10+ chars)", autocomplete: "new-password", "aria-label": "Temporary password" }),
    h("input", { type: "email", name: "email", placeholder: "email (optional)", autocomplete: "off", "aria-label": "Email" }),
    h("select", { name: "role", "aria-label": "Role", style: { flex: "0 0 auto" } }, h("option", { value: "viewer" }, "viewer"), h("option", { value: "admin" }, "admin")),
    h("button", { class: "btn", type: "submit" }, "Add user"));
  const createMsg = statusEl();
  create.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(create));
    try {
      await api("/api/admin/users", { method: "POST", body: { ...v, mustChangePassword: true } });
      await users(body);
      setStatus(`User ${v.username.toLowerCase()} created. They must choose a new password at first sign-in.`);
    } catch (err) { say(createMsg, err.message, "bad"); }
  });
  put(body,
    h("div", { class: "card" },
      h("h2", null, "Users ", h("span", { class: "tag" }, String(list.length))),
      h("div", { class: "tablewrap" }, h("table", { class: "data" },
        h("thead", null, h("tr", null, h("th", null, "User"), h("th", null, "Role"), h("th", null, "Email"), h("th", null, "Status"), h("th", null, "Last sign-in"), h("th", null, ""))),
        h("tbody", null, list.map((u) => {
          const self = u.id === me.id;
          return h("tr", null,
            h("td", null, h("strong", null, u.username), self ? h("span", { class: "tag" }, "you") : null),
            h("td", null, h("span", { class: `tag ${u.role === "admin" ? "admin" : ""}` }, u.role)),
            h("td", { class: "small" }, u.email || h("span", { class: "muted" }, "—")),
            h("td", { class: "small" },
              u.disabled ? h("span", { class: "tag bad" }, "disabled") : "active",
              u.totpEnabled ? h("span", { class: "tag open" }, "2FA") : null,
              u.mustChangePassword ? h("span", { class: "tag" }, "must change password") : null),
            h("td", { class: "small muted", title: u.lastLoginAt ? dateTimeStr(u.lastLoginAt) : "" }, u.lastLoginAt ? relTime(u.lastLoginAt) : "never"),
            h("td", null, h("div", { class: "addrow", style: { margin: 0, justifyContent: "flex-end" } },
              !self ? h("button", { class: "btn ghost sm", type: "button", onclick: () =>
                act(() => api(`/api/admin/users/${u.id}`, { method: "PATCH", body: { role: u.role === "admin" ? "viewer" : "admin" } }), `${u.username} is now ${u.role === "admin" ? "a viewer" : "an admin"}.`) }, u.role === "admin" ? "Make viewer" : "Make admin") : null,
              h("button", { class: "btn ghost sm", type: "button", onclick: async () => {
                const v = await dialog({ title: `Email for ${u.username}`, fields: [{ name: "email", label: "Email address", type: "email", value: u.email }], confirm: "Save" });
                if (v) act(() => api(`/api/admin/users/${u.id}`, { method: "PATCH", body: { email: v.email } }), "Email saved.");
              } }, "Email"),
              h("button", { class: "btn ghost sm", type: "button", onclick: async () => {
                const v = await dialog({
                  title: `Reset password for ${u.username}`,
                  text: self ? "Set a new password for your own account." : "Set a temporary password. They will have to change it at the next sign-in; their sessions end now.",
                  fields: [{ name: "password", label: "New password", type: "password", hint: "10+ characters", autocomplete: "new-password" }], confirm: "Set password",
                });
                if (v) act(() => api(`/api/admin/users/${u.id}`, { method: "PATCH", body: { password: v.password } }), `Password reset for ${u.username}.`);
              } }, "Reset password"),
              u.totpEnabled && !self ? h("button", { class: "btn ghost sm", type: "button", onclick: async () => {
                const ok = await dialog({ title: `Reset two-factor for ${u.username}?`, text: "Use this when they lost their phone. They can sign in with the password only and enrol again.", confirm: "Reset 2FA", danger: true });
                if (ok) act(() => api(`/api/admin/users/${u.id}/2fa/reset`, { method: "POST" }), `Two-factor reset for ${u.username}.`);
              } }, "Reset 2FA") : null,
              h("button", { class: "btn ghost sm", type: "button", onclick: () => showSessions(u) }, "Sessions"),
              !self ? h("button", { class: "btn ghost sm", type: "button", onclick: () =>
                act(() => api(`/api/admin/users/${u.id}`, { method: "PATCH", body: { disabled: !u.disabled } }), `${u.username} ${u.disabled ? "enabled" : "disabled"}.`) }, u.disabled ? "Enable" : "Disable") : null,
              !self ? h("button", { class: "btn danger sm", type: "button", onclick: async () => {
                const ok = await dialog({ title: `Delete ${u.username}?`, text: "The account, its sessions, preferences and personal alerts are removed. Its audit entries stay.", confirm: "Delete", danger: true });
                if (ok) act(() => api(`/api/admin/users/${u.id}`, { method: "DELETE" }), `${u.username} deleted.`);
              } }, "Delete") : null)));
        })))),
      msg),
    h("div", { class: "card section" },
      h("h2", null, "Add a user"),
      h("p", { class: "small muted" }, "Viewers see the dashboards. Admins also manage users, providers, the watchlist, notifications and settings."),
      create, createMsg));
}

// ---------------------------------------------------------------- providers
const KIND_TITLES = {
  equity: ["Share prices", "Tried top to bottom; a share uses the first source that answers for it."],
  crypto: ["Bitcoin", "Every enabled source is shown on the Bitcoin page; the first one is the headline price."],
  fx: ["Exchange rates", "Used to show shares in one currency. Tried top to bottom."],
  btcextra: ["Bitcoin context", "Sentiment, dominance and network figures on the Bitcoin page."],
};

async function providers(body) {
  let cfg = await api("/api/admin/providers");
  const pendingKeys = {};
  const msg = statusEl();
  function move(kind, i, delta) {
    const list = cfg[kind];
    const j = i + delta;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    render();
  }
  function providerRow(kind, p, i) {
    const keyInput = h("input", {
      type: "password", autocomplete: "off", "aria-label": `${p.name} API key`,
      placeholder: p.keySource === "env" ? `set by env var (${p.keyHint})` : p.keySource === "db" ? `stored (${p.keyHint}): type to replace` : p.needsKey ? "API key (required)" : "API key (optional)",
      disabled: p.keySource === "env", oninput: (e) => { pendingKeys[p.id] = e.target.value; },
    });
    const testMsg = h("span", { class: "small muted" });
    const showKey = p.needsKey || p.optionalKey;
    const hl = p.health;
    return h("div", { class: "prow" },
      h("div", { class: "ord" },
        h("button", { class: "iconbtn", type: "button", "aria-label": `Move ${p.name} up`, disabled: i === 0, onclick: () => move(kind, i, -1) }, "▲"),
        h("button", { class: "iconbtn", type: "button", "aria-label": `Move ${p.name} down`, disabled: i === cfg[kind].length - 1, onclick: () => move(kind, i, 1) }, "▼")),
      h("div", null,
        h("label", { class: "check", style: { fontSize: "15px" } }, h("input", { type: "checkbox", checked: p.enabled, onchange: (e) => { p.enabled = e.target.checked; } }), h("strong", null, p.name)),
        p.needsKey ? h("span", { class: "tag" }, "key required") : h("span", { class: "tag open" }, "free, no key"),
        p.history ? h("span", { class: "tag" }, "history") : null,
        hl?.failingForMs ? h("span", { class: "tag bad", title: hl.lastError }, "failing") : null,
        h("div", { class: "small muted" }, p.note, " ", h("a", { href: p.site, target: "_blank", rel: "noopener noreferrer" }, "Site"))),
      h("div", null, h("button", { class: "btn ghost sm", type: "button", onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        testMsg.textContent = "Testing…";
        testMsg.className = "small muted";
        try {
          const r = await api(`/api/admin/providers/${p.id}/test`, { method: "POST", body: { key: pendingKeys[p.id] || "" } });
          testMsg.textContent = r.ok ? `OK in ${r.ms} ms: ${r.sample}` : `Failed: ${r.error}`;
          testMsg.className = r.ok ? "small up" : "small down";
        } catch (err) {
          testMsg.textContent = `Failed: ${err.message}`;
          testMsg.className = "small down";
        }
        btn.disabled = false;
      } }, "Test")),
      h("div", { class: "pkey" },
        showKey ? keyInput : null,
        showKey && p.keySource === "db" ? h("button", { class: "btn ghost sm", type: "button", onclick: () => { pendingKeys[p.id] = null; keyInput.value = ""; keyInput.placeholder = "will be removed on save"; } }, "Remove key") : null,
        testMsg));
  }
  function card(kind) {
    const [title, note] = KIND_TITLES[kind];
    return h("div", { class: "card" }, h("h2", null, title), h("p", { class: "small muted" }, note), cfg[kind].map((p, i) => providerRow(kind, p, i)));
  }
  function render() {
    put(body,
      h("div", { class: "note plain" }, "Free sources need no setup. Keyed sources are optional fallbacks: get a free key on their site and paste it here (or set it as an env var, which wins). Keys are stored encrypted when SECRET_KEY is set."),
      h("div", { class: "layout" },
        h("div", { class: "stack" }, card("equity"), card("fx")),
        h("div", { class: "stack" }, card("crypto"), card("btcextra"),
          h("div", { class: "card" }, h("h2", null, "Caching"),
            field("Reuse an answer for (seconds)", h("input", { type: "number", min: 15, max: 3600, step: 5, value: cfg.cacheTtlSeconds, style: { width: "120px" }, oninput: (e) => { cfg.cacheTtlSeconds = Number(e.target.value); } }), "15–3600; protects the free rate limits")))),
      h("div", { class: "addrow section" }, h("button", { class: "btn", type: "button", onclick: save }, "Save providers"), msg));
  }
  async function save() {
    try {
      const keys = {};
      for (const [id, v] of Object.entries(pendingKeys)) if (v === null || (typeof v === "string" && v.trim())) keys[id] = v === null ? null : v.trim();
      const bodyOut = { cacheTtlSeconds: cfg.cacheTtlSeconds, keys };
      for (const k of ["equity", "crypto", "fx", "btcextra"]) bodyOut[k] = cfg[k].map((p) => ({ id: p.id, enabled: p.enabled }));
      cfg = await api("/api/admin/providers", { method: "PUT", body: bodyOut });
      for (const k of Object.keys(pendingKeys)) delete pendingKeys[k];
      render();
      setStatus("Providers saved. The price cache was cleared.");
    } catch (err) { say(msg, err.message, "bad"); }
  }
  render();
}

// ---------------------------------------------------------------- watchlist
async function watchlist(body) {
  let { items, markets } = await api("/api/admin/watchlist");
  const msg = statusEl();
  const results = h("div");
  let searchTimer;
  async function add(entry) {
    try {
      const r = await api("/api/admin/watchlist", { method: "POST", body: entry });
      ({ items } = await api("/api/admin/watchlist"));
      say(msg, `${r.item.symbol} added as ${r.item.kind === "index" ? "an index" : "a share"}.`);
      render();
    } catch (err) { say(msg, err.message, "bad"); }
  }
  const q = h("input", { type: "search", placeholder: "Search by name or symbol (e.g. tencent, EDP, hang seng)…", "aria-label": "Search symbols" });
  q.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const term = q.value.trim();
    if (term.length < 2) { put(results); return; }
    searchTimer = setTimeout(async () => {
      try {
        const r = await api(`/api/admin/symbol-search?q=${encodeURIComponent(term)}`);
        const on = new Set(items.map((i) => i.symbol));
        put(results,
          r.error ? h("div", { class: "note warn" }, r.error) : null,
          r.results.length ? h("div", { class: "tablewrap" }, h("table", { class: "data" }, h("tbody", null, r.results.map((x) => h("tr", null,
            h("td", null, h("span", { class: "sym" }, x.symbol), h("span", { class: "sub" }, x.name)),
            h("td", { class: "small muted" }, x.exchange, x.type ? ` · ${x.type}` : ""),
            h("td", { class: "num" }, on.has(x.symbol) ? h("span", { class: "small muted" }, "on the list")
              : h("button", { class: "btn ghost sm", type: "button", onclick: () => add({ symbol: x.symbol, name: x.name, exchange: x.exchange, sector: x.sector, type: x.type }) }, "Add"))))))) :
            !r.error ? h("p", { class: "small muted" }, "No matches. You can still add a symbol directly below.") : null);
      } catch (err) { put(results, h("div", { class: "note bad" }, err.message)); }
    }, 350);
  });
  const direct = h("form", { class: "addrow", novalidate: true },
    h("input", { type: "text", name: "symbol", placeholder: "Symbol, e.g. AAPL, EDP.LS, 600519.SS, 0700.HK, ^GSPC", autocapitalize: "characters", "aria-label": "Symbol" }),
    h("select", { name: "kind", "aria-label": "Type", style: { flex: "0 0 auto" } }, h("option", { value: "" }, "auto"), h("option", { value: "equity" }, "share"), h("option", { value: "index" }, "index")),
    h("button", { class: "btn ghost", type: "submit" }, "Add symbol"));
  direct.addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(direct);
    const symbol = fd.get("symbol").trim();
    if (symbol) add({ symbol, kind: fd.get("kind") || undefined }).then(() => direct.reset());
  });
  async function reorder(kind, i, delta) {
    const list = items.filter((x) => x.kind === kind);
    const j = i + delta;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    items = [...items.filter((x) => x.kind !== kind), ...list];
    render();
    try { ({ items } = await api("/api/admin/watchlist/order", { method: "PUT", body: { ids: list.map((x) => x.id) } })); } catch (err) { say(msg, err.message, "bad"); }
  }
  function table(kind, title) {
    const list = items.filter((x) => x.kind === kind);
    return h("div", { class: "card" },
      h("h2", null, `${title} `, h("span", { class: "tag" }, String(list.length))),
      list.length ? h("div", { class: "tablewrap" }, h("table", { class: "data" },
        h("thead", null, h("tr", null, h("th", null, ""), h("th", null, "Symbol"), h("th", null, "Market"), h("th", null, "Currency"), h("th", null, ""))),
        h("tbody", null, list.map((it, i) => h("tr", null,
          h("td", null, h("div", { class: "addrow", style: { margin: 0, flexWrap: "nowrap", gap: "2px" } },
            h("button", { class: "iconbtn", type: "button", "aria-label": `Move ${it.symbol} up`, disabled: i === 0, onclick: () => reorder(kind, i, -1) }, "▲"),
            h("button", { class: "iconbtn", type: "button", "aria-label": `Move ${it.symbol} down`, disabled: i === list.length - 1, onclick: () => reorder(kind, i, 1) }, "▼"))),
          h("td", null, h("span", { class: "sym" }, it.symbol), h("span", { class: "sub" }, it.name)),
          h("td", { class: "small" }, markets[it.market] || it.market),
          h("td", { class: "small" }, it.currency || "—"),
          h("td", { class: "num" }, h("button", { class: "btn danger sm", type: "button", onclick: async () => {
            try {
              await api(`/api/admin/watchlist/${it.id}`, { method: "DELETE" });
              items = items.filter((x) => x.id !== it.id);
              say(msg, `${it.symbol} removed.`);
              render();
            } catch (err) { say(msg, err.message, "bad"); }
          } }, "Remove"))))))) : h("p", { class: "small muted" }, "None."));
  }
  function render() {
    put(body, h("div", { class: "layout" },
      h("div", { class: "stack" }, table("equity", "Shares"), table("index", "Indices"), msg),
      h("div", { class: "stack" },
        h("div", { class: "card" }, h("h2", null, "Find and add"), q, results),
        h("div", { class: "card" }, h("h2", null, "Add by symbol"),
          h("p", { class: "small muted" }, "Yahoo Finance notation: no suffix for US; .LS Lisbon, .PA Paris, .AS Amsterdam, .DE Xetra, .L London; .SS Shanghai, .SZ Shenzhen; .HK Hong Kong. Indices: ^GSPC, ^STOXX50E, ^HSI, PSI20.LS, 000001.SS."),
          direct))));
  }
  render();
}

// ---------------------------------------------------------------- settings
async function settings(body) {
  const { general: g, system } = await api("/api/admin/settings");
  const msg = statusEl();
  const holidayInputs = Object.fromEntries(Object.keys(g.holidays).map((m) => [m, h("textarea", { rows: 3, "aria-label": `Holidays ${m}` }, g.holidays[m].join("\n"))]));
  const f = h("form", { class: "form", novalidate: true, style: { maxWidth: "none" } },
    h("h3", null, "Display"),
    h("div", { class: "addrow" },
      field("Refresh prices every (s)", h("input", { type: "number", name: "refreshSeconds", min: 15, max: 3600, value: g.refreshSeconds }), "15–3600"),
      field("Reference currencies", h("input", { type: "text", name: "cryptoCurrencies", value: g.cryptoCurrencies.join(", ") }), "Bitcoin quotes and conversion, up to 6")),
    h("div", { class: "addrow" },
      field("Bitcoin default currency", h("input", { type: "text", name: "defaultCurrency", value: g.defaultCurrency, maxlength: 3 })),
      field("Show shares in (default)", h("input", { type: "text", name: "displayCurrency", value: g.displayCurrency, maxlength: 3, placeholder: "empty = local" }), "users can override")),
    h("h3", null, "Stored history"),
    h("div", { class: "addrow" },
      field("Snapshot every (min)", h("input", { type: "number", name: "snapshotMinutes", min: 1, max: 60, value: g.snapshotMinutes })),
      field("Keep raw prices (days)", h("input", { type: "number", name: "rawDays", min: 1, max: 90, value: g.retention.rawDays }), "1–90"),
      field("Keep hourly (days)", h("input", { type: "number", name: "hourlyDays", min: 30, max: 3650, value: g.retention.hourlyDays }), "30–3650"),
      field("Keep daily (years)", h("input", { type: "number", name: "dailyYears", min: 0, max: 50, value: g.retention.dailyYears }), "0 = forever")),
    h("p", { class: "small muted" }, `Stored now: ${system.history.raw.toLocaleString()} raw, ${system.history.hour.toLocaleString()} hourly, ${system.history.day.toLocaleString()} daily rows${system.history.oldestDay ? ` (since ${system.history.oldestDay.slice(0, 10)})` : ""}${system.history.bytes != null ? ` · database ${fmtCompact(system.history.bytes)}B` : ""}. Lowering a value deletes older rows at the next hourly run.`),
    h("h3", null, "Market holidays"),
    h("p", { class: "small muted" }, "One date per line (YYYY-MM-DD). Used for the open/close countdowns; check the exchanges' calendars."),
    h("div", { class: "holidays" }, Object.entries(holidayInputs).map(([m, ta]) => field(m, ta))),
    h("h3", null, "Weekly digest (LLM)"),
    h("div", { class: "addrow" },
      h("label", { class: "check" }, h("input", { type: "checkbox", name: "digestEnabled", checked: g.digest.enabled }), "Generate weekly"),
      field("When (server time)", h("input", { type: "text", name: "digestSchedule", value: g.digest.schedule }), "e.g. MON 08:00 or DAILY 18:00"),
      h("label", { class: "check" }, h("input", { type: "checkbox", name: "digestEmail", checked: g.digest.email }), "Email it to admins")),
    h("h3", null, "Alerts"),
    h("label", { class: "check" }, h("input", { type: "checkbox", name: "viewerAlerts", checked: g.viewerAlerts }), "Viewers can create their own alerts (in app and email, up to 20 each)"),
    h("div", null, h("button", { class: "btn", type: "submit" }, "Save settings")), msg);
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(f));
    const holidays = Object.fromEntries(Object.entries(holidayInputs).map(([m, ta]) => [m, ta.value.split(/[\s,]+/).filter(Boolean)]));
    try {
      const r = await api("/api/admin/settings", {
        method: "PUT",
        body: { general: {
          refreshSeconds: Number(v.refreshSeconds), cryptoCurrencies: v.cryptoCurrencies.split(/[\s,;]+/).filter(Boolean),
          defaultCurrency: v.defaultCurrency, displayCurrency: v.displayCurrency, snapshotMinutes: Number(v.snapshotMinutes),
          retention: { rawDays: Number(v.rawDays), hourlyDays: Number(v.hourlyDays), dailyYears: Number(v.dailyYears) }, holidays,
          digest: { enabled: !!v.digestEnabled, schedule: v.digestSchedule, email: !!v.digestEmail }, viewerAlerts: !!v.viewerAlerts,
        } },
      });
      Object.assign(state.me.general, { refreshSeconds: r.general.refreshSeconds, cryptoCurrencies: r.general.cryptoCurrencies, defaultCurrency: r.general.defaultCurrency, displayCurrency: r.general.displayCurrency });
      await settings(body);
      setStatus("Settings saved.");
    } catch (err) { say(msg, err.message, "bad"); }
  });
  put(body, h("div", { class: "layout" },
    h("div", { class: "card" }, h("h2", null, "Settings"), f),
    h("div", { class: "stack" },
      h("div", { class: "card" }, h("h2", null, "Secrets ", h("span", { class: `tag ${system.secrets.encrypted ? "open" : "bad"}` }, system.secrets.encrypted ? "encrypted" : "plain text")),
        h("p", { class: "small muted" }, system.secrets.encrypted
          ? "API keys, the SMTP password and two-factor secrets are encrypted with SECRET_KEY."
          : "Set SECRET_KEY (npm run gen-secret) and restart: stored keys and passwords are then encrypted automatically.")),
      h("div", { class: "card" }, h("h2", null, "LLM ", h("span", { class: `tag ${system.llm.enabled ? "open" : ""}` }, system.llm.enabled ? "enabled" : "off")),
        h("dl", { class: "stats" }, row("API", system.llm.api), row("Model", system.llm.model), row("Endpoint", h("code", null, system.llm.baseURL || "—"))),
        h("p", { class: "small muted", style: { marginTop: "8px" } }, "LLM_ENABLED, LLM_API, LLM_MODEL, LLM_BASE_URL, LLM_API_KEY (env or .env), then restart.")),
      h("div", { class: "card" }, h("h2", null, "Database ", h("span", { class: "tag" }, `${system.db.engine} · schema v${system.db.schemaVersion}`)),
        h("p", null, h("code", null, system.db.describe)),
        h("p", { class: "small muted" }, "DB_ENGINE=sqlite|mysql, SQLITE_PATH or MYSQL_*, then restart.")),
      h("div", { class: "card" }, h("h2", null, "Access"),
        h("dl", { class: "stats" },
          row("Idle timeout", `${system.session.ttlHours} h`), row("Maximum", `${system.session.maxDays} days`),
          row("Secure cookie", system.session.cookieSecure ? "yes" : "no (HTTP)"), row("Behind proxy", system.session.trustProxy ? "yes" : "no"),
          row("Admin networks", system.adminAllowList ? system.adminAllowList.join(", ") : "any (ADMIN_ALLOW_CIDRS)")),
        h("p", { class: "small muted", style: { marginTop: "8px" } }, `Node ${system.node}.`)))));
}

// ---------------------------------------------------------------- notifications
async function notifications(body) {
  const { notifications: n, myEmail } = await api("/api/admin/notifications");
  const msg = statusEl();
  const v = structuredClone(n);
  const secret = (ch, k, label) => field(label, h("input", { type: "password", autocomplete: "new-password", placeholder: n[ch][k] ? "stored: type to replace" : "", oninput: (e) => { v[ch][k] = e.target.value; } }));
  const text = (ch, k, label, opts = {}) => field(label, h("input", { type: opts.type || "text", value: v[ch][k], placeholder: opts.placeholder || "", oninput: (e) => { v[ch][k] = opts.type === "number" ? Number(e.target.value) : e.target.value; } }), opts.hint);
  const on = (ch, label) => h("label", { class: "check" }, h("input", { type: "checkbox", checked: v[ch].enabled, onchange: (e) => { v[ch].enabled = e.target.checked; } }), label);
  const testBtn = (ch) => {
    const out = h("span", { class: "small muted" });
    const to = ch === "email" ? h("input", { type: "email", value: myEmail, placeholder: "send test to…", "aria-label": "Test recipient" }) : null;
    return h("div", { class: "addrow" }, to, h("button", { class: "btn ghost sm", type: "button", onclick: async () => {
      out.textContent = "Sending… (save first if you changed anything)";
      try {
        const r = await api("/api/admin/notifications/test", { method: "POST", body: { channel: ch, to: to?.value } });
        out.textContent = r.ok ? `OK: ${r.result}` : `Failed: ${r.error}`;
        out.className = r.ok ? "small up" : "small down";
      } catch (err) { out.textContent = err.message; out.className = "small down"; }
    } }, "Send test"), out);
  };
  put(body,
    h("div", { class: "note plain" }, "Alerts and the weekly digest are delivered through these channels. Secrets are stored encrypted when SECRET_KEY is set; leave a password field empty to keep the stored value."),
    h("div", { class: "layout" },
      h("div", { class: "card" },
        h("h2", null, "Email (SMTP) ", h("span", { class: "tag" }, "primary")),
        on("email", "Enabled"),
        h("div", { class: "form", style: { maxWidth: "none" } },
          h("div", { class: "addrow" }, text("email", "host", "SMTP host", { placeholder: "smtp.example.com" }), text("email", "port", "Port", { type: "number" })),
          field("Security", h("select", { onchange: (e) => { v.email.tls = e.target.value; } },
            [["starttls", "STARTTLS (port 587)"], ["tls", "TLS (port 465)"], ["none", "None (LAN relay only)"]].map(([k, l]) => h("option", { value: k, selected: v.email.tls === k }, l)))),
          h("div", { class: "addrow" }, text("email", "user", "Username"), secret("email", "pass", "Password")),
          text("email", "from", "From address", { placeholder: "Mos Eisley <alerts@example.com>" }),
          h("label", { class: "check" }, h("input", { type: "checkbox", checked: v.email.allowSelfSigned, onchange: (e) => { v.email.allowSelfSigned = e.target.checked; } }), "Accept a self-signed certificate (LAN mail server)"),
          testBtn("email"))),
      h("div", { class: "stack" },
        h("div", { class: "card" }, h("h2", null, "ntfy"), on("ntfy", "Enabled"),
          text("ntfy", "url", "Topic URL", { placeholder: "https://ntfy.sh/your-secret-topic" }), secret("ntfy", "token", "Access token (optional)"), testBtn("ntfy")),
        h("div", { class: "card" }, h("h2", null, "Telegram"), on("telegram", "Enabled"),
          secret("telegram", "botToken", "Bot token"), text("telegram", "chatId", "Chat id"), testBtn("telegram")),
        h("div", { class: "card" }, h("h2", null, "Webhook"), on("webhook", "Enabled"),
          text("webhook", "url", "URL", { placeholder: "https://…" }), secret("webhook", "secret", "Signing secret (optional)", ""),
          h("p", { class: "small muted" }, "JSON POST; with a secret, the body's HMAC-SHA256 is sent as X-Signature-SHA256."), testBtn("webhook")))),
    h("div", { class: "addrow section" }, h("button", { class: "btn", type: "button", onclick: async () => {
      try {
        const out = structuredClone(v);
        for (const [ch, k] of [["email", "pass"], ["ntfy", "token"], ["telegram", "botToken"], ["webhook", "secret"]]) {
          if (out[ch][k] === n[ch][k]) delete out[ch][k]; // unchanged mask: keep stored
        }
        await api("/api/admin/notifications", { method: "PUT", body: { notifications: out } });
        await notifications(body);
        setStatus("Notifications saved.");
      } catch (err) { say(msg, err.message, "bad"); }
    } }, "Save notifications"), msg));
}

// ---------------------------------------------------------------- health
async function health(body) {
  const r = await api("/api/admin/health");
  const msg = statusEl();
  const pct = (x) => (x == null ? "—" : `${x}%`);
  put(body,
    h("div", { class: "card" },
      h("h2", null, "Data sources"),
      h("div", { class: "tablewrap" }, h("table", { class: "data" },
        h("thead", null, h("tr", null, h("th", null, "Source"), h("th", null, "Kind"), h("th", { class: "num" }, "OK (1 h)"), h("th", null, "Recent calls"),
          h("th", { class: "num" }, "Median"), h("th", { class: "num" }, "Calls/min"), h("th", { class: "num" }, "Today"), h("th", null, "Last OK"), h("th", null, "Last error"))),
        h("tbody", null, r.providers.map((p) => {
          const x = p.health;
          return h("tr", null,
            h("td", null, h("strong", null, p.name), !p.enabled ? h("span", { class: "tag" }, "off") : null, x?.failingForMs ? h("span", { class: "tag bad" }, `failing ${Math.round(x.failingForMs / 60_000)} min`) : null),
            h("td", { class: "small" }, p.kind),
            h("td", { class: "num" }, pct(x?.successPctHour)),
            h("td", null, x?.recent?.length ? sparkline(x.recent.map((v, i) => [i, v]), { base: 0.5, w: 90, h: 18 }) : h("span", { class: "small muted" }, "no calls")),
            h("td", { class: "num small" }, x?.medianMs != null ? `${x.medianMs} ms` : "—"),
            h("td", { class: "num small" }, x ? String(x.callsLastMinute) : "—"),
            h("td", { class: "num small" }, x ? String(x.callsToday) : "—"),
            h("td", { class: "small muted" }, x?.lastOkAt ? relTime(x.lastOkAt) : "—"),
            h("td", { class: "small muted", style: { overflowWrap: "anywhere" } }, x?.lastError ? `${x.lastError} (${relTime(x.lastErrorAt)})` : ""));
        })))),
      h("p", { class: "small muted" }, "Counters are kept in memory since the last restart. Free-tier limits: Twelve Data 8/min, Alpha Vantage 25/day, Finnhub 60/min; the server enforces them.")),
    h("div", { class: "card section" },
      h("h2", null, "Background jobs ", h("span", { class: "tag" }, `up ${Math.round(r.uptimeSeconds / 3600)} h`)),
      h("div", { class: "tablewrap" }, h("table", { class: "data" },
        h("thead", null, h("tr", null, h("th", null, "Job"), h("th", null, "Schedule"), h("th", { class: "num" }, "Runs"), h("th", null, "Last run"), h("th", { class: "num" }, "Took"), h("th", null, "Last error"), h("th", null, ""))),
        h("tbody", null, r.jobs.map((j) => h("tr", null,
          h("td", null, h("strong", null, j.name), h("span", { class: "sub" }, j.description), !j.enabled ? h("span", { class: "tag" }, "off") : null, j.running ? h("span", { class: "tag open" }, "running") : null),
          h("td", { class: "small" }, j.schedule),
          h("td", { class: "num small" }, `${j.runs}${j.failures ? ` (${j.failures} failed)` : ""}`),
          h("td", { class: "small muted" }, j.lastRunAt ? relTime(j.lastRunAt) : "—"),
          h("td", { class: "num small" }, j.lastDurationMs != null ? `${j.lastDurationMs} ms` : "—"),
          h("td", { class: "small", style: { color: "var(--bad-fg)", overflowWrap: "anywhere" } }, j.lastError || ""),
          h("td", { class: "num" }, h("button", { class: "btn ghost sm", type: "button", disabled: !j.enabled && j.name === "digest", onclick: async () => {
            say(msg, `Running ${j.name}…`);
            try {
              const res = await api(`/api/admin/jobs/${j.name}/run`, { method: "POST" });
              say(msg, res.ok ? `${j.name}: done ${JSON.stringify(res.result ?? "")}` : `${j.name} failed: ${res.error}`, res.ok ? "" : "bad");
              await health(body);
            } catch (err) { say(msg, err.message, "bad"); }
          } }, "Run now"))))))),
      msg),
    h("div", { class: "card section" }, h("h2", null, "Stored history"),
      h("dl", { class: "stats" }, row("Raw snapshots", r.history.raw.toLocaleString()), row("Hourly", r.history.hour.toLocaleString()), row("Daily", r.history.day.toLocaleString()),
        row("Since", r.history.oldestDay ? r.history.oldestDay.slice(0, 10) : "—"), row("Database size", r.history.bytes != null ? `${fmtCompact(r.history.bytes)}B` : "—"))));
}

// ---------------------------------------------------------------- audit log
async function audit(body, action = "") {
  const r = await api(`/api/admin/audit?limit=300${action ? `&action=${encodeURIComponent(action)}` : ""}`);
  put(body, h("div", { class: "card" },
    h("h2", null, "Audit log ", h("span", { class: "tag" }, `latest ${r.entries.length}`)),
    chipGroup("Action", [{ value: "", label: "All" }, ...r.actions.map((a) => ({ value: a, label: a.replace(/_/g, " ") }))], action, (v) => audit(body, v)),
    r.entries.length ? h("div", { class: "tablewrap" }, h("table", { class: "data" },
      h("thead", null, h("tr", null, h("th", null, "When"), h("th", null, "User"), h("th", null, "Action"), h("th", null, "Detail"), h("th", null, "Address"))),
      h("tbody", null, r.entries.map((e) => h("tr", null,
        h("td", { class: "small", title: e.at }, dateTimeStr(e.at)),
        h("td", null, e.username || "—"),
        h("td", null, h("span", { class: `tag ${e.action === "login_failed" ? "bad" : ""}` }, e.action.replace(/_/g, " "))),
        h("td", { class: "small muted", style: { overflowWrap: "anywhere" } }, e.detail || ""),
        h("td", { class: "small muted mono" }, e.ip || "")))))) : h("p", { class: "small muted" }, "No entries.")));
}
