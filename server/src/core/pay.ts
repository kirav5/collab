// AP2 (Agent Payments Protocol) after a deal: the seller's agent issues a Cart Mandate for exactly what both owners
// confirmed, the buyer's owner taps Pay and their agent signs a Payment Mandate against that cart, and the payment
// goes to the seller's agent over A2A. Test mode only: no money moves — the payment is simulated, and says so.
// A completed payment records the deal as gone ahead for both sides, so nobody has to answer "did it happen?".
import { createHash } from "node:crypto";
import { sealed } from "./deals.ts";
import type { Engagement, Side } from "./model.ts";
import { newId } from "../market/types.ts";

export interface CartMandate {
  type: "ap2.CartMandate"; id: string; dealHash: string;
  merchant: { handle: string; name: string }; buyer: { handle: string; name: string };
  items: { label: string; amount: number }[]; total: { currency: "INR"; value: number };
  createdAt: number; expiresAt: number; hash: string; merchantSignature: string;
}
export interface PaymentMandate {
  type: "ap2.PaymentMandate"; id: string; cartId: string; cartHash: string;
  amount: { currency: "INR"; value: number }; method: "test";
  payer: string; payee: string; userPresent: true; createdAt: number; hash: string; payerSignature: string;
}
export interface Payment {
  cart: CartMandate; mandate?: PaymentMandate;
  status: "awaiting" | "paying" | "paid" | "outside"; mode: "test";
  /** The tap that claimed this payment (set atomically before anything is signed). */
  claim?: { key: string; at: number };
  paymentId?: string; paidAt?: number; by?: Side;
  /** AP2 v0.2 checkout + mandates (added at Pay). */
  ap2?: import("./ap2.ts").Ap2Bundle;
}

const other = (s: Side): Side => (s === "requester" ? "provider" : "requester");
const digest = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
export const sellerOf = (e: Engagement): Side => e.seller ?? "provider";
export const buyerOf = (e: Engagement): Side => other(sellerOf(e));
const party = (e: Engagement, s: Side) => (s === "requester" ? e.requester : e.provider);

/** Who sells in a deal offered in a chat: "I'll sell…" makes the person offering the seller; "I'll buy / pay…" the buyer. */
export function sellerFrom(text: string, offeredBy: Side): Side | null {
  if (/\b(sell|selling|sale|give (?:it|you))\b/i.test(text)) return offeredBy;
  if (/\b(buy|pay|take it|purchase)\b/i.test(text)) return other(offeredBy);
  return null;
}

/** The seller's agent signs a cart for exactly the agreed terms (once the deal is agreed). */
export function cartFor(e: Engagement, sign: (uid: string, hash: string) => string, now: number): CartMandate | null {
  if (e.phase !== "agreed" || !e.negotiation.deal) return null;
  const seller = party(e, sellerOf(e)), buyer = party(e, buyerOf(e));
  if (!seller.uid) return null;
  const body = { type: "ap2.CartMandate" as const, id: newId(), dealHash: sealed(e).hash,
    merchant: { handle: seller.handle, name: seller.name }, buyer: { handle: buyer.handle, name: buyer.name },
    items: [{ label: e.offer.title || e.title, amount: e.negotiation.deal.price }], total: { currency: "INR" as const, value: e.negotiation.deal.price },
    createdAt: now, expiresAt: now + 7 * 86_400 };
  const hash = digest(body);
  return { ...body, hash, merchantSignature: sign(seller.uid, hash) };
}

/** The buyer's tap: their agent signs a payment mandate against the cart; test mode settles it at once. */
export function pay(e: Engagement, side: Side, sign: (uid: string, hash: string) => string, now: number): PaymentMandate {
  const p = e.payment;
  if (!p || (p.status !== "awaiting" && p.status !== "paying")) throw new Error("Nothing to pay.");
  if (side !== buyerOf(e)) throw new Error("Only the buyer pays.");
  if (p.cart.expiresAt < now) throw new Error("This cart has expired — agree the deal again.");
  if (digest(stripCart(p.cart)) !== p.cart.hash) throw new Error("The cart doesn't match what the seller's agent signed.");
  const buyer = party(e, side);
  const body = { type: "ap2.PaymentMandate" as const, id: newId(), cartId: p.cart.id, cartHash: p.cart.hash,
    amount: p.cart.total, method: "test" as const, payer: buyer.handle, payee: p.cart.merchant.handle, userPresent: true as const, createdAt: now };
  const hash = digest(body);
  const mandate = { ...body, hash, payerSignature: sign(buyer.uid!, hash) };
  e.payment = { ...p, mandate, status: "paid", paymentId: `test_${newId()}`, paidAt: now, by: side };
  // Paid is not delivered: fulfilment starts now and is completed by the handover and the buyer's acceptance.
  e.fulfilment ??= { state: "not_started" };
  return mandate;
}

function stripCart(c: CartMandate) {
  // Explicit order survives Firestore's map reordering.
  return { type: c.type, id: c.id, dealHash: c.dealHash,
    merchant: { handle: c.merchant.handle, name: c.merchant.name }, buyer: { handle: c.buyer.handle, name: c.buyer.name },
    items: c.items.map(i => ({ label: i.label, amount: i.amount })), total: { currency: c.total.currency, value: c.total.value },
    createdAt: c.createdAt, expiresAt: c.expiresAt };
}

/** Does everything still add up: the cart for the deal both confirmed, the payment for that cart? */
export function checkPayment(e: Engagement, verify: (uid: string, hash: string, sig: string) => boolean) {
  const p = e.payment;
  if (!p) return null;
  const seller = party(e, sellerOf(e)), buyer = party(e, buyerOf(e));
  const cartOk = digest(stripCart(p.cart)) === p.cart.hash && p.cart.dealHash === (e.negotiation.deal ? sealed(e).hash : "") && !!seller.uid && verify(seller.uid, p.cart.hash, p.cart.merchantSignature);
  let paymentOk: boolean | null = null;
  if (p.mandate) {
    const m = p.mandate;
    const body = { type: m.type, id: m.id, cartId: m.cartId, cartHash: m.cartHash,
      amount: { currency: m.amount.currency, value: m.amount.value }, method: m.method, payer: m.payer, payee: m.payee, userPresent: m.userPresent, createdAt: m.createdAt };
    paymentOk = digest(body) === m.hash && m.cartHash === p.cart.hash && m.cartId === p.cart.id && m.amount.currency === p.cart.total.currency && m.amount.value === p.cart.total.value
      && m.payer === buyer.handle && m.payee === seller.handle && !!buyer.uid && verify(buyer.uid, m.hash, m.payerSignature);
  }
  return { cartOk, paymentOk };
}
