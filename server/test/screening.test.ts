// Shortlisting: requirements are read from the JD (each quoted from it), every applicant is checked against what they
// shared (each verdict quoted from it), the clear-cut checks and the score are the code's, and nothing about the
// person — their name, age, religion — reaches the model.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Model } from "../src/ai/gemini.ts";
import { decide } from "../src/ai/decide.ts";
import { JDTask, candidateFacts, hiringStatus, jdRules, requirementsFrom, screen } from "../src/core/hiring.ts";
import type { Engagement } from "../src/core/model.ts";
import type { Requirement } from "../src/market/types.ts";

const JD = "We're hiring a junior developer in Indiranagar, ₹30,000 a month. 2+ years with React and Node.js, hybrid, join within 30 days. Good communication.";

test("the JD's requirements must quote it; pay, invented ones and anything personal are dropped", async () => {
  const model = (requirements: object[]): Model => ({ name: "t", complete: async () => JSON.stringify({ requirements }) });
  const d = await decide(model([
    { label: "Experience", value: "2+ years", strength: "must", evidence: "2+ years with React" },
    { label: "Communication", value: "Good communication", strength: "nice", evidence: "Good communication" },
    { label: "Degree", value: "B.Tech", strength: "must", evidence: "B.Tech in computer science" },        // not in the JD
    { label: "Salary", value: "₹30,000", strength: "must", evidence: "₹30,000 a month" },                    // pay
    { label: "Gender", value: "Male", strength: "must", evidence: "junior developer" },                       // personal
  ]), JDTask, { text: JD });
  assert.deepEqual(d.output.map(r => r.label), ["Experience", "Communication"]);
  // Without the model: what the JD says in so many words.
  assert.deepEqual(jdRules(JD), [
    { label: "Experience", value: "2+ years", strength: "must" }, { label: "Skills", value: "React, Node.js", strength: "must" },
    { label: "Work mode", value: "Hybrid", strength: "must" }, { label: "Notice period", value: "Within 30 days", strength: "must" }]);
  assert.deepEqual(requirementsFrom([{ label: "Age", value: "Under 30" }, { label: "Religion", value: "Any" }, { label: "Skills", value: "SQL", strength: "nice" }]),
    [{ label: "Skills", value: "SQL", strength: "nice" }], "an employer's own edits are checked the same way");
});

const app = (about: { label: string; value: string }[], answers: [string, string][] = [], name = "Ravi Kumar"): Engagement => ({
  id: "e1", requester: { uid: "r", handle: "ravi", name }, provider: { uid: "p", handle: "bp", name: "Brightpath Tech" }, participants: ["r", "p"], title: "",
  brief: { title: "Looking for a developer job", summary: `${name.split(" ")[0]} is a developer. He is 26 years old and married.`, category: "jobs", mode: null, area: null, requirements: [], budget: "from ₹30,000/month", questions: [], about },
  offer: { factId: "f1", title: "Junior Developer", price: 30_000, unit: "month", category: "jobs" }, seller: "requester", phase: "asking", waiting: { requester: null, provider: null },
  qa: answers.map(([question, answer], i) => ({ id: `q${i}`, from: "provider" as const, question, answer, status: "answered" as const })),
  negotiation: { requester: [], provider: [], deal: null, dealBy: null, confirmed: { requester: false, provider: false } }, events: [], createdAt: 0, updatedAt: 0,
} as unknown as Engagement);

const REQS: Requirement[] = [
  { label: "Experience", value: "2+ years", strength: "must" }, { label: "Skills", value: "React, Node.js", strength: "must" },
  { label: "Work mode", value: "Hybrid", strength: "must" }, { label: "Notice period", value: "Within 30 days", strength: "must" },
  { label: "Communication", value: "Good communication", strength: "nice" },
];

