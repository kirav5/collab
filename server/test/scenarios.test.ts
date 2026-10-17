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
  const done = await as("buyer", `/api/engagements/${e.id}/received`, { ok: true });
  assert.equal(done.fulfilment.state, "accepted");
  assert.equal(await inboxFor("shop", e.id), undefined, "a finished deal asks the shop nothing");
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
        if (ended && ["buyerAsk", "shopPrice", "buyerPrice"].includes(action)) assert.equal(res.status, 400, `${ctx}: asking after the end is refused`);
        // Once agreed, the two people may message each other; a message never changes the agreed deal.
        if (done && !ended && ["buyerAsk", "shopPrice", "buyerPrice"].includes(action) && res.ok) {
          const after = await as(buyer, `/api/engagements/${e.id}`);
          assert.equal(after.phase, "agreed", `${ctx}: still agreed`); assert.equal(after.events.at(-1).chat, true, `${ctx}: a message`);
        }
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
  assert.equal((await raw("o-b", `/api/engagements/${b.id}/booking`, { action: "cancel" })).status, 409, "unpaid: change the time before paying instead");
  await as("o-b", `/api/engagements/${b.id}/paid-outside`, {});
  const pass = await as("o-b", `/api/engagements/${b.id}/pickup`);
  assert.equal(pass.kind, "booking"); assert.equal(pass.slot, lesson.slots[1].start);
  const taken = await raw("o-b", "/api/people/o-s/order", { offerFactId: lessons.id, quantity: 1, slotId: lesson.slots[1].id });
  assert.equal(taken.status, 409, "a taken time can't be ordered");
  // After paying, the time can move to another free one (the old one is freed), and the booking can be cancelled.
  assert.equal((await raw("o-b", `/api/engagements/${b.id}/booking`, { action: "move", slotId: lesson.slots[1].id })).status, 409, "already that time");
  b = await as("o-b", `/api/engagements/${b.id}/booking`, { action: "move", slotId: lesson.slots[0].id });
  assert.equal(b.reservation.slotId, lesson.slots[0].id);
  assert.equal((await as("o-b", `/api/engagements/${b.id}/pickup`)).slot, lesson.slots[0].start, "the pass shows the new time");
  const free = (await as("o-b", "/api/people/o-s")).shop.find((i: any) => i.factId === lessons.id).slots.map((x: any) => x.id);
  assert.deepEqual(free, [lesson.slots[1].id], "the old time is offered again; the new one is taken");
  b = await as("o-s", `/api/engagements/${b.id}/booking`, { action: "cancel" });
  assert.equal(b.fulfilment.state, "cancelled"); assert.match(b.events.at(-1).text, /Cancelled the booking/);
  assert.equal((await as("o-b", "/api/people/o-s")).shop.find((i: any) => i.factId === lessons.id).slots.length, 2, "cancelled: both times free again");
  assert.equal((await as("o-b", `/api/engagements/${b.id}/pickup`)).cancelled, true, "the pass says cancelled");
  assert.equal((await raw("o-b", `/api/engagements/${b.id}/booking`, { action: "cancel" })).status, 409, "cancelled once");
  await as("o-s", "/api/me/pause", { paused: true });
  const paused = await as("o-b", "/api/people/o-s");
  assert.equal(paused.paused, true);
  assert.equal((await raw("o-b", "/api/people/o-s/order", { offerFactId: bottles.id, quantity: 1 })).status, 409, "paused: no orders");
  await as("o-s", "/api/me/pause", { paused: false });
});

test("paying in the app for several items: the pass, the receipt and every signature verify", async () => {
  await as("m-b", "/api/me", { handle: "m-b", name: "Multi Buyer", areaName: "Indiranagar" });
  await as("m-s", "/api/me", { handle: "m-s", name: "Multi Shop", areaName: "Indiranagar" });
  const f = await as("m-s", "/api/facts", { tier: "public", text: "Steel water bottles for sale in Indiranagar, ₹450 each" });
  await as("m-s", "/api/resources", { factId: f.id, type: "quantity", onHand: 5 });
  let e = await as("m-b", "/api/people/m-s/order", { offerFactId: f.id, quantity: 2 });
  await as("m-s", `/api/inbox/${(await inboxFor("m-s", e.id, "confirm")).id}`, { confirm: true });
  e = await as("m-b", `/api/engagements/${e.id}/pay`, { idempotencyKey: "multi-1" });
  assert.equal(e.payment.status, "paid");
  const pass = await raw("m-b", `/api/engagements/${e.id}/pickup`);
  const body = await pass.json();
  assert.equal(pass.status, 200, JSON.stringify(body));
  assert.equal(body.quantity, 2); assert.equal(body.amount.value, 900);
  const r = await as("m-b", `/api/engagements/${e.id}/receipt`);
  const code = r.verifyPath.split(".html#")[1].split(".")[1];
  const bundle = await (await fetch(`${B}/public/receipts/${e.id}?code=${code}`)).json();
  // @ts-ignore browser module
  const { verifyReceiptBundle } = await import("../../web/js/verify-receipt.js");
  assert.deepEqual(await verifyReceiptBundle(bundle, bundle.publicKey), { receipt: true, cart: true, payment: true, ap2: { merchant: true, mandates: true } });
});

