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

/**
 * A notice in the app's own look: a hairline card with a coloured edge for what kind it is, a small mono label, the
 * title and a line under it, an action when tapping does something, and a bar that runs out (paused while the pointer
 * or keyboard focus is on it). At most three at once; the same notice isn't shown twice in a row.
 *   kind: "attention" (needs you) · "success" · "error" · "deal" · "info" (default)
 */
const KINDS = { attention: ["Needs you", "mark"], success: ["Done", "check"], error: ["Problem", "alert"], deal: ["Deal", "activity"], info: ["Collab", "mark"] };
let lastNotice = { key: "", at: 0 };
export function notice({ title, body = "", kind = "info", label: kicker, action, onClick, ttl } = {}) {
  const box = $("#toast");
  if (!box || !title) return;
  const key = `${kind}|${title}|${body}`;
  if (key === lastNotice.key && Date.now() - lastNotice.at < 2500) return;
  lastNotice = { key, at: Date.now() };
  const [word, glyph] = KINDS[kind] ?? KINDS.info;
  const el = document.createElement("div");
  el.className = `note note-${kind in KINDS ? kind : "info"}${onClick ? " tappable" : ""}`;
  el.setAttribute("role", kind === "error" || kind === "attention" ? "alert" : "status");
  const life = ttl ?? (kind === "attention" || kind === "error" ? 8000 : 4500);
  el.style.setProperty("--life", `${life}ms`);
  el.innerHTML = `<span class="note-ico" aria-hidden="true">${glyph === "mark" ? logo() : icon(glyph, 16)}</span>
    <span class="note-main"><span class="note-kicker">${esc(kicker ?? word)}</span><b class="note-title">${esc(title)}</b>${body ? `<span class="note-body">${esc(body)}</span>` : ""}
      ${onClick ? `<span class="note-action" role="button" tabindex="0">${esc(action ?? "Open")} ›</span>` : ""}</span>
    <button class="note-x" type="button" aria-label="Dismiss">${icon("x", 16)}</button><span class="note-bar" aria-hidden="true"></span>`;
  let timer = null, left = life, started = Date.now(), over = false, inside = false;
  const close = () => { clearTimeout(timer); el.classList.add("leaving"); setTimeout(() => el.remove(), 180); };
  const run = () => { started = Date.now(); timer = setTimeout(close, left); el.classList.remove("paused"); };
  const hold = () => {
    const paused = el.classList.contains("paused");
    if ((over || inside) && !paused) { clearTimeout(timer); left -= Date.now() - started; el.classList.add("paused"); }
    else if (!over && !inside && paused) run();
  };
  el.addEventListener("pointerenter", () => { over = true; hold(); });
  el.addEventListener("pointerleave", () => { over = false; hold(); });
  el.addEventListener("focusin", () => { inside = true; hold(); });
  el.addEventListener("focusout", e => { inside = el.contains(e.relatedTarget); hold(); });
  el.querySelector(".note-x").onclick = e => { e.stopPropagation(); close(); };
  // Said once to screen readers through the page's one live region (the notice itself isn't a second live region).
  if (kind !== "error" && kind !== "attention") { el.removeAttribute("role"); const sr = document.getElementById("sr-live"); if (sr) { sr.textContent = ""; setTimeout(() => { sr.textContent = `${title}${body ? `. ${body}` : ""}`; }, 50); } }
  if (onClick) el.onclick = () => { onClick(); close(); };
  // The action works from the keyboard too (Enter or Space), as a tap on the notice does.
  el.querySelector(".note-action")?.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.click(); } });
  box.append(el);
  while (box.children.length > 3) box.firstElementChild.remove();
  run();
}

/**
 * The short form used across the app: one line of text (a "Title — detail" splits into title and line), an optional
 * tap action, and its kind — given, or read from the words ("Sent…", "Saved…" are done; "Couldn't…" is a problem).
 */
