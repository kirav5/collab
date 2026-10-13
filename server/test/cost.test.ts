// What saves money: the meter, cheap-tier routing, moves that need no model, cached listing answers, reusing a
// category on re-drafts, and not re-reading an unchanged Public fact.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Model } from "../src/ai/gemini.ts";
import { Meter } from "../src/ai/meter.ts";
import { modelsFor } from "../src/ai/gemini.ts";
import { type Task, decide } from "../src/ai/decide.ts";
import { type Docs, memoryDocs } from "../src/docs.ts";
import { catalog, domain } from "../src/market/domains.ts";
import { type Context, NegotiateTask } from "../src/market/negotiate.ts";
import { read } from "../src/market/read.ts";
import { ANSWERS, type Turn, fresh, providerTurn } from "../src/core/engage.ts";
import { saveFact } from "../src/core/directory.ts";
import { PROFILES } from "../src/core/policy.ts";
import type { Profile } from "../src/core/model.ts";

const ctx = (side: "buyer" | "seller", mine: number[] = [], theirs: number[] = []): Context => ({
  side, catalog: catalog(domain("property-rent")), unit: "month",
  mandate: side === "seller" ? { price: { opening: 38_000, limit: 34_500 }, terms: {}, maxRounds: 5 } : { price: { opening: 32_000, limit: 36_000 }, terms: {}, maxRounds: 5 },
  mine: mine.map((p, i) => ({ id: `m${i}`, price: p, terms: {}, round: i })), theirs: theirs.map((p, i) => ({ id: `t${i}`, price: p, terms: {}, round: i })),
});

const profile = (uid: string): Profile => ({ uid, handle: uid, name: uid, bio: "", area: null, createdAt: 0 });

test("the meter counts calls, failures, tokens and cost per task and model", () => {
  const m = new Meter();
  m.record({ task: "x", model: "gemini-3.5-flash-lite", ms: 100, usage: { input: 1000, output: 100, thinking: 50 }, ok: true });
  m.record({ task: "x", model: "gemini-3.5-flash-lite", ms: 200, usage: { input: 1000, output: 100, thinking: 50 }, ok: true });
  m.record({ task: "y", model: "gemini-3.6-flash", ms: 300, usage: { input: 2000, output: 200, thinking: 0 }, ok: false });
  const s = m.status();
  assert.equal(s.calls, 3);
  assert.equal(s.failures, 1);
  assert.deepEqual(s.tokens, { input: 4000, output: 400, thinking: 100, cached: 0 });
  assert.equal(s.byTask.x.calls, 2);
  assert.equal(s.byTask.y.calls, 1);
  assert.deepEqual(s.byModel, { "gemini-3.5-flash-lite": 2, "gemini-3.6-flash": 1 });
  assert.ok(Math.abs(s.costUSD - (2000 * 0.10 + 300 * 0.40 + 2000 * 0.30 + 200 * 2.50) / 1e6) < 1e-9);
  const p = new Meter("lite=1/2");
  p.record({ task: "x", model: "gemini-3.5-flash-lite", ms: 1, usage: { input: 1000, output: 100, thinking: 50 }, ok: true });
  assert.ok(Math.abs(p.status().costUSD - (1000 + 300) / 1e6) < 1e-9);
});

test("cheap tasks try the cheap models first, then the standard ones", () => {
  assert.deepEqual(modelsFor("cheap", ["a", "b"], ["lite", "a"]), ["lite", "a", "b"]);
  assert.deepEqual(modelsFor("standard", ["a", "b"], ["lite", "a"]), ["a", "b"]);
  assert.deepEqual(modelsFor(undefined, ["a", "b"], ["lite", "a"]), ["a", "b"]);
});

test("a task that settles itself never calls the model", async () => {
  let calls = 0;
  const model: Model = { name: "counting", complete: async () => { calls++; return null; } };
  const t: Task<number, number> = { name: "t", instructions: "", prompt: () => "", parse: () => null, validate: v => v, fallback: () => -1, settled: i => (i > 0 ? i * 2 : null) };
  assert.deepEqual(await decide(model, t, 3), { output: 6, byModel: false });
  assert.equal(calls, 0);
  const d = await decide(model, t, 0);
  assert.equal(calls, 1);
  assert.equal(d.byModel, false); // the model answered nothing parseable: fallback
  assert.equal(d.output, -1);
});

test("accepting and escalating cost no model call; counter-proposals still ask it", () => {
  const accept = NegotiateTask.settled!({ ctx: ctx("seller", [], [37_900]), listPrice: 38_000 });
  assert.equal(accept?.action, "accept");
  const escalate = NegotiateTask.settled!({ ctx: ctx("seller", [38_000, 37_500, 37_000, 36_500, 36_000], [30_000]), listPrice: 38_000 });
  assert.equal(escalate?.action, "escalate");
  assert.equal(NegotiateTask.settled!({ ctx: ctx("seller"), listPrice: 38_000 }), null);
});

