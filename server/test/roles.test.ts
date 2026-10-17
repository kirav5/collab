// Who pays and what each side is called: read from the writer's words, checked by code, and carried into the prompts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeModel } from "../src/ai/fake.ts";
import { domain } from "../src/market/domains.ts";
import { resolve } from "../src/market/places.ts";
import { ListingFieldsTask, read } from "../src/market/read.ts";
import { listingRoles, orientMandate, payerCue, rolesFor } from "../src/market/roles.ts";
import { budgetBand, rank } from "../src/market/match.ts";
import { catalog } from "../src/market/domains.ts";
import { direction } from "../src/market/negotiate.ts";
import { BuyerQuestionsTask, SellerAsksTask, buyerQuestions } from "../src/core/intake.ts";
import { TermsTask, suggestTerms } from "../src/core/terms.ts";

test("who pays is taken from explicit words; paying phrases win over 'offering'", () => {
  for (const t of ["We're hiring a junior developer", "Recruiting a cook for our cafe", "Offering a job as a driver", "Want to buy a used iPhone", "I'll pay 1200 for my assignment"])
    assert.equal(payerCue(t), "writer", t);
  for (const t of ["Selling my bicycle", "I teach guitar", "Renting out a 2BHK", "Looking for a job as a cook", "Available for work as a plumber", "I offer haircuts"])
    assert.equal(payerCue(t), "other", t);
  for (const t of ["Need a plumber in HSR", "2BHK in Indiranagar, budget 36000"]) assert.equal(payerCue(t), null, t);
});

test("roles follow the money, not who posted", () => {
  assert.deepEqual([rolesFor("jobs").payee, rolesFor("jobs").payer, rolesFor("jobs").price], ["candidate", "employer", "salary"]);
  assert.equal(rolesFor("not-a-category").payee, "provider");
  assert.deepEqual(listingRoles("jobs", true), { owner: "employer", responder: "candidate", responders: "candidates", price: "salary", respond: "apply and interview" });
  assert.equal(listingRoles("jobs", false).owner, "candidate", "a job seeker's own listing");
  assert.deepEqual([listingRoles("goods", false).owner, listingRoles("goods", false).responders], ["seller", "buyers"]);
});

test("the model's reading of who pays is kept unless the writer says otherwise", () => {
  const d = domain("jobs")!, base = { item: "developer", place: "", placeLatin: null, placeTo: null, price: null, pricePer: null, limit: null, attributes: {}, questions: [] };
  assert.equal(ListingFieldsTask.validate({ ...base, payer: "other" }, { text: "We're hiring a developer", domain: d, side: "sell" })?.payer, "writer", "the text outranks the model");
  assert.equal(ListingFieldsTask.validate({ ...base, payer: "writer" }, { text: "Need a developer for our team", domain: d, side: "sell" })?.payer, "writer", "no cue: the model's reading stands");
  assert.match(ListingFieldsTask.prompt({ text: "x", domain: d, side: "sell" }), /the candidate is paid the salary and the employer pays it/);
});

test("a job post is a listing whose owner pays; a job seeker's request is one where the requester is paid", async () => {
  const now = Math.floor(Date.now() / 1000), here = resolve("Indiranagar");
  const post = await read("Hiring a junior developer in Indiranagar, ₹30,000 a month", "sell", fakeModel(), now, here);
  assert.equal(post.category, "jobs");
  assert.equal(post.draft?.kind === "offer" && post.draft.offer.ownerPays, true);
  const shop = await read("Selling my used bicycle in Koramangala, 4500", "sell", fakeModel(), now, resolve("Koramangala"));
  assert.equal(shop.draft?.kind === "offer" && shop.draft.offer.ownerPays, undefined, "a shop's owner is paid, as before");
  const seeker = await read("Looking for a job as a cook in Indiranagar, ₹18,000 a month", "find", fakeModel(), now, here);
  assert.equal(seeker.draft?.kind === "need" && seeker.draft.need.requesterPaid, true);
});

test("listing prompts name the roles, not buyer and seller", async () => {
  const asks = SellerAsksTask.prompt({ text: "Hiring a cook", category: "Jobs / hiring", known: [], hints: [], owner: "employer", responders: "candidates" });
  assert.match(asks, /The owner is the employer; the people who respond are candidates/);
  for (const ins of [SellerAsksTask.instructions, BuyerQuestionsTask.instructions, TermsTask.instructions]) assert.doesNotMatch(ins, /seller's listing|buyers' agents|a seller of this/);
  assert.match(TermsTask.prompt({ category: "jobs", offering: "x", owner: "employer", audience: "candidates" }), /Owner: employer\nTerms are read by: candidates/);
  // Through the offline model: a job post gets job questions and job terms.
  const offer = (await read("Hiring a junior developer in Indiranagar, ₹30,000 a month", "sell", fakeModel(), 0, resolve("Indiranagar"))).draft;
  assert.ok(offer?.kind === "offer");
  const qs = await buyerQuestions(fakeModel(), offer.offer, offer.offer.details);
  assert.ok(qs?.some(q => /salary/i.test(q.text)), JSON.stringify(qs));
  const terms = await suggestTerms(fakeModel(), "jobs", "We're hiring a junior developer, ₹30,000 a month");
  assert.deepEqual(terms.terms.map(t => t.label), ["Probation", "Notice period"]);
});