test("a seller's own terms are shown and sealed into the receipt; instant booking confirms at the listed price, never below it", async () => {
  await as("t-s", "/api/me", { handle: "t-salon", name: "Trim Salon", areaName: "Indiranagar" });
  await as("t-b", "/api/me", { handle: "t-buyer", name: "Ravi", areaName: "Indiranagar" });
  const f = await as("t-s", "/api/facts", { tier: "public", text: "Haircuts for sale in Indiranagar, ₹450 each" });
  assert.equal((await raw("t-b", `/api/facts/${f.id}/policies`, { policies: [{ label: "Cancellation", text: "x" }] })).status, 404, "only the owner sets terms");
  const policies = [{ label: "Cancellation", text: "Free up to 2 hours before." }, { label: "Re-trim", text: "Free touch-up within 7 days." }];
  await as("t-s", `/api/facts/${f.id}/policies`, { policies, instant: true });
  const card = (await as("t-b", "/api/people/t-salon")).shop.find((i: any) => i.factId === f.id);
  assert.deepEqual(card.policies, policies); assert.equal(card.instant, true);
  let e = await as("t-b", "/api/people/t-salon/order", { offerFactId: f.id, quantity: 1 });
  assert.equal(e.phase, "agreed", "instant booking: confirmed at once by the seller's standing instruction");
  assert.equal(e.negotiation.confirmedBy.provider, "mandate");
  assert.equal(await inboxFor("t-s", e.id, "confirm"), undefined, "the seller wasn't asked");
  const below = await as("t-b", "/api/people/t-salon/order", { offerFactId: f.id, quantity: 1, price: 400 });
  assert.equal(below.phase, "deal", "an offer below the listed price still goes to the seller");
  await as("t-b", `/api/engagements/${e.id}/paid-outside`, {});
  const r = await as("t-b", `/api/engagements/${e.id}/receipt`);
  assert.deepEqual(r.terms.policies, policies, "the terms in force are part of the signed record");
  const code = r.verifyPath.split(".html#")[1].split(".")[1];
  const bundle = await (await fetch(`${B}/public/receipts/${e.id}?code=${code}`)).json();
  // @ts-ignore browser module
  const { verifyReceiptBundle } = await import("../../web/js/verify-receipt.js");
  assert.equal((await verifyReceiptBundle(bundle, bundle.publicKey)).receipt, true);
  bundle.terms.policies[0].text = "No refunds ever."; assert.equal((await verifyReceiptBundle(bundle, bundle.publicKey)).receipt, false, "changing a term breaks the record");
  // Terms changed later don't rewrite a deal already made.
  await as("t-s", `/api/facts/${f.id}/policies`, { policies: [{ label: "Cancellation", text: "No cancellations." }] });
  assert.deepEqual((await as("t-b", `/api/engagements/${e.id}/receipt`)).terms.policies, policies);
});

