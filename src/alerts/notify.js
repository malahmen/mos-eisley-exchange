// Delivery channels for alerts and digests: email (primary, via nodemailer), ntfy, Telegram, webhook.
// Secrets in the notification settings are sealed with SECRET_KEY; they are opened only here.
import { createHmac } from "node:crypto";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (i < tries - 1) await sleep([5000, 20000][i] || 20000);
    }
  }
  throw last;
}

async function post(url, body, headers = {}) {
  const res = await fetch(url, { method: "POST", body, headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}

export function createNotifier({ settings, secrets, log = console.log, retries = 3 }) {
  async function cfg() {
    const n = await settings.get("notifications");
    const open = (v) => { try { return secrets.open(v); } catch { return ""; } };
    n.email.pass = open(n.email.pass);
    n.ntfy.token = open(n.ntfy.token);
    n.telegram.botToken = open(n.telegram.botToken);
    n.webhook.secret = open(n.webhook.secret);
    return n;
  }

  let transport = null, transportKey = "";
  async function mailer(e) {
    const key = JSON.stringify([e.host, e.port, e.tls, e.user, e.pass, e.allowSelfSigned]);
    if (transport && key === transportKey) return transport;
    let nodemailer;
    try {
      nodemailer = (await import("nodemailer")).default;
    } catch {
      throw new Error("Email needs the nodemailer package. Run `npm install`.");
    }
    transport = nodemailer.createTransport({
      host: e.host, port: e.port, secure: e.tls === "tls", requireTLS: e.tls === "starttls", ignoreTLS: e.tls === "none",
      auth: e.user ? { user: e.user, pass: e.pass } : undefined,
      tls: e.allowSelfSigned ? { rejectUnauthorized: false } : undefined,
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
    });
    transportKey = key;
    return transport;
  }

  const channels = {
    async email(n, { to, subject, text, html }) {
      const e = n.email;
      if (!e.enabled || !e.host || !e.from) throw new Error("Email is not configured (Admin → Notifications).");
      const list = [...new Set((Array.isArray(to) ? to : [to]).filter(Boolean))];
      if (!list.length) throw new Error("No recipient email address (set one on the Account page).");
      const t = await mailer(e);
      await withRetry(() => t.sendMail({ from: e.from, to: list.join(", "), subject, text, html }), retries);
      return `sent to ${list.length}`;
    },
    async ntfy(n, { subject, text, priority = "default" }) {
      if (!n.ntfy.enabled || !n.ntfy.url) throw new Error("ntfy is not configured.");
      await withRetry(() => post(n.ntfy.url, text, {
        Title: subject.replace(/[^\x20-\x7e]/g, "?"), Priority: priority, Tags: "chart_with_upwards_trend",
        ...(n.ntfy.token ? { Authorization: `Bearer ${n.ntfy.token}` } : {}),
      }), retries);
      return "sent";
    },
    async telegram(n, { subject, text }) {
      if (!n.telegram.enabled || !n.telegram.botToken || !n.telegram.chatId) throw new Error("Telegram is not configured.");
      await withRetry(() => post(`https://api.telegram.org/bot${n.telegram.botToken}/sendMessage`,
        JSON.stringify({ chat_id: n.telegram.chatId, text: `${subject}\n\n${text}`, disable_web_page_preview: true }),
        { "Content-Type": "application/json" }).catch((err) => { throw new Error(err.message.replace(n.telegram.botToken, "•••")); }), retries);
      return "sent";
    },
    async webhook(n, { subject, text, payload }) {
      if (!n.webhook.enabled || !n.webhook.url) throw new Error("Webhook is not configured.");
      const body = JSON.stringify({ subject, text, ...payload, sentAt: new Date().toISOString() });
      const headers = { "Content-Type": "application/json" };
      if (n.webhook.secret) headers["X-Signature-SHA256"] = createHmac("sha256", n.webhook.secret).update(body).digest("hex");
      await withRetry(() => post(n.webhook.url, body, headers), retries);
      return "sent";
    },
  };

  return {
    /** Sends one message on each listed channel. Returns { channel: "sent…" | "error: …" }. Never throws. */
    async send(list, message) {
      const n = await cfg();
      const out = {};
      for (const ch of list) {
        if (ch === "inapp") { out.inapp = "stored"; continue; }
        if (!channels[ch]) continue;
        try {
          out[ch] = await channels[ch](n, message);
        } catch (err) {
          out[ch] = `error: ${err.message}`;
          log(`Notification via ${ch} failed: ${err.message}`);
        }
      }
      return out;
    },
    async test(channel, to) {
      const n = await cfg();
      if (!channels[channel]) throw Object.assign(new Error("Unknown channel"), { status: 400 });
      return channels[channel](n, {
        to, subject: "[Mos Eisley] Test notification", text: "This is a test from Mos Eisley Exchange. If you can read it, the channel works.",
        html: "<p>This is a test from <strong>Mos Eisley Exchange</strong>. If you can read it, the channel works.</p>",
        payload: { test: true },
      });
    },
    async enabledChannels() {
      const n = await cfg();
      return { inapp: true, email: n.email.enabled, ntfy: n.ntfy.enabled, telegram: n.telegram.enabled, webhook: n.webhook.enabled };
    },
  };
}