/** A provider with one Public offering, a model that answers the deposit question from it, and a turn runner. */
async function listingWorld() {
  const db = memoryDocs();
  const now = Math.floor(Date.now() / 1000);
  const text = "2BHK flat for rent in Indiranagar, 38000 a month, deposit 3 months refundable";
  const offer = { id: "o1", category: "property-rent", title: "2BHK for rent in Indiranagar", details: text,
    price: { amount: 38_000, currency: "INR", period: "month" }, place: { name: "Indiranagar", lat: 12.97, lon: 77.64, isCity: false },
    attributes: { bedrooms: "2" }, askBuyer: [], publishedAt: now, expiresAt: now + 86_400, status: "active" as const };
  await db.set(PROFILES, "pat", profile("pat"));
  await db.set("facts", "fact1", { id: "fact1", owner: "pat", text, tier: "public", topics: ["housing"], offer, createdAt: now, updatedAt: now });
  const calls = { answers: 0 };
  const model: Model = { name: "fake", complete: async r => {
    if (r.instructions.startsWith("You answer one question")) { calls.answers++; return JSON.stringify({ action: "answer", answer: "Yes, the deposit is refundable.", evidence: ["deposit 3 months refundable"] }); }
    return JSON.stringify({ questions: [] });
  } };
  const brief = { title: "2BHK wanted", summary: "Looking for a flat.", category: "property-rent", mode: null, area: null, requirements: [], budget: null, questions: ["Is the deposit refundable?"] };
  const ask = async (uid: string) => {
    const e = fresh({ briefId: null, brief, requester: { uid, handle: uid, name: uid }, provider: { uid: "pat", handle: "pat", name: "pat" },
      offer: { factId: "fact1", title: offer.title, price: 38_000, unit: "month", category: "property-rent" } });
    return { e, out: await providerTurn(db, model, e, { kind: "collab.turn/v1", from: "requester", engagementId: e.id } as Turn) };
  };
  return { db, model, calls, ask };
}

test("an answer from the listing is cached and reused across requesters; editing the fact clears it", async () => {
  const { db, model, calls, ask } = await listingWorld();
  const answers: string[] = [];
  for (const uid of ["r1", "r2"]) answers.push((await ask(uid)).out.answers?.[0]?.answer ?? "");
  assert.equal(calls.answers, 1, "the second requester is answered from cache");
  assert.ok(answers[0] && answers[0] === answers[1]);
  assert.equal((await db.find(ANSWERS, [["factId", "==", "fact1"]], 200)).length, 1);
  await saveFact(db, model, profile("pat"), { id: "fact1", text: "2BHK flat for rent in Indiranagar, 39000 a month", tier: "public" });
  assert.equal((await db.find(ANSWERS, [["factId", "==", "fact1"]], 200)).length, 0, "edited text clears cached answers");
});

test("a paused provider's cached answers stay unshared", async () => {
  const { db, calls, ask } = await listingWorld();
  assert.ok((await ask("r1")).out.answers?.length);
  assert.equal(calls.answers, 1);
  await db.set(PROFILES, "pat", { ...profile("pat"), paused: true });
  const { e, out } = await ask("r2");
  assert.ok(!out.answers?.length, "a paused provider answers nothing, cached or not");
  assert.equal(calls.answers, 1);
  assert.equal(out.pending?.length, 1);
  assert.equal(e.qa[0].status, "pending");
});

const readerModel = (count: Record<string, number>, embeds?: { n: number }): Model => ({
  name: "reader",
  async complete(r) {
    if (r.instructions.startsWith("Pick the category")) { count.classify = (count.classify ?? 0) + 1; return JSON.stringify({ category: "property-rent" }); }
    if (r.instructions.startsWith("Read a marketplace message"))
      return JSON.stringify({ item: "flat", place: "Indiranagar", place_latin: null, place_to: null, price: 38_000, price_scale: "rupees", price_per: "month", limit: null, attributes: { bedrooms: "2" }, questions: [] });
    return JSON.stringify({ mode: "none", filters: [] });
  },
  async embed(texts) { if (embeds) embeds.n += texts.length; return texts.map(() => Array(768).fill(0.1)); },
});

test("a re-draft that carries its category skips ClassifyTask", async () => {
  const count: Record<string, number> = {};
  const model = readerModel(count);
  const text = "2BHK to rent in Indiranagar, budget 38000 a month";
  const r = await read(text, "find", model, 0, null, "property-rent");
  assert.equal(count.classify ?? 0, 0);
  assert.equal(r.byModel.category, true);
  assert.equal(r.draft?.kind, "need");
  const r2 = await read(text, "find", model, 0, null, "not-a-category");
  assert.equal(count.classify, 1);
  assert.equal(r2.draft?.kind, "need");
});

test("re-saving an unchanged Public fact reuses its offer and embedding", async () => {
  const db = memoryDocs();
  const embeds = { n: 0 };
  const model = readerModel({}, embeds);
  const owner = profile("pat");
  const input = { id: "fact09", text: "2BHK flat for rent in Indiranagar, 38000 a month", tier: "public" as const };
  const a = await saveFact(db, model, owner, input);
  assert.equal(embeds.n, 1);
  assert.ok(a.offer);
  const b = await saveFact(db, model, owner, { ...input, topics: ["housing"] });
  assert.equal(embeds.n, 1, "no re-embed for identical text");
  assert.deepEqual(b.offer, a.offer);
});