test("lamps: a counter keeps the quantity, the seller's agent negotiates a low offer instead of asking yes or no, '200rs' is an offer, and stock is checked up front", async () => {
  await as("lm-s", "/api/me", { handle: "lm-shop", name: "Lamp Shop", areaName: "Indiranagar" });
  await as("lm-b", "/api/me", { handle: "lm-buyer", name: "Lamp Buyer", areaName: "Indiranagar" });
  const listing = async (stock: number, autonomy: string | null, text = "Brass desk lamps for sale in Indiranagar, warm LED, ₹450 each") => {
    const f = await as("lm-s", "/api/facts", { tier: "public", text });
    await as("lm-s", "/api/resources", { factId: f.id, type: "quantity", onHand: stock });
    if (autonomy) await as("lm-s", `/api/facts/${f.id}/limit`, { mandate: { price: { opening: 450, limit: 380 } }, autonomy, days: 7 });
    return f;
  };
  const items = async (uid: string, id: string) => ((await as(uid, "/api/inbox")) as any[]).filter(i => i.engagementId === id);
  // 5 at ₹300 from the card: the seller's agent counters (5 × something under ₹450), the seller isn't asked yes or no.
  let f = await listing(15, "negotiate");
  let e = await as("lm-b", "/api/people/lm-shop/order", { offerFactId: f.id, quantity: 5, price: 300 });
  assert.equal(e.negotiation.deal.terms.quantity, 5);
  assert.ok(e.negotiation.deal.price < 450 && e.negotiation.deal.price >= 380, `countered at ₹${e.negotiation.deal.price}`);
  assert.equal(e.negotiation.dealBy, "provider");
  assert.deepEqual((await items("lm-s", e.id)).map(i => i.kind), [], "the seller isn't asked about ₹300");
  const counter = (await items("lm-b", e.id)).find(i => i.kind === "move");
  assert.equal(counter.counter.quantity, 5); assert.equal(counter.counter.total, counter.counter.price * 5);
  // The buyer takes it; the seller (who confirms deals) confirms; the cart is for all five.
  e = await as("lm-b", `/api/engagements/${e.id}/ask`, { text: `I'll buy it for ₹${counter.counter.price}` });
  assert.equal(e.negotiation.confirmed.requester, true, "taking the counter is a yes");
  await as("lm-s", `/api/inbox/${(await items("lm-s", e.id)).find(i => i.kind === "confirm").id}`, { confirm: true });
  e = await as("lm-b", `/api/engagements/${e.id}`);
  assert.equal(e.phase, "agreed"); assert.equal(e.payment.cart.total.value, counter.counter.price * 5); assert.equal(e.reservation.qty, 5);
  // The seller counters in chat without saying how many: still five.
  e = await as("lm-b", "/api/people/lm-shop/order", { offerFactId: (f = await listing(15, null)).id, quantity: 5, price: 300 });
  e = await as("lm-s", `/api/engagements/${e.id}/ask`, { text: "I can do ₹420" });
  assert.equal(e.negotiation.deal.terms.quantity, 5); assert.equal(e.negotiation.deal.price, 420, "₹420 each, not ₹420 for five");
  // A seller whose agent may close: an offer inside the floor is confirmed at once, nobody asked.
  e = await as("lm-b", "/api/people/lm-shop/order", { offerFactId: (await listing(15, "close")).id, quantity: 3, price: 400 });
  assert.equal(e.phase, "agreed"); assert.equal(e.payment.cart.total.value, 1200);
  // Asked a question, the buyer answers "200rs": that's an offer the seller's agent counters, not a question for the seller.
  f = await listing(15, "negotiate");
  e = await as("lm-b", "/api/people/lm-shop/ask", { text: "Is it available?", offerFactId: f.id });
  e = await as("lm-b", `/api/engagements/${e.id}/run`, {});
  e = await as("lm-b", `/api/engagements/${e.id}/ask`, { text: "200rs" });
  e = await as("lm-b", `/api/engagements/${e.id}`);
  assert.equal(e.negotiation.dealBy, "provider", "countered by the seller's agent");
  assert.ok(!(await items("lm-s", e.id)).some(i => i.kind === "answer" && /200/.test(i.question ?? "")), "never sent to the seller as a question");
  // 200 lamps when 15 are there: refused at once, with the offer that fits.
  f = await listing(15, null);
  e = await as("lm-b", "/api/people/lm-shop/ask", { text: "Do you have them?", offerFactId: f.id });
  const r = await raw("lm-b", `/api/engagements/${e.id}/ask`, { text: "I'll take 200 lamps at ₹400 each" });
  assert.equal(r.status, 409);
  const body = await r.json();
  assert.equal(body.available, 15); assert.equal(body.suggest, "I'll take 15 at ₹400 each");
  e = await as("lm-b", `/api/engagements/${e.id}/ask`, { text: body.suggest });
  assert.equal(e.negotiation.deal.terms.quantity, 15); assert.equal(e.negotiation.deal.price, 400);
  // Both agents negotiate when the buyer says "up to" with the offer: no one is asked anything until the deal (the
  // seller confirms deals themselves; the buyer let their agent agree inside its limit).
  f = await listing(15, "negotiate");
  e = await as("lm-b", "/api/people/lm-shop/order", { offerFactId: f.id, quantity: 4, price: 300, max: 420 });
  assert.equal(e.phase, "deal"); assert.equal(e.negotiation.deal.terms.quantity, 4);
  assert.ok(e.negotiation.deal.price >= 380 && e.negotiation.deal.price <= 420, `agents met at ₹${e.negotiation.deal.price}`);
  assert.equal(e.negotiation.confirmed.requester, true, "the buyer's agent agreed inside the limit");
  assert.deepEqual((await items("lm-b", e.id)).map(i => i.kind), [], "the buyer wasn't asked");
  assert.deepEqual((await items("lm-s", e.id)).map(i => i.kind), ["confirm"], "the seller gives the final yes they kept");
  assert.ok(e.events.filter((x: any) => x.who === "requester_agent").length >= 1, "the buyer's agent made moves");
  // A counter handed to the agent afterwards: "up to ₹420", and the agents finish it.
  f = await listing(15, "close");
  e = await as("lm-b", "/api/people/lm-shop/order", { offerFactId: f.id, quantity: 2, price: 250 });
  assert.ok((await items("lm-b", e.id)).some(i => i.kind === "move" && i.counter), "countered");
  e = await as("lm-b", `/api/engagements/${e.id}/delegate`, { limit: 420 });
  assert.equal(e.phase, "agreed", "both agents may close: done without anyone else asked");
  assert.equal(e.payment.cart.total.value, e.negotiation.deal.price * 2);
  assert.deepEqual([...(await items("lm-b", e.id)), ...(await items("lm-s", e.id))].map(i => i.kind), []);
  // The very first message can be the offer: 200 is refused before a conversation opens; 3 at ₹400 is an offer.
  f = await listing(15, "negotiate");
  const first = await raw("lm-b", "/api/people/lm-shop/ask", { text: "I'll take 200 lamps at ₹400 each", offerFactId: f.id });
  assert.equal(first.status, 409); assert.equal((await first.json()).suggest, "I'll take 15 at ₹400 each");
  e = await as("lm-b", "/api/people/lm-shop/ask", { text: "I'll take 3 lamps at ₹400 each", offerFactId: f.id });
  assert.equal(e.negotiation.deal.terms.quantity, 3); assert.equal(e.negotiation.deal.price, 400);
  assert.deepEqual(e.qa, [], "an offer, not a question for the seller to answer");
  assert.equal((await items("lm-s", e.id)).filter(i => i.kind === "confirm").length, 1, "inside the floor: the seller (who confirms deals) is asked once");
  // A request for 200 at a shop with 15: the conversation is for 15, and the buyer's closing agent leaves it to them.
  f = await listing(15, "close", "Ceramic table lamps for sale in Indiranagar, ₹450 each");
  const d = await as("lm-b", "/api/briefs/draft", { text: "Need 200 ceramic table lamps in Indiranagar, up to ₹460 each" });
  const s = await as("lm-b", "/api/briefs", { need: d.draft.need, shared: d.draft.shared, delegate: { mandate: { price: { opening: 400, limit: 460 } }, autonomy: "close", days: 7 } });
  let [x] = await as("lm-b", `/api/briefs/${s.brief.id}/engage`, { providers: [{ factId: f.id }] });
  assert.equal(x.quantity, 15); assert.equal(x.wanted, 200);
  for (let k = 0; k < 6 && x.phase !== "agreed"; k++) {
    for (const i of await items("lm-b", x.id)) await as("lm-b", `/api/inbox/${i.id}`, i.kind === "confirm" ? { confirm: true } : { text: "Tomorrow" });
    for (const i of await items("lm-s", x.id)) await as("lm-s", `/api/inbox/${i.id}`, i.kind === "confirm" ? { confirm: true } : { text: "Yes" });
    x = await as("lm-b", `/api/engagements/${x.id}/run`, {});
  }
  x = await as("lm-b", `/api/engagements/${x.id}`);
  assert.equal(x.phase, "agreed"); assert.equal(x.negotiation.deal.terms.quantity, 15);
  assert.equal(x.payment.cart.total.value, x.negotiation.deal.price * 15);
  assert.equal(x.negotiation.confirmedBy.requester, "owner", "fewer than asked for: the buyer decided, not their agent");
});

