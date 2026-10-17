// Each side of a conversation talks as its role: a candidate's agent never "offers" a salary, a tenant's agent asks
// about rent, and what an agent says always matches what it offers.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Model } from "../src/ai/gemini.ts";
import { decide } from "../src/ai/decide.ts";
import { fakeModel } from "../src/ai/fake.ts";
import { DOMAINS, catalog, domain } from "../src/market/domains.ts";
import { type Context, NegotiateTask, next } from "../src/market/negotiate.ts";
import { resolve } from "../src/market/places.ts";
import { read } from "../src/market/read.ts";
import { fill, introFor, rolesFor, shortName, usualAsks, voiceFor } from "../src/market/roles.ts";

const fake = (answer: object): Model => ({ name: "fake", complete: async () => JSON.stringify(answer) });

/** A salary negotiation: the employer (paying, the provider) opened with its listing; the candidate is paid. */
const job = (who: "candidate" | "employer", mine: number[] = [], theirs: number[] = []): Context => {
  const paid = who === "candidate";
  return { side: paid ? "seller" : "buyer", termsSide: paid ? "buyer" : "seller", catalog: catalog(domain("jobs")), unit: "month",
    voice: voiceFor("jobs", paid, paid ? "Ravi Kumar" : "Brightpath Tech"),
    mandate: paid ? { price: { opening: 38_000, limit: 32_000 }, terms: {}, maxRounds: 5 } : { price: { opening: 30_000, limit: 36_000 }, terms: {}, maxRounds: 5 },
    mine: mine.map((p, i) => ({ id: `m${i}`, price: p, terms: {}, round: i })), theirs: theirs.map((p, i) => ({ id: `t${i}`, price: p, terms: {}, round: i })) };
};

test("every category has a kind of deal, and every role's lines name the amount without calling anyone a buyer or seller by mistake", () => {
  for (const d of DOMAINS) {
    const r = rolesFor(d.id);
    assert.ok(["buy", "book", "visit", "hire"].includes(r.flow), `${d.id}: ${r.flow}`);
    for (const paid of [true, false]) {
      const v = voiceFor(d.id, paid, "Asha Rao");
      for (const kind of ["open", "counter", "accept"] as const) {
        const said = fill(v[kind], v, "₹1,234");
        assert.ok(said.includes("₹1,234"), `${d.id} ${v.me} ${kind}: ${said}`);
        assert.ok(!/[{}]/.test(said), `${d.id} ${v.me} ${kind}: a blank left unfilled: ${said}`);
        if (!["buyer", "seller"].includes(v.me)) assert.doesNotMatch(said, /\b(buyer|seller)s?\b/i, `${d.id} ${v.me} ${kind}`);
        // No "final offer" line: saying the last offer is the most (or least) would give the limit away.
        assert.doesNotMatch(said, /\b(most|least|lowest|highest|final|limit)\b/i, `${d.id} ${v.me} ${kind}`);
      }
    }
  }
  assert.equal(shortName("Ravi Kumar"), "Ravi");
  assert.equal(shortName("Sharp Cuts Barber Studio"), "Sharp Cuts Barber Studio", "a business keeps its whole name");
});

test("the rules talk as each role: the employer offers a salary, the candidate asks for one", () => {
  const employerOpens = next(job("employer"));
  assert.equal(employerOpens.message, "We can offer ₹30,000/month for this role.");
  const candidate = next(job("candidate", [], [30_000]));
  assert.equal(candidate.action, "propose");
  assert.match(candidate.message, /^Thanks — Ravi is looking for ₹38,000\/month\.$/);
  assert.match(next(job("candidate", [38_000], [30_000, 30_600])).message, /^Ravi could do ₹/);
  assert.match(next(job("employer", [30_000], [38_000])).message, /^We could raise that to ₹/);
  // Agreeing says the other side's amount in this side's words.
  // As in a real run: four offers each, then the employer's agent takes Ravi's ₹34,300.
  assert.equal(next(job("employer", [30_000, 30_600, 31_900, 33_700], [38_000, 37_400, 36_100, 34_300])).message, "₹34,300/month works for us — we'll confirm the offer.");
  assert.equal(next(job("candidate", [38_000, 37_400, 36_100, 34_300], [30_000, 30_600, 31_900, 33_700, 34_300])).message, "Ravi is happy with ₹34,300/month.");
  // Without a voice (older callers, tests) the plain wording stays.
  const plain = { ...job("employer"), voice: undefined };
  assert.equal(next(plain).message, "We can offer ₹30,000/month.");
});

