// Admin: users, providers, watchlist, settings, notifications, health/jobs, audit log.
import { readJson, fail } from "../http/core.js";
import { passwordProblem, normalizeUsername, USERNAME_RE } from "../auth/passwords.js";
import { EMAIL_RE } from "../repos/users.js";
import { SYMBOL_RE } from "../repos/watchlist.js";
import { providerById, KINDS } from "../providers/registry.js";
import { MARKETS } from "../providers/markets.js";
import { llmStatus } from "../llm/client.js";

const SECRET_FIELDS = { email: ["pass"], ntfy: ["token"], telegram: ["botToken"], webhook: ["secret"] };

export function adminRoutes({ route }, app) {
  const { users, audit, sessions, settings, watchlist, market, secrets, notifier, jobs, history, db, config } = app;

  // ---------------------------------------------------------------- users
  route("GET", "/api/admin/users", "admin", async () => ({ users: await users.list() }));

  route("POST", "/api/admin/users", "admin", async ({ req, auth, ip }) => {
    const body = await readJson(req);
    const username = normalizeUsername(body.username);
    if (!USERNAME_RE.test(username)) fail(400, "Username: 3–32 characters, a–z, 0–9, dot, underscore or dash.");
    const role = body.role === "admin" ? "admin" : "viewer";
    const problem = passwordProblem(body.password, username);
    if (problem) fail(400, problem);
    const email = String(body.email || "").trim();
    if (email && !EMAIL_RE.test(email)) fail(400, "That is not an email address.");
    if (await users.byUsernameWithHash(username)) fail(409, `"${username}" already exists.`);
    const user = await users.create({ username, password: body.password, role, mustChangePassword: body.mustChangePassword !== false, email });
    await audit.log({ user: auth.user, action: "user_created", detail: `${username} (${role})`, ip });
    return { user };
  });

  route("PATCH", "/api/admin/users/:id", "admin", async ({ req, params, auth, ip }) => {
    const id = Number(params.id);
    const target = await users.byId(id);
    if (!target) fail(404, "No such user.");
    const body = await readJson(req);
    const changes = [];
    const self = id === auth.user.id;
    const losesAdmin = target.role === "admin" && !target.disabled &&
      ((body.role !== undefined && body.role !== "admin") || body.disabled === true);
    if (losesAdmin && (await users.activeAdminCount()) <= 1) fail(400, "This is the last active admin: keep at least one.");
    if (self && (body.disabled === true || (body.role !== undefined && body.role !== target.role))) fail(400, "You cannot disable yourself or change your own role.");
    if (body.role !== undefined) {
      if (!["admin", "viewer"].includes(body.role)) fail(400, "Role must be admin or viewer.");
      if (body.role !== target.role) changes.push(`role → ${body.role}`);
    }
    if (body.disabled !== undefined && !!body.disabled !== target.disabled) changes.push(body.disabled ? "disabled" : "enabled");
    let email;
    if (body.email !== undefined) {
      email = String(body.email || "").trim();
      if (email && !EMAIL_RE.test(email)) fail(400, "That is not an email address.");
      if (email !== target.email) changes.push(email ? "email set" : "email removed");
    }
    await users.update(id, { role: body.role, disabled: body.disabled === undefined ? undefined : !!body.disabled, email });
    if (body.password !== undefined) {
      const problem = passwordProblem(body.password, target.username);
      if (problem) fail(400, problem);
      await users.setPassword(id, body.password, !self);
      changes.push("password reset");
    }
    if (body.disabled === true || body.password !== undefined || (body.role && body.role !== target.role)) {
      await sessions.destroyForUser(id, self ? auth.session.hash : "");
    }
    if (changes.length) await audit.log({ user: auth.user, action: "user_updated", detail: `${target.username}: ${changes.join(", ")}`, ip });
    return { user: await users.byId(id) };
  });

  route("DELETE", "/api/admin/users/:id", "admin", async ({ params, auth, ip }) => {
    const id = Number(params.id);
    const target = await users.byId(id);
    if (!target) fail(404, "No such user.");
    if (id === auth.user.id) fail(400, "You cannot delete your own account.");
    if (target.role === "admin" && !target.disabled && (await users.activeAdminCount()) <= 1) fail(400, "This is the last active admin.");
    await users.remove(id);
    await audit.log({ user: auth.user, action: "user_deleted", detail: target.username, ip });
    return { ok: true };
  });

  route("POST", "/api/admin/users/:id/2fa/reset", "admin", async ({ params, auth, ip }) => {
    const target = await users.byId(Number(params.id));
    if (!target) fail(404, "No such user.");
    await users.disableTotp(target.id);
    await audit.log({ user: auth.user, action: "2fa_reset", detail: target.username, ip });
    return { user: await users.byId(target.id) };
  });

  route("GET", "/api/admin/users/:id/sessions", "admin", async ({ params }) => ({
    sessions: (await sessions.listForUser(Number(params.id))).map(({ hash, ...s }) => s),
  }));
  route("DELETE", "/api/admin/users/:id/sessions", "admin", async ({ params, auth, ip }) => {
    const id = Number(params.id);
    const target = await users.byId(id);
    if (!target) fail(404, "No such user.");
    await sessions.destroyForUser(id, id === auth.user.id ? auth.session.hash : "");
    await audit.log({ user: auth.user, action: "session_revoked", detail: `all sessions of ${target.username}`, ip });
    return { ok: true };
  });

  // ---------------------------------------------------------------- providers
  route("GET", "/api/admin/providers", "admin", async () => market.describeProviders());

  route("PUT", "/api/admin/providers", "admin", async ({ req, auth, ip }) => {
    const body = await readJson(req);
    const cur = await settings.get("providers");
    const next = { ...cur };
    if (body.cacheTtlSeconds !== undefined) next.cacheTtlSeconds = body.cacheTtlSeconds;
    for (const kind of KINDS) {
      if (Array.isArray(body[kind])) next[kind] = body[kind].map((e) => ({ id: String(e.id), enabled: !!e.enabled }));
    }
    const keyChanges = [];
    if (body.keys && typeof body.keys === "object") {
      for (const [id, value] of Object.entries(body.keys)) {
        if (!providerById(id)) continue;
        if (value === null || value === "") {
          if (next.keys[id]) keyChanges.push(`${id} key removed`);
          delete next.keys[id];
        } else if (typeof value === "string") {
          const v = value.trim();
          if (!/^[\w.\-]{4,200}$/.test(v)) fail(400, `The ${id} key has unexpected characters.`);
          next.keys[id] = secrets.seal(v);
          keyChanges.push(`${id} key set`);
        }
      }
    }
    await settings.set("providers", next);
    market.clearCache();
    await audit.log({
      user: auth.user, action: "providers_changed", ip,
      detail: [...KINDS.map((k) => `${k}: ${next[k].filter((e) => e.enabled).map((e) => e.id).join(" > ") || "none"}`), `ttl ${next.cacheTtlSeconds}s`, ...keyChanges].join("; "),
    });
    return market.describeProviders();
  });

  route("POST", "/api/admin/providers/:id/test", "admin", async ({ req, params }) => {
    const body = await readJson(req);
    try {
      return await market.test(params.id, typeof body.key === "string" ? body.key.trim() : "");
    } catch (err) {
      if (err.status) throw err;
      return { ok: false, error: err.message };
    }
  });

  // ---------------------------------------------------------------- watchlist
  route("GET", "/api/admin/watchlist", "admin", async () => ({ items: await watchlist.list(), markets: MARKETS }));

  route("POST", "/api/admin/watchlist", "admin", async ({ req, auth, ip }) => {
    const body = await readJson(req);
    const symbol = String(body.symbol || "").trim().toUpperCase();
    if (!SYMBOL_RE.test(symbol)) fail(400, "Invalid symbol. Use Yahoo notation, e.g. AAPL, EDP.LS, 600519.SS, 0700.HK, ^GSPC.");
    const kind = body.kind === "index" || body.type === "INDEX" || body.type === "Index" ? "index" : body.kind === "equity" ? "equity" : undefined;
    const item = await watchlist.add({ symbol, name: body.name, exchange: body.exchange, currency: body.currency, sector: body.sector, kind });
    await audit.log({ user: auth.user, action: "watchlist_added", detail: `${symbol} (${item.kind})`, ip });
    return { item };
  });

  route("DELETE", "/api/admin/watchlist/:id", "admin", async ({ params, auth, ip }) => {
    const item = (await watchlist.list()).find((i) => i.id === Number(params.id));
    if (!item || !(await watchlist.remove(item.id))) fail(404, "Not on the watchlist.");
    await audit.log({ user: auth.user, action: "watchlist_removed", detail: item.symbol, ip });
    return { ok: true };
  });

  route("PUT", "/api/admin/watchlist/order", "admin", async ({ req }) => {
    const body = await readJson(req);
    const known = new Set((await watchlist.list()).map((i) => i.id));
    await watchlist.reorder((Array.isArray(body.ids) ? body.ids : []).map(Number).filter((id) => known.has(id)));
    return { items: await watchlist.list() };
  });

  route("GET", "/api/admin/symbol-search", "admin", async ({ url }) => {
    const q = String(url.searchParams.get("q") || "").trim().slice(0, 40);
    if (!q) return { results: [] };
    try {
      return { results: await market.searchSymbols(q) };
    } catch (err) {
      return { results: [], error: `Symbol search is unavailable (${err.message}). You can still add a symbol by typing it.` };
    }
  });

  // ---------------------------------------------------------------- settings and system
  async function plaintextSecrets() {
    if (!secrets.enabled) return null;
    let n = 0;
    const p = await settings.get("providers");
    n += Object.values(p.keys).filter((v) => secrets.needsReseal(v)).length;
    const nt = await settings.get("notifications");
    for (const [ch, fields] of Object.entries(SECRET_FIELDS)) for (const f of fields) if (secrets.needsReseal(nt[ch][f])) n++;
    return n;
  }

  route("GET", "/api/admin/settings", "admin", async () => ({
    general: await settings.get("general"),
    system: {
      db: { engine: db.engine, describe: db.describe, schemaVersion: db.schemaVersion },
      history: await history.counts(),
      llm: llmStatus(config.llm),
      session: { ttlHours: config.sessionTtlHours, maxDays: config.sessionMaxDays, cookieSecure: config.cookieSecure, trustProxy: config.trustProxy },
      secrets: { encrypted: secrets.enabled, plaintextLeft: await plaintextSecrets() },
      adminAllowList: app.allowAdmin ? app.allowAdmin.ranges : null,
      node: process.version,
    },
  }));

  route("PUT", "/api/admin/settings", "admin", async ({ req, auth, ip }) => {
    const body = await readJson(req, 128 * 1024);
    const before = await settings.get("general");
    const general = await settings.set("general", { ...before, ...(body.general || {}) });
    app.onGeneralChanged?.(general);
    market.clearCache();
    const changed = Object.keys(general).filter((k) => JSON.stringify(general[k]) !== JSON.stringify(before[k]));
    await audit.log({ user: auth.user, action: "settings_changed", detail: changed.length ? changed.map((k) => `${k}: ${JSON.stringify(general[k]).slice(0, 120)}`).join("; ") : "no change", ip });
    return { general };
  });

  // ---------------------------------------------------------------- notifications
  function maskNotifications(n) {
    const out = structuredClone(n);
    for (const [ch, fields] of Object.entries(SECRET_FIELDS)) for (const f of fields) out[ch][f] = n[ch][f] ? "••••••" : "";
    return out;
  }

  route("GET", "/api/admin/notifications", "admin", async ({ auth }) => ({
    notifications: maskNotifications(await settings.get("notifications")),
    myEmail: auth.user.email,
  }));

  route("PUT", "/api/admin/notifications", "admin", async ({ req, auth, ip }) => {
    const body = await readJson(req);
    const cur = await settings.get("notifications");
    const next = structuredClone(cur);
    for (const ch of Object.keys(SECRET_FIELDS)) {
      const incoming = body.notifications?.[ch];
      if (!incoming || typeof incoming !== "object") continue;
      for (const [k, v] of Object.entries(incoming)) {
        if (!(k in next[ch])) continue;
        if (SECRET_FIELDS[ch].includes(k)) {
          if (v === null) next[ch][k] = "";                                   // explicit clear
          else if (typeof v === "string" && v && v !== "••••••") next[ch][k] = secrets.seal(v.trim()); // new value
        } else next[ch][k] = v;
      }
    }
    if (next.ntfy.url && !/^https?:\/\//.test(next.ntfy.url)) fail(400, "The ntfy URL must start with http:// or https://");
    if (next.webhook.url && !/^https?:\/\//.test(next.webhook.url)) fail(400, "The webhook URL must start with http:// or https://");
    const saved = await settings.set("notifications", next);
    await audit.log({
      user: auth.user, action: "channel_changed", ip,
      detail: Object.keys(SECRET_FIELDS).map((ch) => `${ch}: ${saved[ch].enabled ? "on" : "off"}`).join(", "),
    });
    return { notifications: maskNotifications(saved) };
  });

  route("POST", "/api/admin/notifications/test", "admin", async ({ req, auth }) => {
    const { channel, to } = await readJson(req);
    try {
      return { ok: true, result: await notifier.test(channel, to || auth.user.email) };
    } catch (err) {
      if (err.status) throw err;
      return { ok: false, error: err.message };
    }
  });

  // ---------------------------------------------------------------- health and jobs
  route("GET", "/api/admin/health", "admin", async () => {
    const providers = await market.describeProviders();
    return {
      providers: KINDS.flatMap((k) => providers[k]),
      jobs: jobs.status(),
      history: await history.counts(),
      uptimeSeconds: Math.round(process.uptime()),
    };
  });

  route("POST", "/api/admin/jobs/:name/run", "admin", async ({ params, auth, ip }) => {
    const r = await jobs.run(params.name, `manual by ${auth.user.username}`);
    if (r.skipped) fail(409, "That job is already running.");
    await audit.log({ user: auth.user, action: "job_run", detail: `${params.name}: ${r.ok ? "ok" : r.error}`, ip });
    return r;
  });

  // ---------------------------------------------------------------- audit
  route("GET", "/api/admin/audit", "admin", async ({ url }) => ({
    entries: await audit.list({ action: url.searchParams.get("action") || "", limit: url.searchParams.get("limit") || 200 }),
    actions: await audit.actions(),
  }));
}

export { SECRET_FIELDS };
