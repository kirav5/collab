// Small helpers shared by the views.
export const $ = (s, el = document) => el.querySelector(s);
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const now = () => Math.floor(Date.now() / 1000);
export const id = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export function money(amount, period) {
  if (amount == null) return "";
  const v = Math.round(amount);
  const s = v >= 1e7 ? `₹${+(v / 1e7).toFixed(2)} Cr` : v >= 1e5 ? `₹${+(v / 1e5).toFixed(2)} L` : "₹" + v.toLocaleString("en-IN");
  return s + (period ? `/${period}` : "");
}

export function time(t) { return new Date(t * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }

export function toast(text, onClick) {
  const el = document.createElement("div");
  el.textContent = text;
  if (onClick) el.onclick = () => { onClick(); el.remove(); };
  $("#toast").append(el);
  setTimeout(() => el.remove(), 5000);
}

export const label = (text, cls = "") => `<span class="label ${cls}">${esc(text)}</span>`;
export const tag = (text, cls = "") => `<span class="tag ${cls}">${esc(text)}</span>`;

export function tierTag(tier, topics) {
  if (tier === "private") return tag("On device", "peri");
  if (tier === "protected") return tag(`Protected${topics?.length ? " · " + topics.join(", ") : ""}`, "accent");
  return tag("Public", "fresh");
}

/** Who did this: Gemini, the rules, the owner, or the owner's device. */
export const byTag = b => (b === "gemini" ? tag("✦ Gemini", "accent") : b === "owner" ? tag("Owner", "ink") : b === "device" ? tag("Device", "peri") : b === "rules" ? tag("Rules") : "");

export function busy(btn, on, text = "…") {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> ${esc(text)}`; }
  else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
}
