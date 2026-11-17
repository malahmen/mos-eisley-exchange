// Optional "market brief": a short plain-language read of today's watchlist moves.
// Only public prices are sent (symbols, names, prices, % changes): nothing about the users.
import { createHash } from "node:crypto";
import { askJson } from "./client.js";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "bullets", "bitcoin", "caveat"],
  properties: {
    headline: { type: "string", description: "one sentence, at most 15 words" },
    bullets: { type: "array", items: { type: "string" }, description: "3 to 6 short observations about notable moves, by region" },
    bitcoin: { type: "string", description: "one sentence on Bitcoin's move" },
    caveat: { type: "string", description: "one sentence: what this brief cannot tell (no news access, prices may be delayed)" },
  },
};

const SYSTEM = `You write a short, neutral market brief for a private dashboard.
You get today's quotes for a watchlist of shares (US, Europe, mainland China, Hong Kong) and Bitcoin.
Describe only what the numbers show: the biggest movers, whether regions moved together, anything unusual (a stale quote, a closed market).
Do not invent news or reasons for moves, do not give investment advice, and do not predict prices. Use plain English.`;

const MIN_INTERVAL_MS = 60_000;

export function createBriefService({ db, llm }) {
  let inflight = null;
  let lastRun = 0;

  async function latest() {
    const row = await db.get("SELECT * FROM llm_briefs WHERE kind = 'daily' ORDER BY id DESC LIMIT 1");
    return row ? { id: row.id, model: row.model, createdAt: row.created_at, ...JSON.parse(row.body) } : null;
  }

  return {
    latest,
    async generate(snapshot) {
      const input = {
        asOf: new Date().toISOString(),
        bitcoin: snapshot.bitcoin,
        shares: snapshot.shares.map((s) => ({
          symbol: s.symbol, name: s.name, market: s.market, currency: s.currency,
          price: s.price, changePct: s.changePct == null ? null : Math.round(s.changePct * 100) / 100,
          marketState: s.marketState, stale: !!s.stale,
        })),
      };
      // Same rounded numbers -> same brief: reuse it instead of calling the model again.
      const hash = createHash("sha256").update(JSON.stringify({ b: input.bitcoin, s: input.shares })).digest("hex");
      const same = await db.get("SELECT * FROM llm_briefs WHERE kind = 'daily' AND prompt_hash = ? ORDER BY id DESC LIMIT 1", [hash]);
      if (same) return { cached: true, brief: { id: same.id, model: same.model, createdAt: same.created_at, ...JSON.parse(same.body) } };

      if (inflight) return inflight;
      const wait = lastRun + MIN_INTERVAL_MS - Date.now();
      if (wait > 0) throw Object.assign(new Error(`A brief was generated moments ago. Try again in ${Math.ceil(wait / 1000)} s.`), { status: 429 });

      inflight = (async () => {
        try {
          lastRun = Date.now();
          const { data, model } = await askJson(llm, {
            system: SYSTEM,
            user: `Quotes (JSON):\n${JSON.stringify(input, null, 1)}`,
            schema: SCHEMA,
            schemaName: "market_brief",
          });
          const body = {
            headline: String(data.headline || ""),
            bullets: (Array.isArray(data.bullets) ? data.bullets : []).map(String).slice(0, 8),
            bitcoin: String(data.bitcoin || ""),
            caveat: String(data.caveat || ""),
          };
          const r = await db.run("INSERT INTO llm_briefs (prompt_hash, model, body, created_at) VALUES (?, ?, ?, ?)", [
            hash, model, JSON.stringify(body), new Date().toISOString(),
          ]);
          await db.run("DELETE FROM llm_briefs WHERE kind = 'daily' AND id < ?", [r.insertId - 200]); // keep recent daily briefs
          return { cached: false, brief: { id: r.insertId, model, createdAt: new Date().toISOString(), ...body } };
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },
  };
}
