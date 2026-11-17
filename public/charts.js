// Hand-drawn SVG charts (no chart library), in the reference's viewBox style:
// they scale with the container, read their colors from CSS tokens, and work by mouse, touch and keyboard.
import { h, s, fmtPrice } from "./ui.js";

/**
 * A container that draws lineChart at its real pixel width (redrawn on resize),
 * so axis text stays 11px in a narrow side panel as well as on a wide screen.
 */
export function chartBox(points, opts, emptyText = "No data.") {
  const box = h("div", { class: "chartbox" });
  if (!points.length) {
    box.append(h("div", { class: "empty" }, emptyText));
    return box;
  }
  let lastW = 0;
  const draw = (w) => {
    if (!w || Math.abs(w - lastW) < 2) return;
    lastW = w;
    box.replaceChildren(lineChart(points, { ...opts, width: w }));
  };
  draw(640); // provisional size until the box is laid out
  lastW = 0;
  new ResizeObserver((entries) => draw(Math.round(entries[0].contentRect.width))).observe(box);
  return box;
}

function niceTicks(min, max, count = 4) {
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((st) => span / st <= count + 0.5) || 10 * mag;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

function timeLabel(ms, spanMs) {
  const d = new Date(ms);
  if (spanMs <= 2 * 86400_000) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (spanMs <= 120 * 86400_000) return d.toLocaleDateString([], { day: "numeric", month: "short" });
  return d.toLocaleDateString([], { month: "short", year: "2-digit" });
}
function tipLabel(ms, spanMs) {
  const d = new Date(ms);
  return spanMs <= 8 * 86400_000
    ? d.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}

/**
 * Line chart for [[ms, value], ...].
 * opts: { currency, baseline (number: a dashed reference line, e.g. previous close), height, label }
 */
export function lineChart(points, opts = {}) {
  const W = opts.width || 640, H = opts.height || 260;
  const pad = { l: 4, r: 72, t: 14, b: 24 };
  const svg = s("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", tabindex: "0", "aria-label": opts.label || "Price chart" });
  if (!points.length) return svg;

  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  let lo = Math.min(...ys), hi = Math.max(...ys);
  if (opts.baseline != null) { lo = Math.min(lo, opts.baseline); hi = Math.max(hi, opts.baseline); }
  const padY = (hi - lo) * 0.08 || Math.abs(hi) * 0.01 || 1;
  lo -= padY; hi += padY;
  const x0 = xs[0], x1 = xs[xs.length - 1], span = Math.max(1, x1 - x0);
  const X = (t) => pad.l + ((t - x0) / span) * (W - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);

  // grid + price axis (right side, like trading charts)
  for (const t of niceTicks(lo, hi, 4)) {
    if (t < lo || t > hi) continue;
    svg.append(s("line", { class: "grid", x1: pad.l, x2: W - pad.r, y1: Y(t), y2: Y(t) }));
    svg.append(s("text", { x: W - pad.r + 6, y: Y(t) + 4 }, fmtPrice(t, opts.currency).replace(/\.00(?=\D*$)/, "")));
  }
  // time axis
  const n = Math.max(2, Math.min(6, Math.floor((W - pad.r) / 110)));
  for (let i = 0; i < n; i++) {
    const t = x0 + (span * (i + 0.5)) / n;
    svg.append(s("text", { x: X(t), y: H - 6, "text-anchor": "middle" }, timeLabel(t, span)));
  }
  if (opts.baseline != null) svg.append(s("line", { class: "base", x1: pad.l, x2: W - pad.r, y1: Y(opts.baseline), y2: Y(opts.baseline) }));

  const d = points.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("");
  svg.append(s("path", { class: "area", d: `${d}L${X(x1).toFixed(1)},${H - pad.b}L${X(x0).toFixed(1)},${H - pad.b}Z` }));
  svg.append(s("path", { class: "line", d }));

  // hover / keyboard cursor
  const cursor = s("line", { class: "cursor", y1: pad.t, y2: H - pad.b, visibility: "hidden" });
  const dot = s("circle", { class: "cursor-dot", r: 4, visibility: "hidden" });
  const tip = s("text", { class: "tip", y: pad.t + 2, visibility: "hidden" });
  svg.append(cursor, dot, tip);
  let idx = -1;
  function show(i) {
    idx = Math.max(0, Math.min(points.length - 1, i));
    const [t, v] = points[idx];
    const x = X(t);
    for (const el of [cursor, dot, tip]) el.setAttribute("visibility", "visible");
    cursor.setAttribute("x1", x); cursor.setAttribute("x2", x);
    dot.setAttribute("cx", x); dot.setAttribute("cy", Y(v));
    tip.textContent = `${fmtPrice(v, opts.currency)} · ${tipLabel(t, span)}`;
    const right = x > (W - pad.r) * 0.6;
    tip.setAttribute("x", right ? x - 8 : x + 8);
    tip.setAttribute("text-anchor", right ? "end" : "start");
  }
  function hide() {
    idx = -1;
    for (const el of [cursor, dot, tip]) el.setAttribute("visibility", "hidden");
  }
  function nearest(evt) {
    const r = svg.getBoundingClientRect();
    const px = ((evt.clientX - r.left) / r.width) * W;
    const t = x0 + ((px - pad.l) / (W - pad.l - pad.r)) * span;
    let best = 0;
    for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i] - t) < Math.abs(xs[best] - t)) best = i;
    return best;
  }
  svg.addEventListener("pointermove", (e) => show(nearest(e)));
  svg.addEventListener("pointerleave", hide);
  svg.addEventListener("blur", hide);
  svg.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 10 : 1;
    if (e.key === "ArrowRight") show((idx < 0 ? points.length - 1 : idx) + step);
    else if (e.key === "ArrowLeft") show((idx < 0 ? points.length - 1 : idx) - step);
    else if (e.key === "Home") show(0);
    else if (e.key === "End") show(points.length - 1);
    else if (e.key === "Escape") hide();
    else return;
    e.preventDefault();
  });
  return svg;
}