test("the clear-cut checks are the code's: years, notice, work mode and skills, each with the candidate's own words", async () => {
  const strong = await screen(null, app([{ label: "Experience", value: "3–5 years" }, { label: "Skills", value: "React, Node.js, SQL" }, { label: "Notice period", value: "Within 15 days" }, { label: "Work mode", value: "On-site" }]), REQS, 0);
  assert.deepEqual(strong.checks.map(c => [c.label, c.verdict, c.by]), [["Experience", "met", "rules"], ["Skills", "met", "rules"], ["Work mode", "met", "rules"], ["Notice period", "met", "rules"], ["Communication", "unknown", "none"]]);
  assert.equal(strong.checks[0].evidence, "Experience: 3–5 years");
  assert.equal(strong.summary, "4 of 4 must-haves · 0 of 1 nice-to-haves · 1 to ask");
  const weak = await screen(null, app([{ label: "Experience", value: "Fresher" }, { label: "Skills", value: "Java" }, { label: "Notice period", value: "In 60+ days" }, { label: "Work mode", value: "Remote" }]), REQS, 0);
  assert.deepEqual(weak.checks.slice(0, 4).map(c => c.verdict), ["unmet", "unmet", "unmet", "unmet"]);
  const partly = await screen(null, app([{ label: "Experience", value: "1–2 years" }, { label: "Skills", value: "React" }]), REQS, 0);
  assert.deepEqual(partly.checks.slice(0, 4).map(c => c.verdict), ["partial", "partial", "unknown", "unknown"], "1–2 years may or may not be 2; one of two skills");
  assert.ok(strong.score > partly.score && partly.score > weak.score, `${strong.score} > ${partly.score} > ${weak.score}`);
  // The same inputs aren't screened twice.
  assert.equal(await screen(null, { ...app(strong.checks.length ? [{ label: "Experience", value: "3–5 years" }, { label: "Skills", value: "React, Node.js, SQL" }, { label: "Notice period", value: "Within 15 days" }, { label: "Work mode", value: "On-site" }] : []), screening: strong } as Engagement, REQS, 99), strong);
});

test("the model sees no name and nothing personal, and a verdict without the candidate's own words is 'unknown'", async () => {
  let prompt = "";
  const model = (checks: object[], summary: string): Model => ({ name: "t", complete: async r => { prompt = r.prompt; return JSON.stringify({ checks, summary }); } });
  const e = app([{ label: "Experience", value: "3–5 years" }], [["Can you present to clients?", "Yes, Ravi presents to clients every week."]]);
  assert.ok(!candidateFacts(e).some(f => /Ravi|26 years old|married/.test(f)), JSON.stringify(candidateFacts(e)));
  const s = await screen(model([{ label: "Communication", verdict: "met", evidence: "presents to clients every week" }], "Strong client-facing developer"), e, REQS, 0);
  assert.doesNotMatch(prompt, /Ravi|married|26 years old/);
  assert.match(prompt, /The candidate presents to clients/);
  const comm = s.checks.find(c => c.label === "Communication")!;
  assert.deepEqual([comm.verdict, comm.by, comm.evidence], ["met", "gemini", "presents to clients every week"]);
  assert.equal(s.note, "Strong client-facing developer", "Gemini's line is a note beside the code's count");
  const invented = await screen(model([{ label: "Communication", verdict: "met", evidence: "won a public speaking award" }], "Has 10 years of experience"), { ...e, qa: [] } as Engagement, REQS, 0);
  assert.equal(invented.checks.find(c => c.label === "Communication")!.verdict, "unknown", "a quote that isn't in what they shared");
  assert.equal(invented.note, undefined, "a summary with a number they never gave");
});

test("an applicant's status follows the conversation and the employer's moves", () => {
  const e = app([]);
  assert.equal(hiringStatus(e), "new");
  assert.equal(hiringStatus({ ...e, hiring: { shortlisted: 1 } } as Engagement), "shortlisted");
  assert.equal(hiringStatus({ ...e, hiring: { interview: 1 } } as Engagement), "interview");
  assert.equal(hiringStatus({ ...e, hiring: { shortlisted: 1 }, negotiation: { ...e.negotiation, provider: [{ id: "x", price: 30_000, terms: {}, round: 0 }] } } as Engagement), "in talks");
  assert.equal(hiringStatus({ ...e, phase: "deal" } as Engagement), "offer to send");
  const letter = { role: "Dev", salary: 1, unit: "month", start: "2026-11-01", validUntil: "2026-10-24", mode: "", probation: "", notice: "", issuedAt: 1, revision: 1, hash: "h" };
  assert.equal(hiringStatus({ ...e, phase: "deal", offerLetter: { ...letter, status: "issued" } } as Engagement), "offer sent");
  assert.equal(hiringStatus({ ...e, phase: "deal", offerLetter: { ...letter, status: "changes asked" } } as Engagement), "changes asked");
  assert.equal(hiringStatus({ ...e, phase: "closed", offerLetter: { ...letter, status: "declined" } } as Engagement), "offer declined");
  assert.equal(hiringStatus({ ...e, phase: "agreed" } as Engagement), "offer accepted");
  assert.equal(hiringStatus({ ...e, phase: "declined", hiring: { rejected: 1 } } as Engagement), "rejected");
});
