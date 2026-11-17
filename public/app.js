// Single-page shell: hash router, navigation, notification bell, theme. Pages live in ./pages/.
import { h, put, api, state, setStatus, store } from "./ui.js";
import { makePoller, pageHead, errorNote } from "./common.js";
import { dashboardPage } from "./pages/dashboard.js";
import { bitcoinPage } from "./pages/bitcoin.js";
import { sharesPage } from "./pages/shares.js";
import { comparePage } from "./pages/compare.js";
import { alertsPage } from "./pages/alerts.js";
import { digestsPage } from "./pages/digests.js";
import { accountPage } from "./pages/account.js";
import { adminPage } from "./admin.js";

const view = document.getElementById("view");

// ---------------------------------------------------------------- theme
const THEME_ICONS = { auto: "◐", light: "☀", dark: "☾" };
function applyTheme(choice) {
  store.set("theme-choice", choice);
  try { if (choice === "auto") localStorage.removeItem("mex-theme"); else localStorage.setItem("mex-theme", choice); } catch { /* blocked */ }
  if (choice === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
  const btn = document.getElementById("themeToggle");
  btn.textContent = THEME_ICONS[choice];
  btn.setAttribute("aria-label", `Theme: ${choice}`);
  btn.title = `Theme: ${choice}`;
}

// ---------------------------------------------------------------- router
const PAGES = {
  dashboard: dashboardPage, bitcoin: bitcoinPage, shares: sharesPage, compare: comparePage, alerts: alertsPage,
  digests: digestsPage, admin: adminPage, account: (root, rest, ctx) => accountPage(root, rest, ctx, applyTheme),
};
const TITLES = { dashboard: "Dashboard", bitcoin: "Bitcoin", shares: "Shares", compare: "Compare", alerts: "Alerts", digests: "Digests", admin: "Admin", account: "Account" };
let current = { name: null, poll: null, api: null };

function parseHash() {
  const [path] = location.hash.replace(/^#\/?/, "").split("?");
  const [name, ...rest] = path.split("/").filter(Boolean);
  return { name: PAGES[name] ? name : null, rest };
}

async function route() {
  let { name, rest } = parseHash();
  name ||= state.me.prefs.defaultPage || "dashboard";
  if (state.me.user.mustChangePassword) name = "account";
  if (name === "admin" && !state.me.features.adminAllowed) name = "dashboard";
  for (const a of document.querySelectorAll(".nav a")) {
    if (a.dataset.page === name) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  document.getElementById("nav").classList.remove("open");
  document.getElementById("menuToggle").setAttribute("aria-expanded", "false");
  if (current.name === name && current.api?.update) {
    current.api.update(rest);
    return;
  }
  current.poll?.stop();
  const poll = makePoller();
  current = { name, poll, api: null };
  setStatus("");
  put(view, h("p", { class: "skeleton" }, "Loading…"));
  document.title = `${TITLES[name]} · Mos Eisley Exchange`;
  try {
    const pageApi = await PAGES[name](view, rest, { poll });
    if (current.poll === poll) current.api = pageApi || null;
  } catch (err) {
    if (current.poll === poll) put(view, pageHead("Something went wrong", null), errorNote(err));
  }
}

// ---------------------------------------------------------------- notification bell
async function refreshBell() {
  const badge = document.getElementById("bellCount");
  try {
    const { unread } = await api("/api/alerts/unread");
    badge.textContent = unread > 99 ? "99+" : String(unread);
    badge.hidden = !unread;
    document.getElementById("bell").setAttribute("aria-label", unread ? `${unread} new notifications` : "Notifications");
  } catch { /* keep the last value */ }
}

async function boot() {
  try {
    const me = await api("/api/me");
    state.me = me;
    state.csrf = me.csrf;
  } catch {
    return; // api() already redirected to /login
  }
  const f = state.me.features;
  document.getElementById("navAdmin").hidden = !f.adminAllowed;
  document.getElementById("navAlerts").hidden = !f.alerts;
  document.getElementById("bell").hidden = !f.alerts;
  document.getElementById("userLink").textContent = state.me.user.username;
  applyTheme(store.get("theme-choice", "auto"));
  document.getElementById("themeToggle").addEventListener("click", () => {
    const order = ["auto", "light", "dark"];
    applyTheme(order[(order.indexOf(store.get("theme-choice", "auto")) + 1) % 3]);
  });
  document.getElementById("menuToggle").addEventListener("click", (e) => {
    const nav = document.getElementById("nav");
    nav.classList.toggle("open");
    e.currentTarget.setAttribute("aria-expanded", String(nav.classList.contains("open")));
  });
  document.getElementById("logout").addEventListener("click", async () => {
    try { await api("/api/auth/logout", { method: "POST" }); } finally { location.href = "/login"; }
  });
  window.addEventListener("hashchange", route);
  window.addEventListener("mex:unread", refreshBell);
  if (f.alerts) {
    refreshBell();
    const bellTimer = () => setTimeout(async () => { if (!document.hidden) await refreshBell(); bellTimer(); }, 60_000);
    bellTimer();
  }
  route();
}

boot();
