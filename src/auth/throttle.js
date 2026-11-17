// Login throttling, in memory: per client address and per username.
// After FREE failed attempts, each further failure locks that key for 30 s, doubling up to 15 min.
// A successful login clears the username's counter (not the address's, so one
// valid account cannot be used to reset guessing against others).
const FREE = 5;
const BASE_MS = 30_000;
const MAX_MS = 15 * 60_000;
const FORGET_MS = 60 * 60_000;

export function createThrottle() {
  const entries = new Map(); // key -> { fails, lockedUntil, last }

  function lockedFor(key) {
    const e = entries.get(key);
    if (!e) return 0;
    if (Date.now() - e.last > FORGET_MS) {
      entries.delete(key);
      return 0;
    }
    return Math.max(0, e.lockedUntil - Date.now());
  }

  function fail(key) {
    const e = entries.get(key) || { fails: 0, lockedUntil: 0, last: 0 };
    e.fails++;
    e.last = Date.now();
    if (e.fails > FREE) e.lockedUntil = Date.now() + Math.min(MAX_MS, BASE_MS * 2 ** (e.fails - FREE - 1));
    entries.set(key, e);
  }

  // Keep the map from growing without bound.
  setInterval(() => {
    const cutoff = Date.now() - FORGET_MS;
    for (const [k, e] of entries) if (e.last < cutoff) entries.delete(k);
  }, 10 * 60_000).unref();

  return {
    /** Milliseconds the caller must wait, or 0. */
    check(ip, username) {
      return Math.max(lockedFor(`ip:${ip}`), username ? lockedFor(`user:${username}`) : 0);
    },
    failure(ip, username) {
      fail(`ip:${ip}`);
      if (username) fail(`user:${username}`);
    },
    success(username) {
      entries.delete(`user:${username}`);
    },
  };
}
