// The pass a paid deal gets (pickup, booking or handover), drawn the same way in the app's modal and on the page a
// scanned QR opens: what changes hands, for how much, who's who, and whether it's been collected. The seller marks it
// from the pass itself.
const KINDS = { pickup: { name: "Pickup pass", done: "Collected", ready: "Ready to collect" }, booking: { name: "Booking pass", done: "Checked in", ready: "Ready to check in" }, handover: { name: "Handover pass", done: "Handed over", ready: "Ready to hand over" } };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const rupees = a => (a.currency && a.currency !== "INR" ? `${a.currency} ${a.value.toLocaleString()}` : `₹${Math.round(a.value).toLocaleString("en-IN")}`);
const at = t => new Date(t * 1000).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export const passKind = d => KINDS[d.kind] ?? KINDS.pickup;

/** The QR that opens this pass (an SVG), or "" offline. */
export async function passQR(link) {
  try { return await (await import("/vendor/qrcode.js")).default.toString(link, { type: "svg", margin: 1, color: { dark: "#0a0a0a", light: "#ffffff" } }); } catch { return ""; }
}

/**
 * The pass. `qr`: show the code to scan (the buyer's view). `seller`: the viewer is the seller — they mark it done here.
 * `scanOnly`: the seller viewing without the code (only the buyer holds it), so they mark it by scanning the buyer's.
 * Payment is stated as it was made: in the app, or outside it (and who said so). An open report pauses it.
 */
export function passHTML(d, { qr = "", seller = false, link = "", manage = false, scanOnly = false } = {}) {
  const k = passKind(d), item = d.quantity > 1 ? `${d.quantity} × ${d.item.split(" · ")[0]}` : d.item.split(" · ")[0];
  const paid = d.payment === "outside" ? (d.markedBy === "seller" ? "Paid outside the app" : "They say they paid outside the app — check you received it") : "Paid in the app";
  // In-app payments are simulated: one quiet tag, so a seller never hands over thinking money arrived.
  const demo = d.payment !== "outside" && (d.mode === "test" || d.payment === "in_app_test") ? ` <span class="tag stale">Demo payment</span>` : "";
  const state = d.cancelled ? `<span class="pass-state" style="color:var(--danger)">Cancelled</span>`
    : d.collectedAt ? `<span class="pass-state done">✓ ${k.done} · ${esc(at(d.collectedAt))}</span>`
    : d.paused ? `<span class="pass-state" style="color:var(--danger)">Paused · report open</span>` : `<span class="pass-state">${k.ready}</span>`;
  // A booking can still move or be called off until it happens — by either side, from the pass.
  const changeable = manage && d.kind === "booking" && d.slot && d.slot > Date.now() / 1000 && !d.collectedAt && !d.cancelled && !d.paused;
  return `<div class="pass ${d.collectedAt ? "is-done" : ""}">
    <div class="pass-top"><span class="label sq ink">${k.name}</span>${state}</div>
    ${qr && !d.collectedAt && !d.cancelled && !d.paused ? `<div class="pass-qr" aria-label="${esc(k.name)} QR code">${qr}</div>` : ""}
    <div class="pass-item"><b>${esc(item)}</b><span class="pass-amount">${rupees(d.amount)}</span></div>
    <dl class="pass-kv"><dt>Payment</dt><dd>${esc(paid)}${demo}</dd>${d.slot ? `<dt>Time</dt><dd>${esc(at(d.slot))}</dd>` : ""}<dt>${esc(d.payer ? d.payer[0].toUpperCase() + d.payer.slice(1) : "For")}</dt><dd>${esc(d.buyer)}</dd><dt>${esc(d.payee ? d.payee[0].toUpperCase() + d.payee.slice(1) : "From")}</dt><dd>@${esc(d.sellerHandle)}</dd></dl>
    ${changeable ? `<div class="row"><button class="btn secondary compact" data-act="pass-move">Change time</button><button class="btn quiet compact" data-act="pass-cancel">Cancel booking</button></div><div class="row pass-times" style="flex-wrap:wrap;gap:6px"></div>` : ""}
    ${d.paused && !d.cancelled ? `<span class="small" style="color:var(--danger)">There's an open report on this deal — sort it in the deal first.</span>` : ""}
    ${d.collectedAt || d.cancelled || d.paused ? "" : seller && scanOnly ? `<span class="small faint">Scan their QR with your phone camera to mark it ${k.done.toLowerCase()}.</span>`
      : seller ? `<button class="btn accent" data-act="pass-collect">Mark ${k.done.toLowerCase()}</button><span class="small faint">Check their name first.</span>`
      : link ? `<span class="small faint">${qr ? `Show this to @${esc(d.sellerHandle)} — they scan it once.` : `Send @${esc(d.sellerHandle)} this pass's link — keep it private.`}</span><button class="btn quiet compact" data-act="pass-copy" data-link="${esc(link)}">Copy link</button>` : ""}
  </div>`;
}
