// A job post end to end against the real server (in memory, offline stand-in for Gemini): the employer's listing is
// one whose owner pays, so the candidate who answers it is the one paid — matching, the private limits, the agents'
// negotiation and payment all run that way round.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";

const PORT = 9300 + Math.floor(Math.random() * 100);
const B = `http://localhost:${PORT}`;
let server: ChildProcess;

before(async () => {
  server = spawn(process.execPath, ["src/server.ts"], { cwd: new URL("..", import.meta.url).pathname, stdio: "pipe",
    env: { ...process.env, PORT: String(PORT), STORE: "memory", DEV_AUTH: "1", GEMINI_FAKE: "1", GEMINI_API_KEY: "", PUBLIC_URL: B } });
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

/** Plays one person's device: answers questions, moves with its private limit, confirms. */
async function device(uid: string, limits: Record<string, any>) {
  for (const i of await as(uid, "/api/inbox")) {
    // An offer letter is the people's to send and decide: each test does that itself.
    if (i.owner !== uid || i.kind === "offer_letter" || i.kind === "offer") continue;
    const body = i.kind === "answer" ? { text: "Next month" } : i.kind === "move" ? { mandate: limits[i.side] } : i.kind === "confirm" ? { confirm: true } : { share: true };
    await as(uid, `/api/inbox/${i.id}`, body);
    return true;
  }
  return false;
}

test("hiring: the employer's ceiling stays private, the salary lands inside both limits, and the deal closes on joining, not a payment", async () => {
  await as("brightpath", "/api/me", { handle: "brightpath", name: "Brightpath Tech", areaName: "Indiranagar" });
  await as("ravi", "/api/me", { handle: "ravi", name: "Ravi", areaName: "Indiranagar" });

  // The employer's draft: the listed salary is public, "can stretch to" is their private ceiling.
  const draft = await as("brightpath", "/api/offers/draft", { text: "Job offer: we're hiring a junior developer in Indiranagar, ₹30,000 a month, can stretch to 36,000" });
  assert.equal(draft.ownerPays, true, "an employer's post: the owner pays");
  assert.equal(draft.floor, 36_000, "the private limit is above the listed salary");
  assert.ok(!/36/.test(draft.publicText), draft.publicText);
  const job = await as("brightpath", "/api/facts", { tier: "public", text: draft.publicText });
  assert.equal(job.offer?.ownerPays, true);
  const cfg = await (await fetch(`${B}/api/config`)).json();
  assert.equal(cfg.roles.byCategory.jobs.payer, "employer", "the app gets the role words");

  // The candidate's request: their number is the least they'd take, shared only as a band below it.
  const d = (await as("ravi", "/api/briefs/draft", { text: "Looking for a job as a junior developer in Indiranagar, ₹32,000 a month" })).draft;
  assert.equal(d.need.requesterPaid, true);
  assert.ok(d.mandate.price.opening > d.mandate.price.limit, "a paid requester opens above their floor");
  assert.match(d.shared.budget, /^from /);
  assert.ok(!/32,?000/.test(JSON.stringify(d.shared)), "the shared brief has no exact floor");
  // A form that built the limit the buyer's way round is pointed the right way by the server.
  const sent = await as("ravi", "/api/briefs", { need: d.need, shared: d.shared, delegate: { mandate: { price: { opening: 28_800, limit: 32_000 } }, autonomy: "negotiate" } });
  const limits = await as("ravi", "/api/limits");
  const mine = limits.find((l: any) => l.key === `brief:${sent.brief.id}`);
  assert.ok(mine.mandate.price.opening > mine.mandate.price.limit, JSON.stringify(mine));
  assert.ok(!JSON.stringify(sent.brief).includes("32000"), "the stored brief keeps the band, not the floor");
  const found = sent.found.find((f: any) => f.profile.handle === "brightpath");
  assert.ok(found, "the job post is found for someone looking for that job");

  const [e0] = await as("ravi", `/api/briefs/${sent.brief.id}/engage`, { providers: [{ factId: found.fact.id }] });
  assert.equal(e0.seller, "requester", "the candidate is the one paid");
  let e = await as("ravi", `/api/engagements/${e0.id}/run`, {});
  const both = { requester: { price: { opening: 40_000, limit: 32_000 }, terms: {}, maxRounds: 5 }, provider: { price: { opening: 30_000, limit: 36_000 }, terms: {}, maxRounds: 5 } };
  // Before the employer shortlists Ravi: questions both ways, then the employer's agent holds the salary talk.
  for (let i = 0; i < 20 && !e.events.some((x: any) => /reviewing applications/.test(x.text)); i++) {
    const moved = (await device("ravi", both)) || (await device("brightpath", both));
    e = await as("ravi", `/api/engagements/${e.id}`);
    if (!moved) break;
  }
  assert.ok(e.events.some((x: any) => /^Thanks — Brightpath Tech is reviewing applications/.test(x.text)), JSON.stringify(e.events.slice(-3)));
  assert.equal(e.negotiation.provider.length + e.negotiation.requester.length, 0, "no salary talk before shortlisting");
  assert.equal(e.phase, "asking");
  // The employer shortlists him: their agent opens the salary talk.
  e = await as("brightpath", `/api/engagements/${e.id}/shortlist`, {});
  assert.ok(e.events.some((x: any) => x.text === "Brightpath Tech shortlisted Ravi."));
  for (let i = 0; i < 30 && e.phase !== "deal"; i++) {
    const moved = (await device("ravi", both)) || (await device("brightpath", both));
    e = await as("ravi", `/api/engagements/${e.id}`);
    if (!moved) break;
  }
  // The agents agreed a salary; the people settle it: no standing mandate says yes for either of them.
  assert.equal(e.phase, "deal", JSON.stringify(e.events.slice(-4)));
  assert.ok(!e.events.some((x: any) => /in advance|on .+'s behalf/.test(x.text)), "no mandate confirmed a job offer");
  const toSend = (await as("brightpath", "/api/inbox")).find((i: any) => i.engagementId === e.id && i.kind === "offer_letter");
  assert.ok(toSend, "the employer is asked to send the offer letter");
  assert.equal(toSend.letter.salary, e.negotiation.deal.price);
  assert.equal(toSend.letter.role, "Junior Developer", "starts from the job post");
  const today = new Date(Date.now() + 19_800_000).toISOString().slice(0, 10), inDays = (n: number) => new Date(Date.now() + 19_800_000 + n * 86_400_000).toISOString().slice(0, 10);
  assert.equal((await raw("brightpath", `/api/inbox/${toSend.id}`, { letter: { ...toSend.letter, start: "2020-01-01" } })).status, 400, "a start date in the past");
  e = await as("brightpath", `/api/inbox/${toSend.id}`, { letter: { ...toSend.letter, role: "Junior Developer", start: today, validUntil: inDays(7), mode: "Hybrid, Indiranagar", probation: "3 months", notice: "30 days" } });
  assert.equal(e.offerLetter.status, "issued");
  assert.ok(e.offerLetter.signature?.startsWith("ed25519."), "signed by the employer's agent");
  assert.equal(e.negotiation.confirmed.provider, true);
  const offer = (await as("ravi", "/api/inbox")).find((i: any) => i.engagementId === e.id && i.kind === "offer");
  assert.ok(offer, "Ravi decides on the letter himself");
  assert.equal(offer.deadline, Math.floor(Date.parse(`${inDays(7)}T23:59:59+05:30`) / 1000), "open until the day the letter says");
  assert.ok(today <= e.offerLetter.validUntil);
  e = await as("ravi", `/api/inbox/${offer.id}`, { confirm: true });
  assert.equal(e.phase, "agreed", JSON.stringify(e.events.slice(-4)));
  assert.equal(e.offerLetter.status, "accepted");
  const salary = e.negotiation.deal.price;
  assert.ok(salary >= 32_000 && salary <= 36_000, `salary ${salary} inside both limits`);
  assert.ok(e.negotiation.requester.every((p: any) => p.price >= 32_000), "the candidate never offered below their floor");
  assert.ok(e.negotiation.provider.every((p: any) => p.price <= 36_000), "the employer never offered above their ceiling");
  // It reads as an employer and a candidate talking: an application, the employer screening, then salary in each
  // side's own words.
  const said = (who: string): string[] => e.events.filter((x: any) => x.who === who).map((x: any) => x.text);
  assert.match(said("requester_agent")[0], /^Hello — Ravi would like to apply for (the .+|this) role\./);
  assert.ok(said("provider_agent").some(t => /experience|notice period/.test(t)), `the employer's agent screens: ${said("provider_agent")}`);
  assert.ok(!said("provider_agent").some(t => /team size, and notice period/.test(t)), "not a candidate's question");
  assert.ok(said("provider_agent").includes("We can offer ₹30,000/month for this role."));
  assert.ok(said("requester_agent").some(t => /^Thanks — Ravi is looking for ₹/.test(t)), `${said("requester_agent")}`);
  assert.ok(!said("requester_agent").some(t => /\bWe can (offer|do)\b/.test(t)), "the candidate never offers a salary");

  // A salary isn't paid through Collab: no cart, nobody can pay, and the deal closes on the offer accepted, then joining.
  assert.equal(e.noPayment, true);
  assert.equal(e.payment ?? null, null, "no cart for a salary");
  for (const uid of ["ravi", "brightpath"]) assert.ok([403, 409].includes((await raw(uid, `/api/engagements/${e.id}/pay`, {})).status), `${uid} can't pay`);
  // Joining is the people's own step: Ravi marks it (not before his start date, not a day in the future), the employer
  // confirms. The generic delivered/received buttons don't apply to an accepted letter.
  const goal = (await as("ravi", "/api/goals")).find((g: any) => g.tasks.some((t: any) => t.id === e.id));
  assert.match(goal.tasks.find((t: any) => t.id === e.id).next, /^You start today — mark when you've joined\.$/);
  for (const [uid, path] of [["ravi", "delivered"], ["brightpath", "received"], ["ravi", "outcome"]]) assert.equal((await raw(uid, `/api/engagements/${e.id}/${path}`, { ok: true })).status, 409, `${path} is for other deals`);
  assert.equal((await raw("brightpath", `/api/engagements/${e.id}/joining`, { action: "joined" })).status, 400, "only the candidate says they've joined");
  assert.equal((await raw("ravi", `/api/engagements/${e.id}/joining`, { action: "joined", date: inDays(1) })).status, 400, "not a day in the future");
  e = await as("ravi", `/api/engagements/${e.id}/joining`, { action: "joined" });
  assert.deepEqual([e.joining.state, e.joining.joinedOn, e.fulfilment.state], ["joined", today, "delivered"]);
  assert.equal(e.events.at(-1).text, `Joined on ${today}.`);
  assert.equal((await as("brightpath", `/api/facts/${job.id}/applicants`)).applicants[0].status, "says joined", "first on the employer's board");
  assert.equal((await raw("ravi", `/api/engagements/${e.id}/joining`, { action: "confirm" })).status, 400, "only the employer confirms it");
  e = await as("brightpath", `/api/engagements/${e.id}/joining`, { action: "confirm" });
  assert.deepEqual([e.joining.state, e.fulfilment.state, e.outcome], ["confirmed", "accepted", { requester: "happened", provider: "happened" }]);
  assert.equal(e.events.at(-1).text, `Confirmed they joined on ${today}.`);
  assert.equal((await raw("ravi", `/api/engagements/${e.id}/joining`, { action: "withdraw", reason: "changed my mind" })).status, 400, "settled");
  const done = (await as("ravi", "/api/goals")).find((g: any) => g.id === goal.id);
  assert.match(done.tasks.find((t: any) => t.id === e.id).next, /^Joined Brightpath Tech on /);
  assert.equal(done.state, "completed");
  // The employer's hire record.
  const hires = (await as("brightpath", `/api/facts/${job.id}/applicants`)).hires;
  assert.deepEqual(hires.map((h: any) => [h.name, h.status, h.role, h.salary, h.joining.state, h.joining.joinedOn]), [["Ravi", "joined", "Junior Developer", e.offerLetter.salary, "confirmed", today]]);
  // The receipt names each side by its role, and the signed record still verifies.
  const rec = await as("ravi", `/api/engagements/${e.id}/receipt`);
  assert.deepEqual(rec.sides, { seller: "requester", payee: "candidate", payer: "employer", price: "salary", item: "Role", noPayment: true });
  assert.ok(rec.matches, "the receipt matches the registered record");
  assert.deepEqual([rec.terms.offerLetter.role, rec.terms.offerLetter.start, rec.terms.offerLetter.probation], ["Junior Developer", e.offerLetter.start, "3 months"], "the accepted letter is sealed into the record");
  // @ts-ignore standalone browser module also works with Node WebCrypto.
  const { verifyReceiptBundle } = await import("../../web/js/verify-receipt.js");
  assert.equal((await verifyReceiptBundle(rec, rec.publicKey)).receipt, true, "and anyone can verify it, letter included");
});

test("hiring: someone looking to buy finds the shop, never the job post", async () => {
  await as("cafe", "/api/me", { handle: "cafe-owner", name: "Cafe", areaName: "Indiranagar" });
  await as("cafe", "/api/facts", { tier: "public", text: "Job offer: hiring a junior developer for our cafe app in Indiranagar, ₹25,000 a month" });
  await as("shopper", "/api/me", { handle: "shopper", name: "Shopper", areaName: "Koramangala" });
  await as("seller2", "/api/me", { handle: "seller2", name: "Seller", areaName: "Koramangala" });
  await as("seller2", "/api/facts", { tier: "public", text: "Selling my used cycle in Koramangala, ₹4,000" });
  const seeker = (await as("shopper", "/api/briefs/draft", { text: "Looking for a used cycle in Koramangala under 5000" })).draft;
  const s = await as("shopper", "/api/briefs", { need: seeker.need, shared: seeker.shared });
  assert.ok(s.found.some((f: any) => f.profile.handle === "seller2"), "a buyer finds the shop");
  assert.ok(!s.found.some((f: any) => f.profile.handle === "cafe-owner"), "and not the job post");
});

test("hiring: chat words never flip who is paid, and the listed salary is the employer's opening, never the candidate's", async () => {
  await as("acme", "/api/me", { handle: "acme-hr", name: "Acme Labs", areaName: "Indiranagar" });
  const job = await as("acme", "/api/facts", { tier: "public", text: "Job offer: we're hiring a junior developer in Indiranagar, ₹30,000 a month" });
  await as("acme", `/api/facts/${job.id}/limit`, { mandate: { price: { opening: 30_000, limit: 36_000 } }, autonomy: "close" });

  // A candidate asking to be paid more ("could you pay…") stays the one paid; the employer's agent keeps its ceiling.
  await as("meena", "/api/me", { handle: "meena", name: "Meena Iyer", areaName: "Indiranagar" });
  let e = await as("meena", "/api/people/acme-hr/ask", { text: "Is the role still open?", offerFactId: job.id });
  e = await as("meena", `/api/engagements/${e.id}/run`, {});
  assert.equal(e.seller, "requester");
  e = await as("meena", `/api/engagements/${e.id}/ask`, { text: "Could you pay ₹38,000?" });
  e = await as("meena", `/api/engagements/${e.id}`);
  assert.equal(e.seller, "requester", "still the candidate who is paid");
  assert.ok(e.negotiation.provider.every((p: any) => p.price <= 36_000), `employer offers ${e.negotiation.provider.map((p: any) => p.price)}`);
  assert.ok(!(e.phase === "agreed" && e.negotiation.deal.price > 36_000), "never agreed above the employer's ceiling");

  // The employer names ₹31,000; the candidate hands their agent a minimum of ₹35,000. The listed ₹30,000 is the
  // employer's opening — the candidate's agent never treats it as its own and never goes below ₹35,000.
  await as("kiran", "/api/me", { handle: "kiran", name: "Kiran Das", areaName: "Indiranagar" });
  let k = await as("kiran", "/api/people/acme-hr/ask", { text: "Is the role still open?", offerFactId: job.id });
  k = await as("kiran", `/api/engagements/${k.id}/run`, {});
  await as("acme", `/api/engagements/${k.id}/ask`, { text: "We can offer ₹31,000 a month" });
  k = await as("kiran", `/api/engagements/${k.id}/delegate`, { limit: 35_000, autonomy: "close" });
  assert.equal(k.seller, "requester");
  assert.ok(k.negotiation.requester.length > 0, "the candidate's agent made a move");
  assert.ok(k.negotiation.requester.every((p: any) => p.price >= 35_000), `candidate offers ${k.negotiation.requester.map((p: any) => p.price)}`);
  assert.ok(!(k.phase === "agreed" && k.negotiation.deal.price < 35_000), `agreed at ${k.negotiation.deal?.price}, below the candidate's minimum`);
  const said = k.events.filter((x: any) => x.who === "requester_agent").map((x: any) => x.text as string);
  assert.ok(!said.some((t: string) => /\bWe can (offer|do)\b|We could raise/.test(t)), `the candidate's agent talks as a candidate: ${said}`);
});

test("hiring: a candidate's profile is asked once, shared without salary or contacts, and answers the employer's screening", async () => {
  await as("orbit", "/api/me", { handle: "orbit-hr", name: "Orbit Labs", areaName: "Koramangala" });
  const job = await as("orbit", "/api/facts", { tier: "public", text: "Job offer: we're hiring a junior developer in Koramangala, ₹28,000 a month" });
  await as("orbit", `/api/facts/${job.id}/limit`, { mandate: { price: { opening: 28_000, limit: 34_000 } }, autonomy: "close" });
  await as("asha", "/api/me", { handle: "asha-k", name: "Asha Kumar", areaName: "Koramangala" });
  const d = (await as("asha", "/api/briefs/draft", { text: "Looking for a job as a junior developer in Koramangala, ₹30,000 a month" })).draft;
  assert.deepEqual(d.profile.map((q: any) => q.label), ["Experience", "Skills", "Notice period", "Work mode"]);
  assert.deepEqual(d.clarify, [], "the profile takes the place of generic questions");
  assert.ok(d.profile.every((q: any) => !q.answer), "nothing to prefill the first time");
  // What she shares: her profile — and two things that must never cross (a salary, a phone number).
  const about = [{ label: "Experience", value: "1–2 years" }, { label: "Skills", value: "React, Node.js" }, { label: "Notice period", value: "Within 30 days" },
    { label: "Work mode", value: "Current CTC 4 LPA" }, { label: "Skills", value: "call 98765 43210" }, { label: "Made up", value: "x" }];
  const sent = await as("asha", "/api/briefs", { need: d.need, shared: { ...d.shared, about }, delegate: { mandate: d.mandate, autonomy: "close" } });
  assert.deepEqual(sent.brief.shared.about, about.slice(0, 3), "only the role's own questions, never a salary or contact details");
  assert.ok(!sent.brief.need.filters.some((f: any) => /experience|skills|notice/i.test(`${f.id} ${f.label}`)), "a profile never filters matches");
  const hit = sent.found.find((f: any) => f.profile.handle === "orbit-hr");
  assert.ok(hit, "still finds the job post");
  const [e0] = await as("asha", `/api/briefs/${sent.brief.id}/engage`, { providers: [{ factId: hit.fact.id }] });
  let e = await as("asha", `/api/engagements/${e0.id}/run`, {});
  // Her question about hours isn't in the job post, so the employer answers it; then its turn (with its own screening
  // question) reaches her agent.
  for (const i of (await as("orbit", "/api/inbox")).filter((x: any) => x.engagementId === e.id && x.kind === "answer")) await as("orbit", `/api/inbox/${i.id}`, { text: "Full-time, hybrid." });
  for (let i = 0; i < 4 && !e.qa.some((q: any) => q.from === "provider" && q.status === "answered"); i++) e = await as("asha", `/api/engagements/${e.id}/run`, {});
  const said = (who: string): string[] => e.events.filter((x: any) => x.who === who).map((x: any) => x.text);
  assert.match(said("requester_agent")[0], /^Hello — Asha would like to apply for the .+ role\. Experience: 1–2 years · Skills: React, Node\.js · Notice period: Within 30 days\.$/);
  // The employer screens; Asha's agent answers from her profile — she isn't asked.
  const screen = e.qa.find((q: any) => q.from === "provider" && /experience/i.test(q.question));
  assert.ok(screen, `the employer's agent asked: ${e.qa.map((q: any) => q.question)}`);
  assert.equal(screen.status, "answered", `answered without asking her: ${JSON.stringify(screen)}`);
  assert.match(screen.answer, /1–2 years/);
  assert.match(screen.answer, /30 days/);
  assert.ok(!(await as("asha", "/api/inbox")).some((i: any) => i.engagementId === e.id && i.kind === "answer"), "no question waiting for her");
  // Her next job request starts with the profile she already gave.
  const again = (await as("asha", "/api/briefs/draft", { text: "Looking for a job as a frontend developer in Koramangala, ₹32,000 a month" })).draft;
  assert.deepEqual(again.profile.filter((q: any) => q.answer).map((q: any) => [q.label, q.answer]), [["Experience", "1–2 years"], ["Skills", "React, Node.js"], ["Notice period", "Within 30 days"]]);
});

test("hiring: the board ranks applicants against the JD; salary talk starts only for the one shortlisted; a turn-down is polite and final", async () => {
  await as("nimbus", "/api/me", { handle: "nimbus-hr", name: "Nimbus Labs", areaName: "HSR Layout" });
  const draft = await as("nimbus", "/api/offers/draft", { text: "Job offer: we're hiring a junior developer in HSR Layout, ₹30,000 a month. 2+ years with React and Node.js, hybrid, join within 30 days." });
  assert.deepEqual(draft.offer.requirements.map((r: any) => r.label), ["Experience", "Skills", "Work mode", "Notice period"], "read from the JD");
  const job = await as("nimbus", "/api/facts", { tier: "public", text: draft.publicText });
  assert.equal((await as("nimbus", `/api/facts/${job.id}/requirements`, { requirements: [...draft.offer.requirements, { label: "Age", value: "Under 30" }] })).offer.requirements.length, 4, "a personal requirement is dropped");
  await as("nimbus", `/api/facts/${job.id}/limit`, { mandate: { price: { opening: 30_000, limit: 36_000 } }, autonomy: "close" });

  const apply = async (uid: string, handle: string, name: string, about: [string, string][]) => {
    await as(uid, "/api/me", { handle, name, areaName: "HSR Layout" });
    const d = (await as(uid, "/api/briefs/draft", { text: "Looking for a job as a junior developer in HSR Layout, ₹32,000 a month" })).draft;
    const sent = await as(uid, "/api/briefs", { need: d.need, shared: { ...d.shared, about: about.map(([label, value]) => ({ label, value })) }, delegate: { mandate: d.mandate, autonomy: "close" } });
    const [e0] = await as(uid, `/api/briefs/${sent.brief.id}/engage`, { providers: [{ factId: job.id }] });
    await as(uid, `/api/engagements/${e0.id}/run`, {});
    // The candidate's question the JD doesn't answer goes to the employer, who answers it.
    for (const i of (await as("nimbus", "/api/inbox")).filter((x: any) => x.engagementId === e0.id && x.kind === "answer")) await as("nimbus", `/api/inbox/${i.id}`, { text: "Full-time, 10 to 6." });
    let e = await as(uid, `/api/engagements/${e0.id}/run`, {});
    for (let i = 0; i < 4 && !e.events.some((x: any) => /reviewing applications/.test(x.text)); i++) e = await as(uid, `/api/engagements/${e.id}/run`, {});
    return e;
  };
  const anya = await apply("cand-a", "anya-r", "Anya Rao", [["Experience", "3–5 years"], ["Skills", "React, Node.js, SQL"], ["Notice period", "Within 15 days"], ["Work mode", "Hybrid"]]);
  const bilal = await apply("cand-b", "bilal-k", "Bilal Khan", [["Experience", "Fresher"], ["Skills", "Java"], ["Notice period", "In 60+ days"], ["Work mode", "Remote"]]);
  for (const e of [anya, bilal]) {
    assert.ok(e.events.some((x: any) => x.text === "Thanks — Nimbus Labs is reviewing applications and will be in touch."), JSON.stringify(e.events.slice(-3)));
    assert.equal(e.negotiation.provider.length + e.negotiation.requester.length, 0, "no salary talk before shortlisting");
  }

  const board = await as("nimbus", `/api/facts/${job.id}/applicants`);
  assert.deepEqual(board.applicants.map((a: any) => [a.name, a.status, a.screening.summary]), [["Anya Rao", "new", "4 of 4 must-haves"], ["Bilal Khan", "new", "0 of 4 must-haves"]]);
  assert.equal(board.applicants[0].band, "from ₹30,000/month", "the candidate's salary band, never their exact minimum");
  assert.equal((await raw("cand-a", `/api/facts/${job.id}/applicants`)).status, 404, "only the employer sees the board");
  assert.equal((await raw("cand-a", `/api/engagements/${anya.id}/shortlist`, {})).status, 404, "only the employer shortlists");

  // Shortlisting Anya starts the salary talk with her — and only her.
  let a = await as("nimbus", `/api/engagements/${anya.id}/shortlist`, {});
  for (let i = 0; i < 6 && !["deal", "agreed"].includes(a.phase); i++) a = await as("cand-a", `/api/engagements/${a.id}/run`, {});
  assert.ok(a.events.some((x: any) => x.who === "provider_agent" && x.text === "We can offer ₹30,000/month for this role."), JSON.stringify(a.events.slice(-4)));
  assert.equal(a.phase, "deal", "salary agreed; the letter is the employer's to send");
  const b = await as("nimbus", `/api/engagements/${bilal.id}`);
  assert.equal(b.negotiation.provider.length + b.negotiation.requester.length, 0, "the other applicant still has no salary talk");

  // Bilal: an interview invitation is a question to his agent, which asks him; then the employer turns him down.
  await as("nimbus", `/api/engagements/${bilal.id}/interview`, { note: "a 30-minute video call" });
  assert.ok((await as("cand-b", "/api/inbox")).some((i: any) => i.engagementId === bilal.id && /interview \(a 30-minute video call\)/.test(i.question)), "he's asked when he's free");
  const r = await as("nimbus", `/api/engagements/${bilal.id}/reject`, {});
  assert.equal(r.phase, "declined");
  assert.match(r.events.at(-1).text, /^Thank you for applying\. Nimbus Labs has decided to go ahead with other candidates/);
  assert.ok(!(await as("cand-b", "/api/inbox")).some((i: any) => i.engagementId === bilal.id), "nothing left waiting for him");
  assert.equal((await raw("nimbus", `/api/engagements/${bilal.id}/shortlist`, {})).status, 400, "a turned-down application has ended");
  const after = await as("nimbus", `/api/facts/${job.id}/applicants`);
  assert.deepEqual(after.applicants.map((x: any) => [x.name, x.status]), [["Anya Rao", "offer to send"], ["Bilal Khan", "rejected"]], "the agreed salary waits for the employer's letter");
});

test("hiring: the candidate can ask for changes once; the employer revises (salary too); a decline ends it politely", async () => {
  await as("zen", "/api/me", { handle: "zen-hr", name: "Zenith Labs", areaName: "Whitefield" });
  const job = await as("zen", "/api/facts", { tier: "public", text: "Job offer: we're hiring a QA engineer in Whitefield, ₹28,000 a month" });
  await as("zen", `/api/facts/${job.id}/limit`, { mandate: { price: { opening: 28_000, limit: 34_000 } }, autonomy: "close" });
  await as("tara", "/api/me", { handle: "tara-m", name: "Tara Menon", areaName: "Whitefield" });
  // Tara names a salary in the chat; the employer's agent takes it inside its ceiling — and the employer must still
  // send the letter.
  let e = await as("tara", "/api/people/zen-hr/ask", { text: "Is the QA role still open?", offerFactId: job.id });
  e = await as("tara", `/api/engagements/${e.id}/run`, {});
  await as("zen", `/api/engagements/${e.id}/shortlist`, {});
  e = await as("tara", `/api/engagements/${e.id}/ask`, { text: "I'd accept ₹31,000 a month" });
  e = await as("tara", `/api/engagements/${e.id}`);
  assert.equal(e.phase, "deal");
  assert.equal(e.negotiation.confirmed.provider, false, "the employer's agent agreed the salary but can't say yes to a hire");
  const inDays = (n: number) => new Date(Date.now() + 19_800_000 + n * 86_400_000).toISOString().slice(0, 10);
  const first = (await as("zen", "/api/inbox")).find((i: any) => i.engagementId === e.id && i.kind === "offer_letter");
  assert.ok(first, JSON.stringify((await as("zen", "/api/inbox")).map((i: any) => i.kind)));
  await as("zen", `/api/inbox/${first.id}`, { letter: { ...first.letter, start: inDays(20), validUntil: inDays(5), probation: "3 months" } });

  // Tara asks for changes (once): the letter goes back to the employer, with her note.
  const ask1 = (await as("tara", "/api/inbox")).find((i: any) => i.engagementId === e.id && i.kind === "offer");
  e = await as("tara", `/api/inbox/${ask1.id}`, { changes: "Could the salary be ₹33,000 and the start a week later?" });
  assert.equal(e.offerLetter.status, "changes asked");
  assert.equal(e.phase, "deal");
  const revise = (await as("zen", "/api/inbox")).find((i: any) => i.engagementId === e.id && i.kind === "offer_letter");
  assert.match(revise.question, /salary be ₹33,000/, "the employer sees what she asked");
  e = await as("zen", `/api/inbox/${revise.id}`, { letter: { ...revise.letter, salary: 33_000, start: inDays(27) } });
  assert.deepEqual([e.offerLetter.status, e.offerLetter.revision, e.offerLetter.salary, e.negotiation.deal.price], ["issued", 2, 33_000, 33_000], "a revised letter at a revised salary");
  assert.ok(e.events.some((x: any) => x.text === "Sent a revised offer letter."));

  // No second round of changes: she accepts or declines.
  const ask2 = (await as("tara", "/api/inbox")).find((i: any) => i.engagementId === e.id && i.kind === "offer");
  assert.equal((await raw("tara", `/api/inbox/${ask2.id}`, { changes: "And remote?" })).status, 400);
  const again = (await as("tara", "/api/inbox")).find((i: any) => i.engagementId === e.id && i.kind === "offer");
  e = await as("tara", `/api/inbox/${again.id}`, { decline: true, text: "I've accepted another offer." });
  assert.deepEqual([e.phase, e.offerLetter.status], ["closed", "declined"]);
  assert.match(e.events.at(-1).text, /^Declined the offer: “I've accepted another offer\.”/);
  const board = await as("zen", `/api/facts/${job.id}/applicants`);
  assert.equal(board.applicants[0].status, "offer declined");
});

test("hiring: an offer letter not accepted by its date lapses — nothing is agreed", async () => {
  const { memoryDocs } = await import("../src/docs.ts");
  const { expireDecisions } = await import("../src/core/decisions.ts");
  const db = memoryDocs();
  const letter = { role: "Dev", salary: 30_000, unit: "month", start: "2026-11-01", validUntil: "2026-10-20", mode: "", probation: "", notice: "", issuedAt: 1, revision: 1, hash: "h", status: "issued" };
  await db.set("engagements", "e1", { id: "e1", phase: "deal", offer: { category: "jobs", price: 30_000 }, negotiation: { deal: { id: "p1", price: 30_000, terms: {}, round: 0 }, confirmed: { requester: false, provider: true } },
    waiting: { requester: { kind: "offer", inbox: ["i1"], text: "" }, provider: null }, offerLetter: letter, events: [] });
  await db.set("inbox", "i1", { id: "i1", kind: "offer", engagementId: "e1", side: "requester", owner: "r", status: "open", proposalId: "p1", deadline: 100, onTimeout: "lapse" });
  await expireDecisions(db, 200, async () => {});
  const e = await db.get("engagements", "e1");
  assert.deepEqual([e.phase, e.offerLetter.status], ["closed", "lapsed"]);
  assert.match(e.events.at(-1).text, /The offer lapsed — it wasn't accepted by 2026-10-20/);
});

test("joining: who may do what, and when", async () => {
  const { joiningMove, joiningEffects, hiringStatus, JoinError } = await import("../src/core/hiring.ts");
  const now = Math.floor(Date.now() / 1000), day = (n: number) => new Date((now + 19_800 + n * 86_400) * 1000).toISOString().slice(0, 10);
  const deal = (start: string, joining?: object) => ({ id: "e1", phase: "agreed", seller: "requester", outcome: {}, events: [],
    offerLetter: { role: "Dev", salary: 30_000, unit: "month", start, validUntil: day(0), mode: "", probation: "", notice: "", issuedAt: now - 86_400 * 3, revision: 1, hash: "h", status: "accepted", decidedAt: now - 86_400 * 2 },
    ...(joining ? { joining } : {}) }) as any;
  const no = (e: any, side: string, action: string, input: object, re: RegExp) => assert.throws(() => joiningMove(e, side as any, action as any, input, now), (err: any) => err instanceof JoinError && re.test(err.message));

  // Before the start date: nobody can mark joining, either side can withdraw — with a reason.
  const later = deal(day(10));
  no(later, "requester", "joined", {}, /from your start date/);
  no(later, "provider", "confirm", {}, /confirm it from then/);
  no(later, "provider", "no_show", {}, /say so from that day/);
  no(later, "requester", "withdraw", { reason: "" }, /Say why/);
  no(later, "requester", "withdraw", { reason: "call me on 98450 12345" }, /phone numbers/);
  const w = joiningMove(later, "requester", "withdraw", { reason: "I've taken another offer" }, now);
  assert.deepEqual([w.state, w.by, w.reason], ["withdrawn", "requester", "I've taken another offer"]);
  assert.equal(hiringStatus({ ...later, joining: w }), "withdrawn");
  assert.deepEqual(joiningEffects(later, w).outcome, { provider: "fell_through" }, "a withdrawal counts against whoever withdrew");
  const ew = joiningMove(later, "provider", "withdraw", { reason: "The role was closed" }, now);
  assert.equal(hiringStatus({ ...later, joining: ew }), "offer withdrawn");
  assert.deepEqual(joiningEffects(later, ew).outcome, { requester: "fell_through" });
  no({ ...later, joining: w }, "provider", "withdraw", { reason: "too" }, /already settled/);

  // From the start date: the candidate's day can't be before the offer was accepted or in the future.
  const due = deal(day(-1));
  no(due, "requester", "joined", { date: day(1) }, /today or earlier/);
  no(due, "requester", "joined", { date: day(-30) }, /before the offer was accepted/);
  no(due, "requester", "confirm", {}, /employer confirms/);
  no(due, "provider", "joined", {}, /Only the candidate/);
  no(due, "requester", "no_show", {}, /withdraw instead/);
  const j = joiningMove(due, "requester", "joined", { date: day(-1) }, now);
  assert.deepEqual([j.state, j.joinedOn], ["joined", day(-1)]);
  assert.equal(hiringStatus({ ...due, joining: j }), "says joined");
  no({ ...due, joining: j }, "requester", "withdraw", { reason: "never mind" }, /can't be withdrawn/);
  // The employer can confirm without waiting for the candidate, too.
  assert.deepEqual([joiningMove(due, "provider", "confirm", {}, now).state, joiningMove(due, "provider", "confirm", {}, now).joinedOn], ["confirmed", day(0)]);

  // Two different accounts are recorded, never settled by the app.
  const ns = joiningMove(due, "provider", "no_show", { reason: "Didn't turn up" }, now);
  assert.equal(hiringStatus({ ...due, joining: ns }), "didn't join");
  const d1 = joiningMove({ ...due, joining: ns }, "requester", "joined", {}, now);
  assert.deepEqual([d1.state, d1.reason], ["disputed", "Didn't turn up"]);
  const d2 = joiningMove({ ...due, joining: j }, "provider", "no_show", {}, now);
  assert.equal(d2.state, "disputed");
  assert.deepEqual(joiningEffects(due, d2), { fulfilment: { state: "disputed" }, outcome: { requester: "happened", provider: "fell_through" } });
  no({ ...due, joining: d2 }, "provider", "confirm", {}, /already settled/);
  no({ ...due, joining: ns }, "provider", "confirm", {}, /said they didn't join/);
  // Not an accepted offer: nothing to join.
  no({ ...due, offerLetter: { ...due.offerLetter, status: "issued" } }, "requester", "joined", {}, /no accepted offer/);
});