test("a vague offering: the card asks for the basics, and what buyers would ask comes with tap-to-answer options", async () => {
  await as("vg-s", "/api/me", { handle: "vague-seller", name: "Vague Seller", areaName: "Koramangala" });
  const d = await as("vg-s", "/api/offers/draft", { text: "I want to sell my old iphone" });
  assert.equal(d.offer, null, "no price yet: not a listing");
  assert.equal(d.basics.category, "goods");
  assert.match(d.basics.area, /Koramangala/, "the seller's own area is offered");
  assert.ok(d.missing.length >= 2 && d.missing.every((m: any) => m.label && m.ask.endsWith("?")));
  assert.ok(!d.missing.some((m: any) => /price|phone|address/i.test(m.ask)), "price has its own field; contact details are never asked");
  assert.ok(d.missing.some((m: any) => m.options.length >= 2), "tap-to-answer options");
  // A floor in a vague offering isn't published as a plain note either.
  const plainNote = await as("vg-s", "/api/facts", { tier: "public", text: "Old sofa, lowest 5000" });
  assert.ok(!/5000/.test(plainNote.text), "a strong floor word is enough, with or without a price");
  // With the basics the card adds, it reads as a listing; the answers are part of it.
  const full = await as("vg-s", "/api/offers/draft", { text: "I want to sell my old iphone. ₹32,000. In Koramangala. Condition: Like new." });
  assert.equal(full.offer.price.amount, 32000);
  assert.match(full.offer.place.name, /Koramangala/);
  // A plain fact made public from the notes stays a plain note — it isn't forced into a listing.
  const plain = await as("vg-s", "/api/offers/draft", { text: "I have lived in Koramangala for ten years", note: true });
  assert.equal(plain.offer, null);
  assert.equal(plain.basics, undefined);
});

test("a floor written in a note never reaches public text, however it's published; a note made public keeps its id", async () => {
  const f = await as("vg-s", "/api/facts", { tier: "public", text: "Selling my iPhone 13 in Koramangala for ₹32,000, lowest 29,000." });
  assert.ok(!/29/.test(f.text), f.text);
  assert.equal(f.floorKeptPrivate, true);
  const g = await as("vg-s", "/api/facts", { tier: "public", text: "Guitar lessons in Jayanagar, ₹800 an hour, minimum 2 hours." });
  assert.match(g.text, /minimum 2 hours/, "small numbers aren't floors");
  assert.equal(g.floorKeptPrivate, undefined);
  const p = await as("vg-s", "/api/facts", { tier: "private", text: "Old sofa for sale in Koramangala, ₹6,000, lowest 5,000" });
  assert.match(p.text, /lowest 5,000/, "a private note keeps every word");
  const pub = await as("vg-s", "/api/facts", { id: p.id, tier: "public", text: p.text });
  assert.equal(pub.id, p.id, "made public in place, not copied");
  assert.ok(!/5,?000/.test(pub.text), pub.text);
});

test("a service seller states weekly hours once: buyers see free times two weeks ahead, and the agent names the hours", async () => {
  await as("hr-s", "/api/me", { handle: "hours-barber", name: "Hours Barber", areaName: "Indiranagar" });
  const f = await as("hr-s", "/api/facts", { tier: "public", text: "Guitar lessons in Indiranagar, ₹800 an hour" });
  assert.ok(f.offer, "read as an offering");
  await assert.rejects(as("hr-s", "/api/resources", { factId: f.id, type: "slots", hours: { days: [], from: "10:00", to: "20:00", minutes: 40 } }), /at least one day/);
  const r = await as("hr-s", "/api/resources", { factId: f.id, type: "slots", hours: { days: [1, 2, 3, 4, 5, 6], from: "10:00", to: "20:00", minutes: 40 }, timezone: "Asia/Kolkata" });
  assert.ok(r.slots.length >= 150 && r.hours.minutes === 40);
  await assert.rejects(as("someone", `/api/resources/${r.id}/hours`, { hours: { days: [6], from: "09:00", to: "12:00", minutes: 60 } }), /404|No such/);
  const r2 = await as("hr-s", `/api/resources/${r.id}/hours`, { hours: { days: [6], from: "09:00", to: "12:00", minutes: 60 } });
  assert.ok(r2.slots.length <= 6 && r2.slots.every((s: any) => s.end - s.start === 3600));
  const shop = (await as("buyer-x", "/api/people/hours-barber")).shop;
  assert.ok(shop[0].slots.length >= 1, "the card offers the free times");
});

