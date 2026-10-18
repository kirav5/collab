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
