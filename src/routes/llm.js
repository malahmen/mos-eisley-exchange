// Optional LLM features: daily brief, weekly digest, ask the data. Hidden when LLM_ENABLED is off.
import { readJson, fail } from "../http/core.js";

export function llmRoutes({ route }, app) {
  const { config, briefs, digest, askService, market, audit } = app;

  route("GET", "/api/brief", "user", async () => ({
    enabled: config.llm.enabled,
    model: config.llm.enabled ? config.llm.model : null,
    brief: await briefs.latest(),
    weekly: await digest.latest(),
  }));

  route("POST", "/api/brief", "user", async ({ auth, ip }) => {
    if (!config.llm.enabled) fail(400, "The LLM is not configured (LLM_ENABLED is off).");
    const [snap, btc] = await Promise.all([app.equitySnapshot(), market.bitcoin()]);
    const primary = btc.sources.find((s) => s.quotes.length);
    const result = await briefs.generate({
      bitcoin: primary ? primary.quotes.map((q) => ({ currency: q.currency, price: q.price, changePct24h: q.changePct, source: primary.name })) : null,
      shares: snap.items.filter((r) => r.quote).map((r) => ({ ...r.quote, symbol: r.symbol, name: r.name, market: r.market })),
    });
    if (!result.cached) await audit.log({ user: auth.user, action: "brief_generated", detail: result.brief.model, ip });
    return result;
  });

  route("GET", "/api/digests", "user", async ({ url }) => ({
    enabled: config.llm.enabled,
    digests: await digest.list(url.searchParams.get("limit") || 20),
  }));

  route("POST", "/api/admin/digest/run", "admin", async ({ auth, ip }) => {
    if (!config.llm.enabled) fail(400, "The LLM is not configured (LLM_ENABLED is off).");
    const r = await digest.generate({ reason: `manual by ${auth.user.username}` });
    await audit.log({ user: auth.user, action: "digest_generated", detail: `${r.digest.model}${r.delivery?.email ? `; email ${r.delivery.email}` : ""}`, ip });
    return r;
  });

  route("POST", "/api/ask", "user", async ({ req, auth, ip }) => {
    const { question } = await readJson(req);
    const q = String(question || "").trim().slice(0, 300);
    const result = await askService.ask(auth.user, q);
    await audit.log({ user: auth.user, action: "ask", detail: `${q} [${result.model}${result.cannotAnswer ? ", could not answer" : ""}]`, ip });
    return result;
  });
}
