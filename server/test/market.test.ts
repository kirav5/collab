// The checks that keep the agents safe whatever the model says: negotiation guards, grounding, answering and
// matching.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Model } from "../src/ai/gemini.ts";
import { decide } from "../src/ai/decide.ts";
import { catalog, domain } from "../src/market/domains.ts";
import { type Context, NegotiateTask, leaks, next } from "../src/market/negotiate.ts";
import { DemandFiltersTask, ListingFieldsTask, read } from "../src/market/read.ts";
import { fakeModel } from "../src/ai/fake.ts";
import { AnswerTask, JudgeTask } from "../src/market/answer.ts";
import { check, rank } from "../src/market/match.ts";
import { resolve } from "../src/market/places.ts";
import type { Need } from "../src/market/types.ts";

/** A model that always answers with the same JSON (or the result of a function of the prompt). */
const fake = (answer: object | ((prompt: string) => object)): Model => ({
  name: "fake", complete: async r => JSON.stringify(typeof answer === "function" ? answer(r.prompt) : answer),
});

const ctx = (side: "buyer" | "seller", mine: number[] = [], theirs: number[] = []): Context => ({
  side, catalog: catalog(domain("property-rent")), unit: "month",
  mandate: side === "seller" ? { price: { opening: 38_000, limit: 34_500 }, terms: {}, maxRounds: 5 } : { price: { opening: 32_000, limit: 36_000 }, terms: {}, maxRounds: 5 },
  mine: mine.map((p, i) => ({ id: `m${i}`, price: p, terms: {}, round: i })), theirs: theirs.map((p, i) => ({ id: `t${i}`, price: p, terms: {}, round: i })),
});

test("a model can't propose past the owner's limit, backwards, or too fast", async () => {
  for (const price of [30_000, 40_000]) {
    const m = await decide(fake({ action: "propose", price, message: "ok" }), NegotiateTask, { ctx: ctx("seller"), listPrice: 38_000 });
    assert.equal(m.byModel, false, `seller proposing ${price} must be refused`);
  }
  const back = await decide(fake({ action: "propose", price: 37_500, message: "ok" }), NegotiateTask, { ctx: ctx("seller", [37_000], [33_000]), listPrice: 38_000 });
  assert.equal(back.byModel, false);
  const fine = await decide(fake({ action: "propose", price: 37_800, message: "How about this?" }), NegotiateTask, { ctx: ctx("seller"), listPrice: 38_000 });
  assert.ok(fine.byModel && fine.output.action === "propose" && fine.output.proposal.price === 37_800);
});

test("a message that reveals the limit is replaced; accepting outside the limit is refused", async () => {
  const leak = await decide(fake({ action: "propose", price: 37_800, message: "My lowest is 34500, honestly." }), NegotiateTask, { ctx: ctx("seller"), listPrice: 38_000 });
  assert.ok(leak.output.action === "propose" && !leak.output.message.includes("34500"));
  assert.ok(leaks("I can't go below 34,500", ctx("seller")));
  const bad = await decide(fake({ action: "accept", message: "deal" }), NegotiateTask, { ctx: ctx("seller", [38_000], [30_000]), listPrice: 38_000 });
  assert.notEqual(bad.output.action, "accept");
});

test("the rules alone reach a deal between overlapping limits, and escalate when they don't overlap", () => {
  const run = (sellerLimit: number) => {
    const s: Context = { ...ctx("seller"), mandate: { price: { opening: 38_000, limit: sellerLimit }, terms: {}, maxRounds: 5 } };
    const b = ctx("buyer");
    for (let i = 0; i < 12; i++) {
      const [me, other] = i % 2 === 0 ? [b, s] : [s, b];
      const mv = next(me);
      if (mv.action !== "propose") return mv;
      me.mine.push(mv.proposal);
      other.theirs.push(mv.proposal);
    }
    return null;
  };
  const deal = run(34_500);
  assert.equal(deal?.action, "accept");
  assert.equal(run(37_000)?.action, "escalate");
});

test("reading: numbers and places must be written; filters must quote the request", () => {
  const d = domain("property-rent")!;
  const text = "2BHK to rent in Indiranagar, budget 36000 a month";
  const f = ListingFieldsTask.validate({ item: "flat", place: "Indiranagar", placeLatin: null, placeTo: null, price: 39_000, pricePer: null, limit: null,
    attributes: { bedrooms: "2", deposit_months: "6", made_up: "x" }, questions: [] }, { text, domain: d, side: "find" })!;
  assert.equal(f.price, null, "39,000 isn't written");
  assert.deepEqual(f.attributes, { bedrooms: "2" });
  assert.equal(ListingFieldsTask.validate({ ...f, place: "Whitefield" }, { text, domain: d, side: "find" }), null);
  const plan = DemandFiltersTask.validate({ mode: null, filters: [
    { id: "budget", label: "Budget", kind: "price", comparison: "atMost", value: "36000", strength: "required", source: "stated", evidence: "budget 36000" },
    { id: "budget2", label: "Budget", kind: "price", comparison: "atMost", value: "50000", strength: "required", source: "stated", evidence: "budget 36000" },
    { id: "gym", label: "Gym", kind: "text", comparison: "mentions", value: "gym", strength: "required", source: "implied", evidence: "has a gym" },
  ] }, { text, side: "find", category: d.label, knownKeys: [] })!;
  assert.deepEqual(plan.filters.map(x => x.id), ["budget"]);
});

