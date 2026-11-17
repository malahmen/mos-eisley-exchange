// Password hashing with scrypt (node:crypto, no dependency).
// Stored as "scrypt$N$r$p$<salt b64>$<hash b64>" so parameters can be raised later
// without invalidating existing hashes.
import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";

const N = 16384, R = 8, P = 1, KEYLEN = 64;
const MAXMEM = 64 * 1024 * 1024;

const derive = (password, salt, n, r, p) =>
  new Promise((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key))),
  );

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, "base64");
  const key = await derive(password, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// A hash of a random password, compared against when the username does not exist,
// so "no such user" and "wrong password" take the same time.
let dummy;
export async function burnTime(password) {
  dummy ??= await hashPassword(randomBytes(12).toString("hex"));
  await verifyPassword(password, dummy);
}

export const PASSWORD_MIN = 10;

export function passwordProblem(password, username = "") {
  if (typeof password !== "string" || password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > 256) return "Use at most 256 characters.";
  if (username && password.toLowerCase().includes(username.toLowerCase())) return "The password must not contain the username.";
  if (new Set(password).size < 4) return "The password is too repetitive.";
  return null;
}

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
export const normalizeUsername = (u) => String(u || "").trim().toLowerCase();
