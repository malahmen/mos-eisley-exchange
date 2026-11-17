// Market regions, exchange codes, trading schedules and a timezone-aware market clock (Intl only, no library).
// Symbol suffixes use Yahoo notation. mic: ISO 10383 exchange code (Twelve Data). av: Alpha Vantage suffix.
export const SUFFIXES = {
  "":   { market: "US", mic: "",     av: "",     label: "US" },
  LS:   { market: "EU", mic: "XLIS", av: null,   label: "Euronext Lisbon" },
  PA:   { market: "EU", mic: "XPAR", av: "PAR",  label: "Euronext Paris" },
  AS:   { market: "EU", mic: "XAMS", av: "AMS",  label: "Euronext Amsterdam" },
  BR:   { market: "EU", mic: "XBRU", av: "BRU",  label: "Euronext Brussels" },
  IR:   { market: "EU", mic: "XDUB", av: null,   label: "Euronext Dublin" },
  OL:   { market: "EU", mic: "XOSL", av: null,   label: "Oslo" },
  MI:   { market: "EU", mic: "XMIL", av: null,   label: "Milan" },
  MC:   { market: "EU", mic: "XMAD", av: null,   label: "Madrid" },
  DE:   { market: "EU", mic: "XETR", av: "DEX",  label: "Xetra" },
  F:    { market: "EU", mic: "XFRA", av: "FRK",  label: "Frankfurt" },
  L:    { market: "EU", mic: "XLON", av: "LON",  label: "London" },
  SW:   { market: "EU", mic: "XSWX", av: null,   label: "SIX Swiss" },
  ST:   { market: "EU", mic: "XSTO", av: null,   label: "Stockholm" },
  CO:   { market: "EU", mic: "XCSE", av: null,   label: "Copenhagen" },
  HE:   { market: "EU", mic: "XHEL", av: null,   label: "Helsinki" },
  SS:   { market: "CN", mic: "XSHG", av: "SHH",  label: "Shanghai" },
  SZ:   { market: "CN", mic: "XSHE", av: "SHZ",  label: "Shenzhen" },
  HK:   { market: "HK", mic: "XHKG", av: null,   label: "Hong Kong" },
  T:    { market: "OTHER", mic: "XJPX", av: null, label: "Tokyo" },
  TO:   { market: "OTHER", mic: "XTSE", av: "TRT", label: "Toronto" },
  AX:   { market: "OTHER", mic: "XASX", av: null, label: "ASX" },
  BO:   { market: "OTHER", mic: "XBOM", av: "BSE", label: "Bombay" },
  NS:   { market: "OTHER", mic: "XNSE", av: null, label: "NSE India" },
  SA:   { market: "OTHER", mic: "BVMF", av: "SAO", label: "B3 São Paulo" },
};

export const MARKETS = {
  US: "United States",
  EU: "Europe",
  CN: "Mainland China",
  HK: "Hong Kong",
  OTHER: "Other",
};

// Index symbols (Yahoo) and their region.
export const INDEX_MARKETS = {
  "^GSPC": "US", "^IXIC": "US", "^DJI": "US", "^RUT": "US", "^NDX": "US",
  "^STOXX50E": "EU", "^STOXX": "EU", "^GDAXI": "EU", "^FCHI": "EU", "^FTSE": "EU", "^AEX": "EU", "^IBEX": "EU", "PSI20.LS": "EU", "FTSEMIB.MI": "EU",
  "000001.SS": "CN", "399001.SZ": "CN", "000300.SS": "CN",
  "^HSI": "HK", "^HSCE": "HK",
  "^N225": "OTHER",
};

export const DEFAULT_INDICES = [
  ["^GSPC", "S&P 500"], ["^IXIC", "Nasdaq Composite"], ["^STOXX50E", "Euro Stoxx 50"], ["^GDAXI", "DAX"],
  ["PSI20.LS", "PSI"], ["000001.SS", "SSE Composite"], ["^HSI", "Hang Seng"],
];

/** Splits "EDP.LS" into { base: "EDP", suffix: "LS" }. Index (^GSPC) and FX (EURUSD=X) symbols keep no suffix. */
export function splitSymbol(symbol) {
  const m = /^(.+?)\.([A-Z]{1,3})$/.exec(symbol);
  if (m && SUFFIXES[m[2]]) return { base: m[1], suffix: m[2] };
  return { base: symbol, suffix: "" };
}

