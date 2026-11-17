// Weekly digest (#14): a longer read of the week, built from stats (stored history when available),
// index moves, Bitcoin's week and sentiment, and the alerts that fired. Scheduled by the job runner.
import { createHash } from "node:crypto";
import { askJson } from "./client.js";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "sections", "bitcoin", "notable", "caveat"],
  properties: {
    headline: { type: "string", description: "one sentence summary of the week, at most 18 words" },
    sections: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["region", "summary"],
        properties: { region: { type: "string" }, summary: { type: "string", description: "2-3 sentences" } },
      },
    },
    bitcoin: { type: "string", description: "2 sentences on Bitcoin's week, including sentiment if given" },
    notable: { type: "array", items: { type: "string" }, description: "up to 5 notable facts (biggest weekly movers, 52-week highs/lows, alerts)" },
    caveat: { type: "string" },
  },
};

const SYSTEM = `You write a neutral weekly market digest for a private dashboard.
You get, for a watchlist of shares and indices (US, Europe, mainland China, Hong Kong), the weekly, monthly and year-to-date returns,
52-week position, Bitcoin's week and sentiment index, and alerts that fired.
Describe what the numbers show, region by region. Do not invent news or causes, do not give advice, do not predict. Plain English.`;

const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

export function createDigestService({ db, llm, market, watchlist, users, notifier, settings, log = console.log }) {
  async function latest() {
    const row = await db.get("SELECT * FROM llm_briefs WHERE kind = 'weekly' ORDER BY id DESC LIMIT 1");
    return row ? toDigest(row) : null;
  }
  function toDigest(row) {
    return { id: row.id, model: row.model, createdAt: row.created_at, periodStart: row.period_start, periodEnd: row.period_end, ...JSON.parse(row.body) };
  }

  async function buildInput() {
    const general = await settings.get("general");
    const items = await watchlist.list();
    const { quotes } = await market.equities(items);
    const rows = [];
    for (const it of items) {
      const q = quotes[it.symbol];
      const s = await market.stats(it.symbol, { price: q?.price }).catch(() => null);
      rows.push({
        symbol: it.symbol, name: it.name, kind: it.kind, market: it.market, currency: q?.currency || it.currency,
        price: round(q?.price, 4), week: round(s?.r1w), month: round(s?.r1m), ytd: round(s?.ytd),
        fromHigh52: round(s?.fromHigh), badges: s?.badges || [],
      });
    }
    const cur = general.defaultCurrency;
    const primary = (await market.bitcoinPrimary())[cur];
    const btcStats = await market.stats("BTC", { price: primary?.price, kind: "btc", currency: cur }).catch(() => null);
    const week = await market.bitcoinHistory(cur, "7d").catch(() => ({ points: [] }));
    const ys = week.points.map((p) => p[1]);
    const extras = await market.btcExtras().catch(() => ({}));
    const since = new Date(Date.now() - 7 * 86400_000).toISOString();
    const fired = (await db.all("SELECT message FROM alert_events WHERE owner_id IS NULL AND fired_at >= ? ORDER BY id DESC LIMIT 20", [since])).map((r) => r.message);
    return {
      periodStart: since, periodEnd: new Date().toISOString(),
      shares: rows.filter((r) => r.kind === "equity"),
      indices: rows.filter((r) => r.kind === "index"),
      bitcoin: {
        currency: cur, price: round(primary?.price), week: round(btcStats?.r1w), month: round(btcStats?.r1m),
        weekHigh: ys.length ? round(Math.max(...ys)) : null, weekLow: ys.length ? round(Math.min(...ys)) : null,
        fearGreedNow: extras.fearGreed?.value ?? null, fearGreedWeek: (extras.fearGreed?.history || []).slice(-7).map((p) => p[1]),
        dominancePct: round(extras.dominance),
      },
      alertsFired: fired,
    };
  }

  let inflight = null;
  return {
    latest,
    async list(limit = 20) {
      const n = Math.max(1, Math.min(100, Number(limit) || 20));
      return (await db.all(`SELECT * FROM llm_briefs WHERE kind = 'weekly' ORDER BY id DESC LIMIT ${n}`)).map(toDigest);
    },
    async generate({ reason = "schedule" } = {}) {
      if (!llm.enabled) throw new Error("The LLM is not configured (LLM_ENABLED is off).");
      if (inflight) return inflight;
      inflight = (async () => {
        try {
          const input = await buildInput();
          const { data, model } = await askJson(llm, {
            system: SYSTEM, user: `Week data (JSON):\n${JSON.stringify(input, null, 1)}`, schema: SCHEMA, schemaName: "weekly_digest",
          });
          const body = {
            headline: String(data.headline || ""),
            sections: (Array.isArray(data.sections) ? data.sections : []).slice(0, 6).map((s) => ({ region: String(s.region || ""), summary: String(s.summary || "") })),
            bitcoin: String(data.bitcoin || ""),
            notable: (Array.isArray(data.notable) ? data.notable : []).map(String).slice(0, 6),
            caveat: String(data.caveat || ""),
          };
          const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
          const r = await db.run(
            "INSERT INTO llm_briefs (prompt_hash, model, body, created_at, kind, period_start, period_end) VALUES (?, ?, ?, ?, 'weekly', ?, ?)",
            [hash, model, JSON.stringify(body), new Date().toISOString(), input.periodStart, input.periodEnd]);
          const digest = { id: r.insertId, model, createdAt: new Date().toISOString(), periodStart: input.periodStart, periodEnd: input.periodEnd, ...body };
          const general = await settings.get("general");
          let delivery = null;
          if (general.digest.email) {
            const to = await users.adminEmails();
            if (to.length) {
              const text = [body.headline, "", ...body.sections.map((s) => `${s.region}: ${s.summary}`), "", `Bitcoin: ${body.bitcoin}`,
                ...(body.notable.length ? ["", "Notable:", ...body.notable.map((x) => `• ${x}`)] : []), "", body.caveat].join("\n");
              const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
              const html = `<h2>${esc(body.headline)}</h2>${body.sections.map((s) => `<p><strong>${esc(s.region)}</strong>: ${esc(s.summary)}</p>`).join("")}
                <p><strong>Bitcoin</strong>: ${esc(body.bitcoin)}</p>${body.notable.length ? `<ul>${body.notable.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
                <p style="color:#5b6572">${esc(body.caveat)}</p>`;
              delivery = await notifier.send(["email"], { to, subject: `[Mos Eisley] Weekly digest: ${body.headline}`, text, html });
            }
          }
          log(`Weekly digest generated (${reason}).`);
          return { digest, delivery };
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },
  };
}
