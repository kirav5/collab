// AP2 after a deal in a direct chat: who sells, the seller agent's cart, the buyer's payment, and tamper checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { memoryDocs } from "../src/docs.ts";
import { INBOX, fresh, load, offerDeal, resolve, save, setSigner } from "../src/core/engage.ts";
import { checkPayment, pay, sellerFrom } from "../src/core/pay.ts";
import type { InboxItem, SharedBrief } from "../src/core/model.ts";

const sign = (uid: string, hash: string) => createHmac("sha256", "test").update(`${uid}:${hash}`).digest("base64url");
const verify = (uid: string, hash: string, sig: string) => sign(uid, hash) === sig;
setSigner(sign);
const brief: SharedBrief = { title: "Steel bottle", summary: "Direct chat.", category: "goods", mode: null, area: null, requirements: [], budget: null, questions: [] };

test("who sells is read from the offer", () => {
  assert.equal(sellerFrom("I'll sell you the bottle for ₹100", "requester"), "requester");
  assert.equal(sellerFrom("I can pay 80rs", "requester"), "provider");
  assert.equal(sellerFrom("₹90?", "provider"), null);
});

test("a chat deal gets a seller-signed cart; only the buyer pays; tampering shows", async () => {
  const db = memoryDocs();
  const e = fresh({ briefId: "direct-x", brief, requester: { uid: "shop", handle: "shop", name: "Shop" }, provider: { uid: "ana", handle: "ana", name: "Ana" },
    offer: { factId: null, title: "Steel bottle", category: "goods", price: null, unit: null } as never });
  await save(db, e);
  await offerDeal(db, e, "requester", 100, "I'll sell you the bottle for ₹100");
  const item = (await db.find(INBOX, [["owner", "==", "ana"]], 5) as InboxItem[]).find(i => i.kind === "confirm")!;
  await resolve(db, null, item, { confirm: true });
  const agreed = await load(db, e.id);
  assert.equal(agreed.phase, "agreed");
  assert.equal(agreed.seller, "requester");
  assert.equal(agreed.payment?.status, "awaiting");
  assert.equal(agreed.payment?.cart.total.value, 100);
  assert.deepEqual(checkPayment(agreed, verify), { cartOk: true, paymentOk: null });

  assert.throws(() => pay(structuredClone(agreed), "requester", sign, 1), /Only the buyer/);
  const paid = structuredClone(agreed);
  pay(paid, "provider", sign, Math.floor(Date.now() / 1000));
  assert.equal(paid.payment?.status, "paid");
  assert.equal(paid.outcome, undefined, "paying doesn't decide whether it happened");
  assert.equal(paid.fulfilment?.state, "not_started");
  assert.deepEqual(checkPayment(paid, verify), { cartOk: true, paymentOk: true });

  const forged = structuredClone(paid);
  forged.payment!.cart.total.value = 1;
  assert.equal(checkPayment(forged, verify)?.cartOk, false);
  const changed = structuredClone(paid);
  changed.negotiation.deal!.price = 50;
  assert.equal(checkPayment(changed, verify)?.cartOk, false);
});
