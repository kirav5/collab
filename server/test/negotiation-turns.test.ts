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

test("an agent's line that names a role or guesses a gender is replaced by the plain one", async () => {
  const { misnames } = await import("../src/market/negotiate.ts");
  for (const bad of ["Would your client be open to ₹1,600?", "She can lower her offer to ₹500.", "Our customer can do ₹900.", "The seller asks ₹2,000."]) assert.equal(misnames(bad), true, bad);
  for (const ok of ["Could you do ₹1,600?", "We can come down to ₹4,800.", "Here's our offer: ₹900."]) assert.equal(misnames(ok), false, ok);
});

test("a request's summary speaks for itself, never 'a client' or 'a buyer'", async () => {
  const { neutral } = await import("../src/core/tasks.ts");
  assert.equal(neutral("A client requires a custom logo designed for a new café."), "Needs a custom logo designed for a new café.");
  assert.equal(neutral("A buyer is looking to purchase a ready-to-move 3BHK. The client is seeking parking."), "Looking to purchase a ready-to-move 3BHK. Seeking parking.");
  assert.equal(neutral("Looking for a guitar teacher at home."), "Looking for a guitar teacher at home.");
});

test("the owner's 'no deal' line is plain numbers: their latest and the owner's limit — never the model's words", async () => {
  const { NegotiateTask, escalation } = await import("../src/market/negotiate.ts");
  const ctx: any = { side: "buyer", unit: "night", mandate: { price: { opening: 1700, limit: 2000 }, terms: {}, maxRounds: 5 }, catalog: { buyerPrefersLower: () => true, termLabel: (k: string) => k, termUnit: () => null },
    mine: [1700, 1800, 1900, 1950, 2000].map((price, round) => ({ id: `m${round}`, price, terms: {}, round })), theirs: [{ id: "t", price: 2300, terms: {}, round: 4 }] };
  const text = escalation(ctx);
  assert.match(text, /Their latest is ₹2,300\/night; your limit is ₹2,000\/night/);
  const v = NegotiateTask.validate({ action: "escalate", message: "I need to check with Atishay, as ₹2,000 per night is our maximum authorized limit." } as any, { ctx, listPrice: 2800 });
  assert.equal(v?.message, text);
});

test("a demo person's agent answers for itself and holds its best price — nobody is asked to play them", async () => {
  const { memoryDocs } = await import("../src/docs.ts");
  const { fresh, save, load, askOwner, INBOX } = await import("../src/core/engage.ts");
  const { demoReply } = await import("../src/core/engage.ts");
  const db = memoryDocs();
  const brief: any = { title: "Studio", summary: "Looking for a studio for 3 nights.", category: "", mode: null, area: null, requirements: [], budget: null, questions: [] };
  const e: any = fresh({ briefId: "b1", brief, requester: { uid: "u1", handle: "u1", name: "Atishay" }, provider: { uid: "demo-nest-stays", handle: "nest-stays", name: "Nest Stays" },
    offer: { factId: null, title: "Furnished studio · short stays", price: 2800, unit: "night", category: "stays" } });
  e.phase = "negotiating"; e.negotiation.provider = [{ id: "p1", price: 2400, terms: {}, round: 4 }];
  await save(db, e);
  const r = await demoReply(db, null, e, "provider", "Can you provide gig work leads in Bangalore?");
  assert.ok(r.text.length > 10 && !/₹/.test(r.text));
  const cur = await load(db, e.id);
  await askOwner(db, cur, "provider", { kind: "move", question: "No deal inside your limit." });
  assert.equal(cur.waiting.provider, null, "no decision left for anyone to make as them");
  assert.equal((await db.find(INBOX, [["engagementId", "==", e.id]])).length, 0);
  assert.match(cur.events.at(-1)!.text, /₹2,400\/night is our best/);
});

test("an answer that waits on details is never read as a 'no' to a must-have", async () => {
  const { JudgeTask } = await import("../src/market/answer.ts");
  const i = { question: "Is the studio available next week?", answer: "We cannot check live calendar availability directly through this chat, but please send us your exact dates so we can confirm for you." };
  assert.equal(JudgeTask.validate!("unmet" as any, i as any), "unclear");
  assert.equal(JudgeTask.validate!("unmet" as any, { question: "Is it available next week?", answer: "No, we're fully booked next week." } as any), "unmet");
});

test("a demo seller at its limit repeats its best price as an offer, so the turn passes to the buyer", async () => {
  const { fresh, move, myTurnToMove } = await import("../src/core/engage.ts");
  const brief: any = { title: "Studio", summary: "Looking for a studio.", category: "", mode: null, area: null, requirements: [], budget: null, questions: [] };
  const e: any = fresh({ briefId: "b1", brief, requester: { uid: "u1", handle: "u1", name: "Atishay" }, provider: { uid: "demo-nest-stays", handle: "nest-stays", name: "Nest Stays" },
    offer: { factId: null, title: "Furnished studio", price: 2800, unit: "night", category: "stays" } });
  e.phase = "negotiating";
  e.negotiation.provider = [2800, 2550, 2450, 2400, 2400].map((price, round) => ({ id: `p${round}`, price, terms: {}, round }));
  e.negotiation.requester = [{ id: "r1", price: 1950, terms: {}, round: 4 }]; e.negotiation.lastBy = "requester";
  const out: any = { kind: "collab.turn/v1", from: "provider", engagementId: e.id };
  const r = await move(null, e, "provider", { price: { opening: 2800, limit: 2400 }, terms: {}, maxRounds: 5 }, out);
  assert.equal(r, null, "nothing for anyone to decide as them");
  assert.equal(out.proposal.price, 2400);
  assert.equal(myTurnToMove(e, "requester"), true);
  assert.match(e.events.at(-1).text, /₹2,400\/night is our best/);
});

test("an agent hands the decision to its owner only when its offers are used up", async () => {
  const { NegotiateTask } = await import("../src/market/negotiate.ts");
  const ctx: any = { side: "buyer", unit: "day", mandate: { price: { opening: 1650, limit: 1650 }, terms: {}, maxRounds: 5 }, catalog: { buyerPrefersLower: () => true, termLabel: (k: string) => k, termUnit: () => null },
    mine: [{ id: "m0", price: 1650, terms: {}, round: 0 }], theirs: [{ id: "t", price: 1700, terms: {}, round: 1 }] };
  assert.equal(NegotiateTask.validate({ action: "escalate", message: "Checking with my owner" } as any, { ctx, listPrice: 1800 }), null, "four offers left: keep going");
  ctx.mine = [0, 1, 2, 3, 4].map(round => ({ id: `m${round}`, price: 1650, terms: {}, round }));
  assert.equal(NegotiateTask.validate({ action: "escalate", message: "x" } as any, { ctx, listPrice: 1800 })?.action, "escalate");
});

test("a request's time is answered for the day it names, not the next free slots", async () => {
  const { askedDay } = await import("../src/core/resources.ts");
  const mon = Date.parse("2026-10-19T04:30:00Z") / 1000; // Monday 10:00 IST
  assert.deepEqual(askedDay("Are you available this Saturday afternoon?", mon, "Asia/Kolkata"), { day: 6, from: 12, to: 17, label: "Saturday" });
  assert.equal(askedDay("Can you come tomorrow morning?", mon, "Asia/Kolkata")?.day, 2);
  assert.equal(askedDay("How long does it take?", mon, "Asia/Kolkata"), null);
});