test("a seller's offering draft lists what buyers usually ask; terms are suggested for the seller to accept, never saved by themselves", async () => {
  await as("in-s", "/api/me", { handle: "intake-salon", name: "Intake Salon", areaName: "Indiranagar" });
  const draft = await as("in-s", "/api/offers/draft", { text: "Men's haircut for sale in Indiranagar, ₹400 each" });
  assert.ok(Array.isArray(draft.missing));
  const sug = await as("in-s", "/api/terms/suggest", { category: "beauty", text: "Men's haircut in Indiranagar, ₹400" });
  assert.ok(sug.terms.length >= 2 && sug.terms.every((t: any) => t.label && t.text));
  const facts = await as("in-s", "/api/facts");
  assert.ok(!facts.some((f: any) => f.offer?.policies?.length), "suggestions aren't saved until the seller saves them");
});

test("rules in the seller's words: at most 10 per buyer, closes alone at ₹420+, asks between ₹400 and ₹419, counters below", async () => {
  await as("ru-s", "/api/me", { handle: "ru-shop", name: "Rules Shop", areaName: "Indiranagar" });
  await as("ru-b", "/api/me", { handle: "ru-buyer", name: "Rules Buyer", areaName: "Indiranagar" });
  const f = await as("ru-s", "/api/facts", { tier: "public", text: "Brass desk lamps for sale in Indiranagar, ₹450 each" });
  await as("ru-s", "/api/resources", { factId: f.id, type: "quantity", onHand: 100 });
  const words = "Don't go below ₹400 a lamp, max 10 per buyer, pickups only on weekdays after 5 pm, and close deals yourself above ₹420";
  const read = await as("ru-s", "/api/rules/read", { text: words, side: "seller", factId: f.id });
  assert.ok(read.lines.some((l: any) => /Most per person: 10/.test(l.text)));
  const saved = await as("ru-s", `/api/facts/${f.id}/rules`, { text: words, rules: read.rules });
  assert.equal(saved.fact.offer.maxPerBuyer, 10); assert.ok(saved.fact.offer.policies.some((p: any) => p.label === "Pickup"));
  const item = (await as("ru-b", "/api/people/ru-shop")).shop.find((i: any) => i.factId === f.id);
  assert.equal(item.perBuyer, 10); assert.equal(item.maxQuantity, 10, "the card won't go past 10");
  const many = await raw("ru-b", "/api/people/ru-shop/order", { offerFactId: f.id, quantity: 15, price: 425 });
  assert.equal(many.status, 409); assert.equal((await many.json()).available, 10);
  const inbox = async (uid: string, id: string) => ((await as(uid, "/api/inbox")) as any[]).filter(i => i.engagementId === id);
  let e = await as("ru-b", "/api/people/ru-shop/order", { offerFactId: f.id, quantity: 10, price: 425 });
  assert.equal(e.phase, "agreed", "₹425 is past ₹420: the agent agreed on its own"); assert.equal(e.payment.cart.total.value, 4250);
  e = await as("ru-b", "/api/people/ru-shop/order", { offerFactId: f.id, quantity: 10, price: 410 });
  assert.equal(e.phase, "deal"); assert.deepEqual((await inbox("ru-s", e.id)).map(i => i.kind), ["confirm"], "between ₹400 and ₹419: the seller gives the final yes");
  e = await as("ru-b", "/api/people/ru-shop/order", { offerFactId: f.id, quantity: 4, price: 350 });
  assert.equal(e.negotiation.dealBy, "provider", "below ₹400: the agent counters");
  assert.ok(e.negotiation.deal.price >= 400 && e.negotiation.deal.terms.quantity === 4);
  assert.deepEqual((await inbox("ru-s", e.id)).map(i => i.kind), [], "and the seller isn't asked");
  // The buyer hands the counter over in words: a limit, and a must-be-yes question their agent asks the seller.
  const bw = "Up to ₹430 a lamp, only if I can pick it up this weekend";
  const br = await as("ru-b", "/api/rules/read", { text: bw, side: "buyer", engagementId: e.id });
  assert.equal(br.rules.limit, 430); assert.deepEqual(br.rules.mustAsk, ["Can I pick it up this weekend?"]);
  e = await as("ru-b", `/api/engagements/${e.id}/rules`, { text: bw, rules: br.rules });
  assert.ok(e.qa.some((q: any) => q.question === "Can I pick it up this weekend?" && q.required), "a must-be-yes check");
  assert.ok(e.events.some((x: any) => x.who === "requester_agent"), "the buyer's agent took over");
  assert.ok(!(await inbox("ru-b", e.id)).some(i => i.kind === "move" && i.counter), "no counter waiting on the buyer");
});

test("once agreed, the two people can message each other before paying — messages, not offers; optional notes are suggested", async () => {
  await as("ch-s", "/api/me", { handle: "chat-shop", name: "Chat Shop", areaName: "Indiranagar" });
  await as("ch-b", "/api/me", { handle: "chat-buyer", name: "Chat Buyer", areaName: "Indiranagar" });
  const f = await as("ch-s", "/api/facts", { tier: "public", text: "Steel water bottles for sale in Indiranagar, ₹450 each" });
  let e = await as("ch-b", "/api/people/chat-shop/order", { offerFactId: f.id, quantity: 2 });
  assert.deepEqual(e.qa, [], "an order isn't a question for the seller");
  await as("ch-s", `/api/inbox/${((await as("ch-s", "/api/inbox")) as any[]).find(i => i.engagementId === e.id && i.kind === "confirm").id}`, { confirm: true });
  e = await as("ch-b", `/api/engagements/${e.id}/ask`, { text: "Can I collect after 6 pm? I'll pay at pickup." });
  assert.equal(e.phase, "agreed"); assert.equal(e.events.at(-1).chat, true);
  e = await as("ch-s", `/api/engagements/${e.id}/ask`, { text: "Sure, 6 to 8 pm works. I'll take ₹400." });
  assert.equal(e.negotiation.deal.price, 450, "a price in a message doesn't change the agreed deal");
  assert.equal(e.payment.cart.total.value, 900);
  const ideas = await as("ch-b", `/api/engagements/${e.id}/note-ideas`);
  assert.ok(Array.isArray(ideas.notes));
  assert.deepEqual((await as("ch-s", `/api/engagements/${e.id}/note-ideas`)).notes, [], "suggestions are for the buyer");
});

