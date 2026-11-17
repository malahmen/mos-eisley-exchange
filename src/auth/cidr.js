// CIDR matching for IPv4 and IPv6 (ADMIN_ALLOW_CIDRS). IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) match IPv4 ranges.

function parseV4(s) {
  const p = s.split(".");
  if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null;
  return p.reduce((a, x) => (a << 8n) | BigInt(x), 0n);
}

function parseV6(s) {
  let str = s.toLowerCase();
  // A trailing dotted IPv4 part ("::ffff:1.2.3.4") becomes two hex groups ("::ffff:102:304").
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(str);
  if (v4) {
    const n = parseV4(v4[1]);
    if (n == null) return null;
    str = `${str.slice(0, -v4[1].length)}${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}`;
  }
  const halves = str.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const groups = [...head, ...Array(Math.max(0, fill)).fill("0"), ...rest];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.reduce((a, g) => (a << 16n) | BigInt(parseInt(g, 16)), 0n);
}

export function parseIp(s) {
  s = String(s || "").trim().replace(/^\[|\]$/g, "");
  const v4 = parseV4(s);
  if (v4 != null) return { v: 4, n: v4 };
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  if (m) return { v: 4, n: parseV4(m[1]) };
  const v6 = parseV6(s);
  return v6 != null ? { v: 6, n: v6 } : null;
}

export function parseCidr(s) {
  const [addr, bitsRaw] = String(s).trim().split("/");
  const ip = parseIp(addr);
  if (!ip) throw new Error(`Invalid address in ADMIN_ALLOW_CIDRS: "${s}"`);
  const max = ip.v === 4 ? 32 : 128;
  const bits = bitsRaw === undefined ? max : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > max) throw new Error(`Invalid prefix length in ADMIN_ALLOW_CIDRS: "${s}"`);
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(max - bits);
  return { v: ip.v, net: ip.n & mask, mask };
}

/** Returns a matcher, or null when the list is empty (everything allowed). */
export function createAllowList(spec) {
  const ranges = String(spec || "").split(/[\s,]+/).filter(Boolean).map(parseCidr);
  if (!ranges.length) return null;
  const fn = (ip) => {
    const a = parseIp(ip);
    return !!a && ranges.some((r) => r.v === a.v && (a.n & r.mask) === r.net);
  };
  fn.ranges = String(spec).split(/[\s,]+/).filter(Boolean);
  return fn;
}
