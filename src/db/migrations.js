// Schema migrations, applied in order at startup and recorded in schema_migrations.
// Each has a SQLite and a MySQL variant. Never edit a released migration: add a new one.
// Timestamps are ISO-8601 strings in both engines, so they compare and sort the same way.
const MY = "CHARACTER SET utf8mb4 COLLATE utf8mb4_bin";

export const MIGRATIONS = [
  {
    version: 1,
    name: "initial schema",
    sqlite: [
      `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'viewer')), disabled INTEGER NOT NULL DEFAULT 0,
        must_change_password INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_login_at TEXT)`,
      `CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, ip TEXT, user_agent TEXT)`,
      `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
      `CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS watchlist_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL UNIQUE, display_name TEXT, market TEXT NOT NULL,
        exchange TEXT, currency TEXT, sector TEXT, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, username TEXT, action TEXT NOT NULL,
        detail TEXT, ip TEXT, at TEXT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS audit_at ON audit_log(at)`,
      `CREATE TABLE IF NOT EXISTS llm_briefs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, prompt_hash TEXT NOT NULL, model TEXT, body TEXT NOT NULL, created_at TEXT NOT NULL)`,
    ],
    mysql: [
      `CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY, username VARCHAR(64) NOT NULL UNIQUE, password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(16) NOT NULL, disabled TINYINT NOT NULL DEFAULT 0, must_change_password TINYINT NOT NULL DEFAULT 0,
        created_at VARCHAR(32) NOT NULL, last_login_at VARCHAR(32)) ${MY}`,
      `CREATE TABLE IF NOT EXISTS sessions (
        token_hash CHAR(64) PRIMARY KEY, user_id INT NOT NULL, csrf VARCHAR(64) NOT NULL, created_at VARCHAR(32) NOT NULL,
        expires_at VARCHAR(32) NOT NULL, ip VARCHAR(64), user_agent VARCHAR(255), INDEX sessions_user (user_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE) ${MY}`,
      `CREATE TABLE IF NOT EXISTS settings (name VARCHAR(64) PRIMARY KEY, value LONGTEXT NOT NULL, updated_at VARCHAR(32) NOT NULL) ${MY}`,
      `CREATE TABLE IF NOT EXISTS watchlist_items (
        id INT AUTO_INCREMENT PRIMARY KEY, symbol VARCHAR(32) NOT NULL UNIQUE, display_name VARCHAR(200), market VARCHAR(16) NOT NULL,
        exchange VARCHAR(64), currency VARCHAR(8), sector VARCHAR(100), sort_order INT NOT NULL DEFAULT 0, created_at VARCHAR(32) NOT NULL) ${MY}`,
      `CREATE TABLE IF NOT EXISTS audit_log (
        id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, username VARCHAR(64), action VARCHAR(64) NOT NULL, detail TEXT,
        ip VARCHAR(64), at VARCHAR(32) NOT NULL, INDEX audit_at (at)) ${MY}`,
      `CREATE TABLE IF NOT EXISTS llm_briefs (
        id INT AUTO_INCREMENT PRIMARY KEY, prompt_hash CHAR(64) NOT NULL, model VARCHAR(200), body LONGTEXT NOT NULL,
        created_at VARCHAR(32) NOT NULL) ${MY}`,
    ],
  },
  {
    version: 2,
    name: "indices, user preferences, stored price history",
    sqlite: [
      `ALTER TABLE watchlist_items ADD COLUMN kind TEXT NOT NULL DEFAULT 'equity'`,
      `CREATE TABLE user_prefs (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, value TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      `CREATE TABLE quote_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, kind TEXT NOT NULL, currency TEXT,
        price REAL NOT NULL, change_pct REAL, source TEXT, at TEXT NOT NULL)`,
      `CREATE INDEX quote_snapshots_sym_at ON quote_snapshots(symbol, at)`,
      `CREATE TABLE quote_rollups (
        k TEXT PRIMARY KEY, symbol TEXT NOT NULL, bucket TEXT NOT NULL, at TEXT NOT NULL,
        open REAL, high REAL, low REAL, close REAL, n INTEGER)`,
      `CREATE INDEX quote_rollups_sym ON quote_rollups(symbol, bucket, at)`,
    ],
    mysql: [
      `ALTER TABLE watchlist_items ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'equity'`,
      `CREATE TABLE user_prefs (user_id INT PRIMARY KEY, value LONGTEXT NOT NULL, updated_at VARCHAR(32) NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE) ${MY}`,
      `CREATE TABLE quote_snapshots (
        id BIGINT AUTO_INCREMENT PRIMARY KEY, symbol VARCHAR(32) NOT NULL, kind VARCHAR(16) NOT NULL, currency VARCHAR(8),
        price DOUBLE NOT NULL, change_pct DOUBLE, source VARCHAR(64), at VARCHAR(32) NOT NULL,
        INDEX quote_snapshots_sym_at (symbol, at)) ${MY}`,
      `CREATE TABLE quote_rollups (
        k VARCHAR(80) PRIMARY KEY, symbol VARCHAR(32) NOT NULL, bucket VARCHAR(8) NOT NULL, at VARCHAR(32) NOT NULL,
        open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE, n INT, INDEX quote_rollups_sym (symbol, bucket, at)) ${MY}`,
    ],
  },
  {
    version: 3,
    name: "session ids, two-factor, user email",
    sqlite: [
      `ALTER TABLE sessions ADD COLUMN public_id TEXT`,
      `ALTER TABLE sessions ADD COLUMN last_seen_at TEXT`,
      `ALTER TABLE sessions ADD COLUMN mfa_passed INTEGER NOT NULL DEFAULT 1`,
      `UPDATE sessions SET public_id = substr(token_hash, 1, 16), last_seen_at = created_at`,
      `ALTER TABLE users ADD COLUMN email TEXT`,
      `ALTER TABLE users ADD COLUMN totp_secret TEXT`,
      `ALTER TABLE users ADD COLUMN totp_pending TEXT`,
      `ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0`,
      `CREATE TABLE recovery_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL, used_at TEXT)`,
    ],
    mysql: [
      `ALTER TABLE sessions ADD COLUMN public_id VARCHAR(32)`,
      `ALTER TABLE sessions ADD COLUMN last_seen_at VARCHAR(32)`,
      `ALTER TABLE sessions ADD COLUMN mfa_passed TINYINT NOT NULL DEFAULT 1`,
      `UPDATE sessions SET public_id = SUBSTRING(token_hash, 1, 16), last_seen_at = created_at`,
      `ALTER TABLE users ADD COLUMN email VARCHAR(254)`,
      `ALTER TABLE users ADD COLUMN totp_secret VARCHAR(255)`,
      `ALTER TABLE users ADD COLUMN totp_pending VARCHAR(255)`,
      `ALTER TABLE users ADD COLUMN totp_enabled TINYINT NOT NULL DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN totp_last_step BIGINT NOT NULL DEFAULT 0`,
      `CREATE TABLE recovery_codes (
        id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, code_hash VARCHAR(255) NOT NULL, used_at VARCHAR(32),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE) ${MY}`,
    ],
  },
  {
    version: 4,
    name: "alerts, digests",
    sqlite: [
      `CREATE TABLE alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        condition TEXT NOT NULL, symbol TEXT, currency TEXT, threshold REAL, hysteresis_pct REAL NOT NULL DEFAULT 0.5,
        cooldown_minutes INTEGER NOT NULL DEFAULT 60, channels TEXT NOT NULL, extra_emails TEXT, note TEXT,
        enabled INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'armed', last_value REAL,
        last_checked_at TEXT, last_fired_at TEXT, created_at TEXT NOT NULL, created_by INTEGER)`,
      `CREATE TABLE alert_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, alert_id INTEGER, owner_id INTEGER, fired_at TEXT NOT NULL,
        value REAL, message TEXT NOT NULL, deliveries TEXT)`,
      `CREATE INDEX alert_events_at ON alert_events(fired_at)`,
      `CREATE TABLE alert_reads (user_id INTEGER NOT NULL, event_id INTEGER NOT NULL, PRIMARY KEY (user_id, event_id))`,
      `ALTER TABLE llm_briefs ADD COLUMN kind TEXT NOT NULL DEFAULT 'daily'`,
      `ALTER TABLE llm_briefs ADD COLUMN period_start TEXT`,
      `ALTER TABLE llm_briefs ADD COLUMN period_end TEXT`,
    ],
    mysql: [
      `CREATE TABLE alerts (
        id INT AUTO_INCREMENT PRIMARY KEY, owner_id INT NULL, \`condition\` VARCHAR(32) NOT NULL, symbol VARCHAR(32),
        currency VARCHAR(8), threshold DOUBLE, hysteresis_pct DOUBLE NOT NULL DEFAULT 0.5, cooldown_minutes INT NOT NULL DEFAULT 60,
        channels TEXT NOT NULL, extra_emails TEXT, note VARCHAR(200), enabled TINYINT NOT NULL DEFAULT 1,
        state VARCHAR(16) NOT NULL DEFAULT 'armed', last_value DOUBLE, last_checked_at VARCHAR(32), last_fired_at VARCHAR(32),
        created_at VARCHAR(32) NOT NULL, created_by INT,
        FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE) ${MY}`,
      `CREATE TABLE alert_events (
        id INT AUTO_INCREMENT PRIMARY KEY, alert_id INT, owner_id INT, fired_at VARCHAR(32) NOT NULL, value DOUBLE,
        message TEXT NOT NULL, deliveries TEXT, INDEX alert_events_at (fired_at)) ${MY}`,
      `CREATE TABLE alert_reads (user_id INT NOT NULL, event_id INT NOT NULL, PRIMARY KEY (user_id, event_id)) ${MY}`,
      `ALTER TABLE llm_briefs ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'daily'`,
      `ALTER TABLE llm_briefs ADD COLUMN period_start VARCHAR(32)`,
      `ALTER TABLE llm_briefs ADD COLUMN period_end VARCHAR(32)`,
    ],
  },
];

/** Applies pending migrations. SQLite runs each one in a transaction; MySQL DDL commits implicitly. */
export async function migrate(db, log = console.log) {
  await db.run(
    db.engine === "mysql"
      ? `CREATE TABLE IF NOT EXISTS schema_migrations (version INT PRIMARY KEY, name VARCHAR(200), applied_at VARCHAR(32) NOT NULL) ${MY}`
      : `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT NOT NULL)`,
  );
  const done = new Set((await db.all("SELECT version FROM schema_migrations")).map((r) => Number(r.version)));
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    const statements = db.engine === "mysql" ? m.mysql : m.sqlite;
    await db.tx(async (t) => {
      for (const sql of statements) {
        try {
          await t.run(sql);
        } catch (err) {
          // A column or index left by an interrupted MySQL migration (DDL is not transactional there).
          if (/duplicate column|already exists|Duplicate key name/i.test(err.message)) continue;
          throw new Error(`Migration ${m.version} (${m.name}) failed: ${err.message}\n${sql}`);
        }
      }
      await t.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)", [m.version, m.name, new Date().toISOString()]);
    });
    log(`Database migrated to version ${m.version}: ${m.name}`);
  }
  return Math.max(0, ...MIGRATIONS.map((m) => m.version));
}
