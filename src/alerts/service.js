// Alerts: storage, validation/permissions, the evaluation run (job "alerts", every minute) and events.
// Evaluation reads the market service cache (and stored history for 52-week figures); it never forces
// extra upstream calls beyond what the cache refreshes anyway.
import { CONDITIONS, CHANNELS, VIEWER_CHANNELS, evaluate, step } from "./engine.js";
import { EMAIL_RE } from "../repos/users.js";
import { providerById } from "../providers/registry.js";
import { convertQuote } from "../providers/fx.js";

const VIEWER_MAX = 20;
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const json = (v, d) => { try { return JSON.parse(v); } catch { return d; } };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const shape = (r) => r && {
  id: r.id, ownerId: r.owner_id, condition: r.condition, symbol: r.symbol || "", currency: r.currency || "",
  threshold: r.threshold, hysteresisPct: r.hysteresis_pct, cooldownMinutes: r.cooldown_minutes,
  channels: json(r.channels, ["inapp"]), extraEmails: json(r.extra_emails, []), note: r.note || "",
  enabled: !!r.enabled, state: r.state, lastValue: r.last_value, lastCheckedAt: r.last_checked_at,
  lastFiredAt: r.last_fired_at, createdAt: r.created_at, createdBy: r.created_by,
};

export function createAlerts({ db, market, watchlist, users, notifier, jobs, health, settings, log = console.log }) {
  const C = db.engine === "mysql" ? "`condition`" : "condition";

  async function get(id) {
    return shape(await db.get("SELECT * FROM alerts WHERE id = ?", [id]));
  }

  function canSee(user, alert) {
    return user.role === "admin" || alert.ownerId === user.id;
  }

  async function validate(input, user, existing) {
    const isAdmin = user.role === "admin";
    const v = { ...(existing || {}), ...input };
    const def = CONDITIONS[v.condition];
    if (!def) throw bad("Choose a condition.");
    if (def.adminOnly && !isAdmin) throw bad("Only admins can create that kind of alert.");
    const general = await settings.get("general");
    let symbol = String(v.symbol || "").trim().toUpperCase();
    if (def.target === "symbol") {
      if (!symbol) throw bad("Choose a symbol.");
      if (symbol !== "BTC" && !(await watchlist.bySymbol(symbol))) throw bad(`${symbol} is not on the watchlist.`);
    } else if (def.target === "provider") {
      symbol = String(v.symbol || "").trim().toLowerCase();
      if (!providerById(symbol)) throw bad("Choose a data source.");
    } else if (def.target === "job") {
      symbol = String(v.symbol || "").trim().toLowerCase();
    } else symbol = "";
    let threshold = null;
    if (def.unit) {
      threshold = Number(v.threshold);
      if (!Number.isFinite(threshold)) throw bad("Enter a threshold.");
      if (def.unit === "%" && threshold <= 0) throw bad("The percentage must be above 0.");
      if (def.unit === "index" && (threshold < 0 || threshold > 100)) throw bad("The index runs from 0 to 100.");
      if (def.unit === "min" && threshold < 1) throw bad("At least 1 minute.");
      if (def.unit === "price" && threshold <= 0) throw bad("The price must be above 0.");
    }
    let currency = String(v.currency || "").toUpperCase();
    if (def.needsCurrency) {
      if (symbol === "BTC" || def.target === null) {
        if (!general.cryptoCurrencies.includes(currency)) currency = general.defaultCurrency;
      } else {
        const item = await watchlist.bySymbol(symbol);
        const allowed = new Set([item?.currency, ...general.cryptoCurrencies].filter(Boolean));
        if (!allowed.has(currency)) currency = item?.currency || general.defaultCurrency;
      }
    } else currency = "";
    const allowedChannels = isAdmin ? CHANNELS : VIEWER_CHANNELS;
    let channels = [...new Set((Array.isArray(v.channels) ? v.channels : ["inapp", "email"]).filter((c) => allowedChannels.includes(c)))];
    if (!channels.length) channels = ["inapp"];
    let extraEmails = [];
    if (isAdmin && Array.isArray(v.extraEmails)) {
      extraEmails = [...new Set(v.extraEmails.map((e) => String(e).trim()).filter(Boolean))].slice(0, 5);
      const wrong = extraEmails.find((e) => !EMAIL_RE.test(e));
      if (wrong) throw bad(`"${wrong}" is not an email address.`);
    }
    const hysteresisPct = Math.min(10, Math.max(0, Number(v.hysteresisPct ?? 0.5) || 0));
    const cooldownMinutes = Math.min(10080, Math.max(1, Math.round(Number(v.cooldownMinutes ?? 60) || 60)));
    return {
      condition: v.condition, symbol, currency, threshold, hysteresisPct, cooldownMinutes, channels, extraEmails,
      note: String(v.note || "").slice(0, 200), enabled: v.enabled === undefined ? true : !!v.enabled,
    };
  }

  async function permitted(user) {
    if (user.role === "admin") return true;
    return (await settings.get("general")).viewerAlerts;
  }

  // ---------------------------------------------------------------- evaluation
  async function gather(alerts) {
    const data = { quotes: {}, fx: {}, stats: {}, btc: null, extras: null, jobs: null };
    const symbols = [...new Set(alerts.filter((a) => CONDITIONS[a.condition]?.target === "symbol" && a.symbol !== "BTC").map((a) => a.symbol))];
    if (symbols.length) {
      const items = (await watchlist.list()).filter((i) => symbols.includes(i.symbol));
      data.quotes = (await market.equities(items)).quotes;
    }
    if (alerts.some((a) => a.symbol === "BTC" || a.condition === "btc_spread_above")) data.btc = await market.bitcoin();
    if (alerts.some((a) => a.condition.startsWith("fng_"))) data.extras = await market.btcExtras();
    if (alerts.some((a) => a.condition === "job_failing")) data.jobs = jobs.status();
    return data;
  }

  async function inputsFor(alert, data) {
    const c = alert.condition;
    if (alert.symbol === "BTC") {
      let q = null;
      for (const s of data.btc?.sources || []) {
        const x = s.quotes.find((y) => y.currency === alert.currency);
        if (x?.price != null) { q = { ...x, marketState: "always", stale: !!s.stale }; break; }
      }
      const stats = c === "high52" || c === "low52" ? await market.stats("BTC", { price: q?.price, kind: "btc", currency: alert.currency }).catch(() => null) : null;
      return { quote: q, stats };
    }
    if (CONDITIONS[c]?.target === "symbol") {
      let q = data.quotes[alert.symbol] || null;
      if (q && c.startsWith("price_") && alert.currency && q.currency && q.currency !== alert.currency) {
        const fx = await market.fx(alert.currency, [q.currency]);
        const conv = convertQuote(q, fx.rates[q.currency]);
        q = conv ? { ...q, price: conv.price, currency: alert.currency } : null;
      }
      const stats = c === "high52" || c === "low52" ? await market.stats(alert.symbol, { price: data.quotes[alert.symbol]?.price }).catch(() => null) : null;
      return { quote: q, stats };
    }
    if (c === "btc_spread_above") {
      const prices = (data.btc?.sources || []).map((s) => s.quotes.find((q) => q.currency === alert.currency)?.price).filter(Number.isFinite).sort((a, b) => a - b);
      if (prices.length < 2) return { spreadPct: null };
      const med = prices.length % 2 ? prices[(prices.length - 1) / 2] : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2;
      return { spreadPct: ((prices[prices.length - 1] - prices[0]) / med) * 100 };
    }
    if (c.startsWith("fng_")) return { fearGreed: data.extras?.fearGreed?.value ?? null };
    if (c === "provider_down") return { failingMinutes: health.failingFor(alert.symbol) / 60_000 };
    if (c === "job_failing") {
      const failing = (data.jobs || []).filter((j) => j.name !== "alerts" && j.lastError && (!alert.symbol || j.name === alert.symbol));
      return { jobError: failing.length ? failing.map((j) => `${j.name}: ${j.lastError}`).join("; ") : null };
    }
    return {};
  }

  async function recipientsFor(alert) {
    const uid = alert.ownerId ?? alert.createdBy;
    const u = uid ? await users.byId(uid) : null;
    return [...new Set([u?.email, ...alert.extraEmails].filter(Boolean))];
  }

  async function deliver(fired) {
    // Email: one message per recipient for everything that fired in this run.
    const byRecipient = new Map();
    for (const f of fired) {
      if (f.alert.channels.includes("email")) {
        const to = await recipientsFor(f.alert);
        if (!to.length) f.deliveries.email = "error: no email address";
        for (const r of to) {
          if (!byRecipient.has(r)) byRecipient.set(r, []);
          byRecipient.get(r).push(f);
        }
      }
      const others = f.alert.channels.filter((c) => c !== "email" && c !== "inapp");
      if (others.length) {
        Object.assign(f.deliveries, await notifier.send(others, {
          subject: `[Mos Eisley] ${f.text.split(":")[0]}`, text: f.text, priority: "high", payload: { alert: f.alert, value: f.value },
        }));
      }
    }
    for (const [to, list] of byRecipient) {
      const subject = list.length === 1 ? `[Mos Eisley] ${list[0].text.split(". Now")[0]}` : `[Mos Eisley] ${list.length} alerts: ${[...new Set(list.map((f) => f.alert.symbol || "Bitcoin"))].join(", ")}`;
      const text = list.map((f) => `• ${f.text}${f.alert.note ? ` (${f.alert.note})` : ""}`).join("\n") + `\n\nSent ${new Date().toLocaleString()}.`;
      const html = `<ul>${list.map((f) => `<li>${esc(f.text)}${f.alert.note ? ` <em>(${esc(f.alert.note)})</em>` : ""}</li>`).join("")}</ul><p style="color:#5b6572">Mos Eisley Exchange · ${esc(new Date().toLocaleString())}</p>`;
      const r = await notifier.send(["email"], { to: [to], subject, text, html });
      for (const f of list) f.deliveries.email = f.deliveries.email && !f.deliveries.email.startsWith("error") ? f.deliveries.email : r.email;
    }
    for (const f of fired) await db.run("UPDATE alert_events SET deliveries = ? WHERE id = ?", [JSON.stringify(f.deliveries), f.eventId]);
  }

  async function run() {
    const alerts = (await db.all(`SELECT * FROM alerts WHERE enabled = 1`)).map(shape);
    if (!alerts.length) return { checked: 0, fired: 0 };
    const data = await gather(alerts);
    const fired = [];
    const now = Date.now();
    for (const a of alerts) {
      let result;
      try {
        result = evaluate(a, await inputsFor(a, data));
      } catch (err) {
        result = { skip: true, reason: err.message };
      }
      const s = step(a, result, now);
      const iso = new Date(now).toISOString();
      await db.run("UPDATE alerts SET state = ?, last_value = ?, last_checked_at = ?" + (s.fire ? ", last_fired_at = ?" : "") + " WHERE id = ?",
        s.fire ? [s.state, result.value ?? a.lastValue, iso, iso, a.id] : [s.state, result.value ?? a.lastValue, iso, a.id]);
      if (s.fire) {
        const r = await db.run("INSERT INTO alert_events (alert_id, owner_id, fired_at, value, message, deliveries) VALUES (?, ?, ?, ?, ?, ?)",
          [a.id, a.ownerId, iso, result.value, result.text, "{}"]);
        fired.push({ alert: a, text: result.text, value: result.value, eventId: r.insertId, deliveries: { inapp: "stored" } });
      }
    }
    if (fired.length) await deliver(fired);
    return { checked: alerts.length, fired: fired.length };
  }

  // ---------------------------------------------------------------- events (in-app)
  function eventScope(user) {
    return user.role === "admin" ? ["(e.owner_id IS NULL OR e.owner_id = ?)", [user.id]] : ["e.owner_id = ?", [user.id]];
  }

  return {
    CONDITIONS,
    run,
    permitted,
    async list(user) {
      const rows = user.role === "admin"
        ? await db.all("SELECT * FROM alerts ORDER BY id DESC")
        : await db.all("SELECT * FROM alerts WHERE owner_id = ? ORDER BY id DESC", [user.id]);
      const out = rows.map(shape);
      const names = new Map((await users.list()).map((u) => [u.id, u.username]));
      return out.map((a) => ({ ...a, owner: a.ownerId ? names.get(a.ownerId) || "?" : null }));
    },
    async create(input, user, { personal = user.role !== "admin" } = {}) {
      if (!(await permitted(user))) throw Object.assign(new Error("Only admins can create alerts."), { status: 403 });
      if (user.role !== "admin") {
        const n = Number((await db.get("SELECT COUNT(*) AS n FROM alerts WHERE owner_id = ?", [user.id])).n);
        if (n >= VIEWER_MAX) throw bad(`You can have at most ${VIEWER_MAX} alerts.`);
      }
      const v = await validate(input, user);
      const r = await db.run(
        `INSERT INTO alerts (owner_id, ${C}, symbol, currency, threshold, hysteresis_pct, cooldown_minutes, channels, extra_emails, note, enabled, state, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'armed', ?, ?)`,
        [personal || input.personal ? user.id : null, v.condition, v.symbol, v.currency, v.threshold, v.hysteresisPct, v.cooldownMinutes,
          JSON.stringify(v.channels), JSON.stringify(v.extraEmails), v.note, v.enabled, new Date().toISOString(), user.id],
      );
      return get(r.insertId);
    },
    async update(id, input, user) {
      const a = await get(id);
      if (!a || !canSee(user, a)) throw Object.assign(new Error("No such alert."), { status: 404 });
      if (!(await permitted(user))) throw Object.assign(new Error("Only admins can change alerts."), { status: 403 });
      const v = await validate(input, user, a);
      const changedRule = ["condition", "symbol", "currency", "threshold"].some((k) => v[k] !== a[k]);
      await db.run(
        `UPDATE alerts SET ${C} = ?, symbol = ?, currency = ?, threshold = ?, hysteresis_pct = ?, cooldown_minutes = ?, channels = ?, extra_emails = ?, note = ?, enabled = ?${changedRule ? ", state = 'armed'" : ""} WHERE id = ?`,
        [v.condition, v.symbol, v.currency, v.threshold, v.hysteresisPct, v.cooldownMinutes, JSON.stringify(v.channels), JSON.stringify(v.extraEmails), v.note, v.enabled, id],
      );
      return get(id);
    },
    async remove(id, user) {
      const a = await get(id);
      if (!a || !canSee(user, a)) throw Object.assign(new Error("No such alert."), { status: 404 });
      await db.run("DELETE FROM alerts WHERE id = ?", [id]);
      return a;
    },
    async events(user, { limit = 100 } = {}) {
      const [where, params] = eventScope(user);
      const n = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
      const rows = await db.all(
        `SELECT e.*, CASE WHEN r.event_id IS NULL THEN 0 ELSE 1 END AS seen FROM alert_events e
           LEFT JOIN alert_reads r ON r.event_id = e.id AND r.user_id = ? WHERE ${where} ORDER BY e.id DESC LIMIT ${n}`,
        [user.id, ...params]);
      return rows.map((r) => ({ id: r.id, alertId: r.alert_id, firedAt: r.fired_at, value: r.value, message: r.message, deliveries: json(r.deliveries, {}), seen: !!r.seen, personal: r.owner_id != null }));
    },
    async unreadCount(user) {
      const [where, params] = eventScope(user);
      const r = await db.get(
        `SELECT COUNT(*) AS n FROM alert_events e LEFT JOIN alert_reads r ON r.event_id = e.id AND r.user_id = ?
          WHERE ${where} AND r.event_id IS NULL AND e.fired_at >= ?`,
        [user.id, ...params, new Date(Date.now() - 30 * 86400_000).toISOString()]);
      return Number(r.n);
    },
    async markAllRead(user) {
      const evs = await this.events(user, { limit: 500 });
      for (const e of evs.filter((x) => !x.seen)) {
        await db.run("INSERT INTO alert_reads (user_id, event_id) VALUES (?, ?)", [user.id, e.id]).catch(() => {});
      }
    },
    async pruneEvents(days = 180) {
      await db.run("DELETE FROM alert_events WHERE fired_at < ?", [new Date(Date.now() - days * 86400_000).toISOString()]);
    },
  };
}
