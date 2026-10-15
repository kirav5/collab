// Final-test scenarios, end to end against the real server (in memory, offline stand-in for Gemini): sign-up edge
// cases, opening a shop's or a person's agent from a QR, conversations that end midway, a paused agent, private facts,
// payment outside the app with a pass, and random buyer–seller conversations checked against invariants after every
// step. docs/TEST-SCENARIOS.md maps each scenario to where it is tested.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";

const PORT = 9000 + Math.floor(Math.random() * 100);
const B = `http://localhost:${PORT}`;
let server: ChildProcess;

before(async () => {
  server = spawn(process.execPath, ["src/server.ts"], { cwd: new URL("..", import.meta.url).pathname, stdio: "pipe",
    env: { ...process.env, PORT: String(PORT), STORE: "memory", DEV_AUTH: "1", GEMINI_FAKE: "1", GEMINI_API_KEY: "", PUBLIC_URL: B } });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${B}/health`)).ok) return; } catch { /* starting */ } await new Promise(r => setTimeout(r, 200)); }
  throw new Error("server didn't start");
});
after(() => { server.kill(); });

const raw = (uid: string | null, path: string, body?: unknown) => fetch(B + path, { method: body === undefined ? "GET" : "POST",
  headers: { "content-type": "application/json", ...(uid ? { authorization: `Bearer dev:${uid}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
async function as(uid: string, path: string, body?: unknown) {
  const r = await raw(uid, path, body);
  const data = await r.json();
  if (!r.ok) throw Object.assign(new Error(`${path}: ${r.status} ${JSON.stringify(data)}`), { status: r.status });
  return data;
}
const inboxFor = async (uid: string, engagementId: string, kind?: string) =>
  ((await as(uid, "/api/inbox")) as any[]).find(i => i.engagementId === engagementId && (!kind || i.kind === kind));

let shopFact = "";
test("sign-up: no account, no profile, bad and taken handles, and a handle given up is free again", async () => {
  assert.equal((await raw(null, "/api/me")).status, 401, "no sign-in, no API");
  assert.equal(await as("newbie", "/api/me"), null, "signed in but no profile yet");
  await assert.rejects(as("newbie", "/api/me", { handle: "a!", name: "N" }), /3–24 letters/);
  await as("shop", "/api/me", { handle: "steel-shop", name: "Steel Shop", areaName: "Indiranagar" });
  await assert.rejects(as("newbie", "/api/me", { handle: "steel-shop", name: "N" }), /taken/);
  await assert.rejects(as("newbie", "/api/me", { handle: "Steel-Shop", name: "N" }), /taken/, "handles ignore case");
  const n = await as("newbie", "/api/me", { handle: "newbie-1", name: "Newbie" });
  assert.equal(n.handle, "newbie-1");
  const renamed = await as("newbie", "/api/me", { handle: "newbie-2" });
  assert.equal(renamed.name, "Newbie", "renaming the handle keeps the rest");
  await as("other", "/api/me", { handle: "newbie-1", name: "Other" });
  assert.equal((await as("other", "/api/me")).handle, "newbie-1", "the old handle was released");
});

test("QR: a shop's card suggests stock, price and pickup; a person's suggests questions about them; the agent card publishes the same", async () => {
  // (The offline stand-in model reads a listing phrased "for sale"; Gemini reads any phrasing.)
  const f = await as("shop", "/api/facts", { tier: "public", text: "Steel water bottles 500 ml for sale in Indiranagar, ₹400 each" });
  assert.ok(f.offer, "a public offering");
  shopFact = f.id;
  await as("shop", "/api/resources", { factId: f.id, type: "quantity", onHand: 3 });
  await as("buyer", "/api/me", { handle: "anu-b", name: "Anu", areaName: "Indiranagar" });
  const shop = await as("buyer", "/api/people/steel-shop");
  assert.equal(shop.offers, 1);
  assert.match(shop.suggestions[0].text, /in stock\?$/);
  assert.match(shop.suggestions[1].text, /best price/);
  assert.match(shop.suggestions[2].text, /collect today/);
  const card = await (await fetch(`${B}/a2a/steel-shop/.well-known/agent-card.json`)).json();
  const skill = card.skills.find((s: any) => s.id === `offer-${f.id}`);
  assert.ok(skill, "one skill per offering");
  assert.deepEqual(skill.examples, shop.suggestions.map((s: any) => s.text));
  assert.match(skill.description, /Stock is tracked/);
  const anu = await as("shop", "/api/people/anu-b");
  assert.equal(anu.offers, 0);
  assert.deepEqual(anu.suggestions.map((s: any) => s.text), ["What are you looking for right now?", "Are you free this weekend?", "What do you do, Anu?"]);
  assert.equal((await raw("buyer", "/api/people/nobody-here")).status, 404);
  await assert.rejects(as("shop", "/api/people/steel-shop/ask", { text: "hi" }), /that's you/);
});

test("QR: tapping the stock suggestion is answered from the ledger at once, without the owner", async () => {
  const shop = await as("buyer", "/api/people/steel-shop");
  let e = await as("buyer", "/api/people/steel-shop/ask", { text: shop.suggestions[0].text });
  e = await as("buyer", `/api/engagements/${e.id}/run`, {});
  const qa = e.qa.find((q: any) => q.question === shop.suggestions[0].text);
  assert.equal(qa?.status, "answered");
  assert.equal(qa?.answer, "3 available");
  assert.equal(await inboxFor("shop", e.id, "answer"), undefined, "the owner wasn't asked");
});

test("mid-conversation: whoever ends it, nobody can keep asking; paying or a pass before a deal is refused", async () => {
  let e = await as("buyer", "/api/people/steel-shop/ask", { text: "Do you have a blue one?" });
  e = await as("buyer", `/api/engagements/${e.id}/run`, {});
  assert.ok([400, 409].includes((await raw("buyer", `/api/engagements/${e.id}/pay`, {})).status), "no deal, nothing to pay");
  assert.equal((await raw("buyer", `/api/engagements/${e.id}/pickup`)).status, 400, "no payment, no pass");
  e = await as("buyer", `/api/engagements/${e.id}/close`, {});
  assert.equal(e.phase, "closed");
  assert.equal(await inboxFor("buyer", e.id), undefined, "nothing left asking the buyer");
  assert.equal(await inboxFor("shop", e.id), undefined, "nothing left asking the shop");
  await assert.rejects(as("shop", `/api/engagements/${e.id}/ask`, { text: "Still there?" }), /ended/);
  await assert.rejects(as("buyer", `/api/engagements/${e.id}/ask`, { text: "Wait" }), /ended/);
  assert.equal((await as("buyer", `/api/engagements/${e.id}/close`, {})).phase, "closed", "ending twice is harmless");
  let d = await as("buyer", "/api/people/steel-shop/ask", { text: "Can you deliver to Koramangala?" });
  d = await as("buyer", `/api/engagements/${d.id}/run`, {});
  d = await as("shop", `/api/engagements/${d.id}/close`, {});
  assert.equal(d.phase, "declined", "the shop ending it is a decline");
  assert.equal((await as("buyer", `/api/engagements/${d.id}`)).phase, "declined");
});

test("a paused shop's agent answers nobody from its facts, and its private notes never cross", async () => {
  await as("shop", "/api/facts", { tier: "private", text: "My supplier charges me ₹170 a bottle; never go below ₹250." });
  let e = await as("buyer", "/api/people/steel-shop/ask", { text: "What does your supplier charge you per bottle?" });
  e = await as("buyer", `/api/engagements/${e.id}/run`, {});
  // Only what was said (not ids or timestamps, which can contain any digits).
  const said = [...e.qa.map((q: any) => `${q.question} ${q.answer ?? ""}`), ...e.events.map((x: any) => x.text)].join(" ");
  assert.ok(!/\b(170|250)\b/.test(said), `the private cost and floor are never said: ${said}`);
  await as("shop", "/api/me/pause", { paused: true });
  let p = await as("buyer", "/api/people/steel-shop/ask", { text: "Do you have steel water bottles?" });
  p = await as("buyer", `/api/engagements/${p.id}/run`, {});
  assert.ok(!p.qa.some((q: any) => q.status === "answered" && q.source === "listing"), "paused: nothing answered from the listing");
  await as("shop", "/api/me/pause", { paused: false });
});

/** Buyer asks; the shop names a price; the buyer confirms → agreed. */
async function agreed(price: number) {
  let e = await as("buyer", "/api/people/steel-shop/ask", { text: "I'd like one steel bottle.", offerFactId: shopFact });
  e = await as("buyer", `/api/engagements/${e.id}/run`, {});
  e = await as("shop", `/api/engagements/${e.id}/ask`, { text: `I'll sell the steel bottle for ₹${price}` });
  const c = await inboxFor("buyer", e.id, "confirm");
  assert.ok(c, "the buyer is asked to confirm");
  await as("buyer", `/api/inbox/${c.id}`, { confirm: true });
  e = await as("buyer", `/api/engagements/${e.id}`);
  assert.equal(e.phase, "agreed");
  assert.equal(e.negotiation.deal.price, price);
  return e;
}

test("paid outside the app (cash/UPI): the buyer still gets a pass, it says who marked it, and the shop scans it once", async () => {
  const e = await agreed(380);
  const before = (await as("shop", "/api/resources")).find((r: any) => r.factId === shopFact).onHand;
  const settled = await as("buyer", `/api/engagements/${e.id}/paid-outside`, {});
  assert.equal(settled.payment.status, "outside");
  assert.equal(settled.reservation.state, "committed", "paid in cash: the unit is sold, not just held");
  assert.equal((await as("shop", "/api/resources")).find((r: any) => r.factId === shopFact).onHand, before - 1, "it left the stock");
  const pass = await as("buyer", `/api/engagements/${e.id}/pickup`);
  assert.equal(pass.kind, "pickup"); assert.equal(pass.payment, "outside"); assert.equal(pass.markedBy, "buyer");
  const code = pass.path.split(".html#")[1].split(".")[1];
  const pub = await (await fetch(`${B}/public/pickup/${e.id}?code=${code}`)).json();
  assert.equal(pub.markedBy, "buyer"); assert.equal(pub.amount.value, 380);
  assert.equal((await raw("buyer", `/api/pickup/${e.id}/collect`, { code })).status, 403, "the buyer can't mark their own pickup");
  assert.equal((await raw("shop", `/api/pickup/${e.id}/collect`, { code })).status, 200);
  assert.equal((await raw("shop", `/api/pickup/${e.id}/collect`, { code })).status, 409, "once only");
  const after = await as("buyer", `/api/engagements/${e.id}`);
  assert.equal(after.fulfilment.state, "delivered");
  assert.ok([400, 409].includes((await raw("buyer", `/api/engagements/${e.id}/pay`, {})).status), "already settled outside: nothing to pay in the app");
  const byShop = await agreed(390);
  await as("shop", `/api/engagements/${byShop.id}/paid-outside`, {});
  assert.equal((await as("buyer", `/api/engagements/${byShop.id}/pickup`)).markedBy, "seller");
});

// A small deterministic random generator, so a failing sequence can be replayed from its seed.
const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

test("random buyer–seller conversations keep every invariant after every step", async () => {
  const ORDER: Record<string, number> = { asking: 0, negotiating: 1, deal: 2, agreed: 3, closed: 4, declined: 4 };
  const reached = new Set<string>(), actions = new Map<string, number>();
  for (const seed of [7, 42, 1234, 99991, 5, 77, 2026, 31337]) {
    const r = rng(seed), pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
    // Each run is its own buyer and shop (accounts are rate-limited, as they should be).
    const buyer = `rb-${seed}`, shop = `rs-${seed}`;
    await as(buyer, "/api/me", { handle: buyer, name: `Buyer ${seed}`, areaName: "Indiranagar" });
    await as(shop, "/api/me", { handle: shop, name: `Shop ${seed}`, areaName: "Indiranagar" });
    const listing = await as(shop, "/api/facts", { tier: "public", text: "Steel water bottles 500 ml for sale in Indiranagar, ₹400 each" });
    await as(shop, "/api/resources", { factId: listing.id, type: "quantity", onHand: 2 });
    let e = await as(buyer, `/api/people/${shop}/ask`, { text: "Is the steel bottle available?", offerFactId: listing.id });
    e = await as(buyer, `/api/engagements/${e.id}/run`, {});
    let lastPrice: number | null = null, phase = e.phase;
    for (let step = 0; step < 18; step++) {
      const ended = ["closed", "declined"].includes(phase), done = phase === "agreed";
      // Weighted like real chats: offers and confirmations are common, walking away is rarer.
      const action = pick(["buyerAsk", "buyerAsk", "shopAnswer", "shopPrice", "shopPrice", "buyerPrice", "confirm", "confirm", "confirm", "decline", "pay", "pay", "close"]);
      const price = 300 + Math.floor(r() * 150);
      let res: Response | null = null;
      if (action === "buyerAsk") res = await raw(buyer, `/api/engagements/${e.id}/ask`, { text: pick(["What colour is it?", "Is it dishwasher safe?", "Can I collect today?", "मुझे दो चाहिए, मिलेगा?"]) });
      if (action === "shopAnswer") { const q = await inboxFor(shop, e.id, "answer"); if (q) res = await raw(shop, `/api/inbox/${q.id}`, { text: pick(["Yes.", "Blue and black.", "Open till 9 pm."]) }); }
      if (action === "shopPrice") { res = await raw(shop, `/api/engagements/${e.id}/ask`, { text: `I'll sell it for ₹${price}` }); if (res.ok) lastPrice = (await res.clone().json()).negotiation.deal?.price ?? lastPrice; }
      if (action === "buyerPrice") { res = await raw(buyer, `/api/engagements/${e.id}/ask`, { text: `I'll buy it for ₹${price}` }); if (res.ok) lastPrice = (await res.clone().json()).negotiation.deal?.price ?? lastPrice; }
      if (action === "confirm" || action === "decline") {
        for (const uid of [buyer, shop]) { const c = await inboxFor(uid, e.id, "confirm"); if (c) { res = await raw(uid, `/api/inbox/${c.id}`, action === "confirm" ? { confirm: true } : { decline: true }); break; } }
      }
      if (action === "close") res = await raw(pick([buyer, shop]), `/api/engagements/${e.id}/close`, {});
      if (action === "pay") res = await raw(buyer, `/api/engagements/${e.id}/pay`, {});
      const ctx = `seed ${seed} step ${step} ${action}`;
      if (res) actions.set(`${action}:${res.status}`, (actions.get(`${action}:${res.status}`) ?? 0) + 1);
      if (res) {
        assert.ok(res.status < 500, `${ctx}: server error ${res.status}`);
        if ((ended || done) && ["buyerAsk", "shopPrice", "buyerPrice"].includes(action)) assert.equal(res.status, 400, `${ctx}: asking after the end is refused`);
        if (action === "pay" && phase !== "agreed") assert.ok([400, 409].includes(res.status), `${ctx}: no payment before a deal (${res.status})`);
      }
      e = await as(buyer, `/api/engagements/${e.id}`);
      assert.ok(e.phase in ORDER, `${ctx}: known phase ${e.phase}`);
      if (["closed", "declined"].includes(phase)) assert.equal(e.phase, phase, `${ctx}: an ended conversation stays ended`);
      if (phase === "agreed") assert.equal(e.phase, "agreed", `${ctx}: a deal is never undone by chat`);
      if (e.phase === "agreed") {
        assert.equal(e.negotiation.deal.price, lastPrice, `${ctx}: the deal is the last price named`);
        assert.ok(e.payment, `${ctx}: an agreed deal has a payment step`);
      }
      if (e.payment?.status === "paid") assert.equal(e.phase, "agreed", `${ctx}: paid only after agreement`);
      phase = e.phase; reached.add(phase);
      if (e.payment?.status === "paid") reached.add("paid");
    }
  }
  // The runs went somewhere: deals were made and paid, and conversations were ended early.
  assert.ok(reached.has("agreed") && reached.has("paid"), `reached ${[...reached]}`);
  assert.ok(reached.has("closed") || reached.has("declined"), `reached ${[...reached]}`);
  console.log("random runs:", [...reached].join(" "), "|", [...actions].map(([k, v]) => `${k}×${v}`).join(" "));
});

test("a changed price replaces the pending one (the stale confirmation is refused); a decision must say yes or no", async () => {
  await as("cp-b", "/api/me", { handle: "cp-b", name: "CP Buyer", areaName: "Indiranagar" });
  await as("cp-s", "/api/me", { handle: "cp-s", name: "CP Shop", areaName: "Indiranagar" });
  const listing = await as("cp-s", "/api/facts", { tier: "public", text: "Steel water bottles 500 ml for sale in Indiranagar, ₹400 each" });
  let e = await as("cp-b", "/api/people/cp-s/ask", { text: "Is it available?", offerFactId: listing.id });
  e = await as("cp-b", `/api/engagements/${e.id}/run`, {});
  e = await as("cp-s", `/api/engagements/${e.id}/ask`, { text: "I'll sell it for ₹320" });
  const first = await inboxFor("cp-b", e.id, "confirm");
  assert.equal((await raw("cp-b", `/api/inbox/${first.id}`, { confirm: false })).status, 400, "neither yes nor no: refused, not taken as yes");
  assert.equal((await raw("cp-b", `/api/inbox/${first.id}`, {})).status, 400);
  e = await as("cp-s", `/api/engagements/${e.id}/ask`, { text: "Sorry, I'll sell it for ₹448" });
  assert.equal(e.negotiation.deal.price, 448, "the new price replaced the pending one");
  assert.equal((await raw("cp-b", `/api/inbox/${first.id}`, { confirm: true })).status, 404, "the ₹320 confirmation is gone");
  e = await as("cp-s", `/api/engagements/${e.id}/ask`, { text: "Is ₹448 ok?" });
  assert.equal(e.negotiation.deal.price, 448, "a question naming the same price changes nothing");
  // The buyer counters: their own pending confirmation is answered by it, and the shop now decides.
  e = await as("cp-b", `/api/engagements/${e.id}/ask`, { text: "I'll buy it for ₹400" });
  assert.equal(e.negotiation.deal.price, 400); assert.equal(e.negotiation.dealBy, "requester");
  assert.equal(await inboxFor("cp-b", e.id, "confirm"), undefined, "the buyer has nothing left to confirm");
  const shopSays = await inboxFor("cp-s", e.id, "confirm");
  await as("cp-s", `/api/inbox/${shopSays.id}`, { decline: true });
  e = await as("cp-b", `/api/engagements/${e.id}`);
  assert.equal(e.phase, "asking", "saying no to a typed offer keeps the chat open");
  e = await as("cp-s", `/api/engagements/${e.id}/ask`, { text: "I can do ₹420, final" });
  await as("cp-b", `/api/inbox/${(await inboxFor("cp-b", e.id, "confirm")).id}`, { confirm: true });
  e = await as("cp-b", `/api/engagements/${e.id}`);
  assert.equal(e.phase, "agreed"); assert.equal(e.negotiation.deal.price, 420);
  assert.equal(e.payment.cart.total.value, 420, "the cart is for the agreed price");
});

test("'2 bottles for ₹800' is ₹800 for two, not ₹800 each: the cart, the stock hold and the uneven case add up", async () => {
  await as("q-b", "/api/me", { handle: "q-b", name: "Q Buyer", areaName: "Indiranagar" });
  await as("q-s", "/api/me", { handle: "q-s", name: "Q Shop", areaName: "Indiranagar" });
  const listing = await as("q-s", "/api/facts", { tier: "public", text: "Steel water bottles 500 ml for sale in Indiranagar, ₹450 each" });
  const stock = await as("q-s", "/api/resources", { factId: listing.id, type: "quantity", onHand: 5 });
  let e = await as("q-b", "/api/people/q-s/ask", { text: "Is it available?", offerFactId: listing.id });
  e = await as("q-b", `/api/engagements/${e.id}/run`, {});
  e = await as("q-b", `/api/engagements/${e.id}/ask`, { text: "I'll buy 2 bottles for ₹800" });
  assert.equal(e.negotiation.deal.price, 400); assert.equal(e.negotiation.deal.terms.quantity, 2);
  const same = await as("q-b", `/api/engagements/${e.id}/ask`, { text: "So I'll buy 2 bottles for ₹800, ok?" });
  assert.equal(same.negotiation.deal.id, e.negotiation.deal.id, "the same offer again changes nothing");
  assert.match(e.events.at(-1).text, /2 for ₹800 \(₹400 each\)/);
  await as("q-s", `/api/inbox/${(await inboxFor("q-s", e.id, "confirm")).id}`, { confirm: true });
  e = await as("q-b", `/api/engagements/${e.id}`);
  assert.equal(e.payment.cart.total.value, 800, "the cart is ₹800 in all");
  assert.equal(e.reservation.qty, 2, "two units held");
  await as("q-b", `/api/engagements/${e.id}/paid-outside`, {});
  assert.equal((await as("q-b", `/api/engagements/${e.id}/pickup`)).quantity, 2, "the pass says how many");
  const [ledger] = (await as("q-s", "/api/resources")).filter((r: any) => r.id === stock.id);
  assert.equal(ledger.onHand, 3, "paid: the two left the stock");
  // ₹1,000 for 3 doesn't divide: two lines that add up to exactly ₹1,000.
  let u = await as("q-b", "/api/people/q-s/ask", { text: "Any more?", offerFactId: listing.id });
  u = await as("q-b", `/api/engagements/${u.id}/run`, {});
  u = await as("q-b", `/api/engagements/${u.id}/ask`, { text: "I'll take 3 for ₹1,000" });
  assert.deepEqual(u.negotiation.deal.items.map((l: any) => [l.quantity, l.unitPrice]), [[2, 333], [1, 334]]);
  await as("q-s", `/api/inbox/${(await inboxFor("q-s", u.id, "confirm")).id}`, { confirm: true });
  u = await as("q-b", `/api/engagements/${u.id}`);
  assert.equal(u.payment.cart.total.value, 1000);
  assert.equal(u.reservation.qty, 3);
});

test("ordering from a card: buy several (bounded by stock), offer a price, book a free time (held when confirmed), never your own or a paused card", async () => {
  await as("o-b", "/api/me", { handle: "o-b", name: "Order Buyer", areaName: "Indiranagar" });
  await as("o-s", "/api/me", { handle: "o-s", name: "Order Shop", areaName: "Indiranagar" });
  const bottles = await as("o-s", "/api/facts", { tier: "public", text: "Steel water bottles for sale in Indiranagar, ₹450 each" });
  await as("o-s", "/api/resources", { factId: bottles.id, type: "quantity", onHand: 3 });
  const card = await as("o-b", "/api/people/o-s");
  const item = card.shop.find((i: any) => i.factId === bottles.id);
  assert.equal(item.action, "buy"); assert.equal(item.stock.available, 3); assert.equal(item.maxQuantity, 3);
  const tooMany = await raw("o-b", "/api/people/o-s/order", { offerFactId: bottles.id, quantity: 4 });
  assert.equal(tooMany.status, 409); assert.match((await tooMany.json()).error, /Only 3 left/);
  assert.equal((await raw("o-b", "/api/people/o-s/order", { offerFactId: bottles.id, quantity: 0 })).status, 400);
  assert.equal((await raw("o-b", "/api/people/o-s/order", { offerFactId: "nope", quantity: 1 })).status, 404);
  assert.equal((await raw("o-s", "/api/people/o-s/order", { offerFactId: bottles.id, quantity: 1 })).status, 400, "not your own card");
  let e = await as("o-b", "/api/people/o-s/order", { offerFactId: bottles.id, quantity: 2 });
  assert.equal(e.phase, "deal"); assert.equal(e.negotiation.deal.price, 450); assert.equal(e.negotiation.deal.terms.quantity, 2);
  assert.match(e.brief.summary, /2 × .* at ₹450 each/);
  await as("o-s", `/api/inbox/${(await inboxFor("o-s", e.id, "confirm")).id}`, { confirm: true });
  e = await as("o-b", `/api/engagements/${e.id}`);
  assert.equal(e.payment.cart.total.value, 900); assert.equal(e.reservation.qty, 2);
  assert.equal((await as("o-b", "/api/people/o-s")).shop.find((i: any) => i.factId === bottles.id).stock.available, 1, "two held for this buyer");
  const offer = await as("o-b", "/api/people/o-s/order", { offerFactId: bottles.id, quantity: 1, price: 400 });
  assert.equal(offer.negotiation.deal.price, 400); assert.match(offer.brief.summary, /would you take ₹400/);
  // A lesson with free times: the time picked on the card is held once the teacher confirms.
  const T = Math.floor(Date.now() / 1000);
  const lessons = await as("o-s", "/api/facts", { tier: "public", text: "Guitar lessons for sale in Indiranagar, ₹800 each" });
  await as("o-s", "/api/resources", { factId: lessons.id, type: "slots", slots: [{ start: T + 86400, end: T + 90000, capacity: 1 }, { start: T + 172800, end: T + 176400, capacity: 1 }] });
  const lesson = (await as("o-b", "/api/people/o-s")).shop.find((i: any) => i.factId === lessons.id);
  assert.equal(lesson.slots.length, 2);
  let b = await as("o-b", "/api/people/o-s/order", { offerFactId: lessons.id, quantity: 1, slotId: lesson.slots[1].id });
  assert.equal(b.preferredSlotId, lesson.slots[1].id);
  await as("o-s", `/api/inbox/${(await inboxFor("o-s", b.id, "confirm")).id}`, { confirm: true });
  b = await as("o-b", `/api/engagements/${b.id}`);
  assert.equal(b.reservation.state, "held"); assert.equal(b.reservation.slotId, lesson.slots[1].id);
  assert.equal((await as("o-b", "/api/people/o-s")).shop.find((i: any) => i.factId === lessons.id).slots.length, 1, "the held time is no longer offered");
  assert.equal((await as("o-b", `/api/engagements/${b.id}/pickup`).catch(() => null)), null, "no pass before paying");
  await as("o-b", `/api/engagements/${b.id}/paid-outside`, {});
  const pass = await as("o-b", `/api/engagements/${b.id}/pickup`);
  assert.equal(pass.kind, "booking"); assert.equal(pass.slot, lesson.slots[1].start);
  const taken = await raw("o-b", "/api/people/o-s/order", { offerFactId: lessons.id, quantity: 1, slotId: lesson.slots[1].id });
  assert.equal(taken.status, 409, "a taken time can't be ordered");
  await as("o-s", "/api/me/pause", { paused: true });
  const paused = await as("o-b", "/api/people/o-s");
  assert.equal(paused.paused, true);
  assert.equal((await raw("o-b", "/api/people/o-s/order", { offerFactId: bottles.id, quantity: 1 })).status, 409, "paused: no orders");
  await as("o-s", "/api/me/pause", { paused: false });
});
