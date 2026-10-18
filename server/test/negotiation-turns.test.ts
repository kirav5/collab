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
  assert.equal(concession(3, 12), 1, "the limit by the fourth offer, however many rounds are allowed");
  const base: any = { side: "buyer", mandate: { price: { opening: 900, limit: 1000 }, terms: {}, maxRounds: 12 }, mine: [], theirs: [], catalog: { buyerPrefersLower: () => true }, unit: "event" };
  const steps = [0, 1, 2, 3, 4].map(r => planned({ ...base, mine: [] }, r).price);
  assert.ok(steps[1] - steps[0] >= 10, `a real first move (${steps.join(", ")})`);
  assert.equal(steps[4], 1000);
  const again = planned({ ...base, mine: [{ id: "a", price: 930, terms: {}, round: 3 }], theirs: [{ id: "b", price: 1030, terms: {}, round: 3 }] }, 2);
  assert.ok(again.price > 930 && again.price <= 1000, `moves on from a repeated ₹930 (got ${again.price})`);
});

test("while their agent checks with its owner, their questions for us are still taken up — no stall", async () => {
  const { memoryDocs } = await import("../src/docs.ts");
  const { answerWhileTheyCheck } = await import("../src/core/engage.ts");
  const db = memoryDocs();
  const e: any = { id: "e1", phase: "asking", requester: { uid: "u1", handle: "me", name: "Asha" }, provider: { uid: "u2", handle: "steel", name: "Steel Bottle Store" },
    participants: ["u1", "u2"], offer: { factId: "f1", title: "Water Bottles", price: 450, unit: "each", category: "goods" }, brief: { title: "Water bottles", summary: "", requirements: [] },
    qa: [{ id: "q1", from: "requester", question: "Do you provide a GST invoice?", status: "pending" }, { id: "q2", from: "provider", question: "What quantity of bottles are you looking to order?", status: "open" }],
    waiting: { requester: null, provider: { kind: "answer", inbox: ["i1"], text: "Do you provide a GST invoice?" } }, negotiation: { requester: [], provider: [], deal: null, dealBy: null, confirmed: { requester: false, provider: false } },
    events: [], createdAt: 1, updatedAt: 1 };
  await answerWhileTheyCheck(db, null, e, null);
  const q2 = e.qa.find((q: any) => q.id === "q2");
  assert.notEqual(q2.status, "open", "their question is answered or put to our owner, not left untouched");
  const asked = (await db.find("inbox", [["owner", "==", "u1"]])).map((i: any) => i.question);
  assert.ok(q2.status === "answered" || asked.includes("What quantity of bottles are you looking to order?"));
});

test("a side waiting only on closed or settled items is no longer waiting — the conversation can move", async () => {
  const { memoryDocs } = await import("../src/docs.ts");
  const { pruneWaiting } = await import("../src/core/engage.ts");
  const db = memoryDocs();
  await db.set("inbox", "copy", { id: "copy", status: "open", qaId: "q2", kind: "answer", engagementId: "e1" });
  await db.set("inbox", "old", { id: "old", status: "done", qaId: "q2", kind: "answer", engagementId: "e1" });
  const e: any = { id: "e1", qa: [{ id: "q2", from: "requester", question: "Where is it?", status: "declined" }],
    waiting: { requester: null, provider: { kind: "answer", inbox: ["copy", "old"], text: "Where is it?" } } };
  assert.equal(await pruneWaiting(db, e), true);
  assert.equal(e.waiting.provider, null, "nothing open is left to wait on");
  assert.equal((await db.get("inbox", "copy")).status, "done", "the stray copy is closed");
});

