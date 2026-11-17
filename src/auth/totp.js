// TOTP (RFC 6238: HMAC-SHA1, 30 s steps, 6 digits) with node:crypto. Unit-tested against the RFC vectors.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("Invalid base32 secret");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function hotp(key, counter, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", key).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / 30);

/**
 * Checks a 6-digit code against the base32 secret within ±window steps.
 * Returns the matched step (store it to refuse replays), or null. Steps <= lastStep are refused.
 */
export function verifyTotp(secretB32, code, { now = Date.now(), window = 1, lastStep = 0 } = {}) {
  const c = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const key = base32Decode(secretB32);
  const cur = stepAt(now);
  for (let d = -window; d <= window; d++) {
    const step = cur + d;
    if (step <= lastStep) continue;
    const expected = Buffer.from(hotp(key, step));
    if (timingSafeEqual(expected, Buffer.from(c))) return step;
  }
  return null;
}

export const generateSecret = () => base32Encode(randomBytes(20));

export function otpauthUri({ issuer, account, secret }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/** Ten single-use recovery codes like "k7qp-2xmd". */
export function generateRecoveryCodes(n = 10) {
  const abc = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: n }, () => {
    const b = randomBytes(8);
    const s = [...b].map((x) => abc[x % abc.length]).join("");
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}