test("communities: any kind of post — a trip, a group, an event — shaped from plain words; members only; seats can't overfill", async () => {
  await as("cm-a", "/api/me", { handle: "cm-asha", name: "Asha", areaName: "Indiranagar" });
  await as("cm-b", "/api/me", { handle: "cm-bala", name: "Bala", areaName: "Koramangala" });
  await as("cm-x", "/api/me", { handle: "cm-out", name: "Outsider", areaName: "Jayanagar" });
  const c = await as("cm-a", "/api/communities", { name: "Embassy Tech Village", kind: "office", place: "Whitefield" });
  assert.match(c.place.name, /White ?field/i); assert.equal(c.members, 1); assert.equal(c.createdBy, "you");
  const list = await as("cm-b", "/api/communities");
  assert.ok(list.nearby.some((x: any) => x.id === c.id), "found nearby to join");
  assert.ok(!JSON.stringify(list).includes("cm-a"), "no account ids in the list");
  assert.equal((await raw("cm-b", `/api/communities/${c.id}`)).status, 403, "not a member yet");
  assert.equal((await raw("cm-b", `/api/communities/${c.id}/posts/draft`, { text: "Cab from Koramangala at 9am tomorrow" })).status, 403);
  await as("cm-b", `/api/communities/${c.id}/join`, {});
  await as("cm-b", "/api/facts", { tier: "public", text: "Home-made tiffin lunch box for sale in Koramangala, ₹120 each" });
  await as("cm-b", "/api/facts", { tier: "public", text: "Part-time assignment help job in Koramangala, ₹500 each" });

  // A trip: read from the words, checked, then posted with one edit (1 seat, not 2).
  const words = "Anyone want to share a cab from Koramangala to Whitefield at 9am tomorrow? 2 seats";
  const d = await as("cm-b", `/api/communities/${c.id}/posts/draft`, { text: words });
  assert.equal(d.kind, "trip"); assert.match(d.from.name, /Koramangala/); assert.match(d.to.name, /White ?field/i);
  assert.equal(d.spots, 2); assert.ok(d.at > Date.now() / 1000, "a time from 'tomorrow 9am'");
  assert.equal((await raw("cm-b", `/api/communities/${c.id}/posts`, { text: words, kind: "trip", title: d.title, from: "Atlantis", at: d.at, spots: 1 })).status, 400, "an area we don't know");
  const trip = await as("cm-b", `/api/communities/${c.id}/posts`, { text: words, kind: "trip", title: d.title, from: d.from.name, at: d.at, spots: 1 });
  assert.equal(trip.spots, 1); assert.match(trip.to.name, /White ?field/i, "to the community's place by default");
  // A group and an event straight from the words; the shape decides how each card is shown.
  const group = await as("cm-b", `/api/communities/${c.id}/posts`, { text: "Bulk order of basmati rice, need 5 people to pool" });
  assert.equal(group.kind, "group"); assert.equal(group.spots, 5);
  assert.equal((await raw("cm-b", `/api/communities/${c.id}/posts`, { text: "Splitting a plan", kind: "group", title: "Plan", spots: 1 })).status, 400, "a group of one can't be joined");
  const event = await as("cm-a", `/api/communities/${c.id}/posts`, { text: "Terrace yoga class in Whitefield at 7am tomorrow, all welcome" });
  assert.equal(event.kind, "event"); assert.ok(event.at); assert.match(event.place.name, /White ?field/i); assert.equal(event.spots, null, "no number stated, no limit");
  assert.equal((await raw("cm-a", `/api/communities/${c.id}/posts`, { text: "Selling my old desk, call 98450 12345" })).status, 400, "no phone numbers — people reach you through your agent");

  const feed = await as("cm-a", `/api/communities/${c.id}`);
  assert.equal(feed.community.members, 2);
  assert.deepEqual(feed.posts.map((x: any) => x.kind).slice(0, 1), ["trip"], "trips first");
  assert.equal(feed.posts.length, 3);
  assert.ok(feed.posts.every((x: any) => x.owner === undefined && x.joined === undefined), "no internal ids");
  assert.ok(typeof feed.posts[0].km === "number", "how far its start is from you");
  assert.ok(feed.offers.length + feed.gigs.length >= 1);

  // "I'm in": seats can't overfill; the poster sees who's in; outsiders can't join.
  assert.equal((await raw("cm-b", `/api/posts/${trip.id}/join`, {})).status, 409, "not your own post");
  const joined = await as("cm-a", `/api/posts/${trip.id}/join`, {});
  assert.equal(joined.count, 1); assert.equal(joined.youJoined, true); assert.equal(joined.people, undefined, "only the poster sees who's in");
  assert.equal(joined.notified, undefined); assert.equal(joined.joined, undefined, "no account ids");
  assert.equal((await raw("cm-x", `/api/posts/${trip.id}/join`, {})).status, 403, "outsiders can't join");
  await as("cm-x", `/api/communities/${c.id}/join`, {});
  assert.equal((await raw("cm-x", `/api/posts/${trip.id}/join`, {})).status, 409, "no seats left");
  const mine = (await as("cm-b", `/api/communities/${c.id}`)).posts.find((x: any) => x.id === trip.id);
  assert.deepEqual(mine.people.map((x: any) => x.handle), ["cm-asha"]);
  await as("cm-a", `/api/posts/${trip.id}/join`, { leave: true });
  assert.equal((await as("cm-x", `/api/posts/${trip.id}/join`, {})).count, 1, "a seat freed up");

  assert.equal((await raw("cm-a", `/api/posts/${trip.id}/close`, {})).status, 404, "only the poster closes it");
  await as("cm-b", `/api/posts/${trip.id}/close`, {});
  assert.equal((await as("cm-a", `/api/communities/${c.id}`)).posts.length, 2);
});