/** Tiny sparkline; colored by direction against `base` (default: first point). */
export function sparkline(points, { base, w = 90, h = 26 } = {}) {
  const svg = s("svg", { class: "spark", viewBox: `0 0 ${w} ${h}`, "aria-hidden": "true", preserveAspectRatio: "none" });
  if (!points || points.length < 2) return svg;
  const ys = points.map((p) => p[1]);
  const ref = base ?? ys[0];
  const lo = Math.min(...ys, ref), hi = Math.max(...ys, ref);
  const x0 = points[0][0], span = Math.max(1, points[points.length - 1][0] - x0);
  const X = (t) => ((t - x0) / span) * (w - 2) + 1;
  const Y = (v) => (hi === lo ? h / 2 : 2 + (1 - (v - lo) / (hi - lo)) * (h - 4));
  const up = ys[ys.length - 1] >= ref;
  svg.append(s("line", { class: "ref", x1: 0, x2: w, y1: Y(ref), y2: Y(ref) }));
  svg.append(s("polyline", {
    class: up ? "up" : "down",
    points: points.map((p) => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(" "),
  }));
  return svg;
}

/**
 * Several series normalised to % change from their first point (compare mode).
 * series: [{ name, points: [[ms, v]...], color }]. Each line keeps its own timestamps (no interpolation).
 */
export function multiChart(series, opts = {}) {
  const W = opts.width || 640, H = opts.height || 300;
  const pad = { l: 4, r: 56, t: 14, b: 24 };
  const svg = s("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", tabindex: "0", "aria-label": opts.label || "Comparison chart" });
  const norm = series.filter((x) => x.points.length > 1).map((x) => ({ ...x, pts: x.points.map(([t, v]) => [t, (v / x.points[0][1] - 1) * 100]) }));
  if (!norm.length) return svg;
  const all = norm.flatMap((x) => x.pts);
  const x0 = Math.min(...all.map((p) => p[0])), x1 = Math.max(...all.map((p) => p[0])), span = Math.max(1, x1 - x0);
  let lo = Math.min(0, ...all.map((p) => p[1])), hi = Math.max(0, ...all.map((p) => p[1]));
  const padY = (hi - lo) * 0.08 || 1;
  lo -= padY; hi += padY;
  const X = (t) => pad.l + ((t - x0) / span) * (W - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  for (const t of niceTicks(lo, hi, 4)) {
    if (t < lo || t > hi) continue;
    svg.append(s("line", { class: t === 0 ? "base" : "grid", x1: pad.l, x2: W - pad.r, y1: Y(t), y2: Y(t) }));
    svg.append(s("text", { x: W - pad.r + 6, y: Y(t) + 4 }, `${t > 0 ? "+" : ""}${+t.toFixed(1)}%`));
  }
  const n = Math.max(2, Math.min(6, Math.floor((W - pad.r) / 110)));
  for (let i = 0; i < n; i++) {
    const t = x0 + (span * (i + 0.5)) / n;
    svg.append(s("text", { x: X(t), y: H - 6, "text-anchor": "middle" }, timeLabel(t, span)));
  }
  for (const x of norm) {
    const path = s("path", { class: "mline", d: x.pts.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("") });
    path.style.stroke = x.color;
    svg.append(path);
  }
  const cursor = s("line", { class: "cursor", y1: pad.t, y2: H - pad.b, visibility: "hidden" });
  const tips = norm.map((x) => {
    const t = s("text", { class: "tip", visibility: "hidden" });
    t.style.fill = x.color;
    return t;
  });
  svg.append(cursor, ...tips);
  const show = (t) => {
    const x = X(t);
    cursor.setAttribute("x1", x); cursor.setAttribute("x2", x); cursor.setAttribute("visibility", "visible");
    const right = x > (W - pad.r) * 0.6;
    norm.forEach((ser, i) => {
      let best = ser.pts[0];
      for (const p of ser.pts) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
      tips[i].textContent = `${ser.name} ${best[1] > 0 ? "+" : ""}${best[1].toFixed(2)}%`;
      tips[i].setAttribute("x", right ? x - 8 : x + 8);
      tips[i].setAttribute("y", pad.t + 12 + i * 15);
      tips[i].setAttribute("text-anchor", right ? "end" : "start");
      tips[i].setAttribute("visibility", "visible");
    });
  };
  const hide = () => [cursor, ...tips].forEach((e) => e.setAttribute("visibility", "hidden"));
  let cur = x1;
  svg.addEventListener("pointermove", (e) => {
    const r = svg.getBoundingClientRect();
    cur = x0 + ((((e.clientX - r.left) / r.width) * W - pad.l) / (W - pad.l - pad.r)) * span;
    show(cur);
  });
  svg.addEventListener("pointerleave", hide);
  svg.addEventListener("blur", hide);
  svg.addEventListener("keydown", (e) => {
    const stepMs = span / 100 * (e.shiftKey ? 10 : 1);
    if (e.key === "ArrowRight") cur = Math.min(x1, cur + stepMs);
    else if (e.key === "ArrowLeft") cur = Math.max(x0, cur - stepMs);
    else if (e.key === "Escape") return hide();
    else return;
    e.preventDefault();
    show(cur);
  });
  return svg;
}

/** Like chartBox, for multiChart. */
export function multiChartBox(series, opts, emptyText = "No data.") {
  const box = h("div", { class: "chartbox" });
  if (!series.some((x) => x.points.length > 1)) {
    box.append(h("div", { class: "empty" }, emptyText));
    return box;
  }
  let lastW = 0;
  new ResizeObserver((entries) => {
    const w = Math.round(entries[0].contentRect.width);
    if (!w || Math.abs(w - lastW) < 2) return;
    lastW = w;
    box.replaceChildren(multiChart(series, { ...opts, width: w }));
  }).observe(box);
  box.append(multiChart(series, opts));
  return box;
}
