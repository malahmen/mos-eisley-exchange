// Weekly digest archive (LLM).
import { h, put, api, state, dateTimeStr } from "../ui.js";
import { pageHead, errorNote, isAdmin } from "../common.js";

export async function digestsPage(root) {
  const list = h("div", { class: "stack" });
  const status = h("div", { class: "status", role: "status" });
  const btn = isAdmin() && state.me.features.adminAllowed ? h("button", { class: "btn ghost sm", type: "button" }, "Generate now") : null;
  put(root, pageHead("Weekly digests", "A longer read of each week, written by the configured LLM from the app's own figures."),
    btn ? h("div", { class: "addrow" }, btn, status) : null, list);

  async function load() {
    let r;
    try { r = await api("/api/digests?limit=30"); } catch (err) { put(list, errorNote(err)); return; }
    if (!r.enabled) { put(list, h("div", { class: "note plain" }, "LLM not configured (LLM_ENABLED is off).")); if (btn) btn.disabled = true; return; }
    if (!r.digests.length) { put(list, h("p", { class: "small muted" }, "No digests yet. They are generated on the schedule set in Admin → Settings.")); return; }
    put(list, r.digests.map((d) => h("article", { class: "card" },
      h("h2", null, d.headline),
      h("p", { class: "small muted" }, `Week ${dateTimeStr(d.periodStart)} – ${dateTimeStr(d.periodEnd)} · ${d.model}`),
      d.sections.map((s) => h("p", null, h("strong", null, `${s.region}: `), s.summary)),
      d.bitcoin ? h("p", null, h("strong", null, "Bitcoin: "), d.bitcoin) : null,
      d.notable.length ? [h("h3", null, "Notable"), h("ul", { class: "small tight" }, d.notable.map((x) => h("li", null, x)))] : null,
      h("p", { class: "small muted" }, d.caveat))));
  }
  btn?.addEventListener("click", async () => {
    btn.disabled = true;
    status.textContent = "Generating… this can take a few minutes.";
    status.className = "status";
    try {
      const r = await api("/api/admin/digest/run", { method: "POST" });
      status.textContent = r.delivery?.email ? `Done. Email: ${r.delivery.email}` : "Done.";
      await load();
    } catch (err) {
      status.textContent = err.message;
      status.className = "status bad";
    } finally {
      btn.disabled = false;
    }
  });
  await load();
}
