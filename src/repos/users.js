import { hashPassword, verifyPassword } from "../auth/passwords.js";

const now = () => new Date().toISOString();
const shape = (r) =>
  r && {
    id: r.id,
    username: r.username,
    role: r.role,
    email: r.email || "",
    disabled: !!r.disabled,
    mustChangePassword: !!r.must_change_password,
    totpEnabled: !!r.totp_enabled,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
  };

export const EMAIL_RE = /^[^\s@<>()",;]{1,64}@[^\s@<>()",;]{1,190}\.[A-Za-z]{2,}$/;

export function createUsersRepo(db) {
  return {
    async count() {
      return Number((await db.get("SELECT COUNT(*) AS n FROM users")).n);
    },
    async list() {
      return (await db.all("SELECT * FROM users ORDER BY username")).map(shape);
    },
    async byId(id) {
      return shape(await db.get("SELECT * FROM users WHERE id = ?", [id]));
    },
    /** Full row including secrets: only for auth checks. */
    async rawById(id) {
      return db.get("SELECT * FROM users WHERE id = ?", [id]);
    },
    async byUsernameWithHash(username) {
      return db.get("SELECT * FROM users WHERE username = ?", [username]);
    },
    async hashOf(id) {
      return (await db.get("SELECT password_hash FROM users WHERE id = ?", [id]))?.password_hash;
    },
    async create({ username, password, role, mustChangePassword = false, email = "" }) {
      const r = await db.run(
        "INSERT INTO users (username, password_hash, role, disabled, must_change_password, created_at, email) VALUES (?, ?, ?, 0, ?, ?, ?)",
        [username, await hashPassword(password), role, mustChangePassword, now(), email || null],
      );
      return this.byId(r.insertId);
    },
    async setPassword(id, password, mustChange) {
      await db.run("UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?", [await hashPassword(password), mustChange, id]);
    },
    async update(id, { role, disabled, email }) {
      if (role !== undefined) await db.run("UPDATE users SET role = ? WHERE id = ?", [role, id]);
      if (disabled !== undefined) await db.run("UPDATE users SET disabled = ? WHERE id = ?", [disabled, id]);
      if (email !== undefined) await db.run("UPDATE users SET email = ? WHERE id = ?", [email || null, id]);
      return this.byId(id);
    },
    async remove(id) {
      await db.run("DELETE FROM sessions WHERE user_id = ?", [id]);
      await db.run("DELETE FROM recovery_codes WHERE user_id = ?", [id]);
      await db.run("DELETE FROM user_prefs WHERE user_id = ?", [id]);
      await db.run("DELETE FROM alert_reads WHERE user_id = ?", [id]);
      await db.run("DELETE FROM alerts WHERE owner_id = ?", [id]);
      await db.run("DELETE FROM users WHERE id = ?", [id]);
    },
    async touchLogin(id) {
      await db.run("UPDATE users SET last_login_at = ? WHERE id = ?", [now(), id]);
    },
    async activeAdminCount() {
      return Number((await db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0")).n);
    },
    async adminEmails() {
      return (await db.all("SELECT email FROM users WHERE role = 'admin' AND disabled = 0 AND email IS NOT NULL AND email <> ''")).map((r) => r.email);
    },

    // ---- two-factor
    async setTotpPending(id, sealedSecret) {
      await db.run("UPDATE users SET totp_pending = ? WHERE id = ?", [sealedSecret, id]);
    },
    async enableTotp(id, sealedSecret, step, recoveryCodes) {
      await db.run("UPDATE users SET totp_secret = ?, totp_pending = NULL, totp_enabled = 1, totp_last_step = ? WHERE id = ?", [sealedSecret, step, id]);
      await db.run("DELETE FROM recovery_codes WHERE user_id = ?", [id]);
      for (const code of recoveryCodes) {
        await db.run("INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)", [id, await hashPassword(code)]);
      }
    },
    async disableTotp(id) {
      await db.run("UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_enabled = 0, totp_last_step = 0 WHERE id = ?", [id]);
      await db.run("DELETE FROM recovery_codes WHERE user_id = ?", [id]);
    },
    async setTotpStep(id, step) {
      await db.run("UPDATE users SET totp_last_step = ? WHERE id = ?", [step, id]);
    },
    /** Consumes a recovery code. Returns the number left, or -1 when the code is not valid. */
    async useRecoveryCode(id, code) {
      const rows = await db.all("SELECT id, code_hash FROM recovery_codes WHERE user_id = ? AND used_at IS NULL", [id]);
      const c = String(code || "").trim().toLowerCase();
      if (!/^[a-z0-9]{4}-[a-z0-9]{4}$/.test(c)) return -1;
      for (const r of rows) {
        if (await verifyPassword(c, r.code_hash)) {
          await db.run("UPDATE recovery_codes SET used_at = ? WHERE id = ?", [now(), r.id]);
          return rows.length - 1;
        }
      }
      return -1;
    },
    async recoveryLeft(id) {
      return Number((await db.get("SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL", [id])).n);
    },
  };
}