test("a request never asks the provider about the requester's own home", async () => {
  const { ListingFieldsTask } = await import("../src/market/read.ts");
  const { domain } = await import("../src/market/domains.ts");
  const { decide } = await import("../src/ai/decide.ts");
  const text = "Need a deep clean for my 2BHK this Saturday";
  const m: any = { name: "t", complete: async () => JSON.stringify({ item: "deep clean", place: "", price: null, limit: null, attributes: {}, questions: ["Where is the home located?", "Do you bring your own supplies?"] }) };
  const d = await decide(m, ListingFieldsTask, { text, domain: domain("tasks")!, side: "find" });
  assert.deepEqual(d.output.questions, ["Do you bring your own supplies?"]);
});

test("when a deal is agreed, a question nobody answered is marked not needed (the record never says 'asked you' to no one)", async () => {
  const e: any = { id: "e1", phase: "deal", qa: [{ id: "q1", from: "provider", question: "Acoustic or electric?", status: "pending" }, { id: "q2", from: "requester", question: "Lead time?", status: "answered", answer: "2 days" }],
    negotiation: { requester: [], provider: [], deal: { id: "d", price: 700, terms: {}, round: 1 }, dealBy: "provider", confirmed: { requester: true, provider: true } }, waiting: { requester: null, provider: null }, events: [] };
  const { settleForTest } = await import("../src/core/engage.ts");
  settleForTest(e);
  assert.equal(e.phase, "agreed");
  assert.equal(e.qa[0].status, "moot"); assert.match(e.qa[0].answer, /not needed/i);
  assert.equal(e.qa[1].status, "answered", "answers stay as they were");
});

test("an agent's own offer can't crawl: too slow toward the limit, and the scheduled offer is used", async () => {
  const { NegotiateTask } = await import("../src/market/negotiate.ts");
  const ctx: any = { side: "seller", mandate: { price: { opening: 1800, limit: 1500 }, terms: {}, maxRounds: 5 }, catalog: { buyerPrefersLower: () => true, termLabel: (k: string) => k, termUnit: () => null }, unit: null,
    mine: [{ id: "a", price: 1800, terms: {}, round: 0 }, { id: "b", price: 1720, terms: {}, round: 1 }, { id: "c", price: 1650, terms: {}, round: 2 }], theirs: [{ id: "t", price: 1480, terms: {}, round: 2 }] };
  const crawl = NegotiateTask.validate({ action: "propose", proposal: { id: "x", price: 1610, terms: {}, round: 3 }, message: "We can do ₹1,610." } as any, { ctx, listPrice: 1800 });
  assert.equal(crawl, null, "₹1,610 on the 4th offer is too slow toward a ₹1,500 floor");
  const onTime = NegotiateTask.validate({ action: "propose", proposal: { id: "y", price: 1500, terms: {}, round: 3 }, message: "We can do ₹1,500." } as any, { ctx, listPrice: 1800 });
  assert.equal(onTime?.action, "propose");
});

test("a pending question nobody is asked (its waiting entry lost) is asked again, once", async () => {
  const { memoryDocs } = await import("../src/docs.ts");
  const { reaskPending } = await import("../src/core/engage.ts");
  const db = memoryDocs();
  const e: any = { id: "e1", title: "Logo", offer: { title: "Logo design · café" }, phase: "asking",
    requester: { uid: "u1", name: "Asha" }, provider: { uid: "demo-pixel", name: "Pixel Studio" }, participants: ["u1", "demo-pixel"],
    qa: [{ id: "q1", from: "requester", question: "Do you have a portfolio?", status: "pending", required: true }],
    waiting: { requester: null, provider: null }, negotiation: { requester: [], provider: [], deal: null, dealBy: null, confirmed: { requester: false, provider: false } }, events: [] };
  assert.equal(await reaskPending(db, e), true);
  assert.equal(e.waiting.provider?.kind, "answer");
  const items = await db.find("inbox", [["engagementId", "==", "e1"], ["status", "==", "open"]]);
  assert.equal(items.length, 1);
  assert.equal(items[0].owner, "demo-pixel");
  assert.equal(await reaskPending(db, e), false, "already asked: nothing to do");
});
