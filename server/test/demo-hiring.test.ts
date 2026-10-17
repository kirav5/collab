// The hiring demo against the real server with the demo seed: an employer invites the demo candidates to their own job
// post, and a candidate applies to the demo employer. A demo person's phone is simulated, so the person talking to them
// makes their decisions for them — never a real person's.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";

const PORT = 8700 + Math.floor(Math.random() * 100);
const B = `http://localhost:${PORT}`;
let server: ChildProcess;

before(async () => {
  server = spawn(process.execPath, ["src/server.ts"], { cwd: new URL("..", import.meta.url).pathname, stdio: "pipe",
    env: { ...process.env, PORT: String(PORT), STORE: "memory", DEV_AUTH: "1", SEED_DEMO: "1", GEMINI_FAKE: "1", GEMINI_API_KEY: "", PUBLIC_URL: B } });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${B}/health`)).ok) return; } catch { /* starting */ } await new Promise(r => setTimeout(r, 200)); }
  throw new Error("server didn't start");
});
after(() => { server.kill(); });

const raw = (uid: string, path: string, body?: unknown) => fetch(B + path, { method: body === undefined ? "GET" : "POST",
  headers: { "content-type": "application/json", authorization: `Bearer dev:${uid}` }, body: body === undefined ? undefined : JSON.stringify(body) });
async function as(uid: string, path: string, body?: unknown) {
  const r = await raw(uid, path, body);
  const data = await r.json();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(data)}`);
  return data;
}
const today = new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + 19_800_000 + n * 86_400_000).toISOString().slice(0, 10);

/** Answers whatever this person's inbox holds for one conversation (their own items and a demo person's), except the
 *  offer letter and the decision on it; runs any waiting turn. Until the salary is agreed. */
async function talk(uid: string, id: string) {
  let e = await as(uid, `/api/engagements/${id}`);
  for (let i = 0; i < 30 && !["deal", "agreed", "closed", "declined"].includes(e.phase); i++) {
    const item = (await as(uid, "/api/inbox")).find((x: any) => x.engagementId === id && !["offer_letter", "offer"].includes(x.kind));
    if (item) await as(uid, `/api/inbox/${item.id}`, item.kind === "answer" ? { text: "Full-time, 10 to 6." } : item.kind === "confirm" ? { confirm: true } : item.kind === "move" ? {} : { share: true });
    e = await as(uid, `/api/engagements/${id}/run`, {});
    if (!item && !e.outbox) break;
  }
  return e;
}

test("demo: an employer invites the demo candidates; they're screened, and the employer decides for them only where they're demo", async () => {
  await as("hr", "/api/me", { handle: "acme-hr", name: "Acme Software", areaName: "Indiranagar" });
  const d = await as("hr", "/api/offers/draft", { text: "Job offer: we're hiring a junior developer in Indiranagar, ₹30,000 a month. 2+ years with React and Node.js, hybrid, join within 30 days." });
  const job = await as("hr", "/api/facts", { tier: "public", text: d.publicText });
  await as("hr", `/api/facts/${job.id}/requirements`, { requirements: d.offer.requirements });
  await as("hr", `/api/facts/${job.id}/limit`, { mandate: { price: { opening: 30_000, limit: 36_000 } }, autonomy: "close" });

  assert.equal((await raw("someone", `/api/facts/${job.id}/demo-applicants`, {})).status, 404, "only the employer invites them");
  assert.equal((await as("hr", `/api/facts/${job.id}/demo-applicants`, {})).added, 4);
  assert.equal((await as("hr", `/api/facts/${job.id}/demo-applicants`, {})).added, 0, "each applies once");
  for (const a of (await as("hr", `/api/facts/${job.id}/applicants`)).applicants) await talk("hr", a.id);
  const board = await as("hr", `/api/facts/${job.id}/applicants`);
  assert.deepEqual(board.applicants.map((a: any) => [a.name, a.status]).sort(), [["Anya Rao", "new"], ["Bilal Khan", "new"], ["Meghna Shetty", "new"], ["Ravi Kumar", "new"]]);
  assert.deepEqual(board.applicants.slice(0, 2).map((a: any) => a.screening.summary), ["4 of 4 must-haves", "4 of 4 must-haves"], "the two strong fits first");
  assert.equal(board.applicants.at(-1).name, "Bilal Khan");
  assert.ok(board.applicants.every((a: any) => /^from ₹/.test(a.band)), "each shares a band, never their minimum");

  // Anya: shortlisted; the agents agree a salary inside both limits; the letter, her decision and her joining.
  const anya = board.applicants.find((a: any) => a.name === "Anya Rao");
  await as("hr", `/api/engagements/${anya.id}/shortlist`, {});
  let e = await talk("hr", anya.id);
  assert.equal(e.phase, "deal", JSON.stringify(e.events.slice(-3)));
  assert.ok(e.negotiation.deal.price >= 32_000 && e.negotiation.deal.price <= 36_000, `${e.negotiation.deal.price}`);
  const letter = (await as("hr", "/api/inbox")).find((i: any) => i.engagementId === e.id && i.kind === "offer_letter");
  assert.equal(letter.owner, "hr", "the employer's own letter");
  e = await as("hr", `/api/inbox/${letter.id}`, { letter: { ...letter.letter, start: today, validUntil: inDays(7) } });
  const offer = (await as("hr", "/api/inbox")).find((i: any) => i.engagementId === e.id && i.kind === "offer");
  assert.equal(offer.owner, "demo-anya", "her decision shows to the employer because her phone is simulated");
  e = await as("hr", `/api/inbox/${offer.id}`, { confirm: true });
  assert.equal(e.phase, "agreed");
  assert.equal((await raw("hr", `/api/engagements/${e.id}/joining`, { action: "joined" })).status, 400, "not as the employer");
  e = await as("hr", `/api/engagements/${e.id}/joining`, { action: "joined", as: "them" });
  assert.equal(e.joining.state, "joined");
  assert.equal(e.events.at(-1).who, "requester", "recorded as hers");
  e = await as("hr", `/api/engagements/${e.id}/joining`, { action: "confirm" });
  const hires = (await as("hr", `/api/facts/${job.id}/applicants`)).hires;
  assert.deepEqual(hires.map((h: any) => [h.name, h.status]), [["Anya Rao", "joined"]]);
});

