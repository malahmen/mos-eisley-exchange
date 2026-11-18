# Mos Eisley Exchange

A private dashboard for your LAN. It shows **Bitcoin**, **shares** and the main **indices** from the US, Europe, mainland China and Hong Kong, using free market-data APIs.

It has sign-in with optional two-factor codes, admin and viewer roles, stored price history, cross-market comparison, alerts by email and other channels, and optional LLM features: a daily brief, a weekly digest, and questions about your data.

It follows the conventions of `death-star-audit`: plain Node with no framework and no frontend build, and LLM and database endpoints set through env vars or `.env`.

## Run

```sh
npm install
cp .env.example .env            # optional: the defaults work (SQLite, no LLM)
npm run gen-secret              # optional but recommended: put the output in SECRET_KEY
npm start                       # or: npm run dev
npm test                        # unit and database tests (node --test)
```

Open `http://<host>:3000`. On first start a **setup page** creates the first admin. For a headless start, set `ADMIN_USERNAME` and `ADMIN_PASSWORD` instead.

Requires Node 22.13 or newer.

### Docker

```sh
docker build -t mos-eisley-exchange .
docker run -p 3000:3000 -v exchange-data:/app/data -e SECRET_KEY=... mos-eisley-exchange
```

## Pages

| Page | What it shows |
|---|---|
| Dashboard | Strip of indices, Bitcoin with its Fear & Greed level, market tiles with open/close countdowns (including CN/HK lunch breaks), your pinned symbols, top movers (today or this week), a heat map of the watchlist, the LLM brief (daily or weekly), and the "Ask the data" box |
| Bitcoin | Price chart for 24 h to 1 y in each reference currency, range stats, each source's gap from the median, a table of sources, and market context: a Fear & Greed gauge with 30-day history, BTC dominance, the price gap between exchanges, and optionally block height and fees |
| Shares | Shares and indices with filters for type, region, gain or loss, currency, open markets only and pinned only. Prices can be shown **in one currency**, optionally including the day's FX move. Optional 1W/1M/3M/YTD/1Y column. Detail panel: chart, returns, 52-week badges, volatility, drawdown, and Compare and Alert buttons |
| Compare | Up to four shares, indices or Bitcoin, each as % change from the start of the range, with return, volatility, max drawdown and correlation |
| Alerts | Alerts on price, daily move, 52-week high/low, Fear & Greed, the exchange price gap, and (admins only) failing data sources or jobs. Shows their state and the notifications sent; the bell in the top bar counts unread ones |
| Digests | Archive of weekly LLM digests |
| Account | Password, email, preferences (start page, display currency, hidden markets, theme), two-factor sign-in, active sessions |
| Admin | Users, Providers, Watchlist, Settings, Notifications, Health (data sources and background jobs), Audit log |

## Data sources (Admin → Providers)

| Kind | Sources (default order) |
|---|---|
| Shares and indices | **Yahoo Finance** (no key), Twelve Data (free key), Finnhub (free key, US only), Alpha Vantage (free key, 25 requests/day) |
| Bitcoin | **CoinGecko, Coinbase, Kraken, Binance** (all without a key) |
| Exchange rates | **Yahoo Finance FX** (live, with the previous close), **Frankfurter** (European Central Bank daily rates) |
| Bitcoin context | **Fear & Greed** (alternative.me), **CoinGecko global** (dominance), mempool.space (off by default) |

How sources are called:

- **Rate limits:** each source has a token bucket that respects its free tier. Yahoo is called on both of its hosts, with backoff when it answers 429 (Too Many Requests).
- **Caching:** answers are cached on the server, and identical requests in flight are merged into one.
- **Fallback:** if a source fails, the next one in the list is tried. If all fail, the last good price is shown, marked *stale*.
- **Health:** Admin → Health shows each source's success rate, latency, calls per minute and per day, and its last error.

## Stored history