test("answers must quote the facts and invent no numbers or contacts", () => {
  const facts = [{ label: "Deposit (months)", value: "3" }, { label: "Pets allowed", value: "small pets allowed" }];
  const input = { question: "Are dogs ok?", facts, side: "seller" as const };
  assert.ok(AnswerTask.validate({ action: "answer", text: "Yes, small pets are allowed.", evidence: ["small pets allowed"] }, input));
  assert.equal(AnswerTask.validate({ action: "answer", text: "Yes, up to 2 dogs.", evidence: ["small pets allowed"] }, input), null);
  assert.equal(AnswerTask.validate({ action: "answer", text: "Call me at 98450 12345.", evidence: ["small pets allowed"] }, input), null);
  assert.equal(AnswerTask.validate({ action: "answer", text: "Yes.", evidence: ["dogs welcome"] }, input), null);
});

test("a bare yes/no settles the judge without the model; anything wordier goes to it", async () => {
  const yes = await decide(null, JudgeTask, { question: "Can you come this week?", answer: "Yes." });
  assert.deepEqual([yes.output, yes.byModel, yes.settled], ["met", false, true]);
  const no = await decide(null, JudgeTask, { question: "Can you come this week?", answer: "No." });
  assert.deepEqual([no.output, no.byModel], ["unmet", false]);
  const wordy = await decide(fake({ verdict: "met" }), JudgeTask, { question: "Can you come this week?", answer: "Yes, Tuesday works, parts are extra." });
  assert.equal(JudgeTask.settled!({ question: "Can you come this week?", answer: "Yes, Tuesday works, parts are extra." }), null);
  assert.equal(wordy.byModel, true);
});

test("matching: area, budget and required numbers filter; worded text is asked, not excluded", () => {
  const now = Math.floor(Date.now() / 1000);
  const place = (n: string) => resolve(n)!;
  const offer = (id: string, area: string, price: number, attributes: Record<string, string>) => ({ key: id, offer: { id, category: "property-rent", title: id, details: "", price: { amount: price, currency: "INR", period: "month" },
    place: place(area), attributes, askBuyer: [], publishedAt: now, expiresAt: now + 86_400, status: "active" as const } });
  const need: Need = { id: "n", category: "property-rent", text: "", place: place("Indiranagar"), radiusKm: 3, maxPrice: 39_000, attributes: { bedrooms: "2" }, mustAsk: [], unit: "month", mode: null,
    filters: [{ id: "pets", label: "Pets allowed", kind: "choice", comparison: "equals", value: "yes", strength: "required", source: "stated", evidence: "dog" }] };
  const m = rank([offer("near", "Indiranagar", 38_000, { bedrooms: "2", pets: "small pets allowed" }), offer("far", "Whitefield", 30_000, { bedrooms: "2" }),
    offer("dear", "Indiranagar", 50_000, { bedrooms: "2" }), offer("one", "Indiranagar", 20_000, { bedrooms: "1" })], need, now);
  assert.deepEqual(m.map(x => x.key), ["near"]);
  assert.equal(check(need.filters[0], m[0].offer), null);
});

test("used goods read as 'goods', match like any category, and 'other' is the catch-all", async () => {
  const now = Math.floor(Date.now() / 1000), here = resolve("Koramangala");
  const sell = await read("Selling my used bicycle in Koramangala, 4500, lowest 4000", "sell", fakeModel(), now, here);
  assert.equal(sell.draft?.kind, "offer");
  if (sell.draft?.kind !== "offer") return;
  assert.equal(sell.draft.offer.category, "goods");
  assert.equal(sell.draft.offer.price.amount, 4_500);
  assert.equal(sell.draft.mandate.price.limit, 4_000);
  const find = await read("Looking for a used cycle in Koramangala under 5000", "find", fakeModel(), now, here);
  assert.equal(find.draft?.kind, "need");
  if (find.draft?.kind !== "need") return;
  assert.equal(find.draft.need.category, "goods");
  const nikhil = { key: "n", offer: { id: "n", category: "goods", title: "Used cycle", details: "", price: { amount: 4_500, currency: "INR", period: null },
    place: here!, attributes: { brand: "Decathlon" }, askBuyer: [], publishedAt: now, expiresAt: now + 86_400, status: "active" as const } };
  assert.equal(rank([nikhil], find.draft.need, now).length, 1, "the used-cycle need matches a goods listing under budget");
  assert.ok(domain("other"));
  assert.equal(catalog(domain("other")).termLabel("what"), "What");
});

test("the local gazetteer supplement resolves Bengaluru localities GeoNames lacks", () => {
  const p = resolve("HSR Layout", resolve("Bengaluru"));
  assert.ok(p && !p.isCity && p.name.startsWith("HSR Layout"), JSON.stringify(p));
});
