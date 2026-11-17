// Alerts: list, create/edit dialog, and the event history (in-app notifications).
import { h, put, api, state, dateTimeStr, relTime, setStatus } from "../ui.js";
import { pageHead, errorNote, isAdmin } from "../common.js";

const CHANNEL_LABEL = { inapp: "In app", email: "Email", ntfy: "ntfy", telegram: "Telegram", webhook: "Webhook" };

export async function alertsPage(root, rest, ctx) {
  const listCard = h("div", { class: "card" }), eventsCard = h("div", { class: "card section" });
  put(root, pageHead("Alerts", "Get told when a price crosses a level, moves a lot in a day, or a data source stops working."), listCard, eventsCard);
  let meta = null, symbols = [];

  async function load() {
    try {
      meta = await api("/api/alerts");
      if (!symbols.length) symbols = (await api("/api/quotes/equities")).items.map((i) => ({ symbol: i.symbol, name: i.name, kind: i.kind, currency: i.currency }));
    } catch (err) {
      put(listCard, errorNote(err));
      return;
    }
    renderList();
  }

  function describe(a) {
    const d = meta.conditions[a.condition] || { label: a.condition };
    const target = a.symbol ? (meta.providers.find((p) => p.id === a.symbol)?.name || a.symbol) : d.target === null ? "Bitcoin" : "any job";
    const thr = d.unit === "price" ? `${a.threshold} ${a.currency}` : d.unit === "%" ? `${a.threshold}%` : d.unit === "min" ? `${a.threshold} min` : d.unit === "index" ? `${a.threshold}` : "";
    return { target, rule: `${d.label.replace(/ \(.*\)$/, "")} ${thr}`.trim() };
  }

  function renderList() {
    const emailMissing = !meta.email && meta.alerts.some((a) => a.channels.includes("email") && (a.ownerId === state.me.user.id || a.createdBy === state.me.user.id));
    put(listCard,
      h("div", { class: "cardhead" }, h("h2", null, "Alerts ", h("span", { class: "tag" }, String(meta.alerts.length))),
        meta.canCreate ? h("div", { class: "addrow", style: { margin: 0 } },
          isAdmin() ? h("button", { class: "btn ghost sm", type: "button", onclick: runNow }, "Check now") : null,
          h("button", { class: "btn sm", type: "button", onclick: () => edit(null) }, "New alert")) : null),
      !meta.canCreate ? h("div", { class: "note plain" }, "Only admins can create alerts. You can see notifications sent to you below.") : null,
      emailMissing ? h("div", { class: "note warn" }, "Some alerts send email, but your account has no email address. ", h("a", { href: "#/account" }, "Add one on the Account page.")) : null,
      !meta.channelsEnabled.email && meta.alerts.some((a) => a.channels.includes("email")) ? h("div", { class: "note warn" }, "Email is not configured yet", isAdmin() ? [": ", h("a", { href: "#/admin/notifications" }, "Admin → Notifications")] : " (ask an admin).") : null,
      meta.alerts.length ? h("div", { class: "tablewrap" }, h("table", { class: "data" },
        h("thead", null, h("tr", null, h("th", null, "Target"), h("th", null, "Rule"), h("th", null, "Channels"), h("th", null, "State"), h("th", { class: "num" }, "Last value"), h("th", null, "Last fired"), isAdmin() ? h("th", null, "Owner") : null, h("th", null, ""))),
        h("tbody", null, meta.alerts.map((a) => {
          const d = describe(a);
          return h("tr", null,
            h("td", null, h("strong", null, d.target)),
            h("td", { class: "small" }, d.rule, a.note ? h("span", { class: "sub" }, a.note) : null),
            h("td", { class: "small" }, a.channels.map((c) => CHANNEL_LABEL[c] || c).join(", ")),
            h("td", null, !a.enabled ? h("span", { class: "tag" }, "off") : a.state === "fired" ? h("span", { class: "tag bad" }, "triggered") : h("span", { class: "tag open" }, "watching")),
            h("td", { class: "num small" }, a.lastValue != null ? String(Math.round(a.lastValue * 100) / 100) : "—"),
            h("td", { class: "small muted", title: a.lastFiredAt || "" }, a.lastFiredAt ? relTime(a.lastFiredAt) : "never"),
            isAdmin() ? h("td", { class: "small" }, a.owner ? a.owner : "everyone") : null,
            h("td", null, h("div", { class: "addrow", style: { margin: 0, justifyContent: "flex-end", flexWrap: "nowrap" } },
              h("button", { class: "btn ghost sm", type: "button", onclick: () => toggle(a) }, a.enabled ? "Pause" : "Resume"),
              h("button", { class: "btn ghost sm", type: "button", onclick: () => edit(a) }, "Edit"),
              h("button", { class: "btn danger sm", type: "button", onclick: () => remove(a) }, "Delete"))));
        })))) : h("p", { class: "small muted" }, meta.canCreate ? "No alerts yet." : ""));
  }

  async function runNow() {
    try {
      const r = await api("/api/alerts/run", { method: "POST" });
      setStatus(r.ok ? `Checked ${r.result.checked} alert(s), ${r.result.fired} triggered.` : `Check failed: ${r.error}`, r.ok ? "" : "bad");
      await load();
      await loadEvents();
    } catch (err) { setStatus(err.message, "bad"); }
  }
  async function toggle(a) {
    try { await api(`/api/alerts/${a.id}`, { method: "PUT", body: { enabled: !a.enabled } }); await load(); } catch (err) { setStatus(err.message, "bad"); }
  }
  async function remove(a) {
    if (!confirm(`Delete this alert (${describe(a).target}: ${describe(a).rule})?`)) return;
    try { await api(`/api/alerts/${a.id}`, { method: "DELETE" }); await load(); } catch (err) { setStatus(err.message, "bad"); }
  }

  function edit(a, prefill = {}) {
    const v = a ? { ...a } : { condition: "price_below", symbol: prefill.symbol || "", threshold: "", currency: "", channels: ["inapp", "email"], cooldownMinutes: 60, hysteresisPct: 0.5, note: "", extraEmails: [], personal: false };
    const msg = h("div", { class: "status bad", role: "alert" });
    const body = h("div", { class: "form", style: { maxWidth: "none" } });
    const dlg = h("dialog", { class: "wide" });
    const field = (label, control, hint) => h("label", { class: "field" }, h("span", null, label, hint ? h("span", { class: "hint" }, ` ${hint}`) : null), control);

    function render() {
      const d = meta.conditions[v.condition];
      const symSel = h("select", { onchange: (e) => { v.symbol = e.target.value; render(); } },
        h("option", { value: "" }, "Choose…"),
        h("option", { value: "BTC", selected: v.symbol === "BTC" }, "Bitcoin (BTC)"),
        h("optgroup", { label: "Shares" }, symbols.filter((s) => s.kind === "equity").map((s) => h("option", { value: s.symbol, selected: v.symbol === s.symbol }, `${s.symbol} · ${s.name}`))),
        h("optgroup", { label: "Indices" }, symbols.filter((s) => s.kind === "index").map((s) => h("option", { value: s.symbol, selected: v.symbol === s.symbol }, `${s.symbol} · ${s.name}`))));
      const item = symbols.find((s) => s.symbol === v.symbol);
      const currencies = [...new Set([item?.currency, ...meta.currencies].filter(Boolean))];
      if (d?.needsCurrency && !currencies.includes(v.currency)) v.currency = (v.symbol === "BTC" || !item) ? state.me.general.defaultCurrency : item.currency || currencies[0];
      put(body,
        h("h2", null, a ? "Edit alert" : "New alert"),
        field("Condition", h("select", { onchange: (e) => { v.condition = e.target.value; render(); } },
          Object.entries(meta.conditions).map(([k, c]) => h("option", { value: k, selected: k === v.condition }, c.label)))),
        d?.target === "symbol" ? field("Symbol", symSel) : null,
        d?.target === "provider" ? field("Data source", h("select", { onchange: (e) => { v.symbol = e.target.value; } },
          h("option", { value: "" }, "Choose…"), meta.providers.map((p) => h("option", { value: p.id, selected: v.symbol === p.id }, p.name)))) : null,
        d?.target === "job" ? field("Job", h("select", { onchange: (e) => { v.symbol = e.target.value; } },
          h("option", { value: "" }, "Any job"), meta.jobs.filter((j) => j !== "alerts").map((j) => h("option", { value: j, selected: v.symbol === j }, j)))) : null,
        d?.unit ? h("div", { class: "addrow" },
          field(d.unit === "price" ? "Price" : d.unit === "%" ? "Percent" : d.unit === "min" ? "Minutes" : "Value",
            h("input", { type: "number", step: "any", value: v.threshold ?? "", oninput: (e) => { v.threshold = e.target.value; } }),
            d.unit === "index" ? "0–100" : ""),
          d.needsCurrency ? field("Currency", h("select", { onchange: (e) => { v.currency = e.target.value; } }, currencies.map((c) => h("option", { value: c, selected: c === v.currency }, c)))) : null) : null,
        h("fieldset", { class: "field" }, h("legend", null, "Send to"),
          h("div", { class: "chips" }, meta.channels.map((c) => h("label", { class: "check" },
            h("input", { type: "checkbox", checked: v.channels.includes(c), onchange: (e) => { v.channels = e.target.checked ? [...v.channels, c] : v.channels.filter((x) => x !== c); } }),
            CHANNEL_LABEL[c], c !== "inapp" && !meta.channelsEnabled[c] ? h("span", { class: "tag" }, "not set up") : null))),
          v.channels.includes("email") && !meta.email ? h("p", { class: "small", style: { color: "var(--warn-fg)" } }, "Your account has no email address yet (Account page).") : null),
        isAdmin() ? field("Extra email recipients", h("input", { type: "text", value: (v.extraEmails || []).join(", "), placeholder: "a@example.com, b@example.com", oninput: (e) => { v.extraEmails = e.target.value.split(/[\s,;]+/).filter(Boolean); } }), "optional, up to 5") : null,
        h("details", null, h("summary", { class: "small" }, "Timing"),
          h("div", { class: "addrow" },
            field("Cooldown (minutes)", h("input", { type: "number", min: 1, max: 10080, value: v.cooldownMinutes, oninput: (e) => { v.cooldownMinutes = Number(e.target.value); } }), "min. time between two alerts"),
            field("Re-arm band (%)", h("input", { type: "number", min: 0, max: 10, step: 0.1, value: v.hysteresisPct, oninput: (e) => { v.hysteresisPct = Number(e.target.value); } }), "how far back before it can fire again"))),
        field("Note", h("input", { type: "text", maxlength: 200, value: v.note, oninput: (e) => { v.note = e.target.value; } }), "optional, shown in the notification"),
        isAdmin() && !a ? h("label", { class: "check" }, h("input", { type: "checkbox", checked: v.personal, onchange: (e) => { v.personal = e.target.checked; } }), "Only for me (otherwise all admins see it)") : null,
        h("p", { class: "small muted" }, "Share alerts are checked once a minute while the market is open."),
        msg,
        h("div", { class: "actions" },
          h("button", { type: "button", class: "btn ghost", onclick: () => dlg.close() }, "Cancel"),
          h("button", { type: "button", class: "btn", onclick: submit }, a ? "Save" : "Create")));
    }
    async function submit() {
      try {
        const payload = { ...v, threshold: v.threshold === "" ? null : Number(v.threshold) };
        if (a) await api(`/api/alerts/${a.id}`, { method: "PUT", body: payload });
        else await api("/api/alerts", { method: "POST", body: payload });
        dlg.close();
        await load();
      } catch (err) {
        msg.textContent = err.message;
      }
    }
    dlg.append(body);
    dlg.addEventListener("close", () => dlg.remove());
    document.body.append(dlg);
    render();
    dlg.showModal();
  }

  async function loadEvents() {
    let r;
    try { r = await api("/api/alerts/events?limit=100"); } catch (err) { put(eventsCard, errorNote(err)); return; }
    const unread = r.events.filter((e) => !e.seen).length;
    put(eventsCard,
      h("div", { class: "cardhead" }, h("h2", null, "Notifications ", unread ? h("span", { class: "tag bad" }, `${unread} new`) : null),
        unread ? h("button", { class: "btn ghost sm", type: "button", onclick: async () => { await api("/api/alerts/events/read", { method: "POST" }); await loadEvents(); window.dispatchEvent(new Event("mex:unread")); } }, "Mark all read") : null),
      r.events.length ? h("ul", { class: "events" }, r.events.map((e) => h("li", { class: e.seen ? "" : "unseen" },
        h("div", null, e.message),
        h("div", { class: "small muted" }, dateTimeStr(e.firedAt), " · ",
          Object.entries(e.deliveries || {}).map(([k, v]) => `${CHANNEL_LABEL[k] || k}: ${v}`).join(" · "))))) : h("p", { class: "small muted" }, "Nothing yet."));
  }

  await load();
  await loadEvents();
  if (rest[0] === "new" && meta?.canCreate) {
    const sym = new URLSearchParams(location.hash.split("?")[1] || "").get("symbol");
    history.replaceState(null, "", "#/alerts");
    edit(null, { symbol: (sym || "").toUpperCase() });
  }
  ctx.poll.every(async () => { await load(); await loadEvents(); }, 60);
}
