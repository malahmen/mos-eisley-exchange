import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Minimal .env loader (no dependency). Real environment variables win.
const envFile = resolve(ROOT, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const env = process.env;
const flag = (v, dflt = false) => (v === undefined || v === "" ? dflt : /^(1|true|yes)$/i.test(v));

export const config = {
  port: Number(env.PORT || 3000),
  host: env.HOST || "0.0.0.0",

  // Sessions and cookies. COOKIE_SECURE=true once the site is served over HTTPS.
  sessionTtlHours: Number(env.SESSION_TTL_HOURS || 12),
  sessionMaxDays: Number(env.SESSION_MAX_DAYS || 7),
  cookieSecure: flag(env.COOKIE_SECURE),
  // Read the client address from X-Forwarded-For (only behind a reverse proxy you control).
  trustProxy: flag(env.TRUST_PROXY),
  // Encrypts stored secrets (API keys, SMTP password, 2FA secrets). 32 bytes, base64: `npm run gen-secret`.
  secretKey: env.SECRET_KEY || "",
  secretKeyOld: env.SECRET_KEY_OLD || "",
  // Admin pages only from these networks, e.g. "192.168.1.0/24,10.0.0.5". Empty = no restriction.
  adminAllowCidrs: env.ADMIN_ALLOW_CIDRS || "",

  // Database: "sqlite" (a file, default) or "mysql" (a server).
  db: {
    engine: (env.DB_ENGINE || "sqlite").toLowerCase(),
    sqlitePath: resolve(ROOT, env.SQLITE_PATH || "data/exchange.sqlite"),
    mysql: {
      host: env.MYSQL_HOST || "",
      port: Number(env.MYSQL_PORT || 3306),
      user: env.MYSQL_USER || "",
      password: env.MYSQL_PASSWORD || "",
      database: env.MYSQL_DATABASE || "",
    },
  },

  // Seeds the first admin when the user table is empty (otherwise the /setup page does it).
  bootstrapAdmin: {
    username: env.ADMIN_USERNAME || "",
    password: env.ADMIN_PASSWORD || "",
  },

  // Market-data API keys. Optional: they can also be entered in Admin → Providers.
  // A key set here wins over one stored in the database.
  providerKeys: {
    finnhub: env.FINNHUB_API_KEY || "",
    twelvedata: env.TWELVEDATA_API_KEY || "",
    alphavantage: env.ALPHAVANTAGE_API_KEY || "",
    coingecko: env.COINGECKO_DEMO_API_KEY || "",
  },

  llm: {
    // The market brief is off until explicitly enabled.
    enabled: flag(env.LLM_ENABLED),
    // "anthropic": the Messages API (Anthropic, or a gateway speaking it).
    // "openai": an OpenAI-compatible /chat/completions server such as LM Studio.
    api: (env.LLM_API || "anthropic").toLowerCase(),
    maxTokens: Number(env.LLM_MAX_TOKENS || 4000),
    timeoutMs: Number(env.LLM_TIMEOUT_SECONDS || 180) * 1000,
    model: env.LLM_MODEL || "claude-opus-5-5",
    baseURL: env.LLM_BASE_URL || undefined, // e.g. a gateway/proxy; default is the Anthropic API
    apiKey: env.LLM_API_KEY || undefined,   // falls back to ANTHROPIC_API_KEY
    effort: env.LLM_EFFORT || "low",
  },
};
