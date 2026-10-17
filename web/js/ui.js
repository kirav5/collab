// Small helpers shared by the views.
export const $ = (s, el = document) => el.querySelector(s);
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const now = () => Math.floor(Date.now() / 1000);
export const id = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export function money(amount, period, currency = "INR") {
  if (amount == null) return "";
  if (currency !== "INR") return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount) + (period ? `/${period}` : "");
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

/**
 * An avatar made from the name: a hue and two shapes picked by a hash of the handle, so the same person always
 * gets the same one and no two neighbours look alike — no photos needed (a photo, when there is one, replaces it).
 */
export function avatarHTML(name, handle = "", size = 30, photo = null) {
  if (photo) return `<img class="avatar" src="${esc(photo)}" alt="" width="${size}" height="${size}" style="width:${size}px;height:${size}px;object-fit:cover">`;
  const key = String(handle || name || "?");
  let h = 2166136261; for (const ch of key) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const hue = h % 360, shape = (h >>> 8) % 4, rot = (h >>> 12) % 360, initial = String(name || "?").trim().slice(0, 1).toUpperCase();
  const shapes = [`<circle cx="22" cy="10" r="9" />`, `<rect x="12" y="2" width="16" height="16" rx="3" transform="rotate(${rot % 45} 20 10)" />`, `<polygon points="20,1 29,18 11,18" />`, `<path d="M4 14 Q16 -4 28 14 T28 14" />`];
  return `<svg class="avatar" viewBox="0 0 30 30" width="${size}" height="${size}" style="width:${size}px;height:${size}px" aria-hidden="true">
    <rect width="30" height="30" rx="6" fill="hsl(${hue} 55% 88%)"/><g fill="hsl(${(hue + 40) % 360} 60% 62%)" opacity=".9">${shapes[shape]}</g>
    <text x="15" y="21" text-anchor="middle" font-size="14" font-weight="700" font-family="-apple-system,Inter,sans-serif" fill="hsl(${hue} 50% 22%)">${esc(initial)}</text></svg>`;
}

export const label = (text, cls = "") => `<span class="label ${cls}">${esc(text)}</span>`;
export const tag = (text, cls = "") => `<span class="tag ${cls}">${esc(text)}</span>`;

export function tierTag(tier, topics) {
  if (tier === "private") return tag("Private", "peri");
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

/**
 * How to call someone in a sentence: a person by their first name ("Riya"), a business by its whole name ("Steel
 * Bottle Store" — never "Steel").
 */
/** A person by first name ("Dr. Mehta" keeps the title), a business in full — the server names owners the same way
 *  in their agents' lines (server/src/market/roles.ts shortName). */
export function shortName(name = "") {
  const trimmed = String(name ?? "").trim(), words = trimmed.split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  const business = words.length >= 3 || /\b(store|stores|shop|mart|traders?|enterprises?|academy|studio|services?|centre|center|kitchen|cafe|café|bakery|clinic|salon|agency|rentals?|motors|pvt|ltd|llp|co\.?|tiffins?|foods?|tech|technologies|labs?|solutions|systems|software|digital|media|consulting|infotech)\b/i.test(trimmed);
  if (business) return trimmed;
  return /^(mr|mrs|ms|miss|dr|prof|shri|smt|sri)\.?$/i.test(words[0]) && words[1] ? `${words[0]} ${words[1]}` : words[0];
}

/**
 * The app's own confirmation: a question, an optional reason (or a word to type), Confirm / Cancel — drawn in the page,
 * so no browser can block or restyle it. `as`: the demo person this decision is made for, shown at the top. Resolves to
 * what was typed ("" when there's no field) on Confirm, or null on Cancel, Escape or a tap outside.
 */
export function ask({ title, detail = "", ok = "Confirm", cancel = "Cancel", danger = false, as = null, input = null } = {}) {
  return new Promise(resolve => {
    const d = document.createElement("dialog");
    d.className = "ask";
    d.setAttribute("aria-label", title);
    d.innerHTML = `<form class="ask-body">
      ${as ? `<span class="ask-as">Deciding as ${esc(as)} · demo</span>` : ""}
      <p class="ask-title">${esc(title)}</p>
      ${detail ? `<p class="ask-detail">${esc(detail)}</p>` : ""}
      ${input ? `<label class="ask-field"><span class="label">${esc(input.label ?? (input.required ? "Required" : "Optional"))}</span><input class="field" name="text" maxlength="${input.max ?? 300}" placeholder="${esc(input.placeholder ?? "")}" autocomplete="off"></label>` : ""}
      <div class="ask-actions"><button type="button" class="btn quiet compact" data-ask="cancel">${esc(cancel)}</button><button type="submit" class="btn ${danger ? "danger" : "accent"} compact" data-ask="ok">${esc(ok)}</button></div>
    </form>`;
    const field = d.querySelector("input"), go = d.querySelector('[data-ask="ok"]');
    const valid = () => !input || ((!input.required || field.value.trim().length >= (input.min ?? 1)) && (!input.match || field.value.trim() === input.match));
    if (input) { const sync = () => { go.disabled = !valid(); }; field.addEventListener("input", sync); sync(); }
    let done = false;
    const finish = v => { if (done) return; done = true; d.close(); d.remove(); resolve(v); };
    d.querySelector('[data-ask="cancel"]').addEventListener("click", () => finish(null));
    d.addEventListener("cancel", ev => { ev.preventDefault(); finish(null); }); // Escape
    d.addEventListener("click", ev => { if (ev.target === d) finish(null); }); // a tap outside the box
    d.querySelector("form").addEventListener("submit", ev => { ev.preventDefault(); if (valid()) finish(field ? field.value.trim() : ""); });
    document.body.append(d);
    d.showModal();
    (field ?? go).focus();
  });
}
