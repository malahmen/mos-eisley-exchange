// MySQL (DB_ENGINE=mysql), for running in a container against a server database.
// Separate MYSQL_* variables rather than a URL, as in death-star-audit.
const norm = (params) => params.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v));

function wrap(conn, extra) {
  return {
    async all(sql, params = []) {
      const [rows] = await conn.query(sql, norm(params));
      return rows;
    },
    async get(sql, params = []) {
      const [rows] = await conn.query(sql, norm(params));
      return rows[0] || null;
    },
    async run(sql, params = []) {
      const [r] = await conn.query(sql, norm(params));
      return { insertId: Number(r.insertId || 0), changes: Number(r.affectedRows || 0) };
    },
    async upsert(table, key, row) {
      const cols = Object.keys(row);
      const updates = cols.filter((c) => c !== key).map((c) => `${c} = VALUES(${c})`).join(", ");
      await conn.query(
        `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ON DUPLICATE KEY UPDATE ${updates}`,
        norm(Object.values(row)),
      );
    },
    ...extra,
  };
}

export async function createMysqlDb({ host, port, user, password, database }) {
  let mysql;
  try {
    mysql = await import("mysql2/promise");
  } catch {
    throw new Error("DB_ENGINE=mysql needs the mysql2 package. Run `npm install` first.");
  }
  for (const [key, value] of Object.entries({ MYSQL_HOST: host, MYSQL_USER: user, MYSQL_DATABASE: database, MYSQL_PASSWORD: password })) {
    if (!value) throw new Error(`DB_ENGINE=mysql: ${key} is not set.`);
  }
  const where = `MySQL ${user}@${host}:${port}/${database}`;
  const pool = mysql.createPool({ host, port, user, password, database, connectionLimit: 5, connectTimeout: 10000 });
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    await pool.end().catch(() => {});
    throw new Error(`${where}: ${err.message}`);
  }

  const api = wrap(pool, {
    engine: "mysql",
    describe: where,
    async tx(fn) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const out = await fn(wrap(conn, { engine: "mysql" }));
        await conn.commit();
        return out;
      } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
      } finally {
        conn.release();
      }
    },
    async sizeBytes() {
      const r = await api.get(
        "SELECT COALESCE(SUM(data_length + index_length), 0) AS n FROM information_schema.tables WHERE table_schema = ?", [database]);
      return Number(r?.n || 0);
    },
    async ping() {
      await pool.query("SELECT 1");
    },
    async close() {
      await pool.end();
    },
  });
  return api;
}
