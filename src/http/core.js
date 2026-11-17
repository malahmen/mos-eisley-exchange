// HTTP plumbing shared by the route modules: responses, errors, JSON bodies, origin checks, a tiny router.
export const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

export function send(res, status, body, type = "application/json; charset=utf-8", extra = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type, "Cache-Control": "no-store", ...extra });
  res.end(Buffer.isBuffer(body) || typeof body === "string" ? body : JSON.stringify(body));
}
export const redirect = (res, to) => send(res, 302, "", "text/plain", { Location: to });

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
export const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

export async function readJson(req, limit = 64 * 1024) {
  if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) fail(415, "Send JSON (Content-Type: application/json).");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) fail(413, "Request body too large.");
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    fail(400, "Invalid JSON.");
  }
}

export function makeHelpers(config) {
  return {
    clientIp(req) {
      if (config.trustProxy) {
        const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
        if (fwd) return fwd;
      }
      return (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
    },
    /** Writes must come from this site: an Origin, when the browser sends one, must match Host. */
    checkOrigin(req) {
      const origin = req.headers.origin;
      if (!origin) return;
      let host;
      try { host = new URL(origin).host; } catch { fail(403, "Bad origin."); }
      const expected = config.trustProxy ? req.headers["x-forwarded-host"] || req.headers.host : req.headers.host;
      if (host !== expected) fail(403, "Cross-site request refused.");
    },
  };
}

/**
 * route(method, "/api/x/:id", access, handler, opts)
 * access: "public" | "user" | "admin". opts: { allowMustChange, allowMfaPending }
 */
export function createRouter() {
  const routes = [];
  return {
    route(method, pattern, access, handler, opts = {}) {
      const keys = [];
      const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
      routes.push({ method, re, keys, access, handler, ...opts });
    },
    match(method, path) {
      const matched = routes.filter((r) => r.re.test(path));
      if (!matched.length) return { status: 404 };
      const r = matched.find((x) => x.method === method);
      if (!r) return { status: 405 };
      const m = r.re.exec(path);
      return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    },
  };
}
