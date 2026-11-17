// Sign-in (password, then a two-factor code when enabled) and first-run setup.
const status = document.getElementById("status");
const say = (msg, kind = "") => { status.textContent = msg; status.className = `status ${kind}`; };
let csrf = "";

async function post(path, body) {
  const res = await fetch(path, {
    method: "POST", credentials: "same-origin", body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function wire(form, handler) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    say("");
    try {
      await handler(Object.fromEntries(new FormData(form)));
    } catch (err) {
      say(err.message, "bad");
    } finally {
      btn.disabled = false;
    }
  });
}

const login = document.getElementById("login");
const totp = document.getElementById("totp");

async function showTotp() {
  const s = await (await fetch("/api/auth/status", { credentials: "same-origin" })).json();
  if (!s.mfaPending) return false;
  csrf = s.csrf;
  document.getElementById("totpWho").textContent = `Signed in as ${s.username}. Enter the 6-digit code from your authenticator app, or one of your recovery codes.`;
  login.hidden = true;
  totp.hidden = false;
  totp.querySelector("input").focus();
  return true;
}

if (login) {
  wire(login, async ({ username, password }) => {
    if (!username || !password) throw new Error("Enter your username and password.");
    const r = await post("/api/auth/login", { username, password });
    if (r.mfaRequired) { await showTotp(); return; }
    location.replace(r.mustChangePassword ? "/#/account" : "/");
  });
  wire(totp, async ({ code }) => {
    const r = await post("/api/auth/totp", { code: code.trim() });
    location.replace(r.mustChangePassword ? "/#/account" : "/");
  });
  document.getElementById("cancelTotp").addEventListener("click", async () => {
    try { await post("/api/auth/logout", {}); } catch { /* already gone */ }
    csrf = "";
    totp.hidden = true;
    login.hidden = false;
    say("");
  });
  showTotp().catch(() => {});
}

const setup = document.getElementById("setup");
if (setup) {
  wire(setup, async ({ username, password, password2 }) => {
    if (password !== password2) throw new Error("The passwords do not match.");
    await post("/api/setup", { username, password });
    location.replace("/");
  });
}
