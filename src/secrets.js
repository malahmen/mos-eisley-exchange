// Secret box: AES-256-GCM with SECRET_KEY (32 bytes, base64 or hex). Values are stored as
// "enc:v1:<iv>:<tag>:<ciphertext>" (base64url). Without SECRET_KEY, values stay in plain text
// and Admin → Settings says so. SECRET_KEY_OLD is accepted for decryption during a key rotation.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";

function parseKey(raw, name) {
  if (!raw) return null;
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error(`${name} must be 32 bytes (base64 or 64 hex characters). Generate one with: npm run gen-secret`);
  return key;
}

export function createSecrets({ key, oldKey } = {}) {
  const current = parseKey(key, "SECRET_KEY");
  const previous = parseKey(oldKey, "SECRET_KEY_OLD");

  function decryptWith(k, value) {
    const [ivB, tagB, ctB] = value.slice(PREFIX.length).split(":");
    const d = createDecipheriv("aes-256-gcm", k, Buffer.from(ivB, "base64url"));
    d.setAuthTag(Buffer.from(tagB, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ctB, "base64url")), d.final()]).toString("utf8");
  }

  return {
    enabled: !!current,
    isSealed: (v) => typeof v === "string" && v.startsWith(PREFIX),
    /** Encrypts with the current key (or returns the value unchanged when no key is set). */
    seal(plain) {
      if (plain == null || plain === "") return plain;
      if (!current) return String(plain);
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", current, iv);
      const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
      return `${PREFIX}${iv.toString("base64url")}:${c.getAuthTag().toString("base64url")}:${ct.toString("base64url")}`;
    },
    /** Decrypts a sealed value; plain values pass through. Throws if no key can open it. */
    open(value) {
      if (typeof value !== "string" || !value.startsWith(PREFIX)) return value;
      for (const k of [current, previous]) {
        if (!k) continue;
        try { return decryptWith(k, value); } catch { /* try the next key */ }
      }
      throw new Error("A stored secret cannot be decrypted: SECRET_KEY changed? Set the previous one as SECRET_KEY_OLD.");
    },
    /** True when the value should be rewritten: plain text while a key exists, or sealed with the old key. */
    needsReseal(value) {
      if (!current || value == null || value === "") return false;
      if (typeof value !== "string" || !value.startsWith(PREFIX)) return true;
      try { decryptWith(current, value); return false; } catch { return true; }
    },
  };
}
