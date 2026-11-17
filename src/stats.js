// Statistics from a daily close series [[ms, close], ...] (oldest first). Pure functions, unit-tested.
const DAY = 86400_000;

/** Close at or before `ms` (the series is sorted). */
function closeAt(points, ms) {
  let v = null;
  for (const [t, c] of points) {
    if (t > ms) break;
    v = c;
  }
  return v;
}

const pct = (a, b) => (a != null && b ? (a / b - 1) * 100 : null);

export function dailyReturns(points) {
  const r = [];
  for (let i = 1; i < points.length; i++) if (points[i - 1][1]) r.push(points[i][1] / points[i - 1][1] - 1);
  return r;
}

export function stdev(xs) {
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

export function maxDrawdown(points) {
  let peak = -Infinity, dd = 0;
  for (const [, c] of points) {
    peak = Math.max(peak, c);
    if (peak > 0) dd = Math.min(dd, c / peak - 1);
  }
  return dd * 100;
}

/** Pearson correlation of two series' daily returns, joined by UTC date. Null if fewer than 10 common days. */
export function correlation(a, b) {
  const key = (ms) => new Date(ms).toISOString().slice(0, 10);
  const byDay = (pts) => {
    const m = new Map();
    for (const [t, c] of pts) m.set(key(t), c);
    return m;
  };
  const ma = byDay(a), mb = byDay(b);
  const days = [...ma.keys()].filter((d) => mb.has(d)).sort();
  const ra = [], rb = [];
  for (let i = 1; i < days.length; i++) {
    const a0 = ma.get(days[i - 1]), a1 = ma.get(days[i]), b0 = mb.get(days[i - 1]), b1 = mb.get(days[i]);
    if (a0 && b0) { ra.push(a1 / a0 - 1); rb.push(b1 / b0 - 1); }
  }
  if (ra.length < 10) return null;
  const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length;
  const xa = mean(ra), xb = mean(rb);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < ra.length; i++) {
    num += (ra[i] - xa) * (rb[i] - xb);
    da += (ra[i] - xa) ** 2;
    db += (rb[i] - xb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : null;
}

/**
 * Returns, 52-week range and risk figures. `price` (live) replaces the last close when given.
 * tradingDays: 252 for shares, 365 for Bitcoin (annualising volatility).
 */
export function computeStats(points, { price, now = Date.now(), tradingDays = 252 } = {}) {
  if (!points?.length) return null;
  const last = price ?? points[points.length - 1][1];
  const yearAgo = now - 365 * DAY;
  const year = points.filter(([t]) => t >= yearAgo);
  const closes = year.map((p) => p[1]).concat(price != null ? [price] : []);
  const hi52 = Math.max(...closes), lo52 = Math.min(...closes);
  const jan1 = Date.UTC(new Date(now).getUTCFullYear(), 0, 1);
  const lastBeforeYear = closeAt(points, jan1 - 1);
  const returns30 = dailyReturns(points.filter(([t]) => t >= now - 45 * DAY)).slice(-30);
  const sd = stdev(returns30);
  const fromHigh = pct(last, hi52), fromLow = pct(last, lo52);
  const badges = [];
  if (price != null && price >= Math.max(...year.map((p) => p[1]))) badges.push("new-52w-high");
  else if (fromHigh != null && fromHigh > -3) badges.push("near-52w-high");
  if (price != null && price <= Math.min(...year.map((p) => p[1]))) badges.push("new-52w-low");
  else if (fromLow != null && fromLow < 3) badges.push("near-52w-low");
  return {
    r1w: pct(last, closeAt(points, now - 7 * DAY)),
    r1m: pct(last, closeAt(points, now - 30 * DAY)),
    r3m: pct(last, closeAt(points, now - 91 * DAY)),
    ytd: pct(last, lastBeforeYear),
    r1y: points[0][0] <= yearAgo + 7 * DAY ? pct(last, closeAt(points, yearAgo) ?? points[0][1]) : null,
    hi52, lo52, fromHigh, fromLow,
    vol30: sd != null ? sd * Math.sqrt(tradingDays) * 100 : null,
    maxDrawdown1y: year.length > 1 ? maxDrawdown(year) : null,
    badges,
    points: points.length,
    from: new Date(points[0][0]).toISOString(),
  };
}
