import { test } from "node:test";
import assert from "node:assert/strict";
import { hotp, verifyTotp, base32Encode, base32Decode, generateSecret, generateRecoveryCodes } from "../src/auth/totp.js";
import { hashPassword, verifyPassword, passwordProblem } from "../src/auth/passwords.js";
import { createThrottle } from "../src/auth/throttle.js";
import { createAllowList, parseIp } from "../src/auth/cidr.js";
import { createSecrets } from "../src/secrets.js";
import { randomBytes } from "node:crypto";

test("TOTP matches the RFC 6238 SHA-1 vectors", () => {
  const key = Buffer.from("12345678901234567890");
  // RFC 6238 appendix B, 8 digits; T = floor(t / 30)
  assert.equal(hotp(key, Math.floor(59 / 30), 8), "94287082");
  assert.equal(hotp(key, Math.floor(1111111109 / 30), 8), "07081804");
  assert.equal(hotp(key, Math.floor(1234567890 / 30), 8), "89005924");
  assert.equal(hotp(key, Math.floor(20000000000 / 30), 8), "65353130");
});

test("TOTP verify: window, replay protection, format", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  const now = 1111111109 * 1000;
  const code = hotp(base32Decode(secret), Math.floor(1111111109 / 30));
  const step = verifyTotp(secret, code, { now });
  assert.equal(step, Math.floor(1111111109 / 30));
  assert.equal(verifyTotp(secret, code, { now, lastStep: step }), null, "same step twice is refused");
  assert.ok(verifyTotp(secret, code, { now: now + 30_000 }), "one step late is accepted");
  assert.equal(verifyTotp(secret, code, { now: now + 120_000 }), null, "four steps late is refused");
  assert.equal(verifyTotp(secret, "12345"), null);
  assert.equal(verifyTotp(secret, "abcdef"), null);
});

test("base32 round trip and generated material", () => {
  const b = randomBytes(20);
  assert.deepEqual(base32Decode(base32Encode(b)), b);
  assert.match(generateSecret(), /^[A-Z2-7]{32}$/);
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 10);
  for (const c of codes) assert.match(c, /^[a-z0-9]{4}-[a-z0-9]{4}$/);
});

test("password hashing and policy", async () => {
  const h = await hashPassword("correct horse battery");
  assert.ok(await verifyPassword("correct horse battery", h));
  assert.ok(!(await verifyPassword("wrong", h)));
  assert.ok(passwordProblem("short"));
  assert.ok(passwordProblem("bob-is-great-123", "bob"));
  assert.ok(passwordProblem("aaaaaaaaaaaa"));
  assert.equal(passwordProblem("tatooine-sunset-77", "bob"), null);
});

test("login throttle locks after five failures", () => {
  const t = createThrottle();
  for (let i = 0; i < 5; i++) t.failure("1.2.3.4", "carol");
  assert.equal(t.check("1.2.3.4", "carol"), 0);
  t.failure("1.2.3.4", "carol");
  assert.ok(t.check("1.2.3.4", "carol") > 25_000);
  assert.ok(t.check("9.9.9.9", "carol") > 0, "the username is locked from any address");
  t.success("carol");
  assert.equal(t.check("9.9.9.9", "carol"), 0);
  assert.ok(t.check("1.2.3.4", "dave") > 0, "the address stays locked");
});

test("CIDR allow-list for IPv4, IPv6 and mapped addresses", () => {
  const allow = createAllowList("192.168.1.0/24, 10.0.0.5, fd00::/8");
  assert.ok(allow("192.168.1.77"));
  assert.ok(!allow("192.168.2.1"));
  assert.ok(allow("10.0.0.5"));
  assert.ok(!allow("10.0.0.6"));
  assert.ok(allow("::ffff:192.168.1.3"));
  assert.ok(allow("fd12:3456::1"));
  assert.ok(!allow("2001:db8::1"));
  assert.equal(createAllowList(""), null);
  assert.equal(parseIp("::1").v, 6);
  assert.throws(() => createAllowList("300.1.1.1/8"));
});

test("secret box: seal, open, rotation, plain text passthrough", () => {
  const k1 = randomBytes(32).toString("base64"), k2 = randomBytes(32).toString("base64");
  const s1 = createSecrets({ key: k1 });
  const sealed = s1.seal("api-key-123");
  assert.match(sealed, /^enc:v1:/);
  assert.equal(s1.open(sealed), "api-key-123");
  assert.equal(s1.open("plain"), "plain");
  assert.ok(s1.needsReseal("plain"));
  assert.ok(!s1.needsReseal(sealed));
  const s2 = createSecrets({ key: k2, oldKey: k1 });
  assert.equal(s2.open(sealed), "api-key-123", "old key still opens");
  assert.ok(s2.needsReseal(sealed), "but asks to be re-sealed");
  assert.throws(() => createSecrets({ key: k2 }).open(sealed));
  const none = createSecrets({});
  assert.equal(none.seal("x"), "x");
  assert.throws(() => createSecrets({ key: "short" }));
});
