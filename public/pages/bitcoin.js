// Bitcoin: chart, range stats, sources vs median, market context (Fear & Greed, dominance, spread, network).
import { h, put, api, state, fmtPrice, fmtCompact, fmtPct, pctEl, dir, relTime, timeStr, chipGroup, notes, setStatus } from "../ui.js";
import { chartBox, sparkline } from "../charts.js";
import { errorNote, median, stat, rangeBar, pageHead, savePrefs } from "../common.js";
import { fgBand } from "./dashboard.js";

const RANGES = [{ value: "1d", label: "24h" }, { value: "7d", label: "7d" }, { value: "30d", label: "30d" }, { value: "90d", label: "90d" }, { value: "1y", label: "1y" }];

export async function bitcoinPage(root, _rest, ctx) {
  const currencies = state.me.general.cryptoCurrencies;
  const saved = state.me.prefs.btc || {};
  const st = {
    currency: currencies.includes(saved.currency) ? saved.currency : state.me.general.defaultCurrency,
    range: RANGES.some((r) => r.value === saved.range) ? saved.range : "1d",
  };
  let btc = null, hist = null, extras = null;
  const filters = h("div"), warnBox = h("div");
  const hero = h("div", { class: "card" }, h("p", { class: "skeleton" }, "Loading…"));
  const statsCard = h("div", { class: "card" }), contextCard = h("div", { class: "card" }), sourcesCard = h("div", { class: "card" });
  const tableCard = h("div", { class: "card section" });
  put(root,
    pageHead("Bitcoin", "Price across public sources, with history and market context."),
    filters, warnBox,
    h("div", { class: "layout" }, hero, h("div", { class: "stack" }, statsCard, contextCard, sourcesCard)),
    tableCard);

  const remember = () => savePrefs({ btc: { currency: st.currency, range: st.range } });
  function renderFilters() {
    put(filters, h("div", { class: "toolbar" },
      chipGroup("Currency", currencies, st.currency, (v) => { st.currency = v; remember(); renderFilters(); loadHistory(); loadExtras(); }),
      chipGroup("Range", RANGES, st.range, (v) => { st.range = v; remember(); renderFilters(); loadHistory(); }),
      h("a", { class: "chip", href: "#/compare?s=BTC,%5EGSPC&r=1y" }, "Compare with S&P 500 →")));
  }

  function renderContext() {
    if (!extras) { put(contextCard, h("h2", null, "Market context"), h("p", { class: "skeleton" }, "Loading…")); return; }
    const fg = extras.fearGreed;
    put(contextCard,
      h("h2", null, "Market context"),
      fg ? [
        h("h3", null, "Fear & Greed"),
        h("div", { class: "price-row" }, h("span", { class: "fgval" }, String(fg.value)), h("span", { class: `tag fg ${fgBand(fg.value)}` }, fg.label)),
        h("div", { class: "track fgtrack", role: "img", "aria-label": `Fear and Greed ${fg.value} of 100` }, h("div", { class: "marker", style: { left: `${fg.value}%` } })),
        h("div", { class: "rangebar" }, h("div", { class: "ends" }, h("span", null, "Extreme fear"), h("span", null, "Extreme greed"))),
        fg.history?.length > 1 ? [h("div", { class: "small muted", style: { marginTop: "6px" } }, "Last 30 days"), sparkline(fg.history, { w: 300, h: 40, base: 50 })] : null,
      ] : null,
      h("dl", { class: "stats" },
        extras.dominance != null ? stat("BTC dominance", `${extras.dominance.toFixed(1)}%`) : null,
        extras.spread ? stat(`Exchange gap (${extras.spread.sources})`, `${extras.spread.pct.toFixed(3)}%`) : null,
        extras.network ? stat("Block height", extras.network.blockHeight?.toLocaleString() ?? "—") : null,
        extras.network ? stat("Fees fast / 1 h", `${extras.network.fees.fast} / ${extras.network.fees.hour} sat/vB`) : null),
      notes(extras.warnings));
    contextCard.querySelectorAll(".spark").forEach((x) => x.classList.add("wide"));
  }

  function render() {
    const cur = st.currency;
    const p = btc && (() => {
      for (const s of btc.sources) {
        const q = s.quotes.find((x) => x.currency === cur);
        if (q?.price != null) return { ...q, source: s.name, stale: s.stale };
      }
      return null;
    })();
    const pts = hist?.points || [];
    const first = pts[0]?.[1], last = pts[pts.length - 1]?.[1];
    const rangeChg = first && last ? ((last - first) / first) * 100 : null;
    const rangeLabel = RANGES.find((r) => r.value === st.range).label;
    put(hero,
      h("h3", null, `BTC / ${cur}`),
      h("div", { class: "price-row" },
        h("span", { class: "price-big" }, p ? fmtPrice(p.price, cur) : "—"),
        p ? [pctEl(p.changePct), h("span", { class: "small muted" }, "24 h")] : null,
        rangeChg != null && st.range !== "1d" ? [pctEl(rangeChg), h("span", { class: "small muted" }, rangeLabel)] : null),
      chartBox(pts, { currency: cur, height: 280, label: `Bitcoin price in ${cur}, ${rangeLabel}` }, hist ? "No history available." : "Loading chart…"),
      h("p", { class: "small muted", style: { marginTop: "6px" } },
        p ? `Price: ${p.source}${p.stale ? " (stale)" : ""}. ` : "", hist?.source ? `Chart: ${hist.source}. ` : "",
        "Hover or use the arrow keys on the chart to read values."));
    if (pts.length) {
      const ys = pts.map((x) => x[1]);
      const hi = Math.max(...ys), lo = Math.min(...ys);
      put(statsCard,
        h("h2", null, "Range ", h("span", { class: "tag" }, rangeLabel)),
        h("dl", { class: "stats" }, stat("High", fmtPrice(hi, cur)), stat("Low", fmtPrice(lo, cur)), stat("Change", pctEl(rangeChg)), stat("Spread", `${(((hi - lo) / lo) * 100).toFixed(2)}%`)),
        p ? rangeBar(lo, hi, p.price, (v) => fmtPrice(v, cur)) : null);
    } else put(statsCard, h("h2", null, "Range"), h("p", { class: "small muted" }, "Waiting for history…"));
    if (!btc) return;
    const rows = btc.sources.map((s) => ({ s, q: s.quotes.find((q) => q.currency === cur) })).filter((r) => r.q);
    const med = median(rows.map((r) => r.q.price));
    const maxDev = Math.max(0.0001, ...rows.map((r) => Math.abs((r.q.price - med) / med) * 100));
    put(sourcesCard,
      h("h2", null, "Versus median ", h("span", { class: "tag" }, fmtPrice(med, cur))),
      rows.length ? rows.map(({ s, q }) => {
        const dev = ((q.price - med) / med) * 100;
        return h("div", { class: "nbrow" },
          h("span", { class: "lab" }, s.name.replace(" Exchange", "")),
          h("div", { class: "track" }, h("div", { class: `fill ${dir(dev)}`, style: { width: `${(Math.abs(dev) / maxDev) * 100}%` } })),
          h("span", { class: "val" }, `${dev >= 0 ? "+" : ""}${dev.toFixed(3)}%`));
      }) : h("p", { class: "small muted" }, `No source quotes ${cur}.`));
    put(tableCard,
      h("h2", null, "Sources"),
      h("div", { class: "tablewrap" }, h("table", { class: "data" },
        h("thead", null, h("tr", null, h("th", null, "Source"), h("th", { class: "num" }, "Price"), h("th", { class: "num" }, "24 h"),
          h("th", { class: "num" }, "High"), h("th", { class: "num" }, "Low"), h("th", { class: "num" }, "Volume 24 h"), h("th", null, "Updated"))),
        h("tbody", null, btc.sources.map((s) => {
          const q = s.quotes.find((x) => x.currency === cur);
          if (!q) return h("tr", null, h("td", null, s.name), h("td", { colspan: 6, class: "small muted" }, s.error ? `Error: ${s.error}` : `No BTC/${cur} market.`));
          return h("tr", null,
            h("td", null, s.name, s.stale ? h("span", { class: "tag bad" }, "stale") : null),
            h("td", { class: "num" }, fmtPrice(q.price, cur)), h("td", { class: "num" }, pctEl(q.changePct)),
            h("td", { class: "num" }, fmtPrice(q.high, cur)), h("td", { class: "num" }, fmtPrice(q.low, cur)),
            h("td", { class: "num" }, fmtCompact(q.volume, cur)), h("td", { class: "small muted" }, relTime(s.fetchedAt)));
        })))),
      h("p", { class: "small muted" }, "Change is a rolling 24 h, except Kraken (since 00:00 UTC) and Coinbase (since its 24 h open)."));
  }

  async function loadQuotes() {
    try {
      btc = await api("/api/quotes/bitcoin");
      put(warnBox, notes(btc.warnings));
      setStatus(`Updated ${timeStr(new Date().toISOString())}`, btc.warnings.length ? "warn" : "");
    } catch (err) {
      put(warnBox, errorNote(err));
    }
    render();
  }
  async function loadHistory() {
    hist = null;
    render();
    try {
      hist = await api(`/api/history/bitcoin?currency=${st.currency}&range=${st.range}`);
    } catch (err) {
      hist = { points: [], warnings: [err.message] };
    }
    render();
  }
  async function loadExtras() {
    try { extras = await api(`/api/bitcoin/extras?currency=${st.currency}`); } catch (err) { extras = { warnings: [err.message] }; }
    renderContext();
  }

  renderFilters();
  renderContext();
  await Promise.all([loadQuotes(), loadHistory(), loadExtras()]);
  ctx.poll.every(loadQuotes, state.me.general.refreshSeconds);
  ctx.poll.every(() => (st.range === "1d" ? loadHistory() : Promise.resolve()), 300);
  ctx.poll.every(loadExtras, 900);
}
