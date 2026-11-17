import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/index.js";
import { MIGRATIONS } from "../src/db/migrations.js";
import { createSettingsRepo } from "../src/repos/settings.js";
import { createUsersRepo } from "../src/repos/users.js";
import { createWatchlistRepo } from "../src/repos/watchlist.js";
import { createHistory } from "../src/history.js";
import { normalizePrefs } from "../src/repos/prefs.js";
import { createSessions } from "../src/auth/sessions.js";
import { createAlerts } from "../src/alerts/service.js";

// SQLite by default. TEST_DB_ENGINE=mysql runs the same tests against a real
// MySQL from the MYSQL_* variables, on an EMPTY database (the tests create
// rows and do not clean up): SQLite accepts SQL that MySQL refuses - a column
// named last_value broke the first deploy - so both engines need running.
//   podman run -d --rm --name mex-mysql -p 3399:3306 -e MYSQL_ROOT_PASSWORD=t -e MYSQL_DATABASE=t mysql:8.4
//   TEST_DB_ENGINE=mysql MYSQL_HOST=127.0.0.1 MYSQL_PORT=3399 MYSQL_USER=root MYSQL_PASSWORD=t MYSQL_DATABASE=t npm test
let dir, db;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), "mex-test-"));
  const engine = process.env.TEST_DB_ENGINE || "sqlite";
  const e = process.env;
  db = await createDb({
    engine,
    sqlitePath: join(dir, "t.sqlite"),
    mysql: { host: e.MYSQL_HOST, port: Number(e.MYSQL_PORT || 3306), user: e.MYSQL_USER, password: e.MYSQL_PASSWORD, database: e.MYSQL_DATABASE },
  }, { log: () => {} });
});
after(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("migrations apply once and record their version", async () => {
  assert.equal(db.schemaVersion, MIGRATIONS[MIGRATIONS.length - 1].version);
  const rows = await db.all("SELECT version FROM schema_migrations ORDER BY version");
  assert.deepEqual(rows.map((r) => r.version), MIGRATIONS.map((m) => m.version));
});

test("settings normalise and clamp", async () => {
  const s = createSettingsRepo(db);
  const g = await s.set("general", { refreshSeconds: 2, cryptoCurrencies: ["usd", "eur", "x"], displayCurrency: "GBP", retention: { rawDays: 500, hourlyDays: 1 } });
  assert.equal(g.refreshSeconds, 15);
  assert.deepEqual(g.cryptoCurrencies, ["USD", "EUR"]);
  assert.equal(g.displayCurrency, "", "not a configured currency");
  assert.equal(g.retention.rawDays, 90);
  assert.equal(g.retention.hourlyDays, 30);
  const p = await s.get("providers");
  for (const k of ["equity", "crypto", "fx", "btcextra"]) assert.ok(p[k].length > 0, k);
});

test("watchlist seeds shares and indices once", async () => {
  const s = createSettingsRepo(db);
  const w = createWatchlistRepo(db, s);
  await w.seed();
  const idx = await w.list("index");
  assert.ok(idx.some((i) => i.symbol === "^HSI" && i.market === "HK"));
  for (const i of idx) await w.remove(i.id);
  await w.seed();
  assert.equal((await w.list("index")).length, 0, "deleted indices are not re-seeded");
  const added = await w.add({ symbol: "^n225" });
  assert.equal(added.kind, "index");
});

test("history: dedupe, rollups, coverage, retention", async () => {
  const h = createHistory(db);
  await h.init();
  const now = Date.now();
  const rows = [];
  for (let i = 0; i < 48; i++) rows.push({ symbol: "TEST", kind: "equity", currency: "USD", price: 100 + i, at: new Date(now - (48 - i) * 1800_000).toISOString() });
  assert.equal(await h.record(rows), 48);
  assert.equal(await h.record(rows), 0, "same timestamps are not stored twice");
  const r = await h.rollup(now - 2 * 86400_000);
  assert.ok(r.hours >= 24 && r.days >= 1);
  const hourly = await h.series("TEST", now - 86400_000, "hour");
  assert.ok(hourly.length >= 23);
  const cov = await h.covered("TEST", now - 20 * 3600_000, { rawDays: 7, hourlyDays: 180 });
  assert.equal(cov.bucket, "raw");
  assert.equal(await h.covered("TEST", now - 300 * 86400_000, { rawDays: 7, hourlyDays: 180 }), null);
  const pruned = await h.prune({ rawDays: 1, hourlyDays: 180, dailyYears: 0 });
  assert.ok(pruned.raw > 0);
});

test("users: two-factor recovery codes are single-use", async () => {
  const u = createUsersRepo(db);
  const user = await u.create({ username: "zed", password: "a-long-password-1", role: "viewer" });
  await u.enableTotp(user.id, "SECRET", 1, ["abcd-efgh", "ijkl-mnop"]);
  assert.equal(await u.recoveryLeft(user.id), 2);
  assert.equal(await u.useRecoveryCode(user.id, "ABCD-EFGH"), 1);
  assert.equal(await u.useRecoveryCode(user.id, "abcd-efgh"), -1);
  await u.disableTotp(user.id);
  assert.equal((await u.byId(user.id)).totpEnabled, false);
});

test("sessions: second factor, rotation and revocation", async () => {
  const u = createUsersRepo(db);
  const user = await u.create({ username: "yan", password: "a-long-password-2", role: "viewer" });
  const s = createSessions(db, { ttlHours: 1, maxDays: 1, cookieSecure: false });
  const pending = await s.create(user.id, { ip: "1.1.1.1", userAgent: "x", mfaPassed: false });
  const look = await s.lookup(pending.token);
  assert.equal(look.session.mfaPassed, false);
  const cookie = await s.passMfa(look.session.hash);
  assert.equal(await s.lookup(pending.token), null, "the pre-MFA token no longer works");
  const fresh = /mex_session=([^;]+)/.exec(cookie)[1];
  const ok = await s.lookup(fresh);
  assert.equal(ok.session.mfaPassed, true);
  const list = await s.listForUser(user.id);
  assert.equal(list.length, 1);
  assert.ok(await s.destroyByPublicId(user.id, list[0].id));
  assert.equal(await s.lookup(fresh), null);
});

test("prefs normalise", () => {
  const p = normalizePrefs({ pinned: ["AAPL", "NOPE"], displayCurrency: "jpy", extraColumn: "bad", defaultPage: "x" }, { symbols: ["AAPL"], currencies: ["USD", "EUR"] });
  assert.deepEqual(p.pinned, ["AAPL"]);
  assert.equal(p.displayCurrency, null);
  assert.equal(p.extraColumn, "");
  assert.equal(p.defaultPage, "dashboard");
});

test("alerts: a check run stores state and last value, and fires once", async () => {
  // Backticks: `condition` is reserved in MySQL; SQLite accepts them too.
  await db.run("INSERT INTO alerts (owner_id, `condition`, symbol, currency, threshold, channels, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [null, "price_above", "BTC", "USD", 100, JSON.stringify(["inapp"]), new Date().toISOString()]);
  let price = 150;
  const alerts = createAlerts({
    db,
    market: { bitcoin: async () => ({ sources: [{ quotes: [{ currency: "USD", price }] }] }) },
    watchlist: { list: async () => [] },
    users: { byId: async () => null },
    notifier: { send: async () => ({}) },
    jobs: { status: () => [] },
    health: { failingFor: () => 0 },
    settings: { get: async () => ({}) },
    log: () => {},
  });
  assert.deepEqual(await alerts.run(), { checked: 1, fired: 1 });
  const row = await db.get("SELECT state, `last_value` AS v, last_fired_at FROM alerts WHERE symbol = 'BTC'");
  assert.equal(row.v, 150);
  assert.ok(row.last_fired_at);
  price = 160;
  assert.deepEqual(await alerts.run(), { checked: 1, fired: 0 }, "still above: no second fire");
  assert.equal((await db.get("SELECT `last_value` AS v FROM alerts WHERE symbol = 'BTC'")).v, 160);
});
