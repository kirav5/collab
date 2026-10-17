// What to call each side, from the server's role table (/api/config): by category, and by who is paid — not by who
// posted. A config cached before the table existed falls back to plain words until it refreshes.
import { session } from "./api.js";

const HANDOVER = { agreed: "Deal agreed", confirmAsk: "Confirm the deal?", confirmedLine: "confirmed it arrived as agreed", mark: "Mark delivered", marked: "Marked as delivered.", markedBy: "handed it over", confirm: "Received it ✓",
  confirmed: "Received it — all good.", todo: "Hand it over.", waiting: "Waiting for the handover.", confirmTodo: "Confirm you received it.", done: "Done — received as agreed." };
const PLAIN = { payee: "provider", payees: "providers", payer: "customer", payers: "customers", price: "price", payInApp: true, close: HANDOVER };

export const rolesOf = category => {
  const r = session.config?.roles?.byCategory?.[category ?? ""] ?? session.config?.roles?.general ?? PLAIN;
  return { ...r, close: r.close ?? HANDOVER };
};
export const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** `side` ("requester" | "provider") in conversation `e`: what they and the other side are called, and whether they're paid. */
export function partyRoles(e, side) {
  const r = rolesOf(e?.offer?.category), paid = (e?.seller ?? "provider") === side;
  return { me: paid ? r.payee : r.payer, them: paid ? r.payer : r.payee, price: r.price, paid, close: r.close, payee: r.payee, payer: r.payer };
}

/** The listing's owner pays (an employer's job post) — read from the offering, or a card holding one. */
export const ownerPays = x => !!(x?.offer?.ownerPays ?? x?.ownerPays);

/** A listing's owner and the people who answer it: an employer's job post is answered by candidates. */
export function listingRoles(x) {
  const r = rolesOf(x?.offer?.category ?? x?.category ?? x?.basics?.category);
  return ownerPays(x) ? { owner: r.payer, responders: r.payees, price: r.price, pays: true } : { owner: r.payee, responders: r.payers, price: r.price, pays: false };
}

/** An offering card's private limit is past the listed price the way its owner wants: below it if paid, above if paying. */
export function limitPast(c) {
  const listed = c?.offer?.price?.amount;
  if (listed == null || c.floor == null) return false;
  return ownerPays(c) ? c.floor > listed : c.floor < listed;
}

/** A price said in chat as the side the speaker is on: "I'll pay ₹X"; "I'll sell it for ₹X" in a shop, else "I'd accept ₹X". */
export function offerWords(e, side, amount) {
  const p = partyRoles(e, side);
  return p.paid ? (p.payee === "seller" ? `I'll sell it for ${amount}` : `I'd accept ${amount}`) : `I'll pay ${amount}`;
}

/** The private limit, said for its side: "the most you'd pay" / "the least you'd take". */
export const limitWords = paid => (paid ? "the least you'd take" : "the most you'd pay");
