// Alert conditions and the crossing state machine. Pure functions: unit-tested without a database.
// An alert fires when its condition becomes true while "armed", then waits ("fired") until the value
// moves back past threshold ± hysteresis before it can fire again; a cooldown also applies.

export const CONDITIONS = {
  price_above:   { label: "Price rises above", target: "symbol", unit: "price", needsCurrency: true },
  price_below:   { label: "Price falls below", target: "symbol", unit: "price", needsCurrency: true },
  change_up:     { label: "Rises more than (% today)", target: "symbol", unit: "%" },
  change_down:   { label: "Falls more than (% today)", target: "symbol", unit: "%" },
  change_abs:    { label: "Moves more than ± (% today)", target: "symbol", unit: "%" },
  high52:        { label: "Makes a new 52-week high", target: "symbol", unit: null },
  low52:         { label: "Makes a new 52-week low", target: "symbol", unit: null },
  fng_below:     { label: "Bitcoin Fear & Greed falls below", target: null, unit: "index" },
  fng_above:     { label: "Bitcoin Fear & Greed rises above", target: null, unit: "index" },
  btc_spread_above: { label: "Bitcoin price gap between exchanges above (%)", target: null, unit: "%", needsCurrency: true },
  provider_down: { label: "Data source failing for (minutes)", target: "provider", unit: "min", adminOnly: true },
  job_failing:   { label: "Background job failing", target: "job", unit: null, adminOnly: true },
};

export const CHANNELS = ["inapp", "email", "ntfy", "telegram", "webhook"];
export const VIEWER_CHANNELS = ["inapp", "email"];

const fmt = (v, unit, currency) => {
  if (v == null || !Number.isFinite(v)) return "—";
  if (unit === "price") return `${v.toLocaleString("en-US", { maximumFractionDigits: v < 10 ? 4 : 2 })} ${currency || ""}`.trim();
  if (unit === "%") return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
  if (unit === "min") return `${Math.round(v)} min`;
  return String(Math.round(v * 100) / 100);
};

/**
 * Computes { value, active, rearm, skip?, text } for an alert from prepared data:
 * data = { quote, stats, fearGreed, spreadPct, failingMinutes, jobError }
 */
export function evaluate(alert, data) {
  const c = alert.condition;
  const t = Number(alert.threshold);
  const h = Math.abs(t) * (Number(alert.hysteresisPct ?? 0.5) / 100);
  const def = CONDITIONS[c];
  if (!def) return { skip: true, reason: "unknown condition" };
  const q = data.quote;
  const needsQuote = def.target === "symbol";
  if (needsQuote) {
    if (!q || q.price == null) return { skip: true, reason: "no quote" };
    if (q.stale) return { skip: true, reason: "stale quote" };
    if (q.marketState && !["open", "always"].includes(q.marketState)) return { skip: true, reason: "market closed" };
  }
  let value, active, rearm;
  switch (c) {
    case "price_above": value = q.price; active = value > t; rearm = value < t - h; break;
    case "price_below": value = q.price; active = value < t; rearm = value > t + h; break;
    case "change_up": value = q.changePct; active = value >= t; rearm = value < t - Math.max(h, 0.1); break;
    case "change_down": value = q.changePct; active = value <= -t; rearm = value > -t + Math.max(h, 0.1); break;
    case "change_abs": value = q.changePct; active = Math.abs(value) >= t; rearm = Math.abs(value) < t - Math.max(h, 0.1); break;
    case "high52":
      if (!data.stats) return { skip: true, reason: "no history" };
      value = q.price; active = data.stats.badges.includes("new-52w-high"); rearm = (data.stats.fromHigh ?? 0) < -1; break;
    case "low52":
      if (!data.stats) return { skip: true, reason: "no history" };
      value = q.price; active = data.stats.badges.includes("new-52w-low"); rearm = (data.stats.fromLow ?? 0) > 1; break;
    case "fng_below":
      if (data.fearGreed == null) return { skip: true, reason: "no index" };
      value = data.fearGreed; active = value < t; rearm = value > t + Math.max(h, 2); break;
    case "fng_above":
      if (data.fearGreed == null) return { skip: true, reason: "no index" };
      value = data.fearGreed; active = value > t; rearm = value < t - Math.max(h, 2); break;
    case "btc_spread_above":
      if (data.spreadPct == null) return { skip: true, reason: "fewer than two sources" };
      value = data.spreadPct; active = value > t; rearm = value < t - Math.max(h, 0.05); break;
    case "provider_down":
      value = data.failingMinutes ?? 0; active = value >= t; rearm = value === 0; break;
    case "job_failing":
      value = data.jobError ? 1 : 0; active = !!data.jobError; rearm = !data.jobError; break;
    default: return { skip: true };
  }
  if (value == null || !Number.isFinite(value)) return { skip: true, reason: "no value" };
  const who = def.target === "symbol" ? alert.symbol : def.target === "provider" ? `Source ${alert.symbol}` : def.target === "job" ? `Job ${alert.symbol || "(any)"}` : "Bitcoin";
  const label = def.label.replace(/ \(.*\)$/, "");
  const thresholdText = !def.unit ? "" : def.unit === "%" ? ` ${t}%` : ` ${fmt(t, def.unit, alert.currency)}`;
  const nowText = def.unit ? ` Now ${fmt(value, def.unit, alert.currency)}.` : ` Price ${fmt(value, "price", q?.currency)}.`;
  const text = `${who}: ${label}${thresholdText}.${c === "job_failing" ? ` ${data.jobError || ""}` : nowText}`;
  return { value, active, rearm, text: text.trim() };
}

/** The crossing state machine. Returns { state, fire }. */
export function step(alert, result, now = Date.now()) {
  if (result.skip) return { state: alert.state, fire: false };
  const cooldownOk = !alert.lastFiredAt || now - Date.parse(alert.lastFiredAt) >= (alert.cooldownMinutes ?? 60) * 60_000;
  if (alert.state !== "fired") {
    if (result.active && cooldownOk) return { state: "fired", fire: true };
    return { state: "armed", fire: false };
  }
  if (result.rearm) return { state: "armed", fire: false };
  return { state: "fired", fire: false };
}
