// Shares and indices shown in the app. Symbols use Yahoo Finance's notation (the default provider):
// no suffix = US, .LS Lisbon, .PA Paris, .AS Amsterdam, .DE Xetra, .SS Shanghai, .SZ Shenzhen, .HK Hong Kong;
// indices start with ^ (^GSPC) or are known index codes (PSI20.LS, 000001.SS).
import { marketOf, isIndexSymbol, DEFAULT_INDICES } from "../providers/markets.js";

const DEFAULT_WATCHLIST = [
  ["AAPL", "Apple Inc."], ["MSFT", "Microsoft Corporation"], ["NVDA", "NVIDIA Corporation"], ["SPY", "SPDR S&P 500 ETF"],
  ["ASML.AS", "ASML Holding N.V."], ["MC.PA", "LVMH Moët Hennessy Louis Vuitton"], ["SAP.DE", "SAP SE"],
  ["EDP.LS", "EDP, S.A."], ["GALP.LS", "Galp Energia, SGPS, S.A."],
  ["600519.SS", "Kweichow Moutai Co., Ltd."], ["000858.SZ", "Wuliangye Yibin Co., Ltd."],
  ["0700.HK", "Tencent Holdings Limited"], ["9988.HK", "Alibaba Group Holding Limited"],
];

const shape = (r) => ({
  id: r.id,
  symbol: r.symbol,
  kind: r.kind || "equity",
  name: r.display_name || r.symbol,
  market: r.market,
  exchange: r.exchange || "",
  currency: r.currency || "",
  sector: r.sector || "",
  sortOrder: r.sort_order,
});

export const SYMBOL_RE = /^[A-Z0-9^][A-Z0-9.\-^=]{0,24}$/;

export function createWatchlistRepo(db, settings) {
  return {
    async list(kind) {
      const rows = kind
        ? await db.all("SELECT * FROM watchlist_items WHERE kind = ? ORDER BY sort_order, id", [kind])
        : await db.all("SELECT * FROM watchlist_items ORDER BY kind, sort_order, id");
      return rows.map(shape);
    },
    async bySymbol(symbol) {
      const r = await db.get("SELECT * FROM watchlist_items WHERE symbol = ?", [symbol]);
      return r ? shape(r) : null;
    },
    /** Seeds shares on an empty table and indices once (an admin may later delete them all). */
    async seed() {
      const out = [];
      const n = Number((await db.get("SELECT COUNT(*) AS n FROM watchlist_items WHERE kind = 'equity'")).n);
      if (!n) {
        let i = 0;
        for (const [symbol, name] of DEFAULT_WATCHLIST) await this.add({ symbol, name, sortOrder: i++, kind: "equity" });
        out.push("shares");
      }
      if (!(await settings.flag("indices-seeded"))) {
        let i = 0;
        for (const [symbol, name] of DEFAULT_INDICES) {
          if (!(await this.bySymbol(symbol))) await this.add({ symbol, name, sortOrder: i, kind: "index" });
          i++;
        }
        await settings.setFlag("indices-seeded", true);
        out.push("indices");
      }
      return out;
    },
    async add({ symbol, name = "", exchange = "", currency = "", sector = "", sortOrder, kind }) {
      symbol = String(symbol).trim().toUpperCase();
      if (!SYMBOL_RE.test(symbol)) throw Object.assign(new Error("Invalid symbol."), { status: 400 });
      if (await db.get("SELECT id FROM watchlist_items WHERE symbol = ?", [symbol])) {
        throw Object.assign(new Error(`${symbol} is already on the watchlist.`), { status: 409 });
      }
      kind = kind === "index" || kind === "equity" ? kind : isIndexSymbol(symbol) ? "index" : "equity";
      if (sortOrder === undefined) {
        sortOrder = Number((await db.get("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM watchlist_items WHERE kind = ?", [kind])).n);
      }
      const r = await db.run(
        "INSERT INTO watchlist_items (symbol, display_name, market, exchange, currency, sector, sort_order, created_at, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [symbol, String(name).slice(0, 200), marketOf(symbol), String(exchange).slice(0, 64), String(currency).slice(0, 8).toUpperCase(),
          String(sector).slice(0, 100), sortOrder, new Date().toISOString(), kind],
      );
      return shape(await db.get("SELECT * FROM watchlist_items WHERE id = ?", [r.insertId]));
    },
    async remove(id) {
      const r = await db.run("DELETE FROM watchlist_items WHERE id = ?", [id]);
      return r.changes > 0;
    },
    async reorder(ids) {
      let i = 0;
      for (const id of ids) await db.run("UPDATE watchlist_items SET sort_order = ? WHERE id = ?", [i++, id]);
    },
    /** Fills name/currency/exchange learned from a live quote, when they were blank. */
    async enrich(symbol, { name, currency, exchange }) {
      await db.run(
        `UPDATE watchlist_items SET
           display_name = CASE WHEN display_name IS NULL OR display_name = '' THEN ? ELSE display_name END,
           currency     = CASE WHEN currency IS NULL OR currency = '' THEN ? ELSE currency END,
           exchange     = CASE WHEN exchange IS NULL OR exchange = '' THEN ? ELSE exchange END
         WHERE symbol = ?`,
        [name || "", currency || "", exchange || "", symbol],
      );
    },
  };
}
