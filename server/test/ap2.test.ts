// AP2 v0.2 shapes: the seller agent's checkout authorisation and the buyer agent's mandates verify with the public key
// only, and break when the amount, payee or checkout changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { signer } from "../src/core/signatures.ts";
import { ap2Pay, jcs, verifyAp2 } from "../src/core/ap2.ts";

const s = signer(undefined, true);
const make = () => ap2Pay({ key: s.privateKey, kid: s.kid, base: "https://example.com", now: 1_800_000_000, dealHash: "deal-1", idempotencyKey: "tap-1",
  item: "200 ml bottle", amount: 100, merchant: { handle: "shop" }, buyer: { handle: "ana" }, checkoutId: "chk_1", instrument: { id: "instr_1", type: "test", environment: "TEST" } });

test("JCS sorts keys and drops undefined", () => {
  assert.equal(jcs({ b: 1, a: { d: [2, { z: 1, y: "x" }], c: undefined } }), '{"a":{"d":[2,{"y":"x","z":1}]},"b":1}');
});

test("checkout and mandates verify, bind to the checkout hash, and expire in 10 minutes", async () => {
  const b = await make();
  assert.equal(b.checkout.expires_at - b.checkout.created_at, 600);
  assert.ok(b.merchant_authorization.includes(".."), "detached JWS");
  assert.ok(b.checkout_mandate.endsWith("~") && b.payment_mandate.endsWith("~"), "SD-JWT form");
  assert.deepEqual(await verifyAp2(b, s.publicKey as any, "deal-1"), { merchantOk: true, mandatesOk: true });
});

test("changes and other keys are caught", async () => {
  const b = await make();
  assert.equal((await verifyAp2(b, s.publicKey as any, "another-deal")).merchantOk, false);
  const pricier = structuredClone(b); pricier.checkout.totals.total.value = 1;
  assert.deepEqual(await verifyAp2(pricier, s.publicKey as any, "deal-1"), { merchantOk: false, mandatesOk: false });
  const moved = structuredClone(b); moved.checkout.merchant.agent = "https://evil.example/a2a/x";
  assert.equal((await verifyAp2(moved, s.publicKey as any, "deal-1")).mandatesOk, false);
  assert.deepEqual(await verifyAp2(b, signer(undefined, true).publicKey as any, "deal-1"), { merchantOk: false, mandatesOk: false });
});
