import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, step } from "../src/alerts/engine.js";

const base = { condition: "price_above", symbol: "AAPL", currency: "USD", threshold: 100, hysteresisPct: 1, cooldownMinutes: 60, state: "armed", lastFiredAt: null };
const quote = (price, extra = {}) => ({ quote: { price, changePct: 1, marketState: "open", currency: "USD", ...extra } });

test("fires once on crossing, re-arms only past the hysteresis band", () => {
  let a = { ...base };
  const t0 = Date.parse("2026-11-17T15:00:00Z");
  let s = step(a, evaluate(a, quote(99)), t0);
  assert.deepEqual(s, { state: "armed", fire: false });
  s = step(a, evaluate(a, quote(101)), t0);
  assert.deepEqual(s, { state: "fired", fire: true });
  a = { ...a, state: "fired", lastFiredAt: new Date(t0).toISOString() };
  assert.equal(step(a, evaluate(a, quote(102)), t0 + 60_000).fire, false, "no repeat while above");
  assert.equal(step(a, evaluate(a, quote(99.5)), t0 + 60_000).state, "fired", "inside the 1% band: still fired");
  const re = step(a, evaluate(a, quote(98.9)), t0 + 120_000);
  assert.equal(re.state, "armed");
  a = { ...a, state: "armed" };
  assert.equal(step(a, evaluate(a, quote(101)), t0 + 180_000).fire, false, "cooldown blocks a quick refire");
  assert.equal(step(a, evaluate(a, quote(101)), t0 + 3_700_000).fire, true, "fires after the cooldown");
});

test("skips closed markets and stale quotes", () => {
  assert.ok(evaluate(base, quote(150, { marketState: "closed" })).skip);
  assert.ok(evaluate(base, quote(150, { stale: true })).skip);
  assert.ok(evaluate(base, { quote: null }).skip);
  const s = step(base, { skip: true });
  assert.deepEqual(s, { state: "armed", fire: false });
});

test("daily change, sentiment and ops conditions", () => {
  const up = { ...base, condition: "change_up", threshold: 3 };
  assert.ok(evaluate(up, quote(1, { changePct: 3.2 })).active);
  assert.ok(!evaluate(up, quote(1, { changePct: 2.9 })).active);
  const abs = { ...base, condition: "change_abs", threshold: 3 };
  assert.ok(evaluate(abs, quote(1, { changePct: -3.5 })).active);
  const fng = { ...base, condition: "fng_below", threshold: 20, symbol: "" };
  assert.ok(evaluate(fng, { fearGreed: 12 }).active);
  assert.ok(evaluate(fng, { fearGreed: null }).skip);
  const down = { ...base, condition: "provider_down", symbol: "yahoo", threshold: 10 };
  assert.ok(evaluate(down, { failingMinutes: 12 }).active);
  assert.ok(evaluate(down, { failingMinutes: 0 }).rearm);
  const job = { ...base, condition: "job_failing", symbol: "" };
  const r = evaluate(job, { jobError: "snapshot: boom" });
  assert.ok(r.active);
  assert.match(r.text, /snapshot: boom/);
});

test("messages read naturally", () => {
  assert.equal(evaluate(base, quote(101.5)).text, "AAPL: Price rises above 100 USD. Now 101.5 USD.");
  const fall = { ...base, condition: "change_down", threshold: 2 };
  assert.equal(evaluate(fall, quote(1, { changePct: -2.5 })).text, "AAPL: Falls more than 2%. Now -2.50%.");
});
