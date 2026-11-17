// One small interface over both engines: all / get / run / upsert / tx / ping / close, with "?" placeholders.
import { migrate } from "./migrations.js";

export async function createDb(dbConfig, { log = console.log } = {}) {
  let db;
  switch (dbConfig.engine) {
    case "sqlite": {
      const { createSqliteDb } = await import("./sqliteDb.js");
      db = await createSqliteDb(dbConfig.sqlitePath);
      break;
    }
    case "mysql": {
      const { createMysqlDb } = await import("./mysqlDb.js");
      db = await createMysqlDb(dbConfig.mysql);
      break;
    }
    default:
      throw new Error(`Unknown DB_ENGINE "${dbConfig.engine}". Supported: sqlite, mysql`);
  }
  db.schemaVersion = await migrate(db, log);
  return db;
}
