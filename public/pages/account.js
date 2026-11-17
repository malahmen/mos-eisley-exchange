// Account: password, email, preferences, appearance, two-factor sign-in, active sessions.
import { h, put, api, state, chipGroup, store, relTime, dateTimeStr } from "../ui.js";
import { pageHead, errorNote, savePrefs, marketName } from "../common.js";

function form(fields, submitLabel, onSubmit) {
  const msg = h("div", { class: "status", role: "status", "aria-live": "polite" });
  const f = h("form", { class: "form", novalidate: true },
    fields.map((x) => h("label", { class: "field" }, h("span", null, x.label, x.hint ? h("span", { class: "hint" }, ` ${x.hint}`) : null),
      h("input", { type: x.type || "text", name: x.name, value: x.value || "", autocomplete: x.autocomplete || "off", inputmode: x.inputmode }))),
    h("div", null, h("button", { class: "btn", type: "submit" }, submitLabel)), msg);
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    msg.textContent = "";
    msg.className = "status";
    try {
      const r = await onSubmit(Object.fromEntries(new FormData(f)), f);
      if (r) msg.textContent = r;
    } catch (err) {
      msg.textContent = err.message;
      msg.className = "status bad";
    }
  });
  return f;
}

export async function accountPage(root, _rest, _ctx, applyTheme) {
  const u = state.me.user;
  const p = state.me.prefs;
  const twofa = h("div", { class: "card" }), sessionsCard = h("div", { class: "card section" });

  const pw = form([
    { name: "current", label: "Current password", type: "password", autocomplete: "current-password" },
    { name: "next", label: "New password", type: "password", hint: "at least 10 characters", autocomplete: "new-password" },
    { name: "next2", label: "Repeat new password", type: "password", autocomplete: "new-password" },
  ], "Change password", async (v, f) => {
    if (v.next !== v.next2) throw new Error("The new passwords do not match.");
    await api("/api/account/password", { method: "POST", body: { current: v.current, next: v.next } });
    f.reset();
    if (state.me.user.mustChangePassword) {
      state.me.user.mustChangePassword = false;
      setTimeout(() => (location.hash = "#/dashboard"), 900);
    }
    loadSessions();
    return "Password changed. Other sessions were signed out.";
  });

  const email = form([{ name: "email", label: "Email address", type: "email", value: u.email, hint: "for alerts and digests", autocomplete: "email" }],
    "Save email", async (v) => {
      const r = await api("/api/account/email", { method: "PUT", body: { email: v.email } });
      state.me.user.email = r.email;
      return r.email ? "Saved." : "Removed.";
    });

  const themeNow = store.get("theme-choice", "auto");
  const disp = p.displayCurrency === null ? "default" : p.displayCurrency;
  const prefsCard = h("div", { class: "card" },
    h("h2", null, "Preferences"),
    chipGroup("Start page", [{ value: "dashboard", label: "Dashboard" }, { value: "shares", label: "Shares" }, { value: "bitcoin", label: "Bitcoin" }, { value: "compare", label: "Compare" }],
      p.defaultPage, (v) => { savePrefs({ defaultPage: v }); accountPage(root, _rest, _ctx, applyTheme); }),
    chipGroup("Show shares in", [{ value: "default", label: `Default (${state.me.general.displayCurrency || "local"})` }, { value: "", label: "Local" },
      ...state.me.general.cryptoCurrencies.map((c) => ({ value: c, label: c }))], disp,
    (v) => { savePrefs({ displayCurrency: v === "default" ? null : v }); accountPage(root, _rest, _ctx, applyTheme); }),
    h("label", { class: "check" }, h("input", { type: "checkbox", checked: p.includeFx, onchange: (e) => savePrefs({ includeFx: e.target.checked }) }), "Include the day's currency move in converted changes"),
    h("h3", { style: { marginTop: "12px" } }, "Hide markets"),
    h("div", { class: "chips" }, Object.keys(state.me.markets).filter((m) => m !== "OTHER").map((m) => h("label", { class: "check" },
      h("input", { type: "checkbox", checked: (p.hiddenMarkets || []).includes(m), onchange: (e) => {
        const set = new Set(state.me.prefs.hiddenMarkets || []);
        if (e.target.checked) set.add(m); else set.delete(m);
        savePrefs({ hiddenMarkets: [...set] });
      } }), marketName(m)))),
    h("p", { class: "small muted" }, "Saved to your account, on every device. Hidden markets are left out of the dashboard."),
    chipGroup("Theme", [{ value: "auto", label: "Auto" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }], themeNow,
      (v) => { applyTheme(v); accountPage(root, _rest, _ctx, applyTheme); }));

  put(root,
    pageHead("Account", null),
    u.mustChangePassword ? h("div", { class: "note warn" }, "An admin set a temporary password for you. Choose your own before continuing.") : null,
    h("div", { class: "layout" },
      h("div", { class: "stack" },
        h("div", { class: "card" }, h("h2", null, "Signed in as"), h("p", null, h("strong", null, u.username), h("span", { class: `tag ${u.role === "admin" ? "admin" : ""}` }, u.role))),
        h("div", { class: "card" }, h("h2", null, "Change password"), pw),
        h("div", { class: "card" }, h("h2", null, "Email"), email)),
      h("div", { class: "stack" }, twofa, prefsCard)),
    sessionsCard);

  // ---------------------------------------------------------------- two-factor
  async function renderTwofa(extra) {
    let s;
    try { s = await api("/api/account/2fa"); } catch (err) { put(twofa, errorNote(err)); return; }
    if (extra) { put(twofa, extra); return; }
    if (!s.enabled) {
      put(twofa, h("h2", null, "Two-factor sign-in ", h("span", { class: "tag" }, "off")),
        h("p", { class: "small muted" }, "Ask for a 6-digit code from an authenticator app (Aegis, Google Authenticator, 1Password…) after your password."),
        form([{ name: "password", label: "Current password", type: "password", autocomplete: "current-password" }], "Set up", async (v) => {
          const r = await api("/api/account/2fa/setup", { method: "POST", body: { password: v.password } });
          const qr = h("div", { class: "qr", role: "img", "aria-label": "QR code for the authenticator app" });
          qr.innerHTML = r.qrSvg; // generated by the server from our own data
          renderTwofa([
            h("h2", null, "Scan with your authenticator app"),
            qr,
            h("p", { class: "small" }, "Or enter this key: ", h("code", null, r.secret)),
            form([{ name: "code", label: "Code from the app", inputmode: "numeric", autocomplete: "one-time-code" }], "Turn on", async (c) => {
              const res = await api("/api/account/2fa/enable", { method: "POST", body: { code: c.code } });
              state.me.user.totpEnabled = true;
              showCodes(res.recoveryCodes);
            }),
            h("button", { class: "btn ghost sm", type: "button", onclick: () => renderTwofa() }, "Cancel"),
          ]);
        }));
      return;
    }
    put(twofa, h("h2", null, "Two-factor sign-in ", h("span", { class: "tag open" }, "on")),
      h("p", { class: "small muted" }, `${s.recoveryLeft} recovery code(s) left.${s.secretsEncrypted ? "" : " The secret is stored unencrypted: an admin can set SECRET_KEY."}`),
      h("details", null, h("summary", { class: "small" }, "New recovery codes"),
        form([{ name: "password", label: "Current password", type: "password", autocomplete: "current-password" }], "Generate new codes", async (v) => {
          const r = await api("/api/account/2fa/recovery", { method: "POST", body: { password: v.password } });
          showCodes(r.recoveryCodes);
        })),
      h("details", null, h("summary", { class: "small" }, "Turn off"),
        form([
          { name: "password", label: "Current password", type: "password", autocomplete: "current-password" },
          { name: "code", label: "Code from the app (or a recovery code)", autocomplete: "one-time-code" },
        ], "Turn off two-factor", async (v) => {
          await api("/api/account/2fa/disable", { method: "POST", body: v });
          state.me.user.totpEnabled = false;
          renderTwofa();
        })));
  }
  function showCodes(codes) {
    renderTwofa([
      h("h2", null, "Recovery codes"),
      h("div", { class: "note warn" }, "Save these now: each one signs you in once if you lose your phone. They will not be shown again."),
      h("pre", { class: "codes" }, codes.join("\n")),
      h("button", { class: "btn", type: "button", onclick: () => renderTwofa() }, "I saved them"),
    ]);
  }

  // ---------------------------------------------------------------- sessions
  async function loadSessions() {
    let r;
    try { r = await api("/api/account/sessions"); } catch (err) { put(sessionsCard, errorNote(err)); return; }
    put(sessionsCard,
      h("div", { class: "cardhead" }, h("h2", null, "Active sessions ", h("span", { class: "tag" }, String(r.sessions.length))),
        r.sessions.length > 1 ? h("button", { class: "btn ghost sm", type: "button", onclick: async () => { await api("/api/account/sessions", { method: "DELETE" }); loadSessions(); } }, "Sign out all others") : null),
      h("div", { class: "tablewrap" }, h("table", { class: "data" },
        h("thead", null, h("tr", null, h("th", null, "Device"), h("th", null, "Address"), h("th", null, "Signed in"), h("th", null, "Last seen"), h("th", null, ""))),
        h("tbody", null, r.sessions.map((s) => h("tr", null,
          h("td", null, s.device, s.current ? h("span", { class: "tag open" }, "this one") : null, s.mfaPending ? h("span", { class: "tag" }, "code pending") : null),
          h("td", { class: "small mono" }, s.ip || "—"),
          h("td", { class: "small", title: s.createdAt }, dateTimeStr(s.createdAt)),
          h("td", { class: "small muted" }, relTime(s.lastSeenAt)),
          h("td", { class: "num" }, s.current ? "" : h("button", { class: "btn ghost sm", type: "button", onclick: async () => { await api(`/api/account/sessions/${encodeURIComponent(s.id)}`, { method: "DELETE" }); loadSessions(); } }, "Sign out"))))))));
  }

  await Promise.all([renderTwofa(), loadSessions()]);
}
