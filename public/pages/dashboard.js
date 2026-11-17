// Dashboard: indices, Bitcoin, market clocks, pinned symbols, movers (today / this week), heat map, brief, ask.
import { h, put, api, state, fmtPrice, fmtPct, pctEl, dir, timeStr, dateTimeStr, notes, setStatus } from "../ui.js";
import { sparkline } from "../charts.js";
import { marketName, errorNote, median, clockText, displayCurrency, fmtLevel, pageHead, isAdmin } from "../common.js";

export async function dashboardPage(root, _rest, ctx) {
  const cur = state.me.general.defaultCurrency;
  const hidden = new Set(state.me.prefs.hiddenMarkets || []);
  const display = displayCurrency();
  const includeFx = !!state.me.prefs.includeFx;
  const warnBox = h("div");
  const indexStrip = h("div", { class: "istrip", "aria-label": "Market indices" });
  const btcCard = h("div", { class: "card" }, h("p", { class: "skeleton" }, "Loading Bitcoin…"));
  const marketsCard = h("div", { class: "card" }, h("p", { class: "skeleton" }, "Loading markets…"));
  const pinsCard = h("div", { class: "card" });
  const moversCard = h("div", { class: "card" }, h("p", { class: "skeleton" }, "Loading movers…"));
  const briefCard = h("div", { class: "card" });
  const askCard = h("div", { class: "card" });
  const heatCard = h("div", { class: "card section" });
  put(root,
    pageHead("Dashboard", "Indices, Bitcoin and your watchlist at a glance."),
    warnBox, indexStrip,
    h("div", { class: "layout" },
      h("div", { class: "stack" }, btcCard, marketsCard, pinsCard),
      h("div", { class: "stack" }, moversCard, state.me.llm.enabled ? askCard : null, briefCard)),
    heatCard);

  let spark = [], extras = null, clocks = {}, eq = null, weekly = null, moversTab = "today";

  async function loadSpark() {
    try { spark = (await api(`/api/history/bitcoin?currency=${cur}&range=1d`)).points; } catch { spark = []; }
  }
  async function loadExtras() {
    try { extras = await api(`/api/bitcoin/extras?currency=${cur}`); } catch { extras = null; }
  }
  async function loadClocks() {
    try { clocks = (await api("/api/markets")).clocks; } catch { clocks = {}; }
    renderMarkets();
  }
  async function loadWeekly() {
    try { weekly = (await api("/api/stats")).stats; } catch { weekly = null; }
    renderMovers();
  }
  async function adminHealth() {
    if (!state.me.features.adminAllowed) return [];
    try {
      const hlt = await api("/api/admin/health");
      return hlt.providers.filter((p) => p.enabled && p.health?.failingForMs > 10 * 60_000)
        .map((p) => `${p.name} has been failing for ${Math.round(p.health.failingForMs / 60_000)} min: ${p.health.lastError}. See Admin → Health.`);
    } catch { return []; }
  }

  const visible = (items) => items.filter((i) => !hidden.has(i.market));
  const shown = (i) => (display && i.converted ? { price: i.converted.price, changePct: i.converted.changePct, currency: display } : { price: i.quote?.price, changePct: i.quote?.changePct, currency: i.quote?.currency || i.currency });

  function renderIndices() {
    const idx = visible((eq?.items || []).filter((i) => i.kind === "index"));
    put(indexStrip, idx.map((i) => h("a", { class: "itile", href: `#/shares/${encodeURIComponent(i.symbol)}`, title: `${i.name} · ${marketName(i.market)}` },
      h("div", { class: "t-name" }, h("span", { class: `dot ${i.quote?.marketState === "open" ? "open" : "closed"}` }), i.name),
      h("div", { class: "i-row" }, h("span", { class: "num" }, i.quote ? fmtLevel(i, i.quote.price) : "—"), pctEl(i.quote?.changePct)),
      i.quote?.spark ? sparkline(i.quote.spark, { base: i.quote.prevClose }) : null)));
    indexStrip.hidden = !idx.length;
  }

  function renderBtc(btc) {
    const p = (() => {
      for (const s of btc.sources) {
        const q = s.quotes.find((x) => x.currency === cur);
        if (q?.price != null) return { ...q, source: s.name, stale: s.stale };
      }
      return null;
    })();
    const prices = btc.sources.map((s) => s.quotes.find((q) => q.currency === cur)?.price);
    const fg = extras?.fearGreed;
    put(btcCard,
      h("h3", null, "Bitcoin"),
      p ? [
        h("div", { class: "price-row" }, h("span", { class: "price-big" }, fmtPrice(p.price, cur)), pctEl(p.changePct), h("span", { class: "small muted" }, "24 h"),
          fg ? h("span", { class: `tag fg ${fgBand(fg.value)}`, title: "Fear & Greed index (alternative.me)" }, `${fg.label} · ${fg.value}`) : null),
        sparkline(spark, { w: 300, h: 48 }),
        h("p", { class: "small muted" },
          `${p.source}${p.stale ? " (stale)" : ""} · median of ${prices.filter(Number.isFinite).length} sources ${fmtPrice(median(prices), cur)} · `,
          h("a", { href: "#/bitcoin" }, "details")),
      ] : h("div", { class: "note warn" }, `No Bitcoin price in ${cur} right now.`));
    btcCard.querySelector(".spark")?.classList.add("wide");
  }

  function renderMarkets() {
    if (!eq) return;
    const regions = Object.keys(eq.markets).filter((m) => !hidden.has(m));
    put(marketsCard,
      h("h3", null, "Markets"),
      h("div", { class: "tiles" }, regions.map((m) => {
        const info = eq.markets[m];
        const rows = eq.items.filter((i) => i.market === m && i.kind === "equity" && i.quote);
        const avg = rows.length ? rows.reduce((a, r) => a + (shown(r).changePct || 0), 0) / rows.length : null;
        const c = clocks[m];
        const open = info.open > 0 || c?.state === "open";
        const stateWord = c?.state === "break" ? "Lunch break" : open ? "Open" : "Closed";
        return h("a", { class: "tile", href: `#/shares?region=${m}` },
          h("div", { class: "t-name" }, h("span", { class: `dot ${c?.state === "break" ? "pre" : open ? "open" : "closed"}`, title: stateWord }), marketName(m)),
          h("div", { class: "small muted" }, `${stateWord} · ${info.up}▲ ${info.down}▼`),
          c ? h("div", { class: "small", title: `${c.exchange} · local time ${c.localTime}` }, clockText(c)) : null,
          h("div", { class: "small" }, "avg ", pctEl(avg)));
      })));
  }

  function renderPins() {
    const pins = state.me.prefs.pinned || [];
    if (!pins.length || !eq) {
      put(pinsCard, h("h3", null, "My symbols"), h("p", { class: "small muted" }, "Pin symbols with ☆ on the Shares page to keep them here."));
      return;
    }
    const rows = pins.map((s) => eq.items.find((i) => i.symbol === s)).filter(Boolean);
    put(pinsCard, h("h3", null, "My symbols"),
      rows.map((i) => {
        const v = shown(i);
        return h("div", { class: "pinrow" },
          h("a", { class: "sym", href: `#/shares/${encodeURIComponent(i.symbol)}`, title: i.name }, i.symbol),
          h("span", { class: "sub" }, i.name),
          h("span", { class: "num" }, i.quote ? fmtLevel(i, v.price, v.currency) : "—"),
          h("span", { class: "num" }, pctEl(v.changePct)));
      }));
  }

  function renderMovers() {
    if (!eq) return;
    const quoted = visible(eq.items.filter((i) => i.kind === "equity"));
    const value = (i) => (moversTab === "today" ? shown(i).changePct : weekly?.[i.symbol]?.r1w);
    const list = quoted.filter((i) => Number.isFinite(value(i))).sort((a, b) => value(b) - value(a));
    const maxAbs = Math.max(0.01, ...list.map((i) => Math.abs(value(i))));
    const row = (i) => h("div", { class: "nbrow" },
      h("a", { class: "lab sym", href: `#/shares/${encodeURIComponent(i.symbol)}`, title: i.name }, i.symbol),
      h("div", { class: "track" }, h("div", { class: `fill ${dir(value(i))}`, style: { width: `${(Math.abs(value(i)) / maxAbs) * 100}%` } })),
      h("span", { class: `val ${dir(value(i))}` }, fmtPct(value(i))));
    const gainers = list.filter((i) => value(i) > 0).slice(0, 4);
    const losers = list.filter((i) => value(i) < 0).reverse().slice(0, 4);
    const tab = (id, label) => h("button", { type: "button", class: "chip", "aria-pressed": String(moversTab === id), onclick: () => { moversTab = id; renderMovers(); if (id === "week" && !weekly) loadWeekly(); } }, label);
    put(moversCard,
      h("div", { class: "cardhead" }, h("h2", null, "Top movers"), h("div", { class: "chips", style: { margin: 0 } }, tab("today", "Today"), tab("week", "This week"))),
      moversTab === "week" && !weekly ? h("p", { class: "skeleton" }, "Loading weekly figures…") : [
        h("h3", null, "Gainers"), gainers.length ? gainers.map(row) : h("p", { class: "small muted" }, "None."),
        h("h3", { style: { marginTop: "10px" } }, "Losers"), losers.length ? losers.map(row) : h("p", { class: "small muted" }, "None."),
      ],
      display && includeFx && moversTab === "today" ? h("p", { class: "small muted" }, `Changes include the day's move of each currency against ${display}.`) : null);
  }

  function renderHeat() {
    const items = visible(eq.items.filter((i) => i.kind === "equity"));
    put(heatCard,
      h("h2", null, "Watchlist ", h("span", { class: "tag" }, `${items.length} shares`), display ? h("span", { class: "tag" }, `in ${display}`) : null),
      h("div", { class: "heat" }, items.map((i) => {
        const v = shown(i);
        const pct = v.changePct;
        const a = pct == null ? 0 : Math.min(0.55, 0.08 + Math.abs(pct) / 6);
        return h("a", {
          href: `#/shares/${encodeURIComponent(i.symbol)}`, title: `${i.name} · ${marketName(i.market)}`,
          style: { background: pct == null ? "var(--card)" : `rgba(${pct > 0 ? "var(--up-rgb)" : "var(--down-rgb)"}, ${a})` },
        },
        h("div", { class: "h-sym" }, i.symbol),
        h("div", { class: "small" }, i.quote ? fmtPrice(v.price, v.currency) : "—"),
        h("div", { class: "h-pct" }, fmtPct(pct)));
      })));
  }

  async function load() {
    const [btc, eqr, ops] = await Promise.allSettled([
      api("/api/quotes/bitcoin"),
      api(`/api/quotes/equities${display ? `?display=${display}${includeFx ? "&includeFx=1" : ""}` : ""}`),
      adminHealth(),
    ]);
    const warnings = [...(btc.value?.warnings || []), ...(eqr.value?.warnings || [])];
    put(warnBox, notes(ops.value || [], "bad"), notes(warnings));
    if (btc.status === "fulfilled") renderBtc(btc.value);
    else put(btcCard, h("h3", null, "Bitcoin"), errorNote(btc.reason));
    if (eqr.status !== "fulfilled") {
      for (const c of [marketsCard, moversCard]) put(c, errorNote(eqr.reason));
      return;
    }
    eq = eqr.value;
    renderIndices();
    renderMarkets();
    renderPins();
    renderMovers();
    renderHeat();
    setStatus(`Updated ${timeStr(new Date().toISOString())}`, warnings.length ? "warn" : "");
  }

  await Promise.all([loadSpark(), loadExtras(), loadClocks()]);
  await Promise.all([load(), briefWidget(briefCard), state.me.llm.enabled ? askWidget(askCard) : null]);
  ctx.poll.every(load, state.me.general.refreshSeconds);
  ctx.poll.every(loadSpark, 300);
  ctx.poll.every(loadExtras, 900);
  ctx.poll.every(loadClocks, 30); // countdowns: computed on the server, refreshed cheaply
}

