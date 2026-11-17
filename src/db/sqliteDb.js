// SQLite (DB_ENGINE=sqlite), Node's built-in driver. One file, no server: the default for a LAN box.
import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

const norm = (params) => params.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v));
const plain = (row) => (row ? { ...row } : null);

export async function createSqliteDb(path) {
  let DatabaseSync;
  try {
    // Silence the "SQLite is experimental" warning once; everything else still prints.
    const emit = process.emitWarning;
    process.emitWarning = (w, ...a) => (String(w).includes("SQLite") ? undefined : emit.call(process, w, ...a));
    ({ DatabaseSync } = await import("node:sqlite"));
    process.emitWarning = emit;
  } catch {
    throw new Error("DB_ENGINE=sqlite needs Node 22.13 or newer (node:sqlite).");
  }
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

  const api = {
    engine: "sqlite",
    describe: `SQLite ${path}`,
    async all(sql, params = []) {
      return db.prepare(sql).all(...norm(params)).map(plain);
    },
    async get(sql, params = []) {
      return plain(db.prepare(sql).get(...norm(params)));
    },
    async run(sql, params = []) {
      const r = db.prepare(sql).run(...norm(params));
      return { insertId: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
    async upsert(table, key, row) {
      const cols = Object.keys(row);
      const updates = cols.filter((c) => c !== key).map((c) => `${c} = excluded.${c}`).join(", ");
      const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})
                   ON CONFLICT(${key}) DO UPDATE SET ${updates}`;
      db.prepare(sql).run(...norm(Object.values(row)));
    },
    /**
     * Runs fn inside a transaction. The connection is shared, so keep fn short and free of
     * slow awaits (network calls): other requests' statements would land inside it.
     */
    async tx(fn) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const out = await fn(api);
        db.exec("COMMIT");
        return out;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    async sizeBytes() {
      let total = 0;
      for (const f of [path, `${path}-wal`]) {
        try { total += statSync(f).size; } catch { /* no wal file */ }
      }
      return total;
    },
    async ping() {
      db.prepare("SELECT 1").get();
    },
    async close() {
      db.close();
    },
  };
  return api;
}
