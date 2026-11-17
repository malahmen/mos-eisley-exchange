// The signed-in user's own things: profile, password, email, preferences, sessions, two-factor.
import qrcode from "qrcode-generator";
import { readJson, fail } from "../http/core.js";
import { verifyPassword, passwordProblem } from "../auth/passwords.js";
import { generateSecret, otpauthUri, verifyTotp, generateRecoveryCodes } from "../auth/totp.js";
import { EMAIL_RE } from "../repos/users.js";
import { MARKETS, SCHEDULES } from "../providers/markets.js";
import { llmStatus } from "../llm/client.js";

export function accountRoutes({ route }, app) {
  const { users, audit, sessions, throttle, settings, prefs, watchlist, secrets, config } = app;

  async function prefsCtx() {
    const [items, general] = await Promise.all([watchlist.list(), settings.get("general")]);
    return { symbols: items.map((i) => i.symbol).concat("BTC"), currencies: general.cryptoCurrencies };
  }

  async function checkPassword(auth, password, ip) {
    if (!(await verifyPassword(String(password || ""), await users.hashOf(auth.user.id)))) {
      throttle.failure(ip, auth.user.username);
      fail(400, "The current password is wrong.");
    }
  }

  route("GET", "/api/me", "user", async ({ auth, ip }) => {
    const general = await settings.get("general");
    const llm = llmStatus(config.llm);
    return {
      user: auth.user,
      csrf: auth.session.csrf,
      general: { refreshSeconds: general.refreshSeconds, cryptoCurrencies: general.cryptoCurrencies, defaultCurrency: general.defaultCurrency, displayCurrency: general.displayCurrency },
      markets: MARKETS,
      schedules: Object.fromEntries(Object.entries(SCHEDULES).map(([k, v]) => [k, { zone: v.zone, exchange: v.exchange }])),
      llm: { enabled: llm.enabled, model: llm.enabled ? llm.model : null },
      prefs: await prefs.get(auth.user.id, await prefsCtx()),
      features: {
        alerts: auth.user.role === "admin" || general.viewerAlerts,
        adminAllowed: auth.user.role === "admin" && (!app.allowAdmin || app.allowAdmin(ip)),
      },
    };
  }, { allowMustChange: true });

  route("POST", "/api/account/password", "user", async ({ req, auth, ip }) => {
    const body = await readJson(req);
    await checkPassword(auth, body.current, ip);
    if (body.current === body.next) fail(400, "Choose a password different from the current one.");
    const problem = passwordProblem(body.next, auth.user.username);
    if (problem) fail(400, problem);
    await users.setPassword(auth.user.id, body.next, false);
    await sessions.destroyForUser(auth.user.id, auth.session.hash);
    await audit.log({ user: auth.user, action: "password_changed", ip });
    return { ok: true };
  }, { allowMustChange: true });

  route("PUT", "/api/account/email", "user", async ({ req, auth, ip }) => {
    const { email = "" } = await readJson(req);
    const e = String(email).trim();
    if (e && !EMAIL_RE.test(e)) fail(400, "That is not an email address.");
    await users.update(auth.user.id, { email: e });
    await audit.log({ user: auth.user, action: "email_changed", detail: e ? "set" : "removed", ip });
    return { email: e };
  });

  route("GET", "/api/account/prefs", "user", async ({ auth }) => ({ prefs: await prefs.get(auth.user.id, await prefsCtx()) }));
  route("PUT", "/api/account/prefs", "user", async ({ req, auth }) => {
    const body = await readJson(req, 16 * 1024);
    const cur = await prefs.get(auth.user.id, await prefsCtx());
    return { prefs: await prefs.set(auth.user.id, { ...cur, ...(body.prefs || {}) }, await prefsCtx()) };
  });

  // ---- sessions
  route("GET", "/api/account/sessions", "user", async ({ auth }) => ({
    sessions: (await sessions.listForUser(auth.user.id)).map(({ hash, ...s }) => ({ ...s, current: hash === auth.session.hash })),
  }));
  route("DELETE", "/api/account/sessions/:id", "user", async ({ params, auth, ip }) => {
    if (params.id === auth.session.publicId) fail(400, "Use Sign out for this session.");
    if (!(await sessions.destroyByPublicId(auth.user.id, params.id))) fail(404, "No such session.");
    await audit.log({ user: auth.user, action: "session_revoked", detail: params.id, ip });
    return { ok: true };
  });
  route("DELETE", "/api/account/sessions", "user", async ({ auth, ip }) => {
    await sessions.destroyForUser(auth.user.id, auth.session.hash);
    await audit.log({ user: auth.user, action: "session_revoked", detail: "all other sessions", ip });
    return { ok: true };
  });

  // ---- two-factor (opt-in)
  route("GET", "/api/account/2fa", "user", async ({ auth }) => ({
    enabled: auth.user.totpEnabled, recoveryLeft: auth.user.totpEnabled ? await users.recoveryLeft(auth.user.id) : 0, secretsEncrypted: secrets.enabled,
  }));

  route("POST", "/api/account/2fa/setup", "user", async ({ req, auth, ip }) => {
    const body = await readJson(req);
    await checkPassword(auth, body.password, ip);
    if (auth.user.totpEnabled) fail(400, "Two-factor sign-in is already on. Turn it off first to re-enrol.");
    const secret = generateSecret();
    await users.setTotpPending(auth.user.id, secrets.seal(secret));
    const uri = otpauthUri({ issuer: "Mos Eisley Exchange", account: auth.user.username, secret });
    const qr = qrcode(0, "M");
    qr.addData(uri);
    qr.make();
    return { secret: secret.replace(/(.{4})/g, "$1 ").trim(), uri, qrSvg: qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }) };
  });

  route("POST", "/api/account/2fa/enable", "user", async ({ req, auth, ip }) => {
    const { code } = await readJson(req);
    const raw = await users.rawById(auth.user.id);
    if (!raw.totp_pending) fail(400, "Start the setup first.");
    const secret = secrets.open(raw.totp_pending);
    const stepOk = verifyTotp(secret, code);
    if (!stepOk) fail(400, "That code does not match. Check the time on your phone and try the current code.");
    const codes = generateRecoveryCodes();
    await users.enableTotp(auth.user.id, secrets.seal(secret), stepOk, codes);
    await audit.log({ user: auth.user, action: "2fa_enabled", ip });
    return { ok: true, recoveryCodes: codes };
  });

  route("POST", "/api/account/2fa/disable", "user", async ({ req, auth, ip }) => {
    const body = await readJson(req);
    await checkPassword(auth, body.password, ip);
    const raw = await users.rawById(auth.user.id);
    if (!raw.totp_enabled) return { ok: true };
    const okCode = verifyTotp(secrets.open(raw.totp_secret), body.code, { lastStep: Number(raw.totp_last_step || 0) })
      || (await users.useRecoveryCode(raw.id, body.code)) >= 0;
    if (!okCode) fail(400, "That code is not valid.");
    await users.disableTotp(auth.user.id);
    await audit.log({ user: auth.user, action: "2fa_disabled", ip });
    return { ok: true };
  });

  route("POST", "/api/account/2fa/recovery", "user", async ({ req, auth, ip }) => {
    const body = await readJson(req);
    await checkPassword(auth, body.password, ip);
    const raw = await users.rawById(auth.user.id);
    if (!raw.totp_enabled) fail(400, "Two-factor sign-in is off.");
    const codes = generateRecoveryCodes();
    await users.enableTotp(raw.id, raw.totp_secret, Number(raw.totp_last_step || 0), codes);
    await audit.log({ user: auth.user, action: "2fa_recovery_regenerated", ip });
    return { recoveryCodes: codes };
  });
}
