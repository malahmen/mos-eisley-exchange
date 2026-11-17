// Shares and indices: filterable table (stacked cards on phones) and a detail panel with chart and stats.
import { h, put, api, state, fmtPrice, fmtCompact, fmtNum, fmtPct, pctEl, dir, relTime, timeStr, dateTimeStr, chipGroup, notes, setStatus } from "../ui.js";
import { chartBox, sparkline } from "../charts.js";
import { marketName, STATE_LABEL, errorNote, stat, rangeBar, pageHead, savePrefs, displayCurrency, fmtLevel } from "../common.js";

const RANGES = [{ value: "1d", label: "1D" }, { value: "5d", label: "5D" }, { value: "1mo", label: "1M" }, { value: "6mo", label: "6M" }, { value: "1y", label: "1Y" }, { value: "5y", label: "5Y" }];
const SORTS = [
  { value: "order", label: "Watchlist order" }, { value: "symbol", label: "Symbol" }, { value: "name", label: "Name" },
  { value: "changePct", label: "Change %" }, { value: "market", label: "Market" }, { value: "extra", label: "Extra column" },
];
const EXTRA = [{ value: "", label: "None" }, { value: "r1w", label: "1W" }, { value: "r1m", label: "1M" }, { value: "r3m", label: "3M" }, { value: "ytd", label: "YTD" }, { value: "r1y", label: "1Y" }];
const BADGE = { "new-52w-high": "New 52w high", "near-52w-high": "Near 52w high", "new-52w-low": "New 52w low", "near-52w-low": "Near 52w low" };

let statsCache = { at: 0, data: {} };
async function loadStats(symbols) {
  const missing = symbols.filter((s) => !(s in statsCache.data));
  if (Date.now() - statsCache.at > 30 * 60_000) statsCache = { at: Date.now(), data: {} };
  if (missing.length) {
    const r = await api(`/api/stats?symbols=${missing.map(encodeURIComponent).join(",")}`);
    Object.assign(statsCache.data, r.stats);
  }
  return statsCache.data;
}

