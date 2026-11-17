// Compare: up to 4 series (shares, indices, Bitcoin) normalised to % change, with return/volatility/drawdown/correlation.
import { h, put, api, state, fmtPct, pctEl, chipGroup, notes, setStatus, timeStr } from "../ui.js";
import { multiChartBox } from "../charts.js";
import { pageHead, savePrefs, SERIES_COLORS, seriesStats, correlation, errorNote } from "../common.js";

const RANGES = [{ value: "5d", label: "5D" }, { value: "1mo", label: "1M" }, { value: "6mo", label: "6M" }, { value: "1y", label: "1Y" }, { value: "5y", label: "5Y" }];
// Bitcoin ranges that cover each compare range (trimmed to the same span afterwards).
const BTC_RANGE = { "5d": "7d", "1mo": "30d", "6mo": "1y", "1y": "1y" };
const SPAN_DAYS = { "5d": 5, "1mo": 30, "6mo": 182, "1y": 365, "5y": 1826 };

export async function comparePage(root, _rest, ctx) {
  const qs = new URLSearchParams(location.hash.split("?")[1] || "");
  const fromHash = (qs.get("s") || "").split(",").map((x) => decodeURIComponent(x).trim().toUpperCase()).filter(Boolean);
  const st = {
    symbols: (fromHash.length ? fromHash : state.me.prefs.compare || []).slice(0, 4),
    range: RANGES.some((r) => r.value === qs.get("r")) ? qs.get("r") : "1y",
  };
  let items = [], series = [], warnings = [];
  try { items = (await api("/api/quotes/equities")).items; } catch (err) { put(root, pageHead("Compare", null), errorNote(err)); return; }
  const nameOf = (s) => (s === "BTC" ? "Bitcoin" : items.find((i) => i.symbol === s)?.name || s);

  const picker = h("div"), chartCard = h("div", { class: "card" }), tableCard = h("div", { class: "card section" });
  put(root, pageHead("Compare", "Overlay up to four shares, indices or Bitcoin, each as % change from the start of the range."), picker, chartCard, tableCard);

  function sync() {
    history.replaceState(null, "", `#/compare?s=${st.symbols.map(encodeURIComponent).join(",")}&r=${st.range}`);
    savePrefs({ compare: st.symbols });
  }

  function renderPicker() {
    const sel = h("select", { "aria-label": "Add a series" },
      h("option", { value: "" }, "Add a series…"),
      h("optgroup", { label: "Crypto" }, h("option", { value: "BTC", disabled: st.symbols.includes("BTC") }, "Bitcoin (BTC)")),
      h("optgroup", { label: "Indices" }, items.filter((i) => i.kind === "index").map((i) => h("option", { value: i.symbol, disabled: st.symbols.includes(i.symbol) }, `${i.name} (${i.symbol})`))),
      h("optgroup", { label: "Shares" }, items.filter((i) => i.kind === "equity").map((i) => h("option", { value: i.symbol, disabled: st.symbols.includes(i.symbol) }, `${i.symbol} · ${i.name}`))));
    sel.addEventListener("change", () => {
      if (sel.value && st.symbols.length < 4) { st.symbols.push(sel.value); sync(); renderPicker(); load(); }
    });
    put(picker,
      h("div", { class: "toolbar" },
        h("div", { class: "chips", role: "list" }, st.symbols.map((s, i) => h("span", { class: "chip", role: "listitem", "aria-pressed": "true" },
          h("span", { class: "dot", style: { background: SERIES_COLORS[i] } }), s,
          h("button", { class: "x", type: "button", "aria-label": `Remove ${s}`, onclick: () => { st.symbols.splice(i, 1); sync(); renderPicker(); load(); } }, "×")))),
        st.symbols.length < 4 ? sel : h("span", { class: "small muted" }, "Up to 4 series.")),
      chipGroup("Range", RANGES, st.range, (v) => { st.range = v; sync(); renderPicker(); load(); }));
  }

  function render() {
    const ready = series.filter((x) => x.points.length > 1);
    put(chartCard,
      h("h2", null, "Performance ", h("span", { class: "tag" }, RANGES.find((r) => r.value === st.range).label)),
      notes(warnings),
      !st.symbols.length ? h("p", { class: "small muted" }, "Add a share, an index or Bitcoin above.")
        : multiChartBox(series, { height: 320, label: `Comparison of ${st.symbols.join(", ")}` }, "Loading…"),
      h("div", { class: "legend", style: { marginTop: "8px" } }, series.map((x) => h("span", null, h("i", { class: "dot", style: { background: x.color } }), `${x.name}${x.points.length ? "" : " (no data)"}`))),
      h("p", { class: "small muted" }, "Each line keeps its own trading days (markets have different holidays). Hover or use the arrow keys to read values."));
    if (!ready.length) { put(tableCard); tableCard.hidden = true; return; }
    tableCard.hidden = false;
    const base = ready[0];
    put(tableCard,
      h("h2", null, "Figures"),
      h("div", { class: "tablewrap" }, h("table", { class: "data" },
        h("thead", null, h("tr", null, h("th", null, "Series"), h("th", { class: "num" }, "Return"), h("th", { class: "num" }, "Volatility (ann.)"),
          h("th", { class: "num" }, "Max drawdown"), h("th", { class: "num" }, `Correlation with ${base.symbol}`), h("th", null, "Source"))),
        h("tbody", null, ready.map((x) => {
          const s = seriesStats(x.points);
          const c = x === base ? null : correlation(base.points, x.points);
          return h("tr", null,
            h("td", null, h("span", { class: "dot", style: { background: x.color, marginRight: "6px" } }), h("strong", null, x.symbol), h("span", { class: "sub" }, x.name)),
            h("td", { class: "num" }, pctEl(s.ret)),
            h("td", { class: "num" }, s.vol != null ? `${s.vol.toFixed(1)}%` : "—"),
            h("td", { class: "num" }, s.maxDD != null ? `${s.maxDD.toFixed(1)}%` : "—"),
            h("td", { class: "num" }, x === base ? "—" : c == null ? "n/a" : c.toFixed(2)),
            h("td", { class: "small muted" }, x.source || "—"));
        })))),
      h("p", { class: "small muted" }, "Correlation uses daily returns on days both series traded (needs at least 10). Volatility needs a range of 1 month or more."));
  }

  async function load() {
    warnings = [];
    series = st.symbols.map((s, i) => ({ symbol: s, name: nameOf(s), color: SERIES_COLORS[i], points: [], source: null }));
    render();
    const since = Date.now() - SPAN_DAYS[st.range] * 86400_000;
    await Promise.all(series.map(async (x) => {
      try {
        if (x.symbol === "BTC") {
          if (!BTC_RANGE[st.range]) { warnings.push("Bitcoin history is limited to 1 year by the free sources."); return; }
          const r = await api(`/api/history/bitcoin?currency=${state.me.general.defaultCurrency}&range=${BTC_RANGE[st.range]}`);
          x.points = r.points.filter((p) => p[0] >= since);
          x.source = r.source;
        } else {
          const r = await api(`/api/history/equity/${encodeURIComponent(x.symbol)}?range=${st.range}`);
          x.points = r.points;
          x.source = r.source;
          if (!r.points.length) warnings.push(`${x.symbol}: ${r.warnings?.[0] || "no history"}`);
        }
      } catch (err) {
        warnings.push(`${x.symbol}: ${err.message}`);
      }
    }));
    render();
    setStatus(`Updated ${timeStr(new Date().toISOString())}`, warnings.length ? "warn" : "");
  }

  renderPicker();
  await load();
  ctx.poll.every(load, 600);
}
