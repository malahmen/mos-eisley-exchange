// First-run setup, sign-in (password, then TOTP when enabled), sign-out.
import { readJson, fail } from "../http/core.js";
import { verifyPassword, burnTime, passwordProblem, normalizeUsername, USERNAME_RE } from "../auth/passwords.js";
import { verifyTotp } from "../auth/totp.js";
import { COOKIE, readCookie } from "../auth/sessions.js";

export function authRoutes({ route }, app) {
  const { users, audit, sessions, throttle, secrets, checkOrigin } = app;

  route("GET", "/api/setup", "public", async () => ({ needed: (await users.count()) === 0 }));

  route("POST", "/api/setup", "public", async ({ req, res, ip }) => {
    checkOrigin(req);
    if ((await users.count()) > 0) fail(404, "Setup is already done.");
    const body = await readJson(req);
    const username = normalizeUsername(body.username);
    if (!USERNAME_RE.test(username)) fail(400, "Username: 3–32 characters, a–z, 0–9, dot, underscore or dash.");
    const problem = passwordProblem(body.password, username);
    if (problem) fail(400, problem);
    const user = await users.create({ username, password: body.password, role: "admin" });
    const first = (await users.list()).reduce((a, b) => (a.id < b.id ? a : b));
    if (first.id !== user.id) {
      await users.remove(user.id); // two setup forms at once: keep the first
      fail(409, "Setup was completed by someone else.");
    }
    await audit.log({ user, action: "setup", detail: "first admin created", ip });
    const s = await sessions.create(user.id, { ip, userAgent: req.headers["user-agent"] });
    res.setHeader("Set-Cookie", s.setCookie);
    return { ok: true };
  });

  route("POST", "/api/auth/login", "public", async ({ req, res, ip }) => {
    checkOrigin(req);
    const body = await readJson(req);
    const username = normalizeUsername(body.username).slice(0, 64);
    const password = String(body.password || "");
    const wait = throttle.check(ip, username);
    if (wait) {
      const s = Math.ceil(wait / 1000);
      fail(429, `Too many failed attempts. Try again in ${s} s.`, { retryAfter: s });
    }
    const row = username ? await users.byUsernameWithHash(username) : null;
    const ok = row ? await verifyPassword(password, row.password_hash) : (await burnTime(password), false);
    if (!ok || row.disabled) {
      throttle.failure(ip, username);
      await audit.log({ user: row ? { id: row.id, username: row.username } : { username: username || "(empty)" }, action: "login_failed", detail: row?.disabled && ok ? "account disabled" : "", ip });
      fail(401, ok && row.disabled ? "This account is disabled." : "Invalid username or password.");
    }
    const mfa = !!row.totp_enabled;
    if (!mfa) {
      throttle.success(username);
      await users.touchLogin(row.id);
      await audit.log({ user: row, action: "login", ip });
    }
    const s = await sessions.create(row.id, { ip, userAgent: req.headers["user-agent"], mfaPassed: !mfa });
    res.setHeader("Set-Cookie", s.setCookie);
    return { ok: true, mfaRequired: mfa, mustChangePassword: !!row.must_change_password };
  });

  /** Lets the sign-in page know whether a code is pending (it may be reloaded mid-way). */
  route("GET", "/api/auth/status", "public", async ({ req }) => {
    const auth = await sessions.lookup(readCookie(req, COOKIE));
    const pending = !!auth && !auth.session.mfaPassed;
    return { signedIn: !!auth?.session.mfaPassed, mfaPending: pending, username: auth?.user.username || null, csrf: pending ? auth.session.csrf : undefined };
  });

  route("POST", "/api/auth/totp", "user", async ({ req, res, ip, auth }) => {
    if (auth.session.mfaPassed) return { ok: true };
    const body = await readJson(req);
    const key = `${auth.user.username}`;
    const wait = throttle.check(ip, key);
    if (wait) fail(429, `Too many failed attempts. Try again in ${Math.ceil(wait / 1000)} s.`);
    const raw = await users.rawById(auth.user.id);
    const code = String(body.code || "").trim();
    let okHow = null;
    if (/^\d{6}$/.test(code.replace(/\s/g, ""))) {
      let secret = "";
      try { secret = secrets.open(raw.totp_secret || ""); } catch { fail(500, "The two-factor secret cannot be decrypted (SECRET_KEY changed?)."); }
      const stepOk = secret ? verifyTotp(secret, code, { lastStep: Number(raw.totp_last_step || 0) }) : null;
      if (stepOk) {
        await users.setTotpStep(raw.id, stepOk);
        okHow = "code";
      }
    } else {
      const left = await users.useRecoveryCode(raw.id, code);
      if (left >= 0) okHow = `recovery code (${left} left)`;
    }
    if (!okHow) {
      throttle.failure(ip, key);
      await audit.log({ user: auth.user, action: "login_failed", detail: "wrong two-factor code", ip });
      fail(401, "That code is not valid. Use the current 6-digit code, or a recovery code like abcd-efgh.");
    }
    throttle.success(key);
    res.setHeader("Set-Cookie", await sessions.passMfa(auth.session.hash));
    await users.touchLogin(raw.id);
    await audit.log({ user: auth.user, action: "login", detail: `two-factor: ${okHow}`, ip });
    return { ok: true, mustChangePassword: !!raw.must_change_password };
  }, { allowMfaPending: true, allowMustChange: true });

  route("POST", "/api/auth/logout", "user", async ({ res, auth, ip }) => {
    await sessions.destroy(auth.session.hash);
    await audit.log({ user: auth.user, action: "logout", ip });
    res.setHeader("Set-Cookie", sessions.clearCookie());
    return { ok: true };
  }, { allowMustChange: true, allowMfaPending: true });
}