test("a limit is pointed the way its side wants; one sent the other way round is mirrored around the limit", () => {
  const m = (opening: number, limit: number) => ({ price: { opening, limit } });
  assert.deepEqual(orientMandate(m(28_800, 32_000), true).price, { opening: 35_200, limit: 32_000 }, "paid: opens above the least they'd take");
  assert.deepEqual(orientMandate(m(35_200, 32_000), true).price, { opening: 35_200, limit: 32_000 }, "already right: unchanged");
  assert.deepEqual(orientMandate(m(40_000, 36_000), false).price, { opening: 32_000, limit: 36_000 }, "paying: opens below the most they'd pay");
});

test("a paid requester's band is below their floor; a buyer's is above their budget", () => {
  const base = { id: "n", category: "jobs", text: "", place: resolve("Indiranagar")!, radiusKm: 8, attributes: {}, mustAsk: [], unit: "month", filters: [] };
  assert.equal(budgetBand({ ...base, requesterPaid: true, minPrice: 32_000, maxPrice: null }), "from ₹30,000/month");
  assert.equal(budgetBand({ ...base, requesterPaid: true, minPrice: 30_000, maxPrice: null }), "from ₹25,000/month", "strictly below a round floor");
  assert.equal(budgetBand({ ...base, maxPrice: 36_000 }), "up to ₹40,000/month");
});

test("matching needs the money to flow one way: a job seeker finds the post paying enough; someone who would pay never matches a post whose owner pays", async () => {
  const now = Math.floor(Date.now() / 1000), here = resolve("Indiranagar");
  const job = (await read("Hiring a junior developer in Indiranagar, ₹30,000 a month", "sell", fakeModel(), now, here)).draft;
  const low = (await read("Hiring a junior developer in Indiranagar, ₹20,000 a month", "sell", fakeModel(), now, here)).draft;
  const seeker = (await read("Looking for a job as a junior developer in Indiranagar, ₹28,000 a month", "find", fakeModel(), now, here)).draft;
  const hirer = (await read("Need a junior developer in Indiranagar, budget 35,000 a month", "find", fakeModel(), now, here, "jobs")).draft;
  assert.ok(job?.kind === "offer" && low?.kind === "offer" && seeker?.kind === "need" && hirer?.kind === "need");
  const listings = [{ key: "job", offer: job.offer }, { key: "low", offer: low.offer }];
  assert.deepEqual(rank(listings, seeker.need, now).map(m => m.key), ["job"], "the seeker finds the job paying enough, not the one below their floor");
  assert.deepEqual(rank(listings, hirer.need, now).map(m => m.key), [], "someone who'd pay never matches a post whose owner pays");
});

test("after sides flip, price follows who is paid while the category's other terms keep the requester's sense", () => {
  const c = catalog(domain("jobs"));
  const base = { catalog: c, mandate: { price: { opening: 1, limit: 1 }, terms: {}, maxRounds: 5 }, unit: null, mine: [], theirs: [] };
  // The candidate asked (requester) and is paid (seller): wants a higher salary, and — as domains.json says for the
  // one looking — a lower experience requirement.
  const candidate = { ...base, side: "seller" as const, termsSide: "buyer" as const };
  assert.equal(direction(candidate), 1);
  assert.equal(direction(candidate, "experience_years"), -1);
  const employer = { ...base, side: "buyer" as const, termsSide: "seller" as const };
  assert.equal(direction(employer), -1);
  assert.equal(direction(employer, "experience_years"), 1);
});

test("profile options: Gemini fits them to the role; amounts and contacts are dropped; the code's own options stand in", async () => {
  const { ProfileTask } = await import("../src/core/tasks.ts");
  const asks = rolesFor("jobs").profile!;
  const input = { text: "Looking for a frontend developer job", category: "jobs", asks };
  const out = ProfileTask.validate(ProfileTask.parse({ options: { Skills: ["React", "TypeScript", "CSS", "₹30,000 a month"], "Work mode": ["Remote", "call me@x.com"], Invented: ["a", "b"] } }, input)!, input)!;
  assert.deepEqual(out.map(q => q.label), asks.map(a => a.label), "the code's questions, in order, nothing invented");
  assert.deepEqual(out.find(q => q.label === "Skills")!.options, ["React", "TypeScript", "CSS"]);
  assert.deepEqual(out.find(q => q.label === "Work mode")!.options, asks.find(a => a.label === "Work mode")!.options, "too few left: the code's own options");
  assert.deepEqual(ProfileTask.fallback(input).map(q => q.options), asks.map(a => a.options));
});
