// In-process job runner. One instance of the app is assumed (a LAN box); a job never overlaps itself,
// and a failing job is recorded and retried at its next slot.
//   { name, everySeconds, run }            fixed interval (first run after `delaySeconds`, default = interval)
//   { name, at: () => "MON 08:00", run }   weekly / daily slot ("DAILY 06:00"), server local time, checked each minute
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

export function parseSlot(spec) {
  const m = /^(DAILY|SUN|MON|TUE|WED|THU|FRI|SAT)\s+([01]?\d|2[0-3]):([0-5]\d)$/i.exec(String(spec || "").trim());
  if (!m) return null;
  return { day: m[1].toUpperCase(), hour: Number(m[2]), minute: Number(m[3]) };
}

export function slotMatches(slot, date) {
  if (!slot) return false;
  if (slot.day !== "DAILY" && DAYS[date.getDay()] !== slot.day) return false;
  return date.getHours() === slot.hour && date.getMinutes() === slot.minute;
}

export function createJobs({ log = console.log } = {}) {
  const jobs = new Map();
  let ticker = null;

  async function runJob(job, reason = "schedule") {
    if (job.running) return { skipped: true };
    job.running = true;
    const started = Date.now();
    try {
      const result = await job.run({ reason });
      job.lastError = null;
      job.lastResult = result ?? null;
      return { ok: true, result };
    } catch (err) {
      job.lastError = err.message;
      job.failures++;
      log(`Job ${job.name} failed: ${err.message}`);
      return { ok: false, error: err.message };
    } finally {
      job.running = false;
      job.runs++;
      job.lastRunAt = new Date().toISOString();
      job.lastDurationMs = Date.now() - started;
    }
  }

  function schedule(job) {
    if (!job.everySeconds) return;
    const seconds = typeof job.everySeconds === "function" ? job.everySeconds() : job.everySeconds;
    job.timer = setTimeout(async () => {
      if (job.enabled()) await runJob(job);
      schedule(job);
    }, Math.max(5, seconds) * 1000);
    job.timer.unref?.();
  }

  return {
    add(def) {
      const job = {
        enabled: () => true, delaySeconds: undefined, ...def,
        running: false, runs: 0, failures: 0, lastRunAt: null, lastDurationMs: null, lastError: null, lastResult: null,
      };
      jobs.set(job.name, job);
      return job;
    },
    start() {
      for (const job of jobs.values()) {
        if (job.everySeconds) {
          if (job.delaySeconds !== undefined) {
            setTimeout(async () => { if (job.enabled()) await runJob(job, "startup"); }, job.delaySeconds * 1000).unref?.();
          }
          schedule(job);
        }
      }
      // Slot jobs: check once a minute, aligned to the minute.
      const tick = () => {
        const now = new Date();
        for (const job of jobs.values()) {
          if (job.at && job.enabled() && slotMatches(parseSlot(job.at()), now)) runJob(job);
        }
        ticker = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
        ticker.unref?.();
      };
      ticker = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
      ticker.unref?.();
    },
    stop() {
      clearTimeout(ticker);
      for (const job of jobs.values()) clearTimeout(job.timer);
    },
    run(name, reason = "manual") {
      const job = jobs.get(name);
      if (!job) throw Object.assign(new Error(`No job "${name}"`), { status: 404 });
      return runJob(job, reason);
    },
    status() {
      return [...jobs.values()].map((j) => ({
        name: j.name, description: j.description || "", enabled: j.enabled(), running: j.running,
        schedule: j.at ? j.at() : `every ${typeof j.everySeconds === "function" ? j.everySeconds() : j.everySeconds} s`,
        runs: j.runs, failures: j.failures, lastRunAt: j.lastRunAt, lastDurationMs: j.lastDurationMs, lastError: j.lastError,
      }));
    },
  };
}