export function marketOf(symbol) {
  if (INDEX_MARKETS[symbol]) return INDEX_MARKETS[symbol];
  if (/[=^]/.test(symbol)) return "OTHER";
  const { suffix } = splitSymbol(symbol);
  return SUFFIXES[suffix]?.market || "OTHER";
}

export const isIndexSymbol = (symbol) => symbol.startsWith("^") || !!INDEX_MARKETS[symbol];

// ---------------------------------------------------------------- trading schedules
// One representative schedule per region (the region tile). Yahoo's per-quote marketState stays the
// truth for "open now"; this drives countdowns. Europe: Euronext/Xetra hours, which match Lisbon and
// London (08:00–16:30 local) in absolute time.
export const SCHEDULES = {
  US: { zone: "America/New_York", sessions: [["09:30", "16:00"]], exchange: "NYSE / Nasdaq" },
  EU: { zone: "Europe/Paris", sessions: [["09:00", "17:30"]], exchange: "Euronext / Xetra" },
  CN: { zone: "Asia/Shanghai", sessions: [["09:30", "11:30"], ["13:00", "15:00"]], exchange: "Shanghai / Shenzhen" },
  HK: { zone: "Asia/Hong_Kong", sessions: [["09:30", "12:00"], ["13:00", "16:00"]], exchange: "HKEX" },
};

// Seed list (edit in Admin → Settings). Verify against the exchanges' own calendars; CN/HK change yearly
// with the lunar calendar, so they start empty.
export const DEFAULT_HOLIDAYS = {
  US: ["2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
    "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24"],
  EU: ["2026-12-24", "2026-12-25", "2026-12-31", "2027-01-01", "2027-03-26", "2027-03-29", "2027-12-24", "2027-12-31"],
  CN: [],
  HK: [],
};

const partFmts = new Map();
function zonedParts(zone, ms) {
  if (!partFmts.has(zone)) {
    partFmts.set(zone, new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }));
  }
  const p = Object.fromEntries(partFmts.get(zone).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second };
}

function offsetMs(zone, ms) {
  const p = zonedParts(zone, ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** The UTC instant of a wall-clock time in `zone` (handles DST: the offset is re-checked at the result). */
export function zonedToUtc(zone, y, m, d, hh, mm) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let utc = guess - offsetMs(zone, guess);
  const second = offsetMs(zone, utc);
  if (guess - second !== utc) utc = guess - second;
  return utc;
}

const pad = (n) => String(n).padStart(2, "0");

/**
 * State of a region's market at `now`: { state: open|break|closed, opensAt?, closesAt?, resumesAt?, dayCloseAt?,
 * holidayToday, localTime, zone }. Times are ISO strings.
 */
export function marketClock(market, now = Date.now(), holidays = []) {
  const s = SCHEDULES[market];
  if (!s) return null;
  const today = zonedParts(s.zone, now);
  const iso = (ms) => new Date(ms).toISOString();
  const base = { zone: s.zone, exchange: s.exchange, localTime: `${pad(today.hour)}:${pad(today.minute)}`, holidayToday: false };
  for (let k = 0; k < 15; k++) {
    const dt = new Date(Date.UTC(today.year, today.month - 1, today.day + k));
    const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1, d = dt.getUTCDate();
    const wd = dt.getUTCDay();
    const day = `${y}-${pad(m)}-${pad(d)}`;
    if (wd === 0 || wd === 6) continue;
    if (holidays.includes(day)) {
      if (k === 0) base.holidayToday = true;
      continue;
    }
    const sessions = s.sessions.map(([a, b]) => {
      const [ah, am] = a.split(":").map(Number), [bh, bm] = b.split(":").map(Number);
      return [zonedToUtc(s.zone, y, m, d, ah, am), zonedToUtc(s.zone, y, m, d, bh, bm)];
    });
    const dayClose = sessions[sessions.length - 1][1];
    for (let i = 0; i < sessions.length; i++) {
      const [a, b] = sessions[i];
      if (now < a) {
        return i > 0
          ? { ...base, state: "break", resumesAt: iso(a), dayCloseAt: iso(dayClose) }
          : { ...base, state: "closed", opensAt: iso(a) };
      }
      if (now < b) {
        return {
          ...base, state: "open", closesAt: iso(b), dayCloseAt: iso(dayClose),
          breakAt: i < sessions.length - 1 ? iso(b) : null,
        };
      }
    }
  }
  return { ...base, state: "closed" };
}
