// What a request already says is never asked again: Gemini's questions come back answered from the request's own words
// (checked against them), a job seeker's profile fills from what they wrote, ranges stay ranges, and providers' agents
// see the area. Demo customers ask for what a listing offers, in their own words, with no prices or contacts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../src/ai/decide.ts";
import { ClarifyTask, GatherTask, ProfileTask } from "../src/core/tasks.ts";
import { DemandFiltersTask } from "../src/market/read.ts";
import { share } from "../src/core/briefs.ts";
import { DemoAsksTask } from "../src/core/demo-asks.ts";
import { memoryDocs } from "../src/docs.ts";
import { rememberAnswer } from "../src/core/memory.ts";
import { fresh, requesterTurn } from "../src/core/engage.ts";
import { search } from "../src/core/directory.ts";
import { FACTS, PROFILES } from "../src/core/policy.ts";
import { draft } from "../src/core/briefs.ts";
import { fakeModel } from "../src/ai/fake.ts";
import { rank } from "../src/market/match.ts";
import { resolve } from "../src/market/places.ts";

const model = (o: unknown) => ({ name: "t", complete: async () => JSON.stringify(o) }) as any;

test("a question the request already answers comes back answered, with the request's words as evidence", async () => {
  const text = "Veg lunch tiffin delivered in Whitefield on weekdays";
  const d = await decide(model({ questions: [
    { question: "How often do you need it?", options: ["Daily (Mon-Fri)", "Flexible", "Trial"], answer: "Daily (Mon-Fri)", evidence: "on weekdays" },
    { question: "How many tiffins a day?", options: ["1", "2", "3+"], answer: null, evidence: null },
    { question: "Which style of food?", options: ["North Indian", "South Indian"], answer: "North Indian", evidence: "north indian food" },
    { question: "Any allergies?", options: ["None", "Nuts"] },
    { question: "Spice level?", options: ["Mild", "Medium"] },
  ] }), ClarifyTask, { text, category: "food", known: [] });
  const byQ = Object.fromEntries(d.output.map(q => [q.question, q]));
  assert.equal(byQ["How often do you need it?"].answer, "Daily (Mon-Fri)", "answered from 'on weekdays'");
  assert.equal(byQ["Which style of food?"]?.answer, undefined, "an answer whose words aren't in the request is not taken");
  assert.equal(d.output.filter(q => !q.answer).length, 2, "two open questions at most; answered ones don't count");
});

test("an answer in the request's own words joins the options when none fits", async () => {
  const d = await decide(model({ questions: [{ question: "How much experience should they have?", options: ["Fresher", "1–2 years", "3–5 years"], answer: "2–3 years", evidence: "2-3 years of experience" }] }),
    ClarifyTask, { text: "I need a React developer with 2-3 years of experience for a 3 month remote project", category: "jobs", known: [] });
  assert.equal(d.output[0].answer, "2–3 years");
  assert.equal(d.output[0].options[0], "2–3 years");
});

test("a job seeker's profile fills from what they wrote; guesses without their words are left open", async () => {
  const asks = [{ label: "Experience", question: "How many years?", options: ["Fresher", "1–2 years", "3–5 years", "5+ years"] },
    { label: "Work mode", question: "Remote, hybrid or on-site?", options: ["Remote", "Hybrid", "On-site", "Any"] },
    { label: "Notice period", question: "When could you join?", options: ["Right away", "Within 30 days"] }];
  const d = await decide(model({ options: { Experience: ["Fresher", "1–2 years", "3–5 years"], "Work mode": ["Remote", "Hybrid", "On-site"] },
    answers: { Experience: { answer: "2–3 years", evidence: "2-3 years of experience" }, "Work mode": { answer: "Remote", evidence: "remote preferred" }, "Notice period": { answer: "Right away", evidence: "can join immediately" } } }),
    ProfileTask, { text: "Looking for a job as a React developer, I have 2-3 years of experience, remote preferred", category: "jobs", asks });
  const by = Object.fromEntries(d.output.map(q => [q.label, q]));
  assert.equal(by.Experience.answer, "2–3 years");
  assert.ok(by.Experience.options.includes("2–3 years"), "the stated range is one of the chips");
  assert.equal(by["Work mode"].answer, "Remote");
  assert.equal(by["Notice period"].answer, undefined, "not said, so not answered");
});

test("a range in a request stays a range, and the shared requirement reads as written", async () => {
  const text = "I need a React developer with 2-3 years of experience";
  for (const value of ["2-3", "2"]) {
    const d = await decide(model({ mode: "online", filters: [{ id: "experience_years", label: "Experience", kind: "number", comparison: "equals", value, unit: "years", strength: "required", source: "stated", evidence: "2-3 years of experience" }] }),
      DemandFiltersTask, { text, side: "find", category: "jobs", knownKeys: [] });
    const f = d.output.filters[0];
    assert.equal(f.value, "2"); assert.equal(f.upTo, "3"); assert.equal(f.comparison, "atLeast");
    const s = share({ id: "n", category: "jobs", text, place: { name: "Online", lat: 0, lon: 0 }, radiusKm: 0, attributes: {}, mustAsk: [], filters: [f] } as any, { title: "React developer", summary: "" });
    assert.equal(s.requirements[0].value, "2–3 years");
  }
});