- **What is stored:** a background job saves prices every `snapshotMinutes` minutes while markets trade. An hourly job turns them into hourly and daily summaries (open, high, low, close) and deletes data past the retention limits.
- **Retention:** by default raw prices are kept 7 days, hourly figures 180 days, and daily figures forever. All three can be changed in Admin → Settings.
- **How it is used:** charts for one month or longer read stored history first. Shorter charts use it if the sources fail. The weekly digest and "Ask the data" use it too.

## Alerts and notifications

- **When an alert fires:** checks run every minute against cached data. An alert fires when the value **crosses** its threshold. It can only fire again after the value moves back past a small band (default 0.5%) and a cooldown has passed (default 60 min). Share alerts are skipped while their market is closed.
- **Channels:** set up in Admin → Notifications, each with a **Send test** button:
  - **email** over SMTP, the main channel. Alerts firing in the same check are grouped into one email per recipient;
  - **ntfy**;
  - **Telegram**;
  - **webhook**, signed with HMAC.
- **Who can create alerts:** admins by default. The setting "Viewers can create their own alerts" lets viewers create up to 20 alerts each, delivered in the app and to their own email.

## LLM (optional)

- **Configuration:** the same variables as `death-star-audit`: `LLM_ENABLED`, `LLM_API=anthropic|openai`, `LLM_MODEL`, `LLM_BASE_URL`, `LLM_API_KEY`, and so on. `openai` means any OpenAI-compatible server, such as LM Studio, llama.cpp, vLLM or Ollama's `/v1`.
- **Daily brief:** generated on demand from today's prices.
- **Weekly digest:** generated on a schedule (default `MON 08:00`) and optionally emailed to admins.
- **Ask the data:** answers come only from a compact set of the app's own figures. Symbols not in the data are dropped, and figures that don't match the data are flagged. Each user can ask 5 questions per 10 minutes. The full question is written to the audit log.

## Security

**Sign-in**
- Passwords use scrypt; at least 10 characters.
- Optional **TOTP** two-factor codes (RFC 6238), with 10 single-use recovery codes. An admin can reset a user's two-factor setup.
- Failed sign-ins are throttled per IP address and per username.

**Sessions**
- Stored on the server. The cookie is HttpOnly and SameSite=Strict, and only its hash is stored.
- The token is replaced after the two-factor step.
- Account → Sessions lets you sign out a single device.

**Requests**
- Every write needs a CSRF token and passes an Origin check.
- Strict CSP (no inline scripts), `frame-ancestors 'none'`.

**Secrets**
- With `SECRET_KEY` set, API keys, the SMTP password, notification tokens and two-factor secrets are encrypted with AES-256-GCM.
- Existing plain-text values are encrypted at the next start.
- `SECRET_KEY_OLD` supports rotating the key.

**Admin access**
- `ADMIN_ALLOW_CIDRS` limits admin pages to given networks. It can only be set by env var, so a mistake in the UI can't lock you out.

**Roles and audit**
- The last active admin can't be removed or demoted.
- The audit log records sign-ins, settings, provider, channel, user and alert changes, and questions asked.

## Layout

```
server.js                 services, jobs, auth guard, static files
src/config.js             .env loader + config
src/db/                   sqlite | mysql adapters, migrations (schema_migrations)
src/http/core.js          responses, errors, JSON bodies, router
src/routes/               auth, account, market, llm, alerts, admin
src/auth/                 passwords, sessions, throttle, totp, cidr
src/repos/                users, settings, watchlist, prefs, audit
src/providers/            equity, crypto, fx, btc extras, registry, market service, http limiter, health
src/history.js            snapshots, rollups, retention
src/stats.js              returns, volatility, drawdown, correlation
src/alerts/               engine (conditions, state machine), notify (email/ntfy/telegram/webhook), service
src/llm/                  client (anthropic|openai), brief, digest, ask
src/jobs.js, secrets.js   job runner, secret box
public/                   pages (app.js, pages/*.js, admin.js), charts, theme (styles.css)
test/                     node --test suites
```

Health probes: `/healthz` and `/readyz`. The roadmap and the decisions behind these features are in [docs/ROADMAP.md](docs/ROADMAP.md).

## Licence

MIT - see [LICENSE](LICENSE).
