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
 * Payment is stated as it was made: in the app, or outside it (and who said so).
 */
export function passHTML(d, { qr = "", seller = false, link = "" } = {}) {
  const k = passKind(d), item = d.quantity > 1 ? `${d.quantity} × ${d.item.split(" · ")[0]}` : d.item.split(" · ")[0];
  const paid = d.payment === "outside" ? (d.markedBy === "seller" ? "Paid outside the app" : "Buyer says paid outside the app — check you received it") : "Paid in the app";
  // In-app payments are simulated: one quiet tag, so a seller never hands over thinking money arrived.
  const demo = d.payment !== "outside" && (d.mode === "test" || d.payment === "in_app_test") ? ` <span class="tag stale">Demo payment</span>` : "";
  const state = d.collectedAt ? `<span class="pass-state done">✓ ${k.done} · ${esc(at(d.collectedAt))}</span>` : `<span class="pass-state">${k.ready}</span>`;
  return `<div class="pass ${d.collectedAt ? "is-done" : ""}">
    <div class="pass-top"><span class="label sq ink">${k.name}</span>${state}</div>
    ${qr && !d.collectedAt ? `<div class="pass-qr" aria-label="${esc(k.name)} QR code">${qr}</div>` : ""}
    <div class="pass-item"><b>${esc(item)}</b><span class="pass-amount">${rupees(d.amount)}</span></div>
    <dl class="pass-kv"><dt>Payment</dt><dd>${esc(paid)}${demo}</dd>${d.slot ? `<dt>Time</dt><dd>${esc(at(d.slot))}</dd>` : ""}<dt>Buyer</dt><dd>${esc(d.buyer)}</dd><dt>Seller</dt><dd>@${esc(d.sellerHandle)}</dd></dl>
    ${d.collectedAt ? "" : seller ? `<button class="btn accent" data-act="pass-collect">Mark ${k.done.toLowerCase()}</button><span class="small faint">Check the buyer's name first.</span>`
      : link ? `<span class="small faint">${qr ? `Show this to @${esc(d.sellerHandle)} — they scan it once.` : `Send @${esc(d.sellerHandle)} this pass's link — keep it private.`}</span><button class="btn quiet compact" data-act="pass-copy" data-link="${esc(link)}">Copy link</button>` : ""}
  </div>`;
}