test("a provider's agent is told where the request is, so it doesn't ask", () => {
  const p = GatherTask.prompt({ offering: "Deep cleaning", brief: { title: "Deep cleaning", summary: "2BHK this Saturday", category: "tasks", mode: "in_person", area: "Koramangala", requirements: [], budget: null, questions: [] }, answered: [], usual: [] });
  assert.match(p, /Where: Koramangala/);
});

test("demo customers ask in their own words, never with prices or contacts; without the model, the listing's title", async () => {
  const listing = { title: "Home deep cleaning · 2BHK / 3BHK", details: "Team of 3", category: "tasks", area: "Koramangala", people: 3 };
  const d = await decide(model({ requests: ["Need my 2BHK deep cleaned this Saturday, we have a cat", "Deep clean for ₹2,000?", "Call me on 98450 12345 for a cleaning", "Moving out next week — need the flat spotless for the landlord"] }), DemoAsksTask, listing);
  assert.deepEqual(d.output, ["Need my 2BHK deep cleaned this Saturday, we have a cat", "Moving out next week — need the flat spotless for the landlord"]);
  const off = await decide(null, DemoAsksTask, listing);
  assert.deepEqual(off.output, ["Looking for home deep cleaning in Koramangala"]);
});

test("the request asked back isn't a question for providers", async () => {
  const { ListingFieldsTask } = await import("../src/market/read.ts");
  const { domain } = await import("../src/market/domains.ts");
  const text = "Can you book a home deep cleaning for my 2BHK in Koramangala this Saturday?";
  const d = await decide(model({ item: "home deep cleaning", place: "Koramangala", price: null, limit: null, attributes: {}, questions: [text, "Do you bring your own cleaning supplies?"] }),
    ListingFieldsTask, { text, domain: domain("tasks")!, side: "find" });
  assert.deepEqual(d.output.questions, ["Do you bring your own cleaning supplies?"]);
});

test("an earlier answer never beats what today's request says; a question the request doesn't cover still gets it", async () => {
  const db = memoryDocs();
  await rememberAnswer(db, "amy", { question: "How many years of experience do you need?", answer: "5+ years" }, 1);
  await rememberAnswer(db, "amy", { question: "Which language should the sessions be in?", answer: "English" }, 1);
  const brief = { title: "React developer", summary: "Looking for a React developer", category: "tasks", mode: null, area: null, budget: null, questions: [],
    requirements: [{ label: "Experience", value: "2–3 years", strength: "required" as const }] };
  const e = fresh({ briefId: null, brief, requester: { uid: "amy", handle: "amy", name: "Amy" }, provider: { uid: "pat", handle: "pat", name: "Pat" },
    offer: { factId: null, title: "React development", price: null, unit: null, category: "tasks" } });
  await requesterTurn(db, model({ action: "answer", answer: "2–3 years.", evidence: ["2–3 years"] }), e, { kind: "collab.turn/v1", from: "provider", engagementId: e.id,
    questions: [{ id: "q1", question: "How many years of experience do you need?" }, { id: "q2", question: "Which language should the sessions be in?" }] } as any);
  const [q1, q2] = ["q1", "q2"].map(id => e.qa.find(q => q.id === id)!);
  assert.equal(q1.answer, "2–3 years.", "this request's range, not an older request's answer");
  assert.notEqual(q1.source, "memory");
  assert.equal(q2.answer, "English"); assert.equal(q2.source, "memory", "nothing in the request says it: the remembered answer stands");
});

test("search reads track records only for the people it shows, and every shown row has its own", async () => {
  const db = memoryDocs(), reads: string[] = [], at = Math.floor(Date.now() / 1000);
  const get = db.get.bind(db);
  db.get = async (c: string, id: string) => { if (c === "stats") reads.push(id); return get(c, id); };
  for (let i = 0; i < 12; i++) {
    const uid = `p${i}`;
    await db.set(PROFILES, uid, { uid, handle: uid, name: `Teacher ${i}`, bio: "", area: null, createdAt: 1 });
    await db.set(FACTS, `f${i}`, { id: `f${i}`, owner: uid, text: "I teach guitar", tier: "public", topics: [], offer: null, embedding: [1, 0], createdAt: 1, updatedAt: 1 });
    await db.set("stats", uid, { deals: i, kept: i, fellThrough: 0, at });
  }
  const brief = { id: "b", owner: "amy", createdAt: 1, shared: { title: "Guitar teacher", summary: "", category: "lessons", mode: null, area: null, requirements: [], budget: null, questions: [] },
    need: { id: "n", category: "lessons", text: "", place: { name: "Online", lat: 0, lon: 0 }, radiusKm: 8, maxPrice: null, attributes: {}, mustAsk: [], filters: [] } } as any;
  const r = await search(db, { name: "t", complete: async () => null, embed: async () => [[1, 0]] } as any, brief, "amy");
  assert.equal(r.found.length, 8);
  assert.ok(r.found.every(f => f.profile.stats.deals === Number(f.profile.uid.slice(1))), "each row has its own record");
  assert.deepEqual(reads.sort(), r.found.map(f => f.profile.uid).sort(), "records only for the rows shown");
});

