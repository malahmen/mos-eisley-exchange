// Server-side sessions. The browser holds a random token in an HttpOnly cookie;
// the database holds only its SHA-256, so a leaked database cannot be replayed as cookies.
// Each session also carries a CSRF token the page must echo in X-CSRF-Token on writes,
// a public id (for "sign out this device"), and whether the second factor was passed.
import { randomBytes, createHash } from "node:crypto";

export const COOKIE = "mex_session";
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const SEEN_EVERY_MS = 5 * 60_000;

export function describeAgent(ua = "") {
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /curl\//i.test(ua) ? "curl" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS"
    : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export function createSessions(db, { ttlHours, maxDays, cookieSecure }) {
  const ttlMs = ttlHours * 3600_000;
  const maxMs = maxDays * 86400_000;

  function cookie(token, maxAgeSeconds) {
    return [`${COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAgeSeconds}`, ...(cookieSecure ? ["Secure"] : [])].join("; ");
  }

  return {
    /** mfaPassed=false creates a session that only allows the second-factor step. */
    async create(userId, { ip, userAgent, mfaPassed = true }) {
      const token = randomBytes(32).toString("base64url");
      const csrf = randomBytes(24).toString("base64url");
      const publicId = randomBytes(9).toString("base64url");
      const now = new Date();
      const expires = mfaPassed ? now.getTime() + ttlMs : now.getTime() + 10 * 60_000; // 10 min to enter the code
      await db.run(
        `INSERT INTO sessions (token_hash, user_id, csrf, created_at, expires_at, ip, user_agent, public_id, last_seen_at, mfa_passed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [sha256(token), userId, csrf, now.toISOString(), new Date(expires).toISOString(), ip, String(userAgent || "").slice(0, 255),
          publicId, now.toISOString(), mfaPassed],
      );
      return { token, csrf, setCookie: cookie(token, Math.floor((expires - now.getTime()) / 1000)) };
    },

    /** Returns { session, user, refresh } for a valid token, sliding the idle expiry forward. */
    async lookup(token) {
      if (!token || token.length > 100) return null;
      const hash = sha256(token);
      const row = await db.get(
        `SELECT s.token_hash, s.csrf, s.created_at, s.expires_at, s.user_id, s.public_id, s.last_seen_at, s.mfa_passed,
                u.id, u.username, u.role, u.disabled, u.must_change_password, u.email, u.totp_enabled
           FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
        [hash],
      );
      if (!row) return null;
      const now = Date.now();
      const absoluteEnd = Date.parse(row.created_at) + maxMs;
      if (Date.parse(row.expires_at) <= now || absoluteEnd <= now || row.disabled) {
        await db.run("DELETE FROM sessions WHERE token_hash = ?", [hash]);
        return null;
      }
      let refresh = null;
      const mfaPassed = !!row.mfa_passed;
      if (mfaPassed && Date.parse(row.expires_at) - now < ttlMs / 2) {
        const next = Math.min(now + ttlMs, absoluteEnd);
        await db.run("UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE token_hash = ?", [new Date(next).toISOString(), new Date(now).toISOString(), hash]);
        refresh = cookie(token, Math.floor((next - now) / 1000));
      } else if (!row.last_seen_at || now - Date.parse(row.last_seen_at) > SEEN_EVERY_MS) {
        await db.run("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?", [new Date(now).toISOString(), hash]);
      }
      return {
        session: { hash, csrf: row.csrf, publicId: row.public_id, mfaPassed },
        user: {
          id: row.id, username: row.username, role: row.role, mustChangePassword: !!row.must_change_password,
          email: row.email || "", totpEnabled: !!row.totp_enabled,
        },
        refresh,
      };
    },

    /** After a valid second factor: full session lifetime, and a fresh token (no fixation across the step). */
    async passMfa(hash) {
      const token = randomBytes(32).toString("base64url");
      const now = Date.now();
      await db.run("UPDATE sessions SET token_hash = ?, mfa_passed = 1, expires_at = ?, last_seen_at = ? WHERE token_hash = ?",
        [sha256(token), new Date(now + ttlMs).toISOString(), new Date(now).toISOString(), hash]);
      return cookie(token, Math.floor(ttlMs / 1000));
    },

    async listForUser(userId) {
      const rows = await db.all(
        "SELECT token_hash, public_id, created_at, last_seen_at, expires_at, ip, user_agent, mfa_passed FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC",
        [userId]);
      return rows.filter((r) => Date.parse(r.expires_at) > Date.now()).map((r) => ({
        id: r.public_id, hash: r.token_hash, device: describeAgent(r.user_agent || ""), userAgent: r.user_agent, ip: r.ip,
        createdAt: r.created_at, lastSeenAt: r.last_seen_at, mfaPending: !r.mfa_passed,
      }));
    },
    async destroyByPublicId(userId, publicId) {
      const r = await db.run("DELETE FROM sessions WHERE user_id = ? AND public_id = ?", [userId, publicId]);
      return r.changes > 0;
    },
    async destroy(hash) {
      await db.run("DELETE FROM sessions WHERE token_hash = ?", [hash]);
    },
    async destroyForUser(userId, exceptHash = "") {
      await db.run("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?", [userId, exceptHash]);
    },
    async purgeExpired() {
      await db.run("DELETE FROM sessions WHERE expires_at <= ?", [new Date().toISOString()]);
    },
    clearCookie: () => cookie("", 0),
  };
}

export function readCookie(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}
