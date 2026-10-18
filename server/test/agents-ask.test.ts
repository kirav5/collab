// Agents handle the routine; people are asked only when it's theirs to decide. Random buyer–seller conversations
// (seeded, so a failure replays) over every way in: ordering from a card at the listed price or below it, typing an
// offer in chat ("I'll take 12 at ₹400 each", "₹380", "3 for ₹1,000", "200rs"), answering the seller's agent's
// question with an amount, and a request matched to the seller — each with random stock, private limits and how far
// each owner lets their agent go. People answer what they're asked the way people do (confirm, take a counter, offer
// again, walk away). Every time a person is asked is recorded and judged against when asking is actually needed:
//   · an owner whose agent may close deals is never asked to confirm a deal inside their limit
//   · an owner who delegated a limit is never asked yes or no about a price outside it (their agent counters)
//   · nobody is asked to confirm their own offer before the other side answers it, or asked for a limit they gave
//   · a price typed by the buyer is never sent to the seller as a question to answer
//   · nobody has two open asks of the same kind in one conversation
// and every agreed deal is checked: the quantity the buyer asked for (or what was in stock, if they agreed to fewer),
// never more than was in stock, a cart for exactly quantity × price, and the pass for that many.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";

// Its own range: appcheck-modes picks from 9400–9799, scenarios 9000–9099, hiring 9300–9399, e2e 8800–8899.
const PORT = 8600 + Math.floor(Math.random() * 100);
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
  if (!r.ok) throw Object.assign(new Error(`${path}: ${r.status} ${JSON.stringify(data)}`), { status: r.status, data });
  return data;
}
// mulberry32: the same seed gives the same conversations.
function rng(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

type Autonomy = "none" | "negotiate" | "close";
interface Ask { run: number; path: string; side: "buyer" | "seller"; kind: string; question?: string; counter?: boolean; reason: string | null }

test("random conversations: agents handle the routine, people are asked only when it's theirs to decide, and every deal adds up", async () => {
  const R = rng(Number(process.env.ASK_SEED) || 20261016), pick = <T,>(xs: T[]) => xs[Math.floor(R() * xs.length)], int = (a: number, b: number) => a + Math.floor(R() * (b - a + 1));
  const ITEMS = ["brass lamps", "steel bottles", "cotton bags", "wooden chairs"];
  const PATHS = ["card-listed", "card-offer", "card-offer-max", "first-offer", "chat-offer", "answer-amount", "request"] as const;
  const asks: Ask[] = [], seen = new Set<string>(), problems: string[] = [];
  const outcomes: Record<string, number> = {};
  const RUNS = 70;

  for (let run = 0; run < RUNS; run++) {
    const seller = `ag-s${run}`, buyer = `ag-b${run}`, handle = `ag-shop-${run}`;
    await as(seller, "/api/me", { handle, name: `Shop ${run}`, areaName: "Indiranagar" });
    await as(buyer, "/api/me", { handle: `ag-buyer-${run}`, name: `Buyer ${run}`, areaName: "Indiranagar" });
    const item = pick(ITEMS), price = int(2, 20) * 50;
    const f = await as(seller, "/api/facts", { tier: "public", text: `${item[0].toUpperCase()}${item.slice(1)} for sale in Indiranagar, ₹${price} each` });
    assert.ok(f.offer, `run ${run}: the listing is read`);
    const stock = R() < 0.6 ? int(0, 30) : null;
    if (stock !== null) await as(seller, "/api/resources", { factId: f.id, type: "quantity", onHand: stock });
    let sAuto: Autonomy = pick(["none", "negotiate", "close"]);
    let floor = Math.round(price * (0.75 + R() * 0.2));
    if (sAuto !== "none") await as(seller, `/api/facts/${f.id}/limit`, { mandate: { price: { opening: price, limit: floor } }, autonomy: sAuto, days: 7 });
    // Some sellers say their rules in words: a floor, a close-at price, sometimes a most-per-buyer.
    let closeAt: number | null = null, cap: number | null = null;
    if (sAuto !== "none" && R() < 0.4) {
      closeAt = Math.round(floor + (price - floor) * R()); cap = R() < 0.5 ? int(3, 20) : null;
      const words = `Don't go below ₹${floor} each${cap ? `, max ${cap} per buyer` : ""}, and close deals yourself above ₹${closeAt}`;
      const read = await as(seller, "/api/rules/read", { text: words, side: "seller", factId: f.id });
      await as(seller, `/api/facts/${f.id}/rules`, { text: words, rules: read.rules });
      sAuto = "close";
    }
    const instant = R() < 0.25;
    if (instant) await as(seller, `/api/facts/${f.id}/policies`, { policies: [], instant: true });
    const path = pick([...PATHS]);
    // (Answering a question with an amount says no count: that path is for one.)
    const want = R() < 0.6 && path !== "answer-amount" ? int(2, 40) : 1;
    let bAuto: Autonomy = "none", bLimit = Math.round(price * (0.8 + R() * 0.3));
    const label = `run ${run} ${path} (stock ${stock ?? "untracked"}, want ${want}, seller ${sAuto}${instant ? "+instant" : ""} floor ${floor} of ${price}${closeAt != null ? ` close-at ${closeAt}` : ""}${cap ? ` cap ${cap}` : ""})`;
    const free = () => stock; // nothing else touches this listing's stock
    let e: any = null, refused = false;

    try {
      if (path === "card-listed" || path === "card-offer" || path === "card-offer-max") {
        const body: any = { offerFactId: f.id, quantity: want };
        if (path !== "card-listed") body.price = Math.round(price * (0.5 + R() * 0.5));
        if (path === "card-offer-max") { bLimit = Math.max(body.price, Math.round(price * (0.85 + R() * 0.2))); body.max = bLimit; bAuto = "close"; }
        e = await as(buyer, `/api/people/${handle}/order`, body);
      } else if (path === "first-offer") {
        const x = Math.round(price * (0.5 + R() * 0.5));
        e = await as(buyer, `/api/people/${handle}/ask`, { text: want > 1 ? `I'll take ${want} at ₹${x} each` : `I'll pay ₹${x}`, offerFactId: f.id });
      } else if (path === "chat-offer" || path === "answer-amount") {
        e = await as(buyer, `/api/people/${handle}/ask`, { text: "Is it available?", offerFactId: f.id });
        e = await as(buyer, `/api/engagements/${e.id}/run`, {});
        const x = Math.round(price * (0.5 + R() * 0.5));
        if (path === "answer-amount") {
          const q = ((await as(buyer, "/api/inbox")) as any[]).find(i => i.engagementId === e.id && i.kind === "answer");
          if (q) { seen.add(q.id); asks.push({ run, path, side: "buyer", kind: "answer", question: q.question, reason: null }); await as(buyer, `/api/inbox/${q.id}`, { text: `${x}rs` }); }
          else e = await as(buyer, `/api/engagements/${e.id}/ask`, { text: `${x}rs` });
        } else {
          const said = want > 1 ? pick([`I'll take ${want} at ₹${x} each`, `${want} for ₹${x * want}`, `I'll buy ${want} for ₹${x * want} in all`]) : pick([`₹${x}`, `I'll pay ₹${x}`, `${x}rs`]);
          e = await as(buyer, `/api/engagements/${e.id}/ask`, { text: said });
        }
      } else {
        bAuto = pick(["none", "negotiate", "close"]);
        const d = await as(buyer, "/api/briefs/draft", { text: `Need ${want > 1 ? want + " " : "a "}${item} in Indiranagar` });
        const s = await as(buyer, "/api/briefs", { need: d.draft.need, shared: d.draft.shared,
          ...(bAuto !== "none" ? { delegate: { mandate: { price: { opening: Math.round(bLimit * 0.85), limit: bLimit } }, autonomy: bAuto, days: 7 } } : {}) });
        [e] = await as(buyer, `/api/briefs/${s.brief.id}/engage`, { providers: [{ factId: f.id }] });
        e = await as(buyer, `/api/engagements/${e.id}/run`, {});
      }
    } catch (err: any) {
      // Refused only when more were asked for than the seller has.
      if (err.status === 409 && err.data?.code === "CAPACITY_UNAVAILABLE") {
        refused = true;
        if (!(stock !== null && want > stock) && !(stock === 0) && !(cap && want > cap)) problems.push(`${label}: refused for stock though ${stock} ≥ ${want}`);
        assert.equal(err.data.available, cap && want > cap && (stock === null || cap <= stock) ? cap : stock ?? undefined, `${label}: says what's there`);
      } else throw new Error(`${label}: ${err.message}`);
    }
    if (refused || !e) { outcomes.refused = (outcomes.refused ?? 0) + 1; continue; }

    // People answer what they're asked; each ask is judged when it appears.
    for (let step = 0; step < 14; step++) {
      e = await as(buyer, `/api/engagements/${e.id}`);
      if (["agreed", "closed", "declined"].includes(e.phase)) break;
      const items = [...((await as(buyer, "/api/inbox")) as any[]), ...((await as(seller, "/api/inbox")) as any[])].filter(i => i.engagementId === e.id);
      const fresh_ = items.filter(i => !seen.has(i.id));
      for (const i of fresh_) {
        seen.add(i.id);
        const side = i.owner === seller ? "seller" : "buyer", auto = side === "seller" ? sAuto : bAuto;
        const all = [...e.negotiation.requester, ...e.negotiation.provider], p = i.proposalId ? all.find((x: any) => x.id === i.proposalId) : e.negotiation.deal;
        const units = e.quantity > 1 ? e.quantity : 1;
        const lim = side === "buyer" ? (Math.abs(bLimit / units - price) < Math.abs(bLimit - price) ? bLimit / units : bLimit) : floor;
        const inside = p ? (side === "seller" ? p.price >= floor - 0.5 : p.price <= lim + 0.5) : null;
        const mineSide = side === "seller" ? "provider" : "requester";
        let reason: string | null = null;
        const pastCloseAt = side === "seller" ? closeAt == null || (p && p.price >= closeAt - 0.5) : true;
        if (i.kind === "confirm" && auto === "close" && inside && pastCloseAt && !(side === "buyer" && e.wanted && units < e.wanted)) reason = "confirm asked though the agent may close inside the limit";
        else if (i.kind === "confirm" && auto !== "none" && inside === false) reason = "yes/no asked about a price outside the delegated limit (the agent should counter)";
        else if (i.kind === "confirm" && e.negotiation.dealBy === mineSide && !e.negotiation.confirmed[mineSide === "provider" ? "requester" : "provider"] && e.negotiation.chatOffer) reason = "asked to confirm their own offer before the other side answered";
        else if (i.kind === "move" && !i.question && auto !== "none") reason = "asked for a limit already delegated";
        else if (i.kind === "move" && i.counter && auto !== "none") reason = "asked about a counter their agent could answer";
        else if (i.kind === "answer" && side === "seller" && /^\s*(?:₹|rs\.?)?\s*\d[\d,]*\s*(?:rs|rupees?)?\s*$/i.test(i.question ?? "")) reason = "the buyer's price sent to the seller as a question";
        else if (items.filter(x => x.owner === i.owner && x.kind === i.kind).length > 1) reason = "two open asks of the same kind";
        asks.push({ run, path, side, kind: i.kind, question: i.question, counter: !!i.counter, reason });
        if (process.env.ASK_TRACE && i.kind === "move" && i.question && !i.counter && !(globalThis as any).traced) {
          (globalThis as any).traced = true;
          console.log(`\nTRACE ${label}\n  ${e.events.map((x: any) => `[${x.who}] ${x.text}`).join("\n  ")}\n  limits: buyer ${bLimit} (${bAuto}) seller ${floor} (${sAuto})`);
        }
        if (reason) problems.push(`${label}: ${side} ${i.kind}${i.question ? ` "${i.question}"` : ""} — ${reason}${process.env.ASK_DEBUG ? `\n      ${e.events.slice(-8).map((x: any) => `[${x.who}] ${x.text}`).join("\n      ")}\n      deal ${JSON.stringify(p)} dealBy ${e.negotiation.dealBy} confirmed ${JSON.stringify(e.negotiation.confirmed)}` : ""}`);
      }
      if (!items.length) { e = await as(buyer, `/api/engagements/${e.id}/run`, {}); if (step > 2) break; continue; }
      for (const i of items) {
        const who = i.owner, r = R();
        try {
          if (i.kind === "confirm") await as(who, `/api/inbox/${i.id}`, r < 0.85 ? { confirm: true } : { decline: true });
          else if (i.kind === "answer") await as(who, `/api/inbox/${i.id}`, { text: "Tomorrow evening" });
          else if (i.kind === "move" && i.counter) {
            if (r < 0.2) { bLimit = Math.round(price * (0.85 + R() * 0.2)); bAuto = "close"; await as(who, `/api/engagements/${e.id}/delegate`, { limit: bLimit }); }
            else if (r < 0.6) await as(who, `/api/engagements/${e.id}/ask`, { text: `I'll buy it for ₹${i.counter.price}` });
            else if (r < 0.9) await as(who, `/api/engagements/${e.id}/ask`, { text: `I can do ₹${Math.round((i.counter.price + price * 0.7) / 2)}` });
            else await as(who, `/api/inbox/${i.id}`, { decline: true });
          } else if (i.kind === "move") {
            if (r < 0.15) await as(who, `/api/inbox/${i.id}`, { decline: true });
            else {
              // A person asked for their limit gives one (or changes it): their agent goes on with it.
              const sellerSide = who === seller, lp = i.listPrice ?? price;
              if (sellerSide) floor = Math.round(lp * 0.8); else bLimit = lp;
              await as(who, `/api/inbox/${i.id}`, { mandate: sellerSide ? { price: { opening: lp, limit: floor } } : { price: { opening: Math.round(lp * 0.8), limit: bLimit } } });
            }
          }
        } catch (err: any) {
          if (![404, 409].includes(err.status)) throw new Error(`${label}: answering ${i.kind}: ${err.message}`);
        }
      }
      e = await as(buyer, `/api/engagements/${e.id}/run`, {});
    }
    e = await as(buyer, `/api/engagements/${e.id}`);
    outcomes[e.phase] = (outcomes[e.phase] ?? 0) + 1;

    if (e.phase === "agreed") {
      const d = e.negotiation.deal, n = d.items?.length ? d.items.reduce((t: number, l: any) => t + l.quantity, 0) : d.terms?.quantity > 1 ? d.terms.quantity : 1;
      const total = d.items?.length ? d.items.reduce((t: number, l: any) => t + l.quantity * l.unitPrice, 0) : d.price * n;
      const expected = e.wanted ? e.quantity : want;
      if (n !== expected) problems.push(`${label}: agreed for ${n}, the buyer wanted ${expected}`);
      if (free() !== null && n > free()!) problems.push(`${label}: agreed for ${n} with ${free()} in stock`);
      if (cap && n > cap) problems.push(`${label}: agreed for ${n}, more than ${cap} per buyer`);
      if (closeAt != null && e.negotiation.confirmedBy?.provider === "mandate" && d.price < closeAt - 0.5) problems.push(`${label}: the agent agreed at ₹${d.price}, under the seller's close-at ₹${closeAt}`);
      if (e.payment?.cart?.total?.value !== total) problems.push(`${label}: cart ${e.payment?.cart?.total?.value} for a deal of ${total}`);
      if (stock !== null && e.reservation?.qty !== n) problems.push(`${label}: ${e.reservation?.qty} reserved for a deal of ${n}`);
      if (e.reservation?.state === "unavailable" && e.events.some((x: any) => x.text.startsWith("Ready to pay"))) problems.push(`${label}: "Ready to pay" though the units aren't there`);
      if (e.reservation?.state !== "unavailable") {
        await as(buyer, `/api/engagements/${e.id}/paid-outside`, {});
        await as(seller, `/api/engagements/${e.id}/payment-check`, { got: true });
        const pass = await as(buyer, `/api/engagements/${e.id}/pickup`);
        if (pass.quantity !== n) problems.push(`${label}: pass for ${pass.quantity}, deal for ${n}`);
      }
    }
  }

  // What people were asked, and how often an agent handled it alone.
  const by = (k: (a: Ask) => string) => Object.entries(asks.reduce((m, a) => ({ ...m, [k(a)]: (m[k(a)] ?? 0) + 1 }), {} as Record<string, number>)).map(([k, v]) => `${k}×${v}`).join(" ");
  console.log(`\n${RUNS} conversations · outcomes: ${Object.entries(outcomes).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(`asks: ${asks.length} (${(asks.length / RUNS).toFixed(2)} per conversation) · by side and kind: ${by(a => `${a.side}:${a.kind}`)}`);
  console.log(`by path: ${by(a => a.path)}`);
  console.log(`unneeded asks: ${asks.filter(a => a.reason).length}`);
  if (process.env.ASK_DEBUG) console.log(`questions asked: ${by(a => (a.kind === "answer" ? `${a.side}:"${a.question}"` : `${a.side}:${a.kind}${a.kind !== "move" ? "" : a.counter ? "(counter)" : a.question ? "(no deal in limit)" : "(needs limit)"}`))}`);
  for (const p of problems.slice(0, 25)) console.log("  ✗ " + p);
  assert.deepEqual(problems, [], `${problems.length} problems`);
});
