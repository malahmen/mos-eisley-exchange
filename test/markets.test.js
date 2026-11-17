import { test } from "node:test";
import assert from "node:assert/strict";
import { marketClock, zonedToUtc, marketOf } from "../src/providers/markets.js";
import { computeStats, maxDrawdown, correlation } from "../src/stats.js";
import { convertQuote } from "../src/providers/fx.js";
import { parseSlot, slotMatches } from "../src/jobs.js";

const at = (iso) => Date.parse(iso);

test("zonedToUtc handles DST in New York", () => {
  assert.equal(new Date(zonedToUtc("America/New_York", 2026, 7, 1, 9, 30)).toISOString(), "2026-07-01T13:30:00.000Z"); // EDT
  assert.equal(new Date(zonedToUtc("America/New_York", 2026, 12, 1, 9, 30)).toISOString(), "2026-12-01T14:30:00.000Z"); // EST
});

test("US clock: open, closed overnight, weekend, holiday", () => {
  assert.equal(marketClock("US", at("2026-11-17T15:00:00Z")).state, "open");
  const night = marketClock("US", at("2026-11-17T22:00:00Z"));
  assert.equal(night.state, "closed");
  assert.equal(night.opensAt, "2026-11-18T14:30:00.000Z");
  const sat = marketClock("US", at("2026-11-21T15:00:00Z"));
  assert.equal(sat.opensAt, "2026-11-23T14:30:00.000Z");
  const thanksgiving = marketClock("US", at("2026-11-26T15:00:00Z"), ["2026-11-26"]);
  assert.equal(thanksgiving.state, "closed");
  assert.ok(thanksgiving.holidayToday);
  assert.equal(thanksgiving.opensAt, "2026-11-27T14:30:00.000Z");
});

test("Shanghai and Hong Kong lunch breaks", () => {
  const cnLunch = marketClock("CN", at("2026-11-18T04:00:00Z")); // 12:00 Shanghai
  assert.equal(cnLunch.state, "break");
  assert.equal(cnLunch.resumesAt, "2026-11-18T05:00:00.000Z");
  const cnMorning = marketClock("CN", at("2026-11-18T02:00:00Z")); // 10:00
  assert.equal(cnMorning.state, "open");
  assert.equal(cnMorning.breakAt, "2026-11-18T03:30:00.000Z");
  assert.equal(marketClock("HK", at("2026-11-18T04:30:00Z")).state, "break"); // 12:30 HK
  assert.equal(marketClock("HK", at("2026-11-18T07:30:00Z")).state, "open"); // 15:30 HK
});

test("market of a symbol", () => {
  assert.equal(marketOf("AAPL"), "US");
  assert.equal(marketOf("EDP.LS"), "EU");
  assert.equal(marketOf("600519.SS"), "CN");
  assert.equal(marketOf("0700.HK"), "HK");
  assert.equal(marketOf("^HSI"), "HK");
  assert.equal(marketOf("PSI20.LS"), "EU");
  assert.equal(marketOf("EURUSD=X"), "OTHER");
});

test("stats: returns, 52-week range, badges", () => {
  const now = at("2026-11-17T00:00:00Z");
  const pts = [];
  for (let d = 400; d >= 0; d--) pts.push([now - d * 86400_000, 100 + (400 - d) * 0.1]); // steady climb 100 -> 140
  const s = computeStats(pts, { now });
  assert.ok(Math.abs(s.r1w - ((140 / 139.3) - 1) * 100) < 0.01);
  assert.equal(s.hi52, 140);
  assert.ok(s.badges.includes("near-52w-high"));
  assert.ok(s.ytd > 0 && s.r1y > 0);
  const s2 = computeStats(pts, { now, price: 141 });
  assert.ok(s2.badges.includes("new-52w-high"));
});

test("max drawdown and correlation", () => {
  assert.equal(Math.round(maxDrawdown([[1, 100], [2, 120], [3, 90], [4, 130]])), -25);
  const day = 86400_000;
  const a = [], b = [], c = [];
  for (let i = 0; i < 30; i++) {
    const v = 100 + Math.sin(i) * 5;
    a.push([i * day, v]); b.push([i * day, v * 2]); c.push([i * day, 200 - v]);
  }
  assert.ok(correlation(a, b) > 0.99);
  assert.ok(correlation(a, c) < -0.99);
  assert.equal(correlation(a.slice(0, 5), b.slice(0, 5)), null);
});

test("FX conversion, with and without the day's FX move", () => {
  const q = { price: 100, changePct: 2 };
  const fx = { rate: 0.5, prevRate: 0.49 };
  assert.equal(convertQuote(q, fx).price, 50);
  assert.equal(convertQuote(q, fx).changePct, 2);
  const withFx = convertQuote(q, fx, true).changePct;
  assert.ok(Math.abs(withFx - ((1.02 * (0.5 / 0.49)) - 1) * 100) < 1e-9);
  assert.equal(convertQuote(q, { rate: 0.5, prevRate: null }, true).changePct, 2);
});

test("job slots", () => {
  assert.deepEqual(parseSlot("mon 08:00"), { day: "MON", hour: 8, minute: 0 });
  assert.equal(parseSlot("MON 25:00"), null);
  const monday8 = new Date(2026, 10, 16, 8, 0);
  assert.ok(slotMatches(parseSlot("MON 08:00"), monday8));
  assert.ok(slotMatches(parseSlot("DAILY 08:00"), monday8));
  assert.ok(!slotMatches(parseSlot("TUE 08:00"), monday8));
});
