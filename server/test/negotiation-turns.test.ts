// A conversation where the buyer offered twice in a row (typed offers, then their agent's) must still move: the
// seller's agent answers the latest offer. And an agent's message never adds terms the offer doesn't have.
import { test } from "node:test";
import assert from "node:assert/strict";
import { myTurnToMove } from "../src/core/engage.ts";
import { invents } from "../src/market/negotiate.ts";

const at = (req: number[], prov: number[]) => ({ negotiation: { requester: req.map((price, round) => ({ id: `r${round}`, price, terms: {}, round })),
  provider: prov.map((price, round) => ({ id: `p${round}`, price, terms: {}, round })) } }) as any;

test("the seller's agent moves whenever the buyer has offered at least as often — no stall", () => {
  assert.equal(myTurnToMove(at([], []), "provider"), true, "the seller opens");
  assert.equal(myTurnToMove(at([], [140]), "requester"), true);
  assert.equal(myTurnToMove(at([120], [140]), "provider"), true);
  assert.equal(myTurnToMove(at([120], [140]), "requester"), false);
  // ₹140 ordered, ₹100 typed, the agent's ₹100: three buyer offers to the seller's one.
  assert.equal(myTurnToMove(at([140, 100, 100], [138]), "provider"), true, "the seller answers the latest offer");
  assert.equal(myTurnToMove(at([140, 100, 100], [138]), "requester"), false);
});

test("whoever made the last offer waits: the other side moves, once", () => {
  const e = at([140, 100, 100], [138]);
  e.negotiation.lastBy = "requester";
  assert.equal(myTurnToMove(e, "provider"), true);
  e.negotiation.provider.push({ id: "p1", price: 134, terms: {}, round: 1 }); e.negotiation.lastBy = "provider";
  assert.equal(myTurnToMove(e, "provider"), false, "the seller doesn't move twice in a row");
  assert.equal(myTurnToMove(e, "requester"), true);
});

test("an agent's message can't add a credit period, a deposit or a number the offer doesn't have", () => {
  const p = { id: "x", price: 100, terms: {}, round: 1 };
  assert.equal(invents("We can offer ₹100 per order if you can extend the credit period to 30 days.", p), true);
  assert.equal(invents("We can offer ₹100 with a ₹500 deposit.", p), true);
  assert.equal(invents("We can offer ₹100 per order.", p), false);
  assert.equal(invents("₹1,000 for all 10.", { id: "y", price: 100, terms: { quantity: 10 }, round: 1 }), false);
});

test("a buyer with many rounds still reaches their limit in a few offers, and never repeats an offer", async () => {
  const { planned, concession } = await import("../src/market/negotiate.ts");
  assert.equal(concession(4, 12), 1, "the limit by the fifth offer, however many rounds are allowed");
  const base: any = { side: "buyer", mandate: { price: { opening: 900, limit: 1000 }, terms: {}, maxRounds: 12 }, mine: [], theirs: [], catalog: { buyerPrefersLower: () => true }, unit: "event" };
  const steps = [0, 1, 2, 3, 4].map(r => planned({ ...base, mine: [] }, r).price);
  assert.ok(steps[1] - steps[0] >= 10, `a real first move (${steps.join(", ")})`);
  assert.equal(steps[4], 1000);
  const again = planned({ ...base, mine: [{ id: "a", price: 930, terms: {}, round: 3 }], theirs: [{ id: "b", price: 1030, terms: {}, round: 3 }] }, 2);
  assert.ok(again.price > 930 && again.price <= 1000, `moves on from a repeated ₹930 (got ${again.price})`);
});
