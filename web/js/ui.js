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
 * is on it). At most three at once; the same notice isn't shown twice in a row.
 *   kind: "attention" (needs you) · "success" · "error" · "deal" · "info" (default)
 */
const KINDS = { attention: ["Needs you", "!"], success: ["Done", "✓"], error: ["Problem", "×"], deal: ["Deal", "⇄"], info: ["Collab", "■"] };
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
  el.innerHTML = `<span class="note-ico" aria-hidden="true">${glyph}</span>
    <span class="note-main"><span class="note-kicker">${esc(kicker ?? word)}</span><b class="note-title">${esc(title)}</b>${body ? `<span class="note-body">${esc(body)}</span>` : ""}
      ${onClick ? `<span class="note-action">${esc(action ?? "Open")} ›</span>` : ""}</span>
    <button class="note-x" type="button" aria-label="Dismiss">×</button><span class="note-bar" aria-hidden="true"></span>`;
  let timer = null, left = life, started = Date.now();
  const close = () => { clearTimeout(timer); el.classList.add("leaving"); setTimeout(() => el.remove(), 180); };
  const run = () => { started = Date.now(); timer = setTimeout(close, left); el.classList.remove("paused"); };
  el.addEventListener("pointerenter", () => { clearTimeout(timer); left -= Date.now() - started; el.classList.add("paused"); });
  el.addEventListener("pointerleave", run);
  el.querySelector(".note-x").onclick = e => { e.stopPropagation(); close(); };
  if (onClick) el.onclick = () => { onClick(); close(); };
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
  return `<svg class="avatar" viewBox="0 0 30 30" width="${size}" height="${size}" style="width:${size}px;height:${size}px" aria-hidden="true">
    <rect width="30" height="30" rx="6" fill="hsl(${hue} 55% 88%)"/><g fill="hsl(${(hue + 40) % 360} 60% 62%)" opacity=".9">${shapes[shape]}</g>
    <text x="15" y="21" text-anchor="middle" font-size="14" font-weight="700" font-family="-apple-system,Inter,sans-serif" fill="hsl(${hue} 50% 22%)">${esc(initial)}</text></svg>`;
}

/** The two brackets: a pink one and one in the text colour, interlocked (100 × 100). */
export const MARK_PATHS = `<path class="lb-a" d="M0 0H72V18H18V54H72V72H0Z"/><path class="lb-b" d="M28 28H100V100H28V82H82V46H28Z"/>`;
/** The logo: the mark, with the wordmark beside it unless `word` is false; `moving` while the agent works. */
export const logoHTML = (size = 24, word = true, moving = false) =>
  `<span class="logo${moving ? " logo-anim" : ""}" aria-label="Collab"><svg viewBox="0 0 100 100" width="${size}" height="${size}" aria-hidden="true">${MARK_PATHS}</svg>${word ? `<span class="logo-word" style="font-size:${Math.round(size * 0.9)}px">Collab</span>` : ""}</span>`;
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