test("the gate: a vague request or offering comes back with what's missing; a clear one goes straight through", async () => {
  await as("gt", "/api/me", { handle: "gate-user", name: "Gate User", areaName: "Indiranagar" });
  const vague = await as("gt", "/api/briefs/draft", { text: "need stuff" });
  assert.equal(vague.gate.ok, false); assert.ok(vague.gate.missing.length >= 1 && vague.gate.missing.every((m: any) => m.options.length >= 2));
  const clear = await as("gt", "/api/briefs/draft", { text: "Need 2 brass desk lamps in Indiranagar this week, warm light" });
  assert.equal(clear.gate.ok, true);
  const offer = await as("gt", "/api/offers/draft", { text: "Brass desk lamps for sale in Indiranagar, warm LED, ₹450 each" });
  assert.equal(offer.gate.ok, true);
});

test("a seller's record grows from signed receipts: public, verifiable, on their card and agent card — no buyers, no prices", async () => {
  await as("tr-s", "/api/me", { handle: "tr-shop", name: "Record Shop", areaName: "Indiranagar" });
  await as("tr-b", "/api/me", { handle: "tr-buyer", name: "Record Buyer", areaName: "Indiranagar" });
  let rec = await (await fetch(`${B}/public/people/tr-shop/record`)).json();
  assert.equal(rec.sales, 0);
  const f = await as("tr-s", "/api/facts", { tier: "public", text: "Steel water bottles for sale in Indiranagar, ₹450 each" });
  await as("tr-s", "/api/resources", { factId: f.id, type: "quantity", onHand: 10 });
  let e = await as("tr-b", "/api/people/tr-shop/order", { offerFactId: f.id, quantity: 3 });
  await as("tr-s", `/api/inbox/${((await as("tr-s", "/api/inbox")) as any[]).find(i => i.engagementId === e.id && i.kind === "confirm").id}`, { confirm: true });
  await as("tr-b", `/api/engagements/${e.id}/paid-outside`, {});
  const pass = await as("tr-b", `/api/engagements/${e.id}/pickup`);
  await as("tr-s", `/api/pickup/${e.id}/collect`, { code: pass.path.split(".html#")[1].split(".")[1] });
  rec = await (await fetch(`${B}/public/people/tr-shop/record`)).json();
  assert.equal(rec.sales, 1); assert.equal(rec.verified, 1); assert.equal(rec.recent[0].quantity, 3); assert.equal(rec.handedOver, 1, "collected with the pass");
  assert.match(rec.recent[0].receipt.hash, /^[0-9a-f]{64}$/); assert.ok(rec.recent[0].receipt.signature);
  const receipt = await as("tr-b", `/api/engagements/${e.id}/receipt`);
  assert.equal(rec.recent[0].receipt.hash, receipt.hash, "the fingerprint is the receipt's own hash");
  // (Fingerprints and signatures are random-looking: checked apart, so a "450" inside a hash can't fail this.)
  const text = JSON.stringify({ ...rec, recent: rec.recent.map(({ receipt: _r, ...x }: any) => x) });
  assert.ok(!/Record Buyer|tr-buyer|450|1350/.test(text), "no buyer and no price in public");
  assert.equal((await as("tr-b", "/api/people/tr-shop")).record.sales, 1, "on their card");
  const card = await (await fetch(`${B}/a2a/tr-shop/.well-known/agent-card.json`)).json();
  assert.match(card.description, /1 verified sale/, "and on their agent card");
});

test("booking a match from a request keeps one goal, and a second tap returns the same deal", async () => {
  await as("og-s", "/api/me", { handle: "og-seller", name: "Barber Om", areaName: "Indiranagar" });
  await as("og-b", "/api/me", { handle: "og-buyer", name: "Buyer Oz", areaName: "Indiranagar" });
  const f = await as("og-s", "/api/facts", { tier: "public", text: "Steel water bottles 500 ml for sale in Indiranagar, ₹400 each" });
  const d = await as("og-b", "/api/briefs/draft", { text: "Need a steel water bottle in Indiranagar" });
  const sent = await as("og-b", "/api/briefs", { need: d.draft.need, shared: d.draft.shared });
  const before = (await as("og-b", "/api/goals")) as any[];
  assert.equal(before.length, 1, "the request is one goal");
  const e = await as("og-b", "/api/people/og-seller/order", { offerFactId: f.id, quantity: 1, briefId: sent.brief.id });
  const again = await as("og-b", "/api/people/og-seller/order", { offerFactId: f.id, quantity: 1, briefId: sent.brief.id });
  assert.equal(again.id, e.id, "a second tap is the same deal, not a second purchase");
  const goals = (await as("og-b", "/api/goals")) as any[];
  assert.equal(goals.length, 1, "still one goal");
  assert.deepEqual(goals[0].tasks.map((t: any) => t.id), [e.id], "the booking is that goal's task");
  // Someone else's request id doesn't attach their order to it.
  await as("og-c", "/api/me", { handle: "og-other", name: "Other Oy", areaName: "Indiranagar" });
  const theirs = await as("og-c", "/api/people/og-seller/order", { offerFactId: f.id, quantity: 1, briefId: sent.brief.id });
  assert.notEqual(theirs.id, e.id);
  assert.equal(((await as("og-b", "/api/goals")) as any[])[0].tasks.length, 1, "the buyer's goal is untouched");
});

