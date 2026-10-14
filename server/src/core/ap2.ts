// AP2 v0.2 shapes for the payment step (test mode — no money moves). At Pay the seller's agent issues a checkout for
// exactly the agreed deal, valid 10 minutes, and authorises it with a detached JWS over its canonical JSON (RFC 8785).
// The buyer's agent checks that authorisation, then issues two SD-JWTs bound to the checkout hash: a Checkout Mandate
// (the buyer accepts this checkout) and a Payment Mandate (pay this amount to this payee with this instrument).
// Keys: Collab's server signs on behalf of each agent (EdDSA, published at /public/keys) — the mandates prove what
// Collab's agents recorded, not a signature made on the person's own device.
import { createHash, type KeyObject } from "node:crypto";
import { CompactSign, compactVerify, flattenedVerify, importJWK, type JWK } from "jose";
import { policy } from "../config/policy.ts";

export interface Ap2Checkout {
  id: string; status: "ready_for_complete" | "completed";
  line_items: { id: string; title: string; quantity: number; price: { currency: string; value: number } }[];
  totals: { total: { currency: string; value: number } };
  merchant: { handle: string; agent: string }; buyer: { handle: string; agent: string };
  deal_hash: string; created_at: number; expires_at: number;
}
export interface Ap2Instrument { id: string; type: "google_pay" | "test"; environment: "TEST"; network?: string; description?: string; token_sha256?: string }
export interface Ap2Bundle {
  version: "0.2"; mode: "test"; kid: string;
  checkout: Ap2Checkout; checkout_hash: string;
  /** Detached JWS (header..signature) by the seller's agent over JCS(checkout). */
  merchant_authorization: string;
  /** SD-JWTs (no selective disclosures: "<jwt>~") by the buyer's agent. */
  checkout_mandate: string; payment_mandate: string;
  instrument: Ap2Instrument; idempotency_key: string;
}

/** RFC 8785 canonical JSON for the values we sign (integers, strings, booleans, objects, arrays). */
export function jcs(x: unknown): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x);
  if (Array.isArray(x)) return `[${x.map(jcs).join(",")}]`;
  return `{${Object.keys(x as object).filter(k => (x as any)[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${jcs((x as any)[k])}`).join(",")}}`;
}
const sha = (s: string) => createHash("sha256").update(s).digest("base64url");
const enc = new TextEncoder();

async function jwt(key: KeyObject, kid: string, typ: string, claims: object) {
  return new CompactSign(enc.encode(JSON.stringify(claims))).setProtectedHeader({ alg: "EdDSA", kid, typ }).sign(key);
}

export interface Ap2Input {
  key: KeyObject; kid: string; base: string; now: number; dealHash: string; idempotencyKey: string;
  currency: string; lines: { id: string; title: string; quantity: number; unitPrice: number }[];
  merchant: { handle: string }; buyer: { handle: string }; checkoutId: string; instrument: Ap2Instrument;
}

export async function ap2Pay(i: Ap2Input): Promise<Ap2Bundle> {
  const agent = (h: string) => `${i.base}/a2a/${h}`;
  const checkout: Ap2Checkout = { id: i.checkoutId, status: "ready_for_complete",
    line_items: i.lines.map(l => ({ id: l.id, title: l.title, quantity: l.quantity, price: { currency: i.currency, value: l.unitPrice } })),
    totals: { total: { currency: i.currency, value: i.lines.reduce((n, l) => n + l.quantity * l.unitPrice, 0) } },
    merchant: { handle: i.merchant.handle, agent: agent(i.merchant.handle) }, buyer: { handle: i.buyer.handle, agent: agent(i.buyer.handle) },
    deal_hash: i.dealHash, created_at: i.now, expires_at: i.now + policy().timing.checkoutValiditySec };
  const canonical = jcs(checkout), checkout_hash = sha(canonical);
  // The seller's agent authorises the checkout (detached: the checkout itself travels as JSON).
  const full = await new CompactSign(enc.encode(canonical)).setProtectedHeader({ alg: "EdDSA", kid: i.kid, typ: "JOSE" }).sign(i.key);
  const [h, , s] = full.split(".");
  const merchant_authorization = `${h}..${s}`;
  const common = { iss: agent(i.buyer.handle), iat: i.now, exp: i.now + policy().timing.checkoutValiditySec, _sd_alg: "sha-256" };
  const checkout_mandate = `${await jwt(i.key, i.kid, "dc+sd-jwt", { ...common, vct: "ap2.CheckoutMandate", checkout_hash, checkout_id: checkout.id, merchant: checkout.merchant.agent })}~`;
  const payment_mandate = `${await jwt(i.key, i.kid, "dc+sd-jwt", { ...common, vct: "ap2.PaymentMandate", transaction_id: checkout_hash,
    payee: checkout.merchant.agent, payment_amount: checkout.totals.total, payment_instrument: i.instrument, idempotency_key: i.idempotencyKey })}~`;
  return { version: "0.2", mode: "test", kid: i.kid, checkout: { ...checkout, status: "completed" }, checkout_hash, merchant_authorization,
    checkout_mandate, payment_mandate, instrument: i.instrument, idempotency_key: i.idempotencyKey };
}

/** Checks a bundle with the published public key only: merchant authorisation, both mandates, and that they bind. */
export async function verifyAp2(b: Ap2Bundle, publicKey: JWK, dealHash: string): Promise<{ merchantOk: boolean; mandatesOk: boolean }> {
  const key = await importJWK({ ...publicKey, alg: "EdDSA" }, "EdDSA");
  const ready = { ...b.checkout, status: "ready_for_complete" as const };
  const canonical = jcs(ready);
  let merchantOk = false, mandatesOk = false;
  try {
    const [h, , s] = b.merchant_authorization.split(".");
    await flattenedVerify({ protected: h, payload: Buffer.from(canonical).toString("base64url"), signature: s }, key);
    merchantOk = sha(canonical) === b.checkout_hash && b.checkout.deal_hash === dealHash;
  } catch { merchantOk = false; }
  try {
    const claims = async (sd: string) => JSON.parse(new TextDecoder().decode((await compactVerify(sd.replace(/~$/, ""), key)).payload));
    const cm = await claims(b.checkout_mandate), pm = await claims(b.payment_mandate);
    mandatesOk = cm.vct === "ap2.CheckoutMandate" && cm.checkout_hash === b.checkout_hash && cm.checkout_id === b.checkout.id
      && pm.vct === "ap2.PaymentMandate" && pm.transaction_id === b.checkout_hash && pm.payee === b.checkout.merchant.agent
      && pm.payment_amount?.value === b.checkout.totals.total.value && pm.payment_amount?.currency === b.checkout.totals.total.currency
      && pm.idempotency_key === b.idempotency_key && cm.iss === b.checkout.buyer.agent && pm.iss === b.checkout.buyer.agent;
  } catch { mandatesOk = false; }
  return { merchantOk, mandatesOk };
}
