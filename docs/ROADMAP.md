# Roadmap: next features

> **Status (2026-11-17): all phases are implemented.** The README describes the result.
>
> Differences from this plan:
> - Alert emails are grouped per check (every minute) rather than over a 2-minute window.
> - The two-factor QR code is generated on the server (`qrcode-generator`) instead of a vendored browser script.
> - Compare mode does not convert series into one currency yet.
> - The MySQL migrations are written but have not been run against a MySQL server.

This plan covers all 15 proposed features. They are grouped into phases so that shared foundations are built once: a migrations runner, a background job runner, a snapshot store and secret encryption. Each feature is listed with its data, API, UI, effort (S ≈ ½ day, M ≈ 1–2 days, L ≈ 3+ days) and risks.

It keeps the current principles: plain Node with no framework or frontend build, env vars for infrastructure, admin UI for runtime settings, free sources first, the reference theme, and every change written to the audit log.

## Dependency map

```
Phase 0  Foundations ──┬─► migrations runner ─────────────► every schema change below
                       ├─► job runner (scheduler) ────────► #4 snapshots, #9 alerts, #14 digest
                       ├─► Yahoo hardening + #10 health
                       ├─► secret box (AES-GCM) ──────────► #13 keys, #12 TOTP, #9 channel tokens
                       └─► node --test suite
Phase 1  Compare across markets: #1 FX, #2 indices, #3 trading hours, #4 snapshots, #7 stats, #6 compare
Phase 2  Personal + crypto:      #5 per-user views, #8 Bitcoin extras
Phase 3  Account security:       #11 sessions, #13 key encryption, #12 TOTP + admin IP allow-list
Phase 4  Alerts:                 #9 (needs the job runner, snapshots, secret box)
Phase 5  LLM:                    #14 weekly digest (needs snapshots), #15 ask the data (needs #7 stats)
```

---

## Phase 0: Foundations (M–L)

### 0.1 Migrations runner (S)
Today the schema is only `CREATE TABLE IF NOT EXISTS`, which cannot add columns.
- Add a `schema_migrations(version, applied_at)` table and `src/db/migrations.js`: an ordered list of `{ version, sqlite: [...], mysql: [...] }`. Each pending migration runs once at startup, inside a transaction where the engine allows it.
- Add `db.tx(fn)` to both adapters. SQLite: `BEGIN IMMEDIATE`/`COMMIT`. MySQL: a pool connection.
- The current tables become migration 1, so existing databases are stamped at version 1.

### 0.2 Job runner (S)
- `src/jobs.js` keeps a registry of `{ name, everySeconds | at: "MON 08:00", run }`.
- It uses in-process timers, never runs two copies of one job at once, logs the last run and error, and survives a failing job.
- Single instance is assumed (which is true for a LAN box). If replicas are ever needed, add a `job_leases(name, holder, expires_at)` row lock; the interface stays the same.
- Admin → Health shows each job's last run, its duration and its last error.

### 0.3 Yahoo hardening (S)
- Yahoo answers **429 Too Many Requests** to bursts. The adapter should:
  - alternate `query1` and `query2`;
  - honour `Retry-After`, or apply backoff of 2 s, 4 s and 8 s;
  - cap at 4 requests in flight and about 2 requests per second;
  - always send the app's User-Agent.
- Add a per-provider token bucket in `src/providers/http.js`, configurable per provider. Free tiers can then be respected exactly: Twelve Data 8/min, Alpha Vantage 25/day.

### 0.4 #10 Provider health panel (S)
- **Data:** wrap every `getJson` call in a per-provider ring buffer of the last 300 calls (`ok`, `ms`, `status`, `at`, `error`), plus counters per minute and per day. Kept in memory; nothing is stored in the DB.
- **API:** `GET /api/admin/health` returns providers, jobs and cache size.
- **UI:**
  - A new Admin tab, **Health**, with one row per provider: success % (1 h and 24 h), median latency, requests in the last minute and today against the free-tier limit (as a `.track` bar), last error, and when it last succeeded.
  - A `.note.warn` on the Dashboard, for admins only, when a source has failed for more than 10 minutes.