const fgBand = (v) => (v < 25 ? "xfear" : v < 45 ? "fear" : v <= 55 ? "neutral" : v <= 75 ? "greed" : "xgreed");
export { fgBand };

// ---------------------------------------------------------------- brief (daily / weekly)
async function briefWidget(card) {
  let data;
  try { data = await api("/api/brief"); } catch (err) { put(card, h("h2", null, "Market brief"), errorNote(err)); return; }
  if (!data.enabled) {
    put(card, h("h2", null, "Market brief ", h("span", { class: "tag" }, "LLM")),
      h("div", { class: "note plain" }, "LLM not configured. An admin can enable it with LLM_ENABLED=true and the LLM_* settings (see .env.example)."));
    return;
  }
  let tab = "daily";
  const status = h("div", { class: "status", role: "status" });
  const body = h("div");
  const render = () => {
    const tabBtn = (id, label) => h("button", { type: "button", class: "chip", "aria-pressed": String(tab === id), onclick: () => { tab = id; render(); } }, label);
    const b = tab === "daily" ? data.brief : data.weekly;
    put(body, b ? (tab === "daily" ? [
      h("p", null, h("strong", null, b.headline)),
      h("ul", { class: "small tight" }, b.bullets.map((x) => h("li", null, x))),
      b.bitcoin ? h("p", { class: "small" }, h("strong", null, "Bitcoin: "), b.bitcoin) : null,
      h("p", { class: "small muted" }, b.caveat),
      h("p", { class: "small muted" }, `${b.model} · ${dateTimeStr(b.createdAt)}`),
    ] : [
      h("p", null, h("strong", null, b.headline)),
      b.sections.map((s) => h("p", { class: "small" }, h("strong", null, `${s.region}: `), s.summary)),
      h("p", { class: "small muted" }, `${b.model} · ${dateTimeStr(b.createdAt)} · `, h("a", { href: "#/digests" }, "all digests")),
    ]) : h("p", { class: "small muted" }, tab === "daily" ? "No brief yet." : "No weekly digest yet. It is generated on schedule (Admin → Settings)."));
    put(card,
      h("div", { class: "cardhead" }, h("h2", null, "Market brief ", h("span", { class: "tag" }, "LLM")),
        h("div", { class: "chips", style: { margin: 0 } }, tabBtn("daily", "Today"), tabBtn("weekly", "Weekly"))),
      body,
      tab === "daily" ? h("div", { class: "addrow" }, btn) : null, status);
  };
  const btn = h("button", { class: "btn ghost sm", type: "button" }, "Generate brief");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    status.textContent = "Asking the model… this can take a minute.";
    status.className = "status";
    try {
      const r = await api("/api/brief", { method: "POST" });
      data.brief = r.brief;
      status.textContent = r.cached ? "Prices have not changed since the last brief: showing it." : "";
      render();
    } catch (err) {
      status.textContent = err.message;
      status.className = "status bad";
    } finally {
      btn.disabled = false;
    }
  });
  render();
}