test("a photo becomes a listing: read into a sentence, kept, served publicly, and attached only by its owner", async () => {
  await as("ph-s", "/api/me", { handle: "ph-shop", name: "Photo Shop", areaName: "Indiranagar" });
  await as("ph-x", "/api/me", { handle: "ph-other", name: "Other", areaName: "Indiranagar" });
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==".repeat(2);
  assert.equal((await raw("ph-s", "/api/offers/photo", { image: png, mimeType: "image/gif" })).status, 400, "photos only");
  const r = await as("ph-s", "/api/offers/photo", { image: png, mimeType: "image/png", caption: "Brass desk lamp, ₹450" });
  assert.match(r.text, /Brass desk lamp/); assert.match(r.text, /₹450/, "the caption's own price is kept");
  assert.equal(r.photo.stored, "doc", "no bucket configured: kept in the database");
  assert.equal((await fetch(B + r.photo.url)).status, 404, "not served until it's on a public listing");
  const f = await as("ph-s", "/api/facts", { tier: "public", text: "Brass desk lamp for sale in Indiranagar, ₹450 each", photoId: r.photo.id });
  assert.equal(f.offer.photo, r.photo.url, "on the listing");
  const served = await fetch(B + r.photo.url);
  assert.equal(served.status, 200); assert.equal(served.headers.get("content-type"), "image/png");
  assert.equal((await raw("ph-s", "/api/facts", { tier: "public", text: "Steel water bottles for sale in Indiranagar, ₹400 each", photoId: "../x" })).status, 200, "a bad photo id is ignored, not a 500");
  assert.equal((await as("ph-x", "/api/people/ph-shop")).shop.find((i: any) => i.factId === f.id).photo, r.photo.url, "buyers see it on the shop card");
  const stolen = await as("ph-x", "/api/facts", { tier: "public", text: "Steel water bottles for sale in Indiranagar, ₹400 each", photoId: r.photo.id });
  assert.equal(stolen.offer?.photo, undefined, "someone else's photo can't be attached");
  await as("ph-s", `/api/facts/${f.id}/delete`, {});
  assert.equal((await fetch(B + r.photo.url)).status, 404, "deleting the listing deletes its photo");
});

test("shop insights: demand you missed (beyond stock, turned away), prices agreed, buyers — other people only as counts", async () => {
  await as("si-s", "/api/me", { handle: "si-shop", name: "Insight Shop", areaName: "Indiranagar" });
  await as("si-b", "/api/me", { handle: "si-buyer", name: "Buyer One", areaName: "Indiranagar" });
  const f = await as("si-s", "/api/facts", { tier: "public", text: "Steel water bottles 500 ml for sale in Indiranagar, ₹400 each" });
  await as("si-s", "/api/resources", { factId: f.id, type: "quantity", onHand: 3 });
  assert.equal((await raw("si-b", "/api/people/si-shop/order", { offerFactId: f.id, quantity: 20 })).status, 409, "more than in stock");
  const i = await as("si-s", "/api/shop/insights");
  assert.deepEqual({ ...i.missed[0], item: undefined }, { item: undefined, wanted: 20, had: 3, people: 1 }); assert.match(i.missed[0].item, /steel water/i);
  assert.ok(Array.isArray(i.summary) && i.summary.length >= 1, "a summary line to act on");
  assert.ok(i.summary.every((l: string) => (l.match(/\d+/g) ?? []).every(n => ["20", "3", "500"].includes(n) || JSON.stringify(i).includes(n))), "no invented numbers");
  assert.ok(!JSON.stringify(i).includes("si-b") && !JSON.stringify(i).includes("Buyer One"), "no buyer ids or names");
  assert.equal(i.buyers.total, 0);
});

test("deleting an account: the agent stops, what they kept is gone, the handle is free; the other side keeps the conversation", async () => {
  await as("del-a", "/api/me", { handle: "del-anu", name: "Anu", areaName: "Indiranagar" });
  await as("del-b", "/api/me", { handle: "del-bo", name: "Bo", areaName: "Indiranagar" });
  const f = await as("del-a", "/api/facts", { tier: "public", text: "Steel water bottles 500 ml for sale in Indiranagar, ₹400 each" });
  await as("del-a", "/api/facts", { tier: "private", text: "Gate code 4471" });
  const e = await as("del-b", "/api/people/del-anu/ask", { text: "Is it available?", offerFactId: f.id });
  const start = await as("del-a", "/api/start");
  assert.ok(Array.isArray(start.ideas));
  const r = await as("del-a", "/api/me/delete", {});
  assert.equal(r.ok, true); assert.ok(r.removed.facts >= 2);
  assert.equal((await raw("del-b", "/api/people/del-anu")).status, 404, "the handle is free");
  assert.equal((await as("del-a", "/api/facts")).length, 0, "nothing kept");
  const theirs = await as("del-b", `/api/engagements/${e.id}`);
  assert.equal(theirs.phase, "closed"); assert.match(theirs.events.at(-1).text, /closed their account/);
  await as("del-c", "/api/me", { handle: "del-anu", name: "New Anu", areaName: "Indiranagar" });
});
