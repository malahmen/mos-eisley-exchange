// Mos Eisley Exchange: a LAN dashboard for Bitcoin, shares and indices.
// Plain node:http, no framework (same approach as death-star-audit). Routes live in src/routes/.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { config, ROOT } from "./src/config.js";
import { createDb } from "./src/db/index.js";
import { createUsersRepo } from "./src/repos/users.js";
import { createAuditRepo } from "./src/repos/audit.js";
import { createSettingsRepo } from "./src/repos/settings.js";
import { createWatchlistRepo } from "./src/repos/watchlist.js";
import { createPrefsRepo } from "./src/repos/prefs.js";
import { createSessions, readCookie, COOKIE } from "./src/auth/sessions.js";
import { createThrottle } from "./src/auth/throttle.js";
import { createAllowList } from "./src/auth/cidr.js";
import { passwordProblem, normalizeUsername, USERNAME_RE } from "./src/auth/passwords.js";
import { createSecrets } from "./src/secrets.js";
import { createJobs } from "./src/jobs.js";
import { createHistory } from "./src/history.js";
import { createMarket } from "./src/providers/index.js";
import { health } from "./src/providers/http.js";
import { createBriefService } from "./src/llm/brief.js";
import { createDigestService } from "./src/llm/digest.js";
import { createAskService } from "./src/llm/ask.js";
import { llmStatus } from "./src/llm/client.js";
import { createNotifier } from "./src/alerts/notify.js";
import { createAlerts } from "./src/alerts/service.js";
import { send, redirect, fail, makeHelpers, createRouter, SECURITY_HEADERS } from "./src/http/core.js";
import { authRoutes } from "./src/routes/auth.js";
import { accountRoutes } from "./src/routes/account.js";
import { marketRoutes } from "./src/routes/market.js";
import { llmRoutes } from "./src/routes/llm.js";
import { alertRoutes } from "./src/routes/alerts.js";
import { adminRoutes, SECRET_FIELDS } from "./src/routes/admin.js";

const PUBLIC = resolve(ROOT, "public");

// ---------------------------------------------------------------- services
const secrets = createSecrets({ key: config.secretKey, oldKey: config.secretKeyOld });
const db = await createDb(config.db);
const settings = createSettingsRepo(db);
const users = createUsersRepo(db);
const audit = createAuditRepo(db);
const watchlist = createWatchlistRepo(db, settings);
const prefs = createPrefsRepo(db);
const history = createHistory(db);
await history.init();
const sessions = createSessions(db, { ttlHours: config.sessionTtlHours, maxDays: config.sessionMaxDays, cookieSecure: config.cookieSecure });
const throttle = createThrottle();
const market = createMarket({ settings, envKeys: config.providerKeys, secrets, history });
const jobs = createJobs();
const notifier = createNotifier({ settings, secrets });
const alerts = createAlerts({ db, market, watchlist, users, notifier, jobs, health, settings });
const briefs = createBriefService({ db, llm: config.llm });
const digest = createDigestService({ db, llm: config.llm, market, watchlist, users, notifier, settings });
const askService = createAskService({ llm: config.llm, market, watchlist, settings });
const allowAdmin = createAllowList(config.adminAllowCidrs);
const helpers = makeHelpers(config);

let general = await settings.get("general");
const app = {
  config, db, settings, users, audit, watchlist, prefs, history, sessions, throttle, market, jobs, notifier, alerts,
  briefs, digest, askService, secrets, allowAdmin, ...helpers,
  onGeneralChanged: (g) => { general = g; },
};

// ---------------------------------------------------------------- startup tasks
const seeded = await watchlist.seed();
if (seeded.length) console.log(`Watchlist seeded with the default ${seeded.join(" and ")}.`);

if ((await users.count()) === 0) {
  const { username, password } = config.bootstrapAdmin;
  if (username && password) {
    const name = normalizeUsername(username);
    const problem = !USERNAME_RE.test(name) ? "ADMIN_USERNAME: 3–32 characters, a–z 0–9 . _ -" : passwordProblem(password, name);
    if (problem) console.error(`Not seeding the admin from env: ${problem}`);
    else {
      await users.create({ username: name, password, role: "admin" });
      await audit.log({ action: "user_created", detail: `admin "${name}" seeded from ADMIN_USERNAME` });
      console.log(`Admin "${name}" created from ADMIN_USERNAME / ADMIN_PASSWORD. You can remove those variables now.`);
    }
  } else console.log("No users yet: open the site and create the first admin on the setup page.");
}