// ---------------------------------------------------------------- ask the data
const EXAMPLES = [
  "Which European shares fell most this month?",
  "How did Bitcoin compare with the S&P 500 this year?",
  "Which shares are near their 52-week high?",
  "What is the most volatile share on my list?",
];

async function askWidget(card) {
  const input = h("input", { type: "text", maxlength: 300, placeholder: "Ask about your watchlist…", "aria-label": "Question" });
  const out = h("div", { "aria-live": "polite" });
  const btn = h("button", { class: "btn", type: "submit" }, "Ask");
  const form = h("form", { class: "addrow", style: { margin: "4px 0" } }, input, btn);
  async function ask(q) {
    input.value = q;
    btn.disabled = true;
    put(out, h("p", { class: "skeleton" }, "Thinking…"));
    try {
      const r = await api("/api/ask", { method: "POST", body: { question: q } });
      put(out,
        h("div", { class: r.cannotAnswer ? "note plain" : "answer" }, r.answer),
        r.figures.length ? h("dl", { class: "stats" }, r.figures.map((f) => h("div", null, h("dt", null, f.label), h("dd", { class: f.verified ? "" : "unverified", title: f.verified ? "Matches the data" : "Not found in the data" }, `${f.value}${f.verified ? "" : " ?"}`)))) : null,
        r.symbols.length ? h("div", { class: "chips" }, r.symbols.map((s) => h("a", { class: "chip", href: s === "BTC" ? "#/bitcoin" : `#/shares/${encodeURIComponent(s)}` }, s)),
          r.symbols.length > 1 ? h("a", { class: "chip", href: `#/compare?s=${r.symbols.slice(0, 4).map(encodeURIComponent).join(",")}` }, "Compare these") : null) : null,
        notes(r.warnings),
        h("p", { class: "small muted" }, `Based on prices as of ${timeStr(r.asOf)} · ${r.model}`));
    } catch (err) {
      put(out, errorNote(err));
    } finally {
      btn.disabled = false;
    }
  }
  form.addEventListener("submit", (e) => { e.preventDefault(); if (input.value.trim()) ask(input.value.trim()); });
  put(card,
    h("h2", null, "Ask the data ", h("span", { class: "tag" }, "LLM")),
    form,
    h("div", { class: "chips" }, EXAMPLES.map((q) => h("button", { type: "button", class: "chip", onclick: () => ask(q) }, q))),
    out,
    isAdmin() ? null : null);
}
