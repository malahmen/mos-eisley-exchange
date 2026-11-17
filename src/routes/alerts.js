// Alerts and in-app notifications.
import { readJson, fail } from "../http/core.js";
import { CONDITIONS, CHANNELS, VIEWER_CHANNELS } from "../alerts/engine.js";
import { PROVIDERS, KINDS } from "../providers/registry.js";

export function alertRoutes({ route }, app) {
  const { alerts, audit, notifier, jobs, settings } = app;

  route("GET", "/api/alerts", "user", async ({ auth }) => {
    const isAdmin = auth.user.role === "admin";
    const general = await settings.get("general");
    return {
      alerts: await alerts.list(auth.user),
      canCreate: isAdmin || general.viewerAlerts,
      conditions: Object.fromEntries(Object.entries(CONDITIONS).filter(([, d]) => isAdmin || !d.adminOnly)),
      channels: isAdmin ? CHANNELS : VIEWER_CHANNELS,
      channelsEnabled: await notifier.enabledChannels(),
      providers: isAdmin ? KINDS.flatMap((k) => PROVIDERS[k].map((p) => ({ id: p.id, name: p.name }))) : [],
      jobs: isAdmin ? jobs.status().map((j) => j.name) : [],
      currencies: general.cryptoCurrencies,
      email: auth.user.email,
    };
  });

  route("POST", "/api/alerts", "user", async ({ req, auth, ip }) => {
    const body = await readJson(req);
    const a = await alerts.create(body, auth.user, { personal: auth.user.role !== "admin" || !!body.personal });
    await audit.log({ user: auth.user, action: "alert_created", detail: `#${a.id} ${a.condition} ${a.symbol} ${a.threshold ?? ""}`.trim(), ip });
    return { alert: a };
  });

  route("PUT", "/api/alerts/:id", "user", async ({ req, params, auth, ip }) => {
    const a = await alerts.update(Number(params.id), await readJson(req), auth.user);
    await audit.log({ user: auth.user, action: "alert_updated", detail: `#${a.id} ${a.condition} ${a.symbol} ${a.threshold ?? ""} ${a.enabled ? "on" : "off"}`, ip });
    return { alert: a };
  });

  route("DELETE", "/api/alerts/:id", "user", async ({ params, auth, ip }) => {
    const a = await alerts.remove(Number(params.id), auth.user);
    await audit.log({ user: auth.user, action: "alert_deleted", detail: `#${a.id} ${a.condition} ${a.symbol}`, ip });
    return { ok: true };
  });

  route("GET", "/api/alerts/events", "user", async ({ url, auth }) => ({ events: await alerts.events(auth.user, { limit: url.searchParams.get("limit") || 100 }) }));
  route("GET", "/api/alerts/unread", "user", async ({ auth }) => ({ unread: await alerts.unreadCount(auth.user) }));
  route("POST", "/api/alerts/events/read", "user", async ({ auth }) => {
    await alerts.markAllRead(auth.user);
    return { ok: true };
  });

  route("POST", "/api/alerts/run", "admin", async () => {
    const r = await jobs.run("alerts", "manual");
    if (r.skipped) fail(409, "The alert check is already running.");
    return r;
  });
}