/** Encrypts secrets stored in plain text (or with SECRET_KEY_OLD) once SECRET_KEY is set. */
async function resealSecrets() {
  if (!secrets.enabled) return 0;
  let n = 0;
  const p = await settings.get("providers");
  for (const [id, v] of Object.entries(p.keys)) if (secrets.needsReseal(v)) { p.keys[id] = secrets.seal(secrets.open(v)); n++; }
  if (n) await settings.set("providers", p);
  const nt = await settings.get("notifications");
  let m = 0;
  for (const [ch, fields] of Object.entries(SECRET_FIELDS)) {
    for (const f of fields) if (secrets.needsReseal(nt[ch][f])) { nt[ch][f] = secrets.seal(secrets.open(nt[ch][f])); m++; }
  }
  if (m) await settings.set("notifications", nt);
  for (const u of await db.all("SELECT id, totp_secret, totp_pending FROM users WHERE totp_secret IS NOT NULL OR totp_pending IS NOT NULL")) {
    for (const col of ["totp_secret", "totp_pending"]) {
      if (u[col] && secrets.needsReseal(u[col])) {
        await db.run(`UPDATE users SET ${col} = ? WHERE id = ?`, [secrets.seal(secrets.open(u[col])), u.id]);
        m++;
      }
    }
  }
  if (n + m) console.log(`Encrypted ${n + m} stored secret(s) with SECRET_KEY.`);
  return n + m;
}
try {
  await resealSecrets();
} catch (err) {
  console.error(`Secrets: ${err.message}`);
}
if (!secrets.enabled) console.log("SECRET_KEY is not set: stored API keys and passwords stay in plain text (npm run gen-secret).");

// ---------------------------------------------------------------- jobs
async function snapshotJob() {
  const items = await watchlist.list();
  const { quotes } = await market.equities(items);
  const now = new Date().toISOString();
  const rows = [];
  for (const it of items) {
    const q = quotes[it.symbol];
    if (!q || q.stale || q.price == null) continue;
    rows.push({ symbol: it.symbol, kind: it.kind, currency: q.currency, price: q.price, changePct: q.changePct, source: q.source, at: q.asOf || now });
  }
  for (const [c, q] of Object.entries(await market.bitcoinPrimary())) {
    if (!q.stale) rows.push({ symbol: `BTC-${c}`, kind: "btc", currency: c, price: q.price, changePct: q.changePct, source: q.source, at: now });
  }
  const currencies = [...new Set(items.filter((i) => i.kind === "equity").map((i) => quotes[i.symbol]?.currency || i.currency).filter(Boolean))];
  for (const base of general.cryptoCurrencies) {
    const fx = await market.fx(base, currencies);
    for (const [c, r] of Object.entries(fx.rates)) if (!r.stale) rows.push({ symbol: `${c}${base}`, kind: "fx", currency: base, price: r.rate, source: r.source, at: now });
  }
  return { stored: await history.record(rows) };
}

jobs.add({ name: "snapshot", description: "Store current prices for history", everySeconds: () => general.snapshotMinutes * 60, delaySeconds: 20, run: snapshotJob });
let fullRollupDone = false;
jobs.add({
  name: "rollup", description: "Hourly/daily price rollups and retention", everySeconds: 3600, delaySeconds: 60,
  run: async () => {
    const r = await history.rollup(fullRollupDone ? Date.now() - 2 * 86400_000 : Date.now() - general.retention.rawDays * 86400_000);
    fullRollupDone = true;
    return { ...r, pruned: await history.prune(general.retention) };
  },
});
jobs.add({ name: "alerts", description: "Evaluate alerts and send notifications", everySeconds: 60, delaySeconds: 45, run: () => alerts.run() });
jobs.add({
  name: "digest", description: "Weekly LLM digest", at: () => general.digest.schedule,
  enabled: () => config.llm.enabled && general.digest.enabled, run: () => digest.generate({ reason: "schedule" }).then((r) => ({ id: r.digest.id })),
});
jobs.add({
  name: "housekeeping", description: "Expired sessions, old audit entries and alert events", everySeconds: 3600, delaySeconds: 90,
  run: async () => {
    await sessions.purgeExpired();
    await audit.prune();
    await alerts.pruneEvents();
    return { ok: true };
  },
});
jobs.start();

// ---------------------------------------------------------------- routes
const router = createRouter();
authRoutes(router, app);
accountRoutes(router, app);
marketRoutes(router, app);
llmRoutes(router, app);
alertRoutes(router, app);
adminRoutes(router, app);