test("the model is told who it speaks for, and the history is in the order the offers were made", () => {
  const p = NegotiateTask.prompt({ ctx: job("candidate", [38_000], [30_000, 30_600]), listPrice: 30_000 });
  assert.match(p, /You are the candidate's agent, speaking for Ravi to the employer's agent about the salary\./);
  assert.match(p, /Listed salary: 30000/);
  assert.doesNotMatch(p, /You are the seller's agent/);
  // The employer opened (its listing), so its 30,000 comes first, then Ravi's 38,000, then 30,600.
  const order = [...p.matchAll(/- (You|They) offered price (\d+)/g)].map(m => `${m[1]} ${m[2]}`);
  assert.deepEqual(order, ["They 30000", "You 38000", "They 30600"]);
  // A shop that opened with its listing price: its own offer is first, even though it's the seller.
  const shop: Context = { side: "seller", catalog: catalog(domain("goods")), unit: null, voice: voiceFor("goods", true, "Nikhil"),
    mandate: { price: { opening: 4500, limit: 3800 }, terms: {}, maxRounds: 5 },
    mine: [{ id: "listing", price: 4500, terms: {}, round: 0 }], theirs: [{ id: "t0", price: 3600, terms: {}, round: 0 }] };
  const shopOrder = [...NegotiateTask.prompt({ ctx: shop, listPrice: 4500 }).matchAll(/- (You|They) offered price (\d+)/g)].map(m => `${m[1]} ${m[2]}`);
  assert.deepEqual(shopOrder, ["You 4500", "They 3600"]);
});

test("what the model says must name the amount it offers, and nothing else; otherwise the role's own line is used", async () => {
  const ctx = job("employer", [30_000], [38_000]);
  const said = async (message: string, price = 31_000) => (await decide(fake({ action: "propose", price, message }), NegotiateTask, { ctx, listPrice: 30_000 })).output;
  assert.equal((await said("We can stretch to ₹31,000 a month for the right person.")).message, "We can stretch to ₹31,000 a month for the right person.");
  assert.equal((await said("We could do ₹30,500 a month.")).message, "We could raise that to ₹31,000/month.", "a different amount than offered");
  assert.equal((await said("Happy to talk about it.")).message, "We could raise that to ₹31,000/month.", "no amount at all");
  assert.equal((await said("Our ceiling is ₹36,000 but ₹31,000 for now.")).message, "We could raise that to ₹31,000/month.", "the limit is never said");
});

test("job questions follow who is asking whom, in both directions", async () => {
  const d = domain("jobs");
  // An employer's post: the employer screens candidates; the candidate asks about the job.
  assert.match(usualAsks("jobs", "provider", false, d).join(" "), /experience.*notice period/);
  assert.match(usualAsks("jobs", "requester", false, d).join(" "), /position still open/);
  // A candidate's own listing ("hire me"): the employer asking is the requester.
  assert.match(usualAsks("jobs", "requester", true, d).join(" "), /experience.*notice period/);
  assert.match(usualAsks("jobs", "provider", true, d).join(" "), /position still open/);
  // Other categories keep their own questions (written for the provider being the one paid).
  assert.deepEqual(usualAsks("property-rent", "provider", true, domain("property-rent")), domain("property-rent")!.sellerAsks);
  const now = Math.floor(Date.now() / 1000), here = resolve("Indiranagar");
  const post = (await read("Hiring a junior developer in Indiranagar, ₹30,000 a month", "sell", fakeModel(), now, here)).draft;
  assert.ok(post?.kind === "offer");
  assert.match(post.offer.askBuyer.join(" "), /experience/, "the employer's agent asks the employer's questions");
  const seeker = (await read("Looking for a job as a junior developer in Indiranagar, ₹32,000 a month", "find", fakeModel(), now, here)).draft;
  assert.ok(seeker?.kind === "need");
  assert.match(seeker.need.mustAsk.join(" "), /position still open/, "the candidate asks about the job");
  assert.doesNotMatch(seeker.need.mustAsk.join(" "), /team size, and notice period/);
});

test("the requester opens with an application, an enquiry or an answer to a wanted post — never a budget", () => {
  assert.equal(introFor("jobs", true, "Ravi Kumar", "Junior Developer", "Two years with React; can join in 30 days"),
    "Hello — Ravi would like to apply for the Junior Developer role. Two years with React; can join in 30 days.");
  assert.equal(introFor("jobs", true, "Ravi Kumar", "Delivery Executive Job", ""), "Hello — Ravi would like to apply for the Delivery Executive role.", "never '…job role'");
  assert.equal(introFor("jobs", true, "Ravi Kumar", "Job Offer:", ""), "Hello — Ravi would like to apply for this role.");
  assert.equal(introFor("jobs", false, "Brightpath Tech", "React Developer", ""), "Hello — Brightpath Tech would like to talk to you about a role.");
  // The listing's own words, in their own case — any kind of listing reads right.
  assert.equal(introFor("rides", false, "Priya", "Airport rides from Koramangala", ""), "Hi — Priya is interested in “Airport rides from Koramangala”.");
  assert.equal(introFor("pets", false, "Priya", "Labrador puppies for sale", ""), "Hi — Priya is interested in “Labrador puppies for sale”.");
  // Answering a wanted post ("looking to rent…"), and a conversation that isn't about a listing.
  assert.equal(introFor("property-rent", true, "Kabir Mehta", "2BHK wanted in Indiranagar", ""), "Hi — Kabir saw your post “2BHK wanted in Indiranagar” and can help.");
  assert.equal(introFor(null, false, "Priya", null, "Need a ceiling fan installed this weekend"), "Hi — Priya has a request for you. Need a ceiling fan installed this weekend.");
});

test("owners are named the way the app names them: first names, titles kept, businesses in full", () => {
  assert.equal(shortName("Dr. Mehta"), "Dr. Mehta");
  assert.equal(shortName("Mr Sharma"), "Mr Sharma");
  assert.equal(shortName("Acme Labs"), "Acme Labs");
  assert.equal(shortName(""), "my owner", "an empty profile name never leaves a blank in a line");
});

test("amounts are read at the scale they're written: lakh, crore, L, k", async () => {
  const flat: Context = { side: "buyer", catalog: catalog(domain("property-sale")), unit: null, voice: voiceFor("property-sale", false, "Asha"),
    mandate: { price: { opening: 7_000_000, limit: 8_000_000 }, terms: {}, maxRounds: 5 }, mine: [{ id: "m0", price: 7_000_000, terms: {}, round: 0 }], theirs: [{ id: "t0", price: 9_000_000, terms: {}, round: 0 }] };
  const said = async (message: string, price = 7_200_000) => (await decide(fake({ action: "propose", price, message }), NegotiateTask, { ctx: flat, listPrice: 9_000_000 })).output.message;
  assert.equal(await said("Would you consider ₹72 lakh?"), "Would you consider ₹72 lakh?");
  assert.equal(await said("Asha could go to ₹72 L."), "Asha could go to ₹72 L.");
  assert.equal(await said("Would you consider ₹0.72 Cr?"), "Would you consider ₹0.72 Cr?");
  assert.equal(await said("Would you consider ₹75 lakh?"), "Could you do ₹72 L?", "a different amount than offered");
  // The limit, written any way, is never said.
  assert.equal(await said("₹72 lakh for now — though we could stretch to 80 lakh."), "Could you do ₹72 L?");
  assert.equal(await said("₹72 lakh is about as high as Asha can go."), "Could you do ₹72 L?", "says a limit exists, in the third person");
  const job2: Context = { ...job("employer", [30_000], [38_000]) };
  const salary = async (message: string) => (await decide(fake({ action: "propose", price: 31_000, message }), NegotiateTask, { ctx: job2, listPrice: 30_000 })).output.message;
  assert.equal(await salary("₹31,000 a month — Brightpath's budget tops out at 36k."), "We could raise that to ₹31,000/month.");
  assert.equal(await salary("₹31,000 a month; Ravi's minimum doesn't matter to us."), "We could raise that to ₹31,000/month.");
});

test("a counter for several units may say what they come to; a price said again isn't a concession", async () => {
  const shop: Context = { side: "seller", catalog: catalog(domain("goods")), unit: null, voice: voiceFor("goods", true, "Nikhil"),
    mandate: { price: { opening: 420, limit: 380 }, terms: {}, maxRounds: 5 },
    mine: [{ id: "m0", price: 420, terms: { quantity: 5 }, round: 0 }], theirs: [{ id: "t0", price: 360, terms: { quantity: 5 }, round: 0 }] };
  const m = await decide(fake({ action: "propose", price: 410, terms: { quantity: 5 }, message: "We can do ₹410 each — ₹2,050 for all five." }), NegotiateTask, { ctx: shop, listPrice: 420 });
  assert.equal(m.output.message, "We can do ₹410 each — ₹2,050 for all five.");
  // A firm price: the agent repeats it in its opening words, never "we can come down to" the same price.
  const firm: Context = { ...shop, mandate: { price: { opening: 4000, limit: 4000 }, terms: {}, maxRounds: 5 }, mine: [{ id: "listing", price: 4000, terms: {}, round: 0 }], theirs: [{ id: "t0", price: 3600, terms: {}, round: 0 }] };
  assert.equal(next(firm).message, "We're asking ₹4,000.");
});

test("the prompt's history follows the order offers were made, whatever their round numbers", () => {
  // As stored by a card order: rounds that don't count moves (1, 1, 2…).
  const ctx: Context = { side: "seller", catalog: catalog(domain("goods")), unit: null, voice: voiceFor("goods", true, "Nikhil"),
    mandate: { price: { opening: 4950, limit: 4200 }, terms: {}, maxRounds: 5 },
    mine: [{ id: "m0", price: 4950, terms: {}, round: 1 }, { id: "m1", price: 4800, terms: {}, round: 1 }],
    theirs: [{ id: "t0", price: 3800, terms: {}, round: 1 }, { id: "t1", price: 3860, terms: {}, round: 1 }, { id: "t2", price: 3990, terms: {}, round: 2 }] };
  const order = [...NegotiateTask.prompt({ ctx, listPrice: 4950 }).matchAll(/- (You|They) offered price (\d+)/g)].map(m => `${m[1]} ${m[2]}`);
  assert.deepEqual(order, ["They 3800", "You 4950", "They 3860", "You 4800", "They 3990"]);
});

test("outside jobs, questions follow who is paid too: a wanted post's answerer asks the paid side's questions", () => {
  const rent = domain("property-rent")!;
  // A tenant's "looking to rent" post (owner pays): the landlord answering it asks the landlord's questions.
  assert.deepEqual(usualAsks("property-rent", "requester", false, rent), rent.sellerAsks);
  assert.deepEqual(usualAsks("property-rent", "provider", false, rent), rent.buyerAsks);
  // An ordinary listing: unchanged.
  assert.deepEqual(usualAsks("property-rent", "provider", true, rent), rent.sellerAsks);
  assert.deepEqual(usualAsks("property-rent", "requester", true, rent), rent.buyerAsks);
});