test("demo: a candidate applies to the demo employer and makes its decisions; nobody acts for a real person", async () => {
  await as("cand", "/api/me", { handle: "kiran", name: "Kiran Das", areaName: "Indiranagar" });
  const d = (await as("cand", "/api/briefs/draft", { text: "Looking for a job as a junior developer in Indiranagar, ₹32,000 a month" })).draft;
  const sent = await as("cand", "/api/briefs", { need: d.need, shared: { ...d.shared, about: [{ label: "Experience", value: "3–5 years" }, { label: "Skills", value: "React, Node.js" }, { label: "Work mode", value: "Hybrid" }, { label: "Notice period", value: "Within 15 days" }] },
    delegate: { mandate: d.mandate, autonomy: "close" } });
  const found = sent.found.find((f: any) => f.profile.handle === "brightpath");
  assert.ok(found, "the demo job post is found");
  assert.equal(found.fact.offer.requirements.length, 5, "with its requirements");
  const [e0] = await as("cand", `/api/briefs/${sent.brief.id}/engage`, { providers: [{ factId: found.fact.id }] });
  let e = await talk("cand", e0.id);
  assert.ok(e.events.some((x: any) => /^Thanks — Brightpath Tech is reviewing applications/.test(x.text)), JSON.stringify(e.events.slice(-3)));
  // The demo employer's decisions are the candidate's to make for it.
  await as("cand", `/api/engagements/${e.id}/shortlist`, {});
  e = await talk("cand", e.id);
  assert.equal(e.phase, "deal", JSON.stringify(e.events.slice(-3)));
  const letter = (await as("cand", "/api/inbox")).find((i: any) => i.engagementId === e.id && i.kind === "offer_letter");
  assert.equal(letter.owner, "demo-brightpath");
  assert.deepEqual([letter.letter.probation, letter.letter.mode], ["3 months, with a review at the end.", "Hybrid"], "from the demo employer's own terms");
  e = await as("cand", `/api/inbox/${letter.id}`, { letter: { ...letter.letter, start: today, validUntil: inDays(7) } });
  const offer = (await as("cand", "/api/inbox")).find((i: any) => i.engagementId === e.id && i.kind === "offer");
  assert.equal(offer.owner, "cand", "the candidate's own decision");
  e = await as("cand", `/api/inbox/${offer.id}`, { confirm: true });
  e = await as("cand", `/api/engagements/${e.id}/joining`, { action: "joined" });
  e = await as("cand", `/api/engagements/${e.id}/joining`, { action: "confirm", as: "them" });
  assert.equal(e.joining.state, "confirmed");
  const goal = (await as("cand", "/api/goals")).find((g: any) => g.tasks.some((t: any) => t.id === e.id));
  assert.equal(goal.state, "completed");

  // A real employer and a real candidate: neither can act for the other.
  await as("realco", "/api/me", { handle: "realco", name: "Real Co", areaName: "Indiranagar" });
  const job = await as("realco", "/api/facts", { tier: "public", text: "Job offer: we're hiring a junior developer in Indiranagar, ₹30,000 a month" });
  const [r0] = await as("cand", `/api/briefs/${sent.brief.id}/engage`, { providers: [{ factId: job.id }] });
  await as("cand", `/api/engagements/${r0.id}/run`, {});
  assert.equal((await raw("cand", `/api/engagements/${r0.id}/shortlist`, {})).status, 404, "a candidate can't shortlist themselves with a real employer");
  for (const i of (await as("realco", "/api/inbox")).filter((x: any) => x.engagementId === r0.id)) assert.equal((await raw("cand", `/api/inbox/${i.id}`, { text: "yes" })).status, 403, "nor answer for them");
  assert.ok(!(await as("cand", "/api/inbox")).some((i: any) => i.engagementId === r0.id && i.owner === "realco"), "nor see their device");
});