// ---------------------------------------------------------------- static files and pages
const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".webmanifest": "application/manifest+json",
};

async function serveFile(res, rel) {
  const file = resolve(PUBLIC, rel);
  if (file !== PUBLIC && !file.startsWith(PUBLIC + sep)) return send(res, 404, "Not found", "text/plain");
  try {
    const body = await readFile(file);
    const type = TYPES[extname(file)] || "application/octet-stream";
    const cache = type.startsWith("text/html") ? "no-store" : "private, max-age=300";
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": type, "Cache-Control": cache });
    res.end(body);
  } catch {
    send(res, 404, "Not found", "text/plain");
  }
}

async function servePage(req, res, path) {
  const noUsers = (await users.count()) === 0;
  if (path === "/setup") return noUsers ? serveFile(res, "setup.html") : send(res, 404, "Not found", "text/plain");
  if (noUsers) return redirect(res, "/setup");
  const auth = await sessions.lookup(readCookie(req, COOKIE));
  const full = auth && auth.session.mfaPassed;
  if (path === "/login") return full ? redirect(res, "/") : serveFile(res, "login.html");
  if (!full) return redirect(res, "/login");
  if (auth.refresh) res.setHeader("Set-Cookie", auth.refresh);
  return serveFile(res, "index.html");
}

// ---------------------------------------------------------------- server
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  try {
    if (path === "/healthz") return send(res, 200, { ok: true });
    if (path === "/readyz") {
      try {
        await db.ping();
        return send(res, 200, { ok: true, db: db.engine });
      } catch (err) {
        return send(res, 503, { ok: false, error: err.message });
      }
    }

    if (path.startsWith("/api/")) {
      const m = router.match(req.method, path);
      if (m.status === 404) fail(404, "Not found.");
      if (m.status === 405) fail(405, "Method not allowed.");
      const r = m.route;
      const ctx = { req, res, url, params: m.params, ip: helpers.clientIp(req), auth: null };
      if (r.access !== "public") {
        const auth = await sessions.lookup(readCookie(req, COOKIE));
        if (!auth) fail(401, "Sign in first.");
        if (!auth.session.mfaPassed && !r.allowMfaPending) fail(401, "Enter your two-factor code first.", { mfaRequired: true });
        if (auth.refresh) res.setHeader("Set-Cookie", auth.refresh);
        if (req.method !== "GET") {
          helpers.checkOrigin(req);
          if (req.headers["x-csrf-token"] !== auth.session.csrf) fail(403, "Missing or stale CSRF token: reload the page.");
        }
        if (auth.user.mustChangePassword && !r.allowMustChange) fail(403, "Change your password first.", { mustChangePassword: true });
        if (r.access === "admin") {
          if (auth.user.role !== "admin") fail(403, "Admins only.");
          if (allowAdmin && !allowAdmin(ctx.ip)) fail(403, "Admin pages are not available from this network address (ADMIN_ALLOW_CIDRS).");
        }
        ctx.auth = auth;
      }
      const result = await r.handler(ctx);
      if (!res.headersSent) send(res, 200, result ?? { ok: true });
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed", "text/plain");
    if (["/", "/index.html", "/login", "/setup"].includes(path)) return servePage(req, res, path === "/index.html" ? "/" : path);
    if (path.endsWith(".html")) return send(res, 404, "Not found", "text/plain");
    return serveFile(res, decodeURIComponent(path).replace(/^\/+/, ""));
  } catch (err) {
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status === 500) console.error(`${req.method} ${path}:`, err);
    const headers = err.extra?.retryAfter ? { "Retry-After": String(err.extra.retryAfter) } : {};
    if (!res.headersSent) send(res, status, { error: status === 500 ? `Server error: ${err.message}` : err.message, ...(err.extra || {}) }, undefined, headers);
  }
});

server.listen(config.port, config.host, () => {
  console.log(`Mos Eisley Exchange on http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}`);
  console.log(`Database: ${db.describe} (schema v${db.schemaVersion})`);
  const llm = llmStatus(config.llm);
  console.log(llm.enabled ? `LLM: ${llm.model} via ${llm.baseURL} (${llm.api})` : "LLM: off (LLM_ENABLED is not set)");
  if (allowAdmin) console.log(`Admin pages limited to: ${allowAdmin.ranges.join(", ")}`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    jobs.stop();
    server.close();
    server.closeAllConnections?.();
    Promise.resolve(db.close()).finally(() => process.exit(0));
  });
}
