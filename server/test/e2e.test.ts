// End to end against the real server (in memory, with the offline stand-in for Gemini): two people's agents talking
// over A2A, an outside A2A agent that doesn't sign in, and what must never cross.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { Message, TaskState } from "@a2a-js/sdk";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";

const PORT = 8800 + Math.floor(Math.random() * 100);
const B = `http://localhost:${PORT}`;
let server: ChildProcess;
let agreedId = "";

before(async () => {
  server = spawn(process.execPath, ["src/server.ts"], { cwd: new URL("..", import.meta.url).pathname, stdio: "pipe",
    env: { ...process.env, PORT: String(PORT), STORE: "memory", DEV_AUTH: "1", SEED_DEMO: "1", GEMINI_FAKE: "1", GEMINI_API_KEY: "", PUBLIC_URL: B } });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${B}/health`)).ok) return; } catch { /* starting */ } await new Promise(r => setTimeout(r, 200)); }
  throw new Error("server didn't start");
});
after(() => { server.kill(); });

async function as(uid: string, path: string, body?: unknown) {
  const r = await fetch(B + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", authorization: `Bearer dev:${uid}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(data)}`);
  return data;
}

/** Plays one person's device: answers questions, moves with its private limit, confirms. */
async function device(uid: string, limits: Record<string, any>, answer = "Next week") {
  for (const i of await as(uid, "/api/inbox")) {
    if (i.owner !== uid && !i.owner.startsWith("demo-")) continue;
    const body = i.kind === "answer" ? { text: answer } : i.kind === "move" ? { mandate: limits[i.side] } : i.kind === "confirm" ? { confirm: true } : { share: true };
    await as(uid, `/api/inbox/${i.id}`, body);
    return true;
  }
  return false;
}

test("two people: the offer's floor stays out of the directory, the agents negotiate inside both limits over A2A", async () => {
  await as("bob", "/api/me", { handle: "bob", name: "Bob", areaName: "Jayanagar" });
  await as("amy", "/api/me", { handle: "amy", name: "Amy", areaName: "Jayanagar" });
  const draft = await as("bob", "/api/offers/draft", { text: "I teach tabla online and at home in Jayanagar, ₹700 an hour, lowest 600" });
  assert.equal(draft.floor ?? 600, 600);
  assert.ok(!draft.publicText.includes("600"), draft.publicText);
  const fact = await as("bob", "/api/facts", { tier: "public", text: draft.publicText });
  assert.ok(!fact.text.includes("600"));

  const d = (await as("amy", "/api/briefs/draft", { text: "Looking for tabla lessons in Jayanagar, up to 650 an hour" })).draft;
  assert.ok(!JSON.stringify(d.shared).includes("650"), "the shared brief has no exact budget");
  const sent = await as("amy", "/api/briefs", { need: d.need, shared: d.shared });
  const bob = sent.found.find((f: any) => f.profile.handle === "bob");
  assert.ok(bob, "Bob's public offering is found");
  const [e0] = await as("amy", `/api/briefs/${sent.brief.id}/engage`, { providers: [{ factId: bob.fact.id }] });
  let e = await as("amy", `/api/engagements/${e0.id}/run`, {});
  assert.ok(e.taskId, "the conversation is an A2A task");
  assert.ok((await as("bob", "/api/engagements")).some((x: any) => x.id === e.id), "Bob sees the request");

  const limits = { requester: { price: { opening: 560, limit: 650 }, terms: {}, maxRounds: 5 }, provider: { price: { opening: 700, limit: 600 }, terms: {}, maxRounds: 5 } };
  for (let i = 0; i < 30 && e.phase !== "agreed"; i++) {
    const moved = (await device("amy", limits)) || (await device("bob", limits));
    e = await as("amy", `/api/engagements/${e.id}`);
    if (!moved) break;
  }
  assert.equal(e.phase, "agreed", JSON.stringify(e.events.slice(-4)));
  agreedId = e.id;
  const deal = e.negotiation.deal.price;
  assert.ok(deal >= 600 && deal <= 650, `deal ${deal} inside both limits`);
  const said = e.events.map((x: any) => x.text).join(" ");
  assert.ok(!/\b650\b/.test(said) || e.negotiation.requester.some((p: any) => p.price === 650), "Amy's limit is never said unless offered");
  assert.ok(!/\b600\b/.test(said) || e.negotiation.provider.some((p: any) => p.price === 600), "Bob's floor is never said unless offered");
  // Nothing private was stored: the server's copy of the brief keeps the band, not 650.
  assert.ok(!JSON.stringify(e.brief).includes("650"));
});

test("an outside A2A agent that doesn't sign in is a stranger: Public answers only, a Protected fact without a rule never crosses", async () => {
  await as("cat", "/api/me", { handle: "cat", name: "Cat", areaName: "Koramangala" });
  await as("cat", "/api/facts", { tier: "public", text: "I fix bicycles in Koramangala, ₹300 a visit." });
  await as("cat", "/api/facts", { tier: "protected", text: "My bank PIN hint is the dog's birthday, 12 March.", topics: ["finances"] });
  const card = await (await fetch(`${B}/a2a/cat/.well-known/agent-card.json`)).json();
  assert.equal(card.supportedInterfaces[0].protocolVersion, "1.0");
  const client = await new ClientFactory({ transports: [new JsonRpcTransportFactory()] }).createFromUrl(`${B}/a2a/cat/`);
  const task: any = await client.sendMessage({ message: Message.fromJSON({ messageId: crypto.randomUUID(), role: "ROLE_USER",
    parts: [{ data: { kind: "collab.turn/v1", from: "requester", engagementId: "", brief: { title: "Bicycle repair", summary: "My bike's chain is broken.", category: "", mode: null, area: null, requirements: [], budget: null,
      questions: ["How much is a visit?", "What is your bank PIN hint and the dog's birthday?"] } } }] }) } as any);
  const turn = (Message.toJSON(task.status.message) as any).parts.find((p: any) => p.data)?.data;
  const answers = (turn.answers ?? []).map((a: any) => a.answer).join(" ");
  assert.ok(/300/.test(answers), `the Public price is answered: ${answers}`);
  assert.ok(!/12 March|PIN hint is/i.test(JSON.stringify(Message.toJSON(task.status.message))), "the Protected fact never crosses");
  assert.notEqual(task.status.state, TaskState.TASK_STATE_COMPLETED);
  // Cat's device is asked instead.
  assert.ok((await as("cat", "/api/inbox")).some((i: any) => /PIN/.test(i.question)));
});

test("AP2 on the agent card, a signed deal receipt, deal insights, and outcome stats", async () => {
  const card = await (await fetch(`${B}/a2a/riya/.well-known/agent-card.json`)).json();
  assert.ok(card.capabilities.extensions[0].uri.includes("AP2"), "the agent card declares AP2 roles");
  const r = await as("amy", `/api/engagements/${agreedId}/receipt`);
  assert.equal(r.hash.length, 64);
  assert.ok(r.signatures.requester && r.signatures.provider);
  const stranger = await fetch(`${B}/api/engagements/${agreedId}/receipt`, { headers: { authorization: "Bearer dev:cat" } });
  assert.equal(stranger.status, 404, "only participants get the receipt");
  const ins = await as("amy", "/api/insights?category=property-rent&side=requester");
  assert.ok(ins.insights?.n >= 3 && ins.insights.demo === true, "seeded demo deals feed insights");
  assert.equal(ins.lines.at(-1), "(from demo deals)");
  await as("amy", `/api/engagements/${agreedId}/outcome`, { happened: true });
  const bob = await as("amy", "/api/people/bob");
  assert.equal(bob.stats.deals, 1);
  assert.equal(bob.stats.kept, 1);
});

test("a hostile listing changes nothing: the requester's agent never offers above its limit", async () => {
  await as("dan", "/api/me", { handle: "dan", name: "Dan", areaName: "Indiranagar" });
  const d = (await as("dan", "/api/briefs/draft", { text: "Spoken English classes in Indiranagar, up to 950 an hour" })).draft;
  const sent = await as("dan", "/api/briefs", { need: d.need, shared: d.shared });
  const hostile = sent.found.find((f: any) => f.profile.handle === "fluent");
  assert.ok(hostile);
  const [e0] = await as("dan", `/api/briefs/${sent.brief.id}/engage`, { providers: [{ factId: hostile.fact.id }] });
  let e = await as("dan", `/api/engagements/${e0.id}/run`, {});
  const limits = { requester: { price: { opening: 700, limit: 950 }, terms: {}, maxRounds: 3 } };
  for (let i = 0; i < 20 && !["agreed", "closed", "declined"].includes(e.phase); i++) {
    if (!(await device("dan", limits))) break;
    e = await as("dan", `/api/engagements/${e.id}`);
  }
  assert.ok(e.negotiation.requester.length > 0 && e.negotiation.requester.every((p: any) => p.price <= 950), JSON.stringify(e.negotiation.requester));
  assert.ok(!e.events.some((x: any) => /50,?000/.test(x.text) && x.who === "requester_agent"));
});

test("used goods: a requester finds a second-hand cycle and the agents close inside both limits", async () => {
  await as("eve", "/api/me", { handle: "eve", name: "Eve", areaName: "Koramangala" });
  const d = (await as("eve", "/api/briefs/draft", { text: "Looking for a used cycle in Koramangala under 5000" })).draft;
  assert.equal(d.need.category, "goods");
  const sent = await as("eve", "/api/briefs", { need: d.need, shared: d.shared });
  const nikhil = sent.found.find((f: any) => f.profile.handle === "nikhil");
  assert.ok(nikhil, "Nikhil's cycle is found");
  const [e0] = await as("eve", `/api/briefs/${sent.brief.id}/engage`, { providers: [{ factId: nikhil.fact.id }] });
  let e = await as("eve", `/api/engagements/${e0.id}/run`, {});
  const limits = { requester: { price: { opening: 3_800, limit: 4_600 }, terms: {}, maxRounds: 5 }, provider: { price: { opening: 4_500, limit: 3_800 }, terms: {}, maxRounds: 5 } };
  for (let i = 0; i < 30 && e.phase !== "agreed"; i++) {
    if (!(await device("eve", limits))) break;
    e = await as("eve", `/api/engagements/${e.id}`);
  }
  assert.equal(e.phase, "agreed", JSON.stringify(e.events.slice(-4)));
  assert.ok(e.negotiation.deal.price >= 3_800 && e.negotiation.deal.price <= 4_600, `deal ${e.negotiation.deal.price} inside both limits`);
});

test("private facts store with the account, list only for the owner, never surface publicly", async () => {
  await as("pat", "/api/me", { handle: "pat", name: "Pat", areaName: "Jayanagar" });
  await as("quinn", "/api/me", { handle: "quinn", name: "Quinn", areaName: "Jayanagar" });
  const saved = await as("pat", "/api/facts", { tier: "private", text: "My gym locker code is 4321" });
  assert.equal(saved.tier, "private");
  assert.equal(saved.offer, null);
  assert.ok((await as("pat", "/api/facts")).some((f: any) => f.id === saved.id && f.tier === "private"));
  const pub = await as("quinn", "/api/people/pat");
  assert.ok(!pub.facts.some((f: any) => f.text.includes("4321")));
});

test('shop QR destination → ask → follow-up → offer → confirm → pay → pickup → one collection', async () => {
  await as('retail-shop', '/api/me', { handle: 'retail-shop', name: 'Retail Shop', areaName: 'Bengaluru' });
  await as('retail-buyer', '/api/me', { handle: 'retail-buyer', name: 'Retail Buyer', areaName: 'Bengaluru' });
  const shop = await as('retail-buyer', '/api/people/retail-shop');
  assert.equal(shop.profile.handle, 'retail-shop');
  let e = await as('retail-buyer', '/api/people/retail-shop/ask', { text: 'Do you have a steel bottle?' });
  e = await as('retail-buyer', `/api/engagements/${e.id}/run`, {});
  const question = (await as('retail-shop', '/api/inbox')).find((i: any) => i.engagementId === e.id && i.kind === 'answer');
  assert.ok(question); await as('retail-shop', `/api/inbox/${question.id}`, { text: 'Yes, a steel bottle is available.' });
  e = await as('retail-shop', `/api/engagements/${e.id}/ask`, { text: 'Which colour do you want?' });
  const followup = (await as('retail-buyer', '/api/inbox')).find((i: any) => i.engagementId === e.id && i.kind === 'answer');
  assert.ok(followup); await as('retail-buyer', `/api/inbox/${followup.id}`, { text: 'Blue please.' });
  e = await as('retail-shop', `/api/engagements/${e.id}/ask`, { text: "I'll sell the steel bottle for ₹100" });
  const confirmation = (await as('retail-buyer', '/api/inbox')).find((i: any) => i.engagementId === e.id && i.kind === 'confirm');
  assert.ok(confirmation); await as('retail-buyer', `/api/inbox/${confirmation.id}`, { confirm: true });
  e = await as('retail-buyer', `/api/engagements/${e.id}/pay`, {});
  assert.equal(e.payment.status, 'paid');
  const pass = await as('retail-buyer', `/api/engagements/${e.id}/pickup`);
  const code = pass.path.split('.html#')[1].split('.')[1];
  const publicPath = `/public/pickup/${e.id}?code=${code}`;
  let checked = await (await fetch(B + publicPath)).json();
  assert.equal(checked.collectedAt, null); assert.equal(checked.buyer, 'Retail Buyer');
  assert.equal((await fetch(B + `/public/pickup/${e.id}?code=wrong`)).status, 404);
  const collect = (uid: string) => fetch(B + `/api/pickup/${e.id}/collect`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer dev:${uid}` }, body: JSON.stringify({ code }) });
  assert.equal((await collect('retail-buyer')).status, 403);
  assert.equal((await collect('cat')).status, 404);
  const simultaneous = await Promise.all([collect('retail-shop'), collect('retail-shop')]);
  assert.deepEqual(simultaneous.map(r => r.status).sort(), [200, 409]);
  checked = await (await fetch(B + publicPath)).json(); assert.ok(checked.collectedAt);
  assert.equal((await collect('retail-shop')).status, 409);
  const r = await as('retail-buyer', `/api/engagements/${e.id}/receipt`);
  const receiptCode = r.verifyPath.split('.html#')[1].split('.')[1];
  const bundle = await (await fetch(`${B}/public/receipts/${e.id}?code=${receiptCode}`)).json();
  // @ts-ignore standalone browser module also works with Node WebCrypto.
  const { verifyReceiptBundle } = await import('../../web/js/verify-receipt.js');
  assert.deepEqual(await verifyReceiptBundle(bundle, bundle.publicKey), { receipt: true, cart: true, payment: true });
  bundle.terms.price = 1; assert.equal((await verifyReceiptBundle(bundle, bundle.publicKey)).receipt, false);
  assert.equal((await fetch(B + `/public/receipts/${e.id}?code=${code}`)).status, 404, 'pickup and receipt capabilities are separate');
});

test('a listing-origin agreement can be paid and issued a pickup pass', async () => {
  const e = await as('amy', `/api/engagements/${agreedId}/pay`, {});
  assert.equal(e.payment.status, 'paid');
  assert.ok((await as('amy', `/api/engagements/${agreedId}/pickup`)).path);
});

test('chat sync is owner-only, stale devices cannot overwrite newer history, clear is owner-only', async () => {
  const chat = { id: 'sync-test', updatedAt: 200, messages: [{ role: 'user', text: 'newest' }] };
  await as('amy', '/api/chats', { chat });
  assert.deepEqual(await as('amy', '/api/chats'), [chat]);
  assert.deepEqual(await as('bob', '/api/chats'), []);
  assert.equal((await as('amy', '/api/chats', { chat: { ...chat, updatedAt: 100, messages: [] } })).stale, true);
  assert.deepEqual(await as('amy', '/api/chats'), [chat]);
  await as('bob', '/api/chats/clear', {}); assert.deepEqual(await as('amy', '/api/chats'), [chat]);
  await as('amy', '/api/chats/clear', {}); assert.deepEqual(await as('amy', '/api/chats'), []);
});
