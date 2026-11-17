// Per-provider call statistics, in memory: a ring buffer of recent calls plus per-minute and per-day counters.
const RING = 300;

export function createHealth() {
  const map = new Map();
  const get = (id) => {
    if (!map.has(id)) map.set(id, { ring: [], day: "", dayCount: 0, lastOkAt: null, lastErrorAt: null, lastError: null, firstFailAt: null });
    return map.get(id);
  };
  const today = () => new Date().toISOString().slice(0, 10);

  return {
    record(id, { ok, ms, status, error }) {
      const e = get(id);
      const at = Date.now();
      e.ring.push({ ok, ms, status, at });
      if (e.ring.length > RING) e.ring.shift();
      const d = today();
      if (e.day !== d) { e.day = d; e.dayCount = 0; }
      e.dayCount++;
      if (ok) { e.lastOkAt = at; e.firstFailAt = null; }
      else { e.lastErrorAt = at; e.lastError = error || `HTTP ${status}`; e.firstFailAt ??= at; }
    },
    /** Calls made today (UTC), for daily quotas. */
    dayCount(id) {
      const e = get(id);
      return e.day === today() ? e.dayCount : 0;
    },
    /** Milliseconds a provider has been failing without a success, or 0. */
    failingFor(id) {
      const e = map.get(id);
      return e?.firstFailAt ? Date.now() - e.firstFailAt : 0;
    },
    snapshot() {
      const now = Date.now();
      const out = {};
      for (const [id, e] of map) {
        const hour = e.ring.filter((r) => r.at > now - 3600_000);
        const ms = hour.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
        out[id] = {
          callsLastMinute: e.ring.filter((r) => r.at > now - 60_000).length,
          callsLastHour: hour.length,
          callsToday: e.day === today() ? e.dayCount : 0,
          successPctHour: hour.length ? Math.round((hour.filter((r) => r.ok).length / hour.length) * 100) : null,
          successPctRecent: e.ring.length ? Math.round((e.ring.filter((r) => r.ok).length / e.ring.length) * 100) : null,
          medianMs: ms.length ? ms[Math.floor(ms.length / 2)] : null,
          lastOkAt: e.lastOkAt && new Date(e.lastOkAt).toISOString(),
          lastErrorAt: e.lastErrorAt && new Date(e.lastErrorAt).toISOString(),
          lastError: e.lastError,
          failingForMs: e.firstFailAt ? now - e.firstFailAt : 0,
          recent: e.ring.slice(-60).map((r) => (r.ok ? 1 : 0)),
        };
      }
      return out;
    },
  };
}
