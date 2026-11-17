export function createAuditRepo(db) {
  return {
    async log({ user, action, detail = "", ip = "" }) {
      await db.run("INSERT INTO audit_log (user_id, username, action, detail, ip, at) VALUES (?, ?, ?, ?, ?, ?)", [
        user?.id ?? null,
        user?.username ?? null,
        action,
        typeof detail === "string" ? detail.slice(0, 1000) : JSON.stringify(detail).slice(0, 1000),
        ip,
        new Date().toISOString(),
      ]);
    },
    async list({ action = "", limit = 200 } = {}) {
      const n = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 200)));
      const rows = action
        ? await db.all(`SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT ${n}`, [action])
        : await db.all(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ${n}`);
      return rows.map((r) => ({ id: r.id, username: r.username, action: r.action, detail: r.detail, ip: r.ip, at: r.at }));
    },
    async actions() {
      return (await db.all("SELECT DISTINCT action FROM audit_log ORDER BY action")).map((r) => r.action);
    },
    async prune(keepDays = 180) {
      await db.run("DELETE FROM audit_log WHERE at < ?", [new Date(Date.now() - keepDays * 86400_000).toISOString()]);
    },
  };
}