export function toast(text, onClick, kind) {
  const t = String(text ?? "").replace(/^[\u{1F300}-\u{1FAFF}\u2600-\u27BF]\uFE0F?\s*/u, "").trim();
  if (!t) return;
  const [title, ...rest] = t.split(" — ");
  const k = kind ?? (/^(couldn'?t|can'?t|something went wrong|error|failed|not allowed|that (isn'?t|doesn'?t))\b/i.test(t) ? "error"
    : /^(✓|sent|saved|paid|done|copied|link copied|published|booked|added|removed|marked|all \d+ receipts check out|your receipt checks out|thanks)\b/i.test(t) ? "success" : "info");
  const body = rest.join(" — ");
  notice({ title, body: body ? body[0].toUpperCase() + body.slice(1) : "", kind: k, onClick });
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
  // The fills are the light look; .av-bg / .av-ink with --h let the dark look darken the tile (styles.css).
  return `<svg class="avatar" viewBox="0 0 30 30" width="${size}" height="${size}" style="--h:${hue};width:${size}px;height:${size}px" aria-hidden="true">
    <rect class="av-bg" width="30" height="30" rx="6" fill="hsl(${hue} 55% 88%)"/><g fill="hsl(${(hue + 40) % 360} 60% 62%)" opacity=".9">${shapes[shape]}</g>
    <text class="av-ink" x="15" y="21" text-anchor="middle" font-size="14" font-weight="700" font-family="-apple-system,Inter,sans-serif" fill="hsl(${hue} 50% 22%)">${esc(initial)}</text></svg>`;
}

/** One outline icon set (Lucide shapes, ISC licence), drawn in the text colour — never emoji as icons. */
const ICONS = {
  menu: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  activity: '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
  receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M14 8H8"/><path d="M16 12H8"/><path d="M13 16H8"/>',
  card: '<rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3"/><path d="M21 21v.01"/><path d="M12 7v3a2 2 0 0 1-2 2H7"/><path d="M3 12h.01"/><path d="M12 3h.01"/><path d="M12 16v.01"/><path d="M16 12h1"/><path d="M21 12v.01"/><path d="M12 21v-1"/>',
  user: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  settings: '<path d="M21 4h-7"/><path d="M10 4H3"/><path d="M21 12h-9"/><path d="M8 12H3"/><path d="M21 20h-5"/><path d="M12 20H3"/><path d="M14 2v4"/><path d="M8 10v4"/><path d="M16 18v4"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  pin: '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
};
export const icon = (name, size = 18) => `<svg class="icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ""}</svg>`;

/** Three dots that pulse while something is loading or the agent is working. */
export const dots = () => `<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>`;
export const label = (text, cls = "") => `<span class="label ${cls}">${esc(text)}</span>`;
/** The Collab mark (styles: .logo in styles.css). cls "live" loops it, "intro" plays it once. */
export const logo = (cls = "") => `<svg class="logo${cls ? " " + cls : ""}" viewBox="0 0 64 64" aria-hidden="true"><g fill="none" stroke-width="8"><path class="you" d="M42 12H12V40H42"/><path class="them" d="M22 24H52V52H22"/></g><rect class="offer" x="18" y="30" width="4" height="4"/></svg>`;
/** The mark with the name, where the app used to show "■ Collab". */
export const brand = () => `<span class="brand">${logo()}${label("Collab", "ink")}</span>`;
export const tag = (text, cls = "") => `<span class="tag ${cls}">${esc(text)}</span>`;

export function tierTag(tier, topics) {
  if (tier === "private") return tag("Private", "peri");
  if (tier === "protected") return tag(`Protected${topics?.length ? " · " + topics.join(", ") : ""}`, "accent");
  return tag("Public", "fresh");
}

/** Who did this: Gemini, the rules, the owner, or the owner's device. */
export const byTag = b => (b === "gemini" ? tag("✦ Gemini", "accent") : b === "owner" ? tag("Owner", "ink") : b === "device" ? tag("Device", "peri") : b === "rules" ? tag("Rules") : "");

/** A button at work: disabled, the spinner, and what it's doing — with no word given, its own name ("Confirm…", not
 *  just "…", which is all a screen reader would hear). Marked aria-busy until it's done. */
export function busy(btn, on, text = "…") {
  if (!btn) return;
  if (on) {
    const name = btn.hasAttribute("aria-label") ? "" : btn.textContent.replace(/\s+/g, " ").trim().replace(/…$/, "");
    if (!btn.hasAttribute("aria-busy")) btn.dataset.label = btn.innerHTML;
    btn.disabled = true; btn.setAttribute("aria-busy", "true");
    btn.innerHTML = `${logo("live spinner")} ${esc(text === "…" && name ? `${name}…` : text)}`;
  } else { btn.disabled = false; btn.removeAttribute("aria-busy"); if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
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