### 0.5 Secret box (S)
- **Configuration:** `SECRET_KEY` env var, 32 bytes in base64. `npm run gen-secret` prints one.
- **Format:** `src/secrets.js` encrypts with AES-256-GCM (`node:crypto`) and stores `enc:v1:<iv>:<tag>:<ciphertext>`.
- **Without `SECRET_KEY`:** values stay in plain text, and Admin → Settings shows a warning.
- **Key rotation:** `SECRET_KEY_OLD` is accepted for decryption; a migration job re-encrypts everything with the new key.

### 0.6 Tests (S, then ongoing)
- Add `node --test` suites in `test/`. The `npm test` script runs them against SQLite, using a temporary database for each test.
- **First targets:** passwords, sessions, throttle, CSRF and origin checks, settings normalisation, the fallback chain in the market service (with stub providers), and the secret box.
- Each later phase adds its own tests, listed under each feature.

---

## Phase 1: Compare across markets (L)

### #1 Currency conversion (M)
**Goal:** see every share in one display currency, e.g. EUR. Today HK$376 and €4.97 can't be compared at a glance.
- **FX source:** Yahoo pairs `HKDEUR=X`, `USDEUR=X`, … (verified working), fetched for every currency on the watchlist and cached for 5 min. Each pair's previous close comes from the chart metadata.
  - **Fallback:** frankfurter.app (ECB reference rates, free, no key, updated daily). Its endpoint still needs checking when this is built.
  - The fallback is added as an `fx` provider kind in Admin → Providers, so the order is configurable like the others.
- **Calculation:**
  - The converted price is `price × rate`.
  - The default change % is the local-market change.
  - An **"Include FX move"** toggle shows `(1 + r_local) × (1 + r_fx) − 1`, which is what a EUR holder actually saw.
- **API:**
  - `GET /api/fx?base=EUR` returns rates, previous close and source.
  - `/api/quotes/equities?display=EUR` adds `converted: { price, changePct, rate }` to each row.