export async function sharesPage(root, rest, ctx) {
  const saved = state.me.prefs.sharesFilters || {};
  const qsRegion = new URLSearchParams(location.hash.split("?")[1] || "").get("region");
  const st = {
    q: "", region: qsRegion || saved.region || "ALL", move: saved.move || "all", currency: saved.currency || "ALL",
    type: saved.type || "equity", openOnly: !!saved.openOnly, pinnedOnly: !!saved.pinnedOnly,
    sort: saved.sort || "order", desc: !!saved.desc,
    selected: rest[0] ? decodeURIComponent(rest[0]).toUpperCase() : null,
    range: RANGES.some((r) => r.value === saved.range) ? saved.range : "1d",
    display: displayCurrency(), includeFx: !!state.me.prefs.includeFx, extra: state.me.prefs.extraColumn || "",
  };
  if (st.selected?.startsWith("^") || st.selected?.match(/^(PSI20\.LS|000001\.SS)$/)) st.type = "all";
  let data = null, hist = null, histKey = "", stats = {};
  const save = () => savePrefs({ sharesFilters: { region: st.region, move: st.move, currency: st.currency, type: st.type, openOnly: st.openOnly, pinnedOnly: st.pinnedOnly, sort: st.sort, desc: st.desc, range: st.range } });
  const pins = () => new Set(state.me.prefs.pinned || []);

  const search = h("input", { type: "search", placeholder: "Search symbol or name…", "aria-label": "Search", style: { flex: "1 1 220px" } });
  search.addEventListener("input", () => { st.q = search.value.trim().toLowerCase(); renderTable(); });
  const filters = h("div"), warnBox = h("div"), tableCard = h("div", { class: "card" }), detail = h("div", { class: "stack", id: "detail" });
  put(root,
    pageHead("Shares", "Your watchlist across US, European, Chinese and Hong Kong markets, plus the main indices."),
    h("div", { class: "addrow" }, search), filters, warnBox,
    h("div", { class: "layout" }, tableCard, detail));

  const shown = (i) => (st.display && i.converted ? { price: i.converted.price, changePct: i.converted.changePct, currency: st.display, fx: true }
    : { price: i.quote?.price, changePct: i.quote?.changePct, currency: i.quote?.currency || i.currency });

  function filtered() {
    if (!data) return [];
    const p = pins();
    let rows = data.items.filter((i) => {
      const q = i.quote;
      if (st.type !== "all" && i.kind !== st.type) return false;
      if (st.region !== "ALL" && i.market !== st.region) return false;
      if (st.currency !== "ALL" && (q?.currency || i.currency) !== st.currency) return false;
      if (st.openOnly && q?.marketState !== "open") return false;
      if (st.pinnedOnly && !p.has(i.symbol)) return false;
      const ch = shown(i).changePct;
      if (st.move === "gainers" && !(ch > 0)) return false;
      if (st.move === "losers" && !(ch < 0)) return false;
      if (st.q && !`${i.symbol} ${i.name} ${i.exchange} ${i.sector}`.toLowerCase().includes(st.q)) return false;
      return true;
    });
    const key = {
      order: (i) => `${i.kind === "index" ? 1 : 0}-${String(i.sortOrder).padStart(5, "0")}`, symbol: (i) => i.symbol, name: (i) => i.name.toLowerCase(),
      changePct: (i) => shown(i).changePct ?? -Infinity, market: (i) => `${i.market} ${i.symbol}`,
      extra: (i) => stats[i.symbol]?.[st.extra] ?? -Infinity,
    }[st.sort] || ((i) => i.sortOrder);
    return rows.sort((a, b) => {
      const x = key(a), y = key(b);
      return (x < y ? -1 : x > y ? 1 : 0) * (st.desc ? -1 : 1);
    });
  }

  function renderFilters() {
    if (!data) return;
    const pool = data.items.filter((i) => st.type === "all" || i.kind === st.type);
    const count = (pred) => pool.filter(pred).length;
    const regions = [...new Set(data.items.map((i) => i.market))];
    const currencies = [...new Set(pool.map((i) => i.quote?.currency || i.currency).filter(Boolean))].sort();
    const sortSel = h("select", { "aria-label": "Sort by", onchange: (e) => { st.sort = e.target.value; save(); renderTable(); } },
      SORTS.filter((o) => o.value !== "extra" || st.extra).map((o) => h("option", { value: o.value, selected: o.value === st.sort }, o.label)));
    const dirBtn = h("button", { class: "iconbtn", type: "button", title: "Reverse order", "aria-label": st.desc ? "Descending" : "Ascending",
      onclick: () => { st.desc = !st.desc; save(); renderFilters(); renderTable(); } }, st.desc ? "↓" : "↑");
    const extraSel = h("select", { "aria-label": "Extra column", onchange: async (e) => { st.extra = e.target.value; savePrefs({ extraColumn: st.extra }); await ensureStats(); renderFilters(); renderTable(); } },
      EXTRA.map((o) => h("option", { value: o.value, selected: o.value === st.extra }, o.label)));
    const refresh = () => { save(); renderFilters(); renderTable(); };
    put(filters,
      h("div", { class: "toolbar" },
        chipGroup("Type", [{ value: "equity", label: "Shares" }, { value: "index", label: "Indices" }, { value: "all", label: "All" }], st.type, (v) => { st.type = v; st.currency = "ALL"; refresh(); }),
        chipGroup("Region", [{ value: "ALL", label: "All", count: pool.length }, ...regions.map((m) => ({ value: m, label: marketName(m), count: count((i) => i.market === m) }))], st.region, (v) => { st.region = v; refresh(); })),
      h("div", { class: "toolbar" },
        chipGroup("Move", [{ value: "all", label: "All" }, { value: "gainers", label: "▲ Gainers" }, { value: "losers", label: "▼ Losers" }], st.move, (v) => { st.move = v; refresh(); }),
        currencies.length > 1 ? chipGroup("Currency", ["ALL", ...currencies].map((c) => ({ value: c, label: c === "ALL" ? "All" : c })), st.currency, (v) => { st.currency = v; refresh(); }) : null),
      h("div", { class: "toolbar" },
        chipGroup("Show in", [{ value: "", label: "Local" }, ...state.me.general.cryptoCurrencies.map((c) => ({ value: c, label: c }))], st.display, (v) => {
          st.display = v; savePrefs({ displayCurrency: v }); loadQuotes();
        }),
        st.display ? h("label", { class: "check", title: "Add each currency's move today against the display currency" },
          h("input", { type: "checkbox", checked: st.includeFx, onchange: (e) => { st.includeFx = e.target.checked; savePrefs({ includeFx: st.includeFx }); loadQuotes(); } }), "Include FX move") : null,
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: st.openOnly, onchange: (e) => { st.openOnly = e.target.checked; save(); renderTable(); } }), "Open only"),
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: st.pinnedOnly, onchange: (e) => { st.pinnedOnly = e.target.checked; save(); renderTable(); } }), "★ Pinned only"),
        h("span", { class: "chips" }, h("span", { class: "lab" }, "Column"), extraSel),
        h("span", { class: "chips" }, h("span", { class: "lab" }, "Sort"), sortSel, dirBtn)));
  }

  function togglePin(sym) {
    const p = pins();
    if (p.has(sym)) p.delete(sym); else p.add(sym);
    savePrefs({ pinned: [...p] });
    renderTable();
    renderDetail();
  }

  function sortHeader(label, key, cls = "") {
    return h("th", { class: cls, "aria-sort": st.sort === key ? (st.desc ? "descending" : "ascending") : "none" },
      h("button", { class: "sort", type: "button", onclick: () => {
        if (st.sort === key) st.desc = !st.desc; else { st.sort = key; st.desc = key === "changePct" || key === "extra"; }
        save(); renderFilters(); renderTable();
      } }, label));
  }

  function renderTable() {
    if (!data) return;
    const rows = filtered();
    const p = pins();
    const extraLabel = EXTRA.find((x) => x.value === st.extra)?.label;
    put(tableCard,
      h("h2", null, "Quotes ", h("span", { class: "tag" }, `${rows.length} of ${data.items.length}`), st.display ? h("span", { class: "tag" }, `in ${st.display}${st.includeFx ? " incl. FX" : ""}`) : null),
      rows.length ? h("div", { class: "tablewrap" }, h("table", { class: "data quotes" },
        h("thead", null, h("tr", null,
          h("th", { class: "c-pin" }, h("span", { class: "sr" }, "Pin")), sortHeader("Symbol", "symbol"), sortHeader("Market", "market"), h("th", { class: "num" }, "Price"),
          sortHeader("Change", "changePct", "num"), st.extra ? sortHeader(extraLabel, "extra", "num c-extra") : null, h("th", { class: "c-spark" }, "Today"))),
        h("tbody", null, rows.map((i) => {
          const q = i.quote, v = shown(i);
          const pinned = p.has(i.symbol);
          return h("tr", {
            class: "click", tabindex: "0", "aria-selected": String(i.symbol === st.selected), dataset: { sym: i.symbol },
            onclick: (e) => { if (!e.target.closest(".pin")) select(i.symbol); },
            onkeydown: (e) => { if ((e.key === "Enter" || e.key === " ") && !e.target.closest(".pin")) { e.preventDefault(); select(i.symbol); } },
          },
          h("td", { class: "c-pin" }, h("button", { type: "button", class: `pin ${pinned ? "on" : ""}`, "aria-pressed": String(pinned), "aria-label": `${pinned ? "Unpin" : "Pin"} ${i.symbol}`, onclick: () => togglePin(i.symbol) }, pinned ? "★" : "☆")),
          h("td", null, h("span", { class: "sym" }, i.symbol), i.kind === "index" ? h("span", { class: "tag" }, "index") : null, h("span", { class: "sub", title: i.name }, i.name)),
          h("td", { class: "c-market small" },
            h("span", { class: `dot ${q?.marketState || "closed"}`, title: STATE_LABEL[q?.marketState || "unknown"] }), " ", marketName(i.market),
            q?.stale ? h("span", { class: "tag bad" }, "stale") : null),
          h("td", { class: "num" }, q ? fmtLevel(i, v.price, v.currency) : "—",
            v.fx && q && q.currency !== st.display ? h("span", { class: "sub num" }, fmtPrice(q.price, q.currency)) : null),
          h("td", { class: "num c-chg" }, q ? pctEl(v.changePct) : "—"),
          st.extra ? h("td", { class: "num c-extra" }, stats[i.symbol] ? pctEl(stats[i.symbol][st.extra]) : "…") : null,
          h("td", { class: "c-spark" }, q?.spark ? sparkline(q.spark, { base: q.prevClose }) : ""));
        })))) : h("p", { class: "small muted" }, "Nothing matches these filters."));
  }

  function select(sym) {
    st.selected = sym;
    history.replaceState(null, "", `#/shares/${encodeURIComponent(sym)}`);
    for (const tr of tableCard.querySelectorAll("tbody tr")) tr.setAttribute("aria-selected", String(tr.dataset.sym === sym));
    renderDetail();
    loadHistory();
    loadDetailStats();
    if (window.matchMedia("(max-width: 820px)").matches) detail.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderDetail() {
    const item = data?.items.find((i) => i.symbol === st.selected);
    if (!item) {
      put(detail, h("div", { class: "card" }, h("h2", null, "Details"), h("p", { class: "small muted" }, "Select a row to see its chart and figures.")));
      return;
    }
    const q = item.quote, cur = q?.currency || item.currency;
    const fmt = (v) => fmtLevel(item, v, cur);
    const pts = hist?.points || [];
    const rangeLabel = RANGES.find((r) => r.value === st.range).label;
    const first = pts[0]?.[1], last = pts[pts.length - 1]?.[1];
    const rangeChg = st.range !== "1d" && first && last ? ((last - first) / first) * 100 : null;
    const s = stats[item.symbol];
    const pinned = pins().has(item.symbol);
    const v = shown(item);
    put(detail, h("div", { class: "card" },
      h("div", { class: "cardhead" }, h("h2", null, item.name),
        h("button", { type: "button", class: `pin ${pinned ? "on" : ""}`, "aria-pressed": String(pinned), "aria-label": pinned ? "Unpin" : "Pin", onclick: () => togglePin(item.symbol) }, pinned ? "★" : "☆")),
      h("div", { class: "small" },
        h("span", { class: "tag" }, item.symbol), h("span", { class: "tag" }, item.kind === "index" ? "Index" : marketName(item.market)),
        item.exchange ? h("span", { class: "tag" }, item.exchange) : null, cur && item.kind !== "index" ? h("span", { class: "tag" }, cur) : null,
        q ? h("span", { class: `tag ${q.marketState === "open" ? "open" : ""}` }, STATE_LABEL[q.marketState] || q.marketState) : null),
      h("div", { class: "price-row", style: { marginTop: "8px" } },
        h("span", { class: "price-big" }, q ? fmt(q.price) : "—"),
        q ? [pctEl(q.changePct), h("span", { class: "small muted" }, q.change != null ? `${q.change > 0 ? "+" : ""}${fmtNum(q.change, 4)} today` : "today")] : null,
        rangeChg != null ? [pctEl(rangeChg), h("span", { class: "small muted" }, rangeLabel)] : null),
      v.fx && q && cur !== st.display ? h("p", { class: "small muted" }, `≈ ${fmtPrice(v.price, st.display)} (${fmtPct(v.changePct)} in ${st.display}${st.includeFx ? ", incl. FX" : ""}) at 1 ${cur} = ${item.converted.rate.toFixed(4)} ${st.display}`) : null,
      s && !s.error ? h("div", { class: "chips" },
        [["1W", s.r1w], ["1M", s.r1m], ["3M", s.r3m], ["YTD", s.ytd], ["1Y", s.r1y]].map(([l, x]) => h("span", { class: `retchip ${dir(x)}` }, h("span", { class: "muted" }, l), " ", fmtPct(x).replace(/^[▲▼] /, ""))),
        s.badges.map((b) => h("span", { class: `tag ${b.includes("high") ? "open" : "bad"}` }, BADGE[b]))) : null,
      q?.stale ? h("div", { class: "note warn" }, `Every source failed; showing the last price received (${relTime(q.staleSince)}).`) : null,
      chipGroup("Range", RANGES, st.range, (r) => { st.range = r; save(); renderDetail(); loadHistory(); }),
      chartBox(pts, { currency: item.kind === "index" ? undefined : cur, height: 240, baseline: st.range === "1d" ? q?.prevClose : undefined, label: `${item.symbol}, ${rangeLabel}` },
        hist && hist.key === histKey ? (hist.warnings?.[0] || "No history available.") : "Loading chart…"),
      q ? h("dl", { class: "stats" },
        stat("Open", fmt(q.open)), stat("Prev. close", fmt(q.prevClose)), stat("Day low", fmt(q.low)), stat("Day high", fmt(q.high)),
        stat("Volume", fmtCompact(q.volume)), stat("As of", q.asOf ? dateTimeStr(q.asOf) : "—"),
        s?.vol30 != null ? stat("Volatility 30 d", `${s.vol30.toFixed(1)}%`) : null,
        s?.maxDrawdown1y != null ? stat("Max drawdown 1 y", `${s.maxDrawdown1y.toFixed(1)}%`) : null) : null,
      q?.yearLow != null ? [h("h3", { style: { marginTop: "12px" } }, "52-week range"), rangeBar(q.yearLow, q.yearHigh, q.price, fmt, "Price within the 52-week range")] : null,
      q?.low != null && q?.high > q?.low ? [h("h3", { style: { marginTop: "10px" } }, "Day range"), rangeBar(q.low, q.high, q.price, fmt, "Price within today's range")] : null,
      h("div", { class: "addrow", style: { marginTop: "12px" } },
        h("a", { class: "btn ghost sm", href: `#/compare?s=${encodeURIComponent(item.symbol)}` }, "Compare…"),
        state.me.features.alerts ? h("a", { class: "btn ghost sm", href: `#/alerts/new?symbol=${encodeURIComponent(item.symbol)}` }, "Alert me…") : null),
      h("p", { class: "small muted" }, q ? `Quote: ${q.source}. ` : "No quote. ", hist?.source ? `Chart: ${hist.source}.` : "", s?.source ? ` Stats: ${s.source}.` : "")));
  }

  async function ensureStats() {
    if (!st.extra || !data) return;
    try { stats = { ...stats, ...(await loadStats(data.items.map((i) => i.symbol))) }; } catch { /* column shows … */ }
  }
  async function loadDetailStats() {
    if (!st.selected) return;
    try {
      stats = { ...stats, ...(await loadStats([st.selected])) };
      renderDetail();
    } catch { /* optional */ }
  }

  async function loadQuotes() {
    try {
      data = await api(`/api/quotes/equities${st.display ? `?display=${st.display}${st.includeFx ? "&includeFx=1" : ""}` : ""}`);
      put(warnBox, notes(data.warnings));
      setStatus(`Updated ${timeStr(data.fetchedAt)}`, data.warnings.length ? "warn" : "");
    } catch (err) {
      put(warnBox, errorNote(err));
    }
    if (!st.selected && data?.items.length && window.matchMedia("(min-width: 821px)").matches) st.selected = data.items.find((i) => i.kind === "equity")?.symbol || data.items[0].symbol;
    renderFilters();
    renderTable();
    renderDetail();
  }
  async function loadHistory() {
    if (!st.selected) return;
    const key = `${st.selected}:${st.range}`;
    histKey = key;
    hist = null;
    renderDetail();
    let res;
    try { res = await api(`/api/history/equity/${encodeURIComponent(st.selected)}?range=${st.range}`); } catch (err) { res = { points: [], warnings: [err.message] }; }
    if (histKey !== key) return;
    hist = { ...res, key };
    renderDetail();
  }

  await loadQuotes();
  await Promise.all([loadHistory(), loadDetailStats(), ensureStats().then(() => renderTable())]);
  ctx.poll.every(loadQuotes, state.me.general.refreshSeconds);
  ctx.poll.every(() => (st.range === "1d" ? loadHistory() : Promise.resolve()), 300);
  return {
    update(nextRest) {
      const sym = nextRest[0] ? decodeURIComponent(nextRest[0]).toUpperCase() : null;
      if (sym && sym !== st.selected) select(sym);
    },
  };
}
