// Stored price history: raw snapshots, hourly and daily OHLC rollups, retention, and series queries.
// Snapshots only grow while markets trade (a row is written when the quote's own timestamp advances).
const HOUR = 3600_000, DAY = 86400_000;

export function createHistory(db) {
  const lastAt = new Map(); // symbol -> ISO of the newest stored snapshot

  async function init() {
    for (const r of await db.all("SELECT symbol, MAX(at) AS at FROM quote_snapshots GROUP BY symbol")) lastAt.set(r.symbol, r.at);
  }

  /** rows: [{ symbol, kind, currency, price, changePct, source, at }]. Skips rows not newer than the last stored. */
  async function record(rows) {
    const fresh = rows.filter((r) => Number.isFinite(r.price) && r.at && (!lastAt.has(r.symbol) || r.at > lastAt.get(r.symbol)));
    if (!fresh.length) return 0;
    await db.tx(async (t) => {
      for (const r of fresh) {
        await t.run("INSERT INTO quote_snapshots (symbol, kind, currency, price, change_pct, source, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [r.symbol, r.kind, r.currency || null, r.price, r.changePct ?? null, r.source || null, r.at]);
      }
    });
    for (const r of fresh) lastAt.set(r.symbol, r.at);
    return fresh.length;
  }

  function ohlc(groups, bucket, keyLen) {
    const out = [];
    for (const [k, list] of groups) {
      const [symbol, at] = k.split("|");
      out.push({
        k: `${symbol}|${bucket}|${at}`, symbol, bucket, at: at.padEnd(keyLen, "0") ,
        open: list[0].o, high: Math.max(...list.map((x) => x.h)), low: Math.min(...list.map((x) => x.l)), close: list[list.length - 1].c,
        n: list.reduce((a, x) => a + x.n, 0),
      });
    }
    return out;
  }

  /** Rebuilds hourly buckets from raw rows since `sinceMs`, then daily buckets for the days touched. */
  async function rollup(sinceMs = Date.now() - 2 * DAY) {
    const since = new Date(Math.floor(sinceMs / HOUR) * HOUR).toISOString();
    const raw = await db.all("SELECT symbol, price, at FROM quote_snapshots WHERE at >= ? ORDER BY symbol, at", [since]);
    const hours = new Map();
    for (const r of raw) {
      const key = `${r.symbol}|${r.at.slice(0, 13)}:00:00.000Z`;
      if (!hours.has(key)) hours.set(key, []);
      hours.get(key).push({ o: r.price, h: r.price, l: r.price, c: r.price, n: 1 });
    }
    const hourRows = ohlc(hours, "hour", 24);
    const daySince = `${since.slice(0, 10)}T00:00:00.000Z`;
    await db.tx(async (t) => {
      for (const r of hourRows) await t.upsert("quote_rollups", "k", r);
    });
    const hourly = await db.all("SELECT symbol, at, open, high, low, close, n FROM quote_rollups WHERE bucket = 'hour' AND at >= ? ORDER BY symbol, at", [daySince]);
    const days = new Map();
    for (const r of hourly) {
      const key = `${r.symbol}|${r.at.slice(0, 10)}T00:00:00.000Z`;
      if (!days.has(key)) days.set(key, []);
      days.get(key).push({ o: r.open, h: r.high, l: r.low, c: r.close, n: r.n });
    }
    const dayRows = ohlc(days, "day", 24);
    await db.tx(async (t) => {
      for (const r of dayRows) await t.upsert("quote_rollups", "k", r);
    });
    return { hours: hourRows.length, days: dayRows.length };
  }

  async function prune({ rawDays, hourlyDays, dailyYears }) {
    const iso = (ms) => new Date(ms).toISOString();
    const raw = await db.run("DELETE FROM quote_snapshots WHERE at < ?", [iso(Date.now() - rawDays * DAY)]);
    const hour = await db.run("DELETE FROM quote_rollups WHERE bucket = 'hour' AND at < ?", [iso(Date.now() - hourlyDays * DAY)]);
    const day = dailyYears > 0
      ? await db.run("DELETE FROM quote_rollups WHERE bucket = 'day' AND at < ?", [iso(Date.now() - dailyYears * 365 * DAY)])
      : { changes: 0 };
    return { raw: raw.changes, hour: hour.changes, day: day.changes };
  }

  /** [[ms, close], ...] since fromMs from one bucket: "raw" | "hour" | "day". */
  async function series(symbol, fromMs, bucket) {
    const from = new Date(fromMs).toISOString();
    const rows = bucket === "raw"
      ? await db.all("SELECT at, price AS v FROM quote_snapshots WHERE symbol = ? AND at >= ? ORDER BY at", [symbol, from])
      : await db.all("SELECT at, close AS v FROM quote_rollups WHERE symbol = ? AND bucket = ? AND at >= ? ORDER BY at", [symbol, bucket, from]);
    return rows.map((r) => [Date.parse(r.at), Number(r.v)]);
  }

  /** A stored series that covers [fromMs, now], or null. Picks the finest bucket kept for that long. */
  async function covered(symbol, fromMs, retention) {
    const age = Date.now() - fromMs;
    const bucket = age <= Math.min(retention.rawDays, 5) * DAY ? "raw" : age <= Math.min(retention.hourlyDays, 60) * DAY ? "hour" : "day";
    const pts = await series(symbol, fromMs, bucket);
    if (pts.length < 10) return null;
    const span = Date.now() - fromMs;
    if (pts[0][0] > fromMs + span * 0.15) return null; // starts too late to call it covered
    return { bucket, points: pts };
  }

  async function counts() {
    const raw = Number((await db.get("SELECT COUNT(*) AS n FROM quote_snapshots")).n);
    const hour = Number((await db.get("SELECT COUNT(*) AS n FROM quote_rollups WHERE bucket = 'hour'")).n);
    const day = Number((await db.get("SELECT COUNT(*) AS n FROM quote_rollups WHERE bucket = 'day'")).n);
    const oldest = (await db.get("SELECT MIN(at) AS at FROM quote_rollups WHERE bucket = 'day'"))?.at || null;
    return { raw, hour, day, oldestDay: oldest, bytes: db.sizeBytes ? await db.sizeBytes() : null };
  }

  return { init, record, rollup, prune, series, covered, counts };
}