- **UI:**
  - A "Display currency" chip group on Shares (stored per user, see #5), with a converted price column; the local price is kept as a sub-line.
  - The Dashboard tiles, movers and market averages use the converted figures.
- **Risks:** a stale FX rate. Show the rate's time in a tooltip, and add a stale tag if it is older than 1 h on a weekday.
- **Tests:** conversion maths, FX-inclusive change, missing rate → value shown as —.

### #2 Market indices strip (S–M)
- **Data:** add a `kind` column to `watchlist_items` (`equity` | `index`). This uses the migration runner and avoids a new table.
  - Seeded defaults: `^GSPC` (S&P 500), `^IXIC` (Nasdaq), `^STOXX50E` (Euro Stoxx 50), `PSI20.LS` (PSI), `^GDAXI` (DAX), `000001.SS` (SSE Composite), `^HSI` (Hang Seng).
  - The region comes from a small index → market map; `marketOf()` currently returns `OTHER` for `^` symbols.
- **API:** `/api/quotes/equities` returns `kind`, and adds `/api/quotes/indices` (same pipeline and cache).
- **UI:**
  - A Dashboard strip at the top: one compact tile per index with value, change, open dot and sparkline.
  - Shares gets a "Type" filter chip (Shares | Indices | All).
  - Admin → Watchlist gets a kind selector; search already returns `INDEX` results.
- **Risks:** indices are extra Yahoo calls. That's 7 more symbols, all cached, and fine after 0.3.

### #3 Trading hours and countdowns (M)
- **Data:** a static schedule in `src/providers/markets.js`:

  | Market | Timezone | Regular hours | Lunch break |
  |---|---|---|---|
  | US | America/New_York | 09:30–16:00 | none |
  | EU | per exchange (e.g. Europe/Lisbon) | 08:00–16:30 local (varies by exchange) | none |
  | CN | Asia/Shanghai | 09:30–15:00 | 11:30–13:00 |
  | HK | Asia/Hong_Kong | 09:30–16:00 | 12:00–13:00 |

  Times are computed with `Intl.DateTimeFormat` and the IANA zone, with no library. Yahoo's `marketState` stays the source of truth for "open now"; the schedule is used for countdowns.
- **Holidays:**
  - There is no reliable free API for exchange holidays.
  - Add an admin-editable list per market (Admin → Settings → Market holidays: paste dates, one per line), seeded with the current year.
  - When Yahoo reports closed during scheduled hours, show "Closed (holiday?)".
- **API:** `/api/markets` returns, per market, `{ state, opensAt, closesAt, nextBreak, localTime }`.
- **UI:**
  - Market tiles show "Closes in 40 min", "Opens in 3 h 12 min" or "Lunch break, resumes 13:00", plus the market's local time.
  - The countdown updates every 30 s on the client, with no server calls.
- **Tests:** a table of instants per market, including DST changes in the US and EU and the CN/HK lunch break.

### #4 Price history stored in the DB (M)
- **Data:** a migration adds:
  - `quote_snapshots(symbol, kind, currency, price, change_pct, source, at)` with an index on `(symbol, at)`, for raw rows;
  - `quote_rollups(symbol, bucket, at, open, high, low, close)` with `bucket` in `hour` | `day`.
- **Job `snapshot`:**
  - Runs every `snapshotMinutes` (setting, default 5).
  - Snapshots only symbols whose market is open, which saves quota, plus one end-of-day snapshot at close. Bitcoin and FX are included around the clock.
  - It reuses the market service cache, so it adds no extra upstream calls when people are viewing.
- **Job `rollup` (hourly):**
  - Aggregates raw rows into hour and day buckets.
  - Retention, configurable in Admin → Settings:
    - raw rows: 1–90 days (default 7);
    - hourly: 30–3650 days (default 180);
    - daily: forever (default) or 1–50 years.
  - Lowering a retention value prunes rows on the next run; Settings shows the current row counts and database size first.
- **Use:**
  - `equityHistory` and `bitcoinHistory` read from the DB first when it covers the range, and fall back to the providers.
  - Charts then work for Finnhub and Alpha Vantage, which have no history endpoint, and while Yahoo is down.
  - It also gives #7, #14 and #15 their numbers.
- **Size:** about 30 symbols × 12 snapshots/h × 9 h × 7 days ≈ 23k raw rows. Small for both engines.
- **Tests:** rollup correctness, retention pruning, choosing the DB versus the provider.

### #7 More stats in the detail panel (S–M)
- **Calculation:** in `src/stats.js`, from the 1-year daily series (from #4 when available, otherwise provider history, cached 1 h):
  - returns over 1 week, 1 month, 3 months, year to date and 1 year;
  - distance from the 52-week high and low;
  - 30-day volatility (annualised standard deviation of daily returns);
  - maximum drawdown over 1 year.
- **Badges:** "Near 52w high" when within 3%, "Near 52w low", "New 52w high today".
- **API:** `GET /api/stats/:symbol` and `GET /api/stats?symbols=…` (batched, for tables).
- **UI:**
  - The detail panel gets a returns row (chips coloured up or down) and badges.
  - Shares gets an optional "1W / 1M / YTD" column picker.
  - The Dashboard gets a **"This week's movers"** card next to today's movers.
- **Risks:** fetching 1-year history for every symbol (about 13–30 calls/hour). It's fine with caching plus 0.3, and disappears once #4 has data.

### #6 Compare mode (M)
- **Route:** `#/compare?s=AAPL,ASML.AS,^GSPC,BTC&range=1y`. Up to 4 series: any watchlist symbol, index or `BTC`.
- **Chart:** extend `lineChart` to take several series.
  - Each line is normalised to 0% at its first point.
  - Colours come from the reference palette (`--c-vehicle`, `--c-animal`, `--c-place`, `--c-nature`), with a legend of `.chip` toggles.
  - The cursor tooltip lists every series.
  - Calendars differ (US holidays vs HK), so series are not interpolated: each line keeps its own points.
- **Table:** for each series, the range return, volatility, max drawdown, and correlation against the first series (on daily returns, joined by date).
- **Entry points:** a "Compare" button in the Shares detail panel (adds the symbol), selectable rows on Shares, and Bitcoin page → "Compare with S&P 500".
- **Optional:** the display currency from #1 applies, so a EUR investor sees ASML and AAPL in EUR terms.
- **Tests:** normalisation, correlation on misaligned dates.

---

## Phase 2: Personal and crypto (M)

### #5 Per-user views (M)
- **Data:** `user_prefs(user_id PK, value JSON, updated_at)`, holding:
  - `pinned[]` (symbols);
  - `displayCurrency`;
  - `defaultPage`;
  - `hiddenMarkets[]`;
  - `sharesFilters`, moved from localStorage into the server so they follow the user across devices.
- **API:** `GET/PUT /api/account/prefs`, validated against the watchlist and the configured currencies.
- **UI:**
  - A ☆ pin toggle on each Shares row and in the detail panel.
  - A "Pinned only" filter chip.
  - A Dashboard **"My symbols"** card (falls back to the whole watchlist when nothing is pinned).
  - Account page: default page, display currency, hidden markets.
- **Rule:** the admin-curated watchlist stays the master list; users choose a subset. Users don't add symbols, which keeps provider load controlled.

### #8 Bitcoin extras (S)
- **Sources (no key needed):**
  - Fear & Greed index from `api.alternative.me/fng/?limit=30`, cached 1 h, with 30-day history for a sparkline.
  - BTC dominance from CoinGecko `/api/v3/global`, cached 15 min.
  - Optionally, block height and recommended fees from mempool.space (`/api/blocks/tip/height`, `/api/v1/fees/recommended`).
  - All are added as a `btc-extra` provider kind, so they can be switched off in Admin → Providers.
- **Spread:** `(max − min) / median` across exchanges, as a headline figure; the data already exists on the Bitcoin page.
- **UI:**
  - The Bitcoin page gets a "Market context" card: a Fear & Greed gauge (`.track` with a marker, coloured by band) with a 30-day sparkline, dominance %, spread, and (optionally) block height and fees.
  - The Dashboard Bitcoin card gets a single Fear & Greed tag.

---

## Phase 3: Account security (M–L)

### #11 Active sessions (S)
- **Data:** a migration adds to `sessions`:
  - `id`: a random public id, separate from the token hash;
  - `last_seen_at`: updated at most every 5 min, during the sliding refresh;
  - `mfa_passed` (for #12).
- **API:**
  - `GET /api/account/sessions` returns device (a parsed user-agent summary), IP, created, last seen, and "this session".
  - `DELETE /api/account/sessions/:id` signs out one session; `DELETE /api/account/sessions` signs out all others.
  - Admin: `GET/DELETE /api/admin/users/:id/sessions`.
- **UI:** an Account → Sessions table with "Sign out" buttons. In Admin → Users, each user row links to their sessions.
- **Audit:** `session_revoked`.

### #13 Encrypt stored API keys (S)
- Use the secret box (0.5) for `settings.providers.keys`, and later for alert channel tokens (#9) and TOTP secrets (#12).
- A migration job encrypts existing plain-text keys once `SECRET_KEY` is set.
- Admin → Settings shows "Secrets: encrypted with SECRET_KEY" or "plain text, set SECRET_KEY".

### #12 TOTP two-factor sign-in + admin IP allow-list (M)
**TOTP**
- **Implementation:** RFC 6238 (HMAC-SHA1, 30 s, 6 digits) in `src/auth/totp.js` with `node:crypto`. It is unit-tested against the RFC's test vectors and allows ±1 time step.
- **Data:** a migration adds `users.totp_secret` (encrypted) and `users.totp_enabled`, plus `recovery_codes(user_id, code_hash, used_at)`: 10 single-use codes, hashed with scrypt.
- **Enrolment (Account → Two-factor):**
  - The account page shows the `otpauth://` URI and a base32 secret.
  - A QR code comes from a vendored, MIT-licensed `qrcode-generator` in `public/vendor/`. The CSP stays `'self'`.
  - Enrolment is confirmed by entering a code; recovery codes are shown once.
- **Sign-in:** the password step creates a session with `mfa_passed = 0`. Until a code arrives via `POST /api/auth/totp`, only `/api/auth/totp` and `/api/auth/logout` are allowed. This uses the same throttle as passwords.
- **Policy:** opt-in for every account; there is no "require 2FA" setting. Account → Two-factor turns it on or off; turning it off needs the current password and a valid code. Admins can reset another user's 2FA (audited), for lost phones. Admin → Users shows a 2FA column.

**Admin IP allow-list**
- **Configuration:** `ADMIN_ALLOW_CIDRS=192.168.1.0/24,10.0.0.5/32` as an env var. It is deliberately not editable in the UI, so a mistake can't lock you out remotely.
- **Effect:** `/api/admin/*` and the admin nav are refused outside these ranges. Uses `clientIp()`, so `TRUST_PROXY` must be correct.
- **Implementation:** a small CIDR matcher for IPv4 and IPv6, with tests.

---

## Phase 4: Alerts (L)

### #9 Threshold alerts
This is the first feature that works while nobody has the page open, which is why it comes after the job runner, snapshots and secret box.
- **Data:**
  - `alerts(id, owner_id NULL=global, target_kind, symbol, condition, threshold, currency, cooldown_minutes, enabled, state, last_value, last_fired_at, created_at)`.
  - `alert_events(id, alert_id, fired_at, value, message, deliveries JSON)`.
  - `alert_reads(user_id, event_id)` for the in-app unread state.
- **Conditions:**
  - price above or below a threshold (in a chosen currency, using #1);
  - daily change beyond ±X%;
  - crosses the 52-week high or low (#7);
  - Bitcoin Fear & Greed below or above a value (#8);
  - Bitcoin exchange spread above X%;
  - **ops:** a provider failing for more than N minutes (#10), or a job failing.
- **Evaluation (job `alerts`, every minute):**
  - Reads only from the market service cache and snapshots; it never forces upstream calls.
  - It fires on **crossing** (state machine: `armed` → `fired` → re-arms once the value moves back past `threshold ± hysteresis`), and respects the cooldown.
  - Closed markets are skipped.
- **Delivery channels (Admin → Notifications; secrets in the secret box):**
  - **Email (primary):**
    - Uses `nodemailer` (a regular dependency).
    - **SMTP settings:** host, port, TLS mode (`none` | `starttls` | `tls`), user, password (encrypted), From address, and an optional "allow self-signed certificate" switch for a LAN mail relay.
    - **Recipients:** each alert sends to its owner's email, plus optional extra addresses on that alert.
    - **Format:** plain text and simple HTML, with the subject line `[Mos Eisley] EDP.LS below €4.80 (€4.78, −3.1%)`.
    - **Bursts:** several alerts firing within 2 minutes are grouped into one email.
  - **In-app:** a bell with an unread count in the top bar, and a list of events.
  - **ntfy:** a POST to `https://ntfy.sh/<topic>` or your own ntfy server.
  - **Telegram bot:** bot token and chat id.
  - **Generic webhook:** a JSON POST.
  - Every channel has a "Send test" button.
- **User emails:** a migration adds `users.email` (optional, validated), editable on Account and in Admin → Users. Needed for delivery even with admin-only alerts.
- **Who:**
  - The schema has `owner_id` from the start (NULL means a global alert; otherwise the user who owns it).
  - By default only admins create alerts.
  - Setting **"Viewers can create their own alerts"** (off by default): when on, viewers can create, edit and see only their own alerts, on watchlist symbols only, with at most 20 per user. Their alerts are delivered in-app and to their own email.
  - Admins see and manage every alert.
  - The ops conditions (provider or job failures) are admin-only.
- **UI:**
  - An Alerts page with a list (state, last value, last fired) and a create/edit `<dialog>`.
  - Shares detail → "Alert me…" opens the dialog pre-filled.
  - An event history with filters.
- **Audit:** `alert_created`, `alert_updated`, `alert_deleted`, `channel_changed`.
- **Tests:** crossing and hysteresis state machine, cooldown, currency conversion, delivery retries (3× with backoff, failures recorded per event).

---

## Phase 5: LLM features (M)

Both reuse `askJson()` and the `LLM_*` env vars. Both are hidden when `LLM_ENABLED` is off.

### #14 Weekly digest (S–M)
- **Data:** a migration adds `llm_briefs.kind` (`daily` | `weekly`) and `period_start` / `period_end`.
- **Job `digest`:** runs on `digestSchedule` (setting, default `MON 08:00` server time). Input:
  - the week's returns per symbol from #4 and #7;
  - the best and worst per region;
  - index moves (#2);
  - Bitcoin's weekly range and Fear & Greed trend (#8);
  - alerts fired that week (#9).
- **Output schema:** `{ headline, sections: [{ region, summary }], bitcoin, notable[], caveat }`. Same rules as the daily brief: no invented news, no advice.
- **UI:**
  - The Dashboard brief card gets Daily | Weekly tabs.
  - A `#/digests` archive page with previous weeks.
  - Optionally, the digest is sent to a notification channel (#9).
- **Admin:** a "Generate now" button, and schedule and on/off settings.

### #15 Ask the data (M)
- **Approach (grounded and portable):**
  - The server builds a compact data pack of about 3–6 KB. Per symbol: name, market, currency, price, change today, 1W/1M/YTD/1Y returns, 52-week position and volatility (#7). Also the indices, Bitcoin plus extras, and FX.
  - The question and the pack go to `askJson` with the schema `{ answer, symbols[], figures: [{ label, value }], cannotAnswer: boolean }`.
  - The system prompt says to answer only from the pack, and otherwise to set `cannotAnswer`.
- **Checks:**
  - Every symbol in `symbols[]` must exist in the pack; unknown ones are dropped and flagged.
  - Figures are cross-checked against the pack, with a tolerance; mismatches are shown as a warning.
- **Why a data pack instead of tool calling:** it works the same on Anthropic and on LM Studio models, whose tool-calling support varies. Tool calling can come later with the same server functions.
- **API:** `POST /api/ask { question }`. Limited to 5 questions per user per 10 min. Questions are capped at 300 characters. Each one is written to the audit log as `ask`, with the full question and the model used. Answers are not logged.
- **UI:**
  - An "Ask" card on the Dashboard: an input, an answer with clickable symbol chips (they open Shares detail or Compare), and a "Based on prices as of HH:MM" line.
  - Example prompts as chips, such as "Which European shares fell most this month?" or "How did Bitcoin compare with the S&P 500 this year?".

---

## Suggested order and effort

| Step | Items | Effort |
|---|---|---|
| 1 | 0.1 migrations, 0.2 jobs, 0.3 Yahoo hardening, 0.6 tests | M |
| 2 | #10 health, 0.5 secret box, #13 key encryption | S–M |
| 3 | #2 indices, #1 FX conversion | M |
| 4 | #4 snapshots + rollups, #3 trading hours | M |
| 5 | #7 stats, #6 compare | M |
| 6 | #5 per-user views, #8 Bitcoin extras | M |
| 7 | #11 sessions, #12 TOTP + IP allow-list | M |
| 8 | #9 alerts (global v1, then personal v2) | L |
| 9 | #14 weekly digest, #15 ask the data | M |

Each step ships on its own: migrations are added as each step needs them, and new features are off or hidden until configured.

## New configuration (summary)

| Where | Setting |
|---|---|
| env | `SECRET_KEY`, `SECRET_KEY_OLD`, `ADMIN_ALLOW_CIDRS` |
| Admin → Settings | display currency default, snapshot interval, retention (raw / hourly / daily), market holidays, digest schedule, viewers can create alerts |
| Admin → Providers | `fx` and `btc-extra` kinds, per-provider rate limits |
| Admin → Notifications | SMTP email (primary), ntfy, Telegram, webhook |
| Account | email, pins, display currency, default page, hidden markets, 2FA (opt-in), sessions |

## Decisions (2026-11-17)

1. **Email is the main alert channel.** `nodemailer` becomes a regular dependency. ntfy, Telegram and webhook stay as secondary channels.
2. **Alerts are admin-only for now, but built so viewers can be switched on.** Doing both together costs almost the same: the `owner_id` column, scoped queries and per-user email addresses are all needed for admin alerts anyway. The only extra work is permission checks and a per-user cap.
   - So alerts are built with `owner_id` from the start, behind the setting **"Viewers can create their own alerts"** (default **off**).
3. **Two-factor sign-in is opt-in for every admin.** There is no "require 2FA" policy setting.
4. **Snapshot retention defaults are kept, and are configurable** in Admin → Settings:
   - raw rows: 1–90 days (default 7);
   - hourly: 30–3650 days (default 180);
   - daily: forever, or 1–50 years.
5. **Ask the data stores the full question** in the audit log (always on; there is no setting).