test("nothing fits: the closest listings shown come with their records; a paused owner is skipped", async () => {
  const db = memoryDocs(), at = Math.floor(Date.now() / 1000), far = [0.35, Math.sqrt(1 - 0.35 ** 2)];
  for (const [i, paused] of [[0, true], [1, false], [2, false]] as const) {
    const uid = `c${i}`;
    await db.set(PROFILES, uid, { uid, handle: uid, name: `Shop ${i}`, bio: "", area: null, createdAt: 1, ...(paused ? { paused: true } : {}) });
    await db.set(FACTS, `g${i}`, { id: `g${i}`, owner: uid, text: "Steel bottles", tier: "public", topics: [], offer: { category: "goods", title: "Steel bottles", status: "active" }, embedding: far, createdAt: 1, updatedAt: 1 });
    await db.set("stats", uid, { deals: 3 + i, kept: 3, fellThrough: 0, at });
  }
  const brief = { id: "b", owner: "amy", createdAt: 1, shared: { title: "Guitar teacher", summary: "", category: "lessons", mode: null, area: null, requirements: [], budget: null, questions: [] },
    need: { id: "n", category: "lessons", text: "", place: { name: "Online", lat: 0, lon: 0 }, radiusKm: 8, maxPrice: null, attributes: {}, mustAsk: [], filters: [] } } as any;
  const r = await search(db, { name: "t", complete: async () => null, embed: async () => [[1, 0]] } as any, brief, "amy");
  assert.equal(r.found.length, 0);
  assert.deepEqual(r.closest.map(c => [c.profile.uid, c.profile.stats.deals]).sort(), [["c1", 4], ["c2", 5]]);
});

test("a range never filters as an exact number: it isn't kept as a listing field, and matches from its lower end", async () => {
  const { ListingFieldsTask } = await import("../src/market/read.ts");
  const { domain } = await import("../src/market/domains.ts");
  const text = "Looking for a guitar teacher in Indiranagar with 2-3 years of teaching experience";
  const f = await decide(model({ item: "guitar teacher", place: "Indiranagar", price: null, limit: null, attributes: { experience_years: "2-3" }, questions: [] }),
    ListingFieldsTask, { text, domain: domain("lessons")!, side: "find" });
  assert.equal(f.output.attributes.experience_years, undefined, "not a number written in the request");
  const now = Math.floor(Date.now() / 1000), place = resolve("Indiranagar")!;
  const o = (key: string, attributes: Record<string, string>) => ({ key, offer: { id: key, category: "lessons", title: key, details: "", price: { amount: 800, currency: "INR", period: "hour" },
    place, attributes, askBuyer: [], publishedAt: now, expiresAt: now + 86_400, status: "active" as const } });
  const need = { id: "n", category: "lessons", text: "", place, radiusKm: 5, maxPrice: null, attributes: {}, mustAsk: [], unit: "hour", mode: null,
    filters: [{ id: "experience_years", label: "Teaching experience", kind: "number" as const, comparison: "atLeast" as const, value: "2", upTo: "3", unit: "years", strength: "required" as const, source: "stated" as const, evidence: "2-3 years" }] };
  assert.deepEqual(rank([o("five", { experience_years: "5" }), o("one", { experience_years: "1" }), o("unsaid", {})], need, now).map(m => m.key).sort(), ["five", "unsaid"]);
});

test("a request drafted outside the chat (a goal's or a plan's step) asks no quality gate", async () => {
  const tasks: string[] = [], fake = fakeModel();
  const m = { ...fake, complete: async (req: any) => { tasks.push(req.task); return fake.complete(req); } };
  const d = await draft(m, "I need a guitar teacher in Indiranagar", resolve("Indiranagar"), Math.floor(Date.now() / 1000));
  assert.ok(d.draft && tasks.length);
  assert.ok(!tasks.includes("intake.quality"), tasks.join(", "));
});

test("a detail added to an open request is kept only in the message's words; answers only to pending questions", async () => {
  const { RefineTask } = await import("../src/core/tasks.ts");
  const input = { text: "needs 2-3 years of experience, remote is fine", area: "Online", radiusKm: 8, limit: null, requirements: [{ label: "Role", value: "React developer" }],
    pending: [{ question: "Remote or in office?", options: ["Remote", "Office"] }] };
  const r = RefineTask.validate({ radiusKm: null, area: null, limit: null, drop: [], add: [{ label: "Experience", value: "2-3 years" }, { label: "Stack", value: "Vue" }],
    answers: [{ question: "Remote or in office?", answer: "Remote" }, { question: "Start date?", answer: "Monday" }] }, input)!;
  assert.deepEqual(r.add, [{ label: "Experience", value: "2-3 years" }], "a value not in the message is dropped");
  assert.deepEqual(r.answers, [{ question: "Remote or in office?", answer: "Remote" }], "an answer to a question that isn't pending is dropped");
});
