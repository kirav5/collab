// "Did you get it?": a buyer who paid and didn't get it reports it, the seller is told and can answer, and only a
// report still standing after the reply window shows on the seller's record — counted per buyer, never with notes,
// names or prices. End to end against the real server (reply window and wait set to zero so reports open and stand at
// once), then the pure rules with an explicit clock and policy: when a report opens, who may file one, which count,
// what status each has, the public counts, and the cron's one question.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { memoryDocs } from "../src/docs.ts";
import { DEFAULT_POLICY } from "../src/config/policy.ts";
import { ENGAGEMENTS } from "../src/core/engage.ts";
import { REPORTS, askDidYouGetIt, canReport, countsFor, reportStatus, reportWindow, reportsAgainst } from "../src/core/reports.ts";
import type { Engagement } from "../src/core/model.ts";

// Its own range: scenarios 9000–9099, analytics 9100–9199, hiring 9300–9399, appcheck-modes 9400–9799.
const PORT = 9200 + Math.floor(Math.random() * 100);
const B = `http://localhost:${PORT}`;
let server: ChildProcess;

before(async () => {
  server = spawn(process.execPath, ["src/server.ts"], { cwd: new URL("..", import.meta.url).pathname, stdio: "pipe",
    env: { ...process.env, PORT: String(PORT), STORE: "memory", DEV_AUTH: "1", GEMINI_FAKE: "1", GEMINI_API_KEY: "", PUBLIC_URL: B,
      POLICY_JSON: JSON.stringify({ reports: { waitHours: 0, replyHours: 0, minAccountDays: 0, perDay: 3 } }) } });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${B}/health`)).ok) return; } catch { /* starting */ } await new Promise(r => setTimeout(r, 200)); }
  throw new Error("server didn't start");
});
after(() => { server.kill(); });

const send = (token: string, path: string, body?: unknown) => fetch(B + path, { method: body === undefined ? "GET" : "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
async function ok(r: Response, path: string) {
  const data = await r.json();
  if (!r.ok) throw Object.assign(new Error(`${path}: ${r.status} ${JSON.stringify(data)}`), { status: r.status, data });
  return data;
}
const raw = (uid: string, path: string, body?: unknown) => send(`dev:${uid}`, path, body);
const as = async (uid: string, path: string, body?: unknown) => ok(await raw(uid, path, body), path);
/** A guest: signed in anonymously, never linked to Google. */
const asGuest = async (id: string, path: string, body?: unknown) => ok(await send(`dev-anon:${id}`, path, body), path);
type Call = (path: string, body?: unknown) => Promise<any>;
const by = (uid: string): Call => (path, body) => as(uid, path, body);
const record = async (handle: string) => (await fetch(`${B}/public/people/${handle}/record`)).json();
/** Waits until the clock (whole seconds) is past `at`, so the next step comes after a deadline of `at`. */
const pastSecond = async (at: number) => { while (Math.floor(Date.now() / 1000) <= at) await new Promise(r => setTimeout(r, 50)); };

/** A shop with one listing (tracked stock unless `stock` is null); returns the listing's id. */
async function shop(uid: string, handle: string, stock: number | null = 20) {
  await as(uid, "/api/me", { handle, name: `Shop ${handle}`, areaName: "Indiranagar" });
  const f = await as(uid, "/api/facts", { tier: "public", text: "Steel water bottles 500 ml for sale in Indiranagar, ₹437 each" });
  if (stock !== null) await as(uid, "/api/resources", { factId: f.id, type: "quantity", onHand: stock });
  return f.id as string;
}
/** A teacher with lessons at set times (in one, two and three days); returns the listing and its times. */
async function lessons(uid: string, handle: string) {
  await as(uid, "/api/me", { handle, name: `Teacher ${handle}`, areaName: "Indiranagar" });
  const f = await as(uid, "/api/facts", { tier: "public", text: "Guitar lessons for sale in Indiranagar, ₹800 each" });
  const t = Math.floor(Date.now() / 1000);
  const r = await as(uid, "/api/resources", { factId: f.id, type: "slots", slots: [1, 2, 3].map(d => ({ start: t + d * 86_400, end: t + d * 86_400 + 3600, capacity: 1 })) });
  return { fact: f.id as string, slots: r.slots as { id: string; start: number; end: number }[] };
}
/** The buyer orders one from the shop's card (at a time, for a booking) and the shop confirms: an agreed, unpaid deal. */
async function deal(buyer: Call, seller: string, handle: string, factId: string, slotId?: string) {
  const e = await buyer(`/api/people/${handle}/order`, { offerFactId: factId, quantity: 1, ...(slotId ? { slotId } : {}) });
  const c = ((await as(seller, "/api/inbox")) as any[]).find(i => i.engagementId === e.id && i.kind === "confirm");
  await as(seller, `/api/inbox/${c.id}`, { confirm: true });
  const agreed = await buyer(`/api/engagements/${e.id}`);
  assert.equal(agreed.phase, "agreed");
  return agreed;
}
/** An agreed deal, paid in the app (test mode). */
const paid = async (buyer: Call, seller: string, handle: string, factId: string, slotId?: string) => buyer(`/api/engagements/${(await deal(buyer, seller, handle, factId, slotId)).id}/pay`, {});

test("paid in the app and never handed over: the buyer reports it, and it stands on the seller's record without notes, names or prices", async () => {
  const fact = await shop("rv-s", "ravi-shop");
  await as("asha", "/api/me", { handle: "asha-b", name: "Asha Buyer", areaName: "Indiranagar" });
  const config = await (await fetch(`${B}/api/config`)).json();
  assert.equal(config.reports.waitHours, 0); assert.equal(config.reports.warnAt, 2, "the default warning threshold");
  const e = await paid(by("asha"), "rv-s", "ravi-shop", fact);
  assert.equal(e.payment.status, "paid");
  assert.ok(e.askAt >= e.payment.paidAt, "the cron will ask the buyer \"Did you get it?\"");
  const r = await as("asha", `/api/engagements/${e.id}/report`, { reason: "not_received", note: "Waited two hours, nobody came" });
  assert.equal(r.fulfilment.state, "disputed");
  assert.equal(r.fulfilment.report.reason, "not_received"); assert.equal(r.fulfilment.report.counts, true);
  assert.equal(r.fulfilment.report.payment, "in_app");
  assert.equal(r.fulfilment.report.replyBy, r.fulfilment.report.at, "no reply window in this test's policy");
  assert.equal(r.events.at(-1).text, "Says they paid and didn't get it: “Waited two hours, nobody came”");
  assert.equal(r.outcome?.requester, undefined, "a report doesn't set the outcome");
  // One per deal.
  const again = await raw("asha", `/api/engagements/${e.id}/report`, { reason: "not_received" });
  assert.equal(again.status, 409); assert.equal((await again.json()).error, "You've already reported this deal.");
  const rec = await record("ravi-shop");
  assert.equal(rec.reports.notReceived, 1); assert.equal(rec.problems, 1);
  assert.deepEqual(rec.recent[0].report, { reason: "not_received", status: "unanswered", reply: null, passScanned: false });
  assert.match(rec.memberSince, /^\d{4}-\d{2}$/);
  // (Fingerprints and timestamps are random-looking: left out, so a "437" inside one can't fail this.)
  const text = JSON.stringify({ ...rec, since: null, recent: rec.recent.map(({ receipt: _r, ...x }: any) => x) });
  assert.ok(!/Waited|nobody came|Asha|asha|437|fraud|scam/i.test(text), `no note, buyer or price in public: ${text}`);
  assert.equal((await as("asha", "/api/people/ravi-shop")).stats.notReceived, 1, "on the shop card (and so on match cards)");
  const card = await (await fetch(`${B}/a2a/ravi-shop/.well-known/agent-card.json`)).json();
  assert.match(card.description, /1 buyer says they paid and didn't get it \(no reply from the seller\)/);
  assert.ok(!/fraud|scam/i.test(card.description));
});

test("money first: nothing paid, nothing to report — and an unpaid walk-away isn't held against the seller", async () => {
  const fact = await shop("mf-s", "mf-shop", null);
  await as("mf-b", "/api/me", { handle: "mf-b", name: "MF Buyer", areaName: "Indiranagar" });
  const e = await deal(by("mf-b"), "mf-s", "mf-shop", fact);
  for (const [path, body] of [["report", { reason: "not_received" }], ["received", { ok: false }]] as const) {
    const r = await raw("mf-b", `/api/engagements/${e.id}/${path}`, body);
    assert.equal(r.status, 409, path); assert.equal((await r.json()).code, "NOT_PAID", path);
  }
  await as("mf-b", `/api/engagements/${e.id}/outcome`, { happened: false });
  const rec = await record("mf-shop");
  assert.equal(rec.sales, 1); assert.equal(rec.problems, 0, "fell through before anything was paid: not a problem on the seller");
});

test("a guest's report reaches the seller, who can still reply, but doesn't count on the public record", async () => {
  const fact = await shop("gs-s", "gs-shop");
  await asGuest("g1", "/api/me", { handle: "guest-g1", name: "Guest One", areaName: "Indiranagar" });
  const guest: Call = (path, body) => asGuest("g1", path, body);
  const e = await paid(guest, "gs-s", "gs-shop", fact);
  const r = await guest(`/api/engagements/${e.id}/report`, { reason: "not_received" });
  assert.equal(r.fulfilment.state, "disputed");
  assert.equal(r.fulfilment.report.counts, false); assert.equal(r.fulfilment.report.notCounted, "guest");
  const rec = await record("gs-shop");
  assert.equal(rec.reports.notReceived, 0); assert.equal(rec.recent[0].report, null); assert.equal(rec.problems, 0);
  const replied = await as("gs-s", `/api/engagements/${e.id}/report/reply`, { says: "handed_over" });
  assert.equal(replied.fulfilment.report.reply.says, "handed_over");
});

test("counted once per buyer: two reports from one buyer are one, a second buyer makes two", async () => {
  const fact = await shop("db-s", "db-shop");
  for (const u of ["db-1", "db-2"]) await as(u, "/api/me", { handle: u, name: `Buyer ${u}`, areaName: "Indiranagar" });
  for (const _ of [1, 2]) { const e = await paid(by("db-1"), "db-s", "db-shop", fact); await as("db-1", `/api/engagements/${e.id}/report`, { reason: "not_received" }); }
  assert.equal((await record("db-shop")).reports.notReceived, 1);
  const e = await paid(by("db-2"), "db-s", "db-shop", fact);
  await as("db-2", `/api/engagements/${e.id}/report`, { reason: "not_received" });
  const rec = await record("db-shop");
  assert.equal(rec.reports.notReceived, 2); assert.equal(rec.problems, 2, "a buyer's reports count once, however many orders");
  assert.equal(rec.recent.filter((x: any) => x.problem).length, 3, "each sale's row still shows it");
  assert.equal((await as("db-1", "/api/people/db-shop")).stats.notReceived, 2);
});

test("the seller replies once; a reply after the deadline is shown to the buyer but the report still stands; the words stay private", async () => {
  const fact = await shop("sr-s", "sr-shop");
  await as("sr-b", "/api/me", { handle: "sr-b", name: "SR Buyer", areaName: "Indiranagar" });
  const e = await paid(by("sr-b"), "sr-s", "sr-shop", fact);
  const r = await as("sr-b", `/api/engagements/${e.id}/report`, { reason: "not_received" });
  assert.equal((await raw("sr-b", `/api/engagements/${e.id}/report/reply`, { says: "handed_over" })).status, 403, "only the seller replies");
  assert.equal((await raw("sr-s", `/api/engagements/${e.id}/report/reply`, { says: "maybe" })).status, 400);
  await pastSecond(r.fulfilment.report.replyBy);
  const replied = await as("sr-s", `/api/engagements/${e.id}/report/reply`, { says: "handed_over", note: "came at 5" });
  assert.deepEqual({ ...replied.fulfilment.report.reply, at: 0 }, { says: "handed_over", note: "came at 5", at: 0 });
  assert.equal(replied.events.at(-1).text, "Says they handed it over: “came at 5”");
  const twice = await raw("sr-s", `/api/engagements/${e.id}/report/reply`, { says: "refunded" });
  assert.equal(twice.status, 409); assert.match((await twice.json()).error, /already replied/);
  const rec = await record("sr-shop");
  assert.equal(rec.recent[0].report.status, "unanswered", "replied after the deadline: it still stands as unanswered");
  assert.equal(rec.recent[0].report.reply, "handed_over");
  const text = JSON.stringify(rec);
  assert.ok(text.includes("handed_over") && !text.includes("came at 5"), "the answer is public, the words aren't");
  // "Never paid" doesn't fit a payment made in the app.
  const other = await paid(by("sr-b"), "sr-s", "sr-shop", fact);
  await as("sr-b", `/api/engagements/${other.id}/report`, { reason: "not_received" });
  const never = await raw("sr-s", `/api/engagements/${other.id}/report/reply`, { says: "never_paid" });
  assert.equal(never.status, 409); assert.match((await never.json()).error, /paid in the app/);
});

test("the buyer takes a report back (got it after all, or by \"received\"), or closes it on a refund the seller said they made", async () => {
  const fact = await shop("wr-s", "wr-shop");
  await as("wr-b", "/api/me", { handle: "wr-b", name: "WR Buyer", areaName: "Indiranagar" });
  const a = await paid(by("wr-b"), "wr-s", "wr-shop", fact);
  await as("wr-b", `/api/engagements/${a.id}/report`, { reason: "not_received" });
  assert.equal((await record("wr-shop")).reports.notReceived, 1);
  assert.equal((await raw("wr-s", `/api/engagements/${a.id}/report/settle`, { how: "got_it" })).status, 403, "only the buyer takes it back");
  const back = await as("wr-b", `/api/engagements/${a.id}/report/settle`, { how: "got_it" });
  assert.equal(back.fulfilment.state, "accepted"); assert.equal(back.fulfilment.report.end.how, "withdrawn");
  assert.equal(back.outcome.requester, "happened");
  assert.equal((await record("wr-shop")).reports.notReceived, 0, "withdrawn: off the record");
  // The old "received" button does the same.
  const b = await paid(by("wr-b"), "wr-s", "wr-shop", fact);
  await as("wr-b", `/api/engagements/${b.id}/report`, { reason: "not_received" });
  const received = await as("wr-b", `/api/engagements/${b.id}/received`, { ok: true });
  assert.equal(received.fulfilment.state, "accepted"); assert.equal(received.fulfilment.report.end.how, "withdrawn");
  // A refund closes it only once the seller said they refunded.
  const c = await paid(by("wr-b"), "wr-s", "wr-shop", fact);
  await as("wr-b", `/api/engagements/${c.id}/report`, { reason: "not_received" });
  assert.equal((await raw("wr-b", `/api/engagements/${c.id}/report/settle`, { how: "refunded" })).status, 409, "nobody said it was refunded");
  await as("wr-s", `/api/engagements/${c.id}/report/reply`, { says: "refunded" });
  const sales = (await record("wr-shop")).sales;
  const refunded = await as("wr-b", `/api/engagements/${c.id}/report/settle`, { how: "refunded" });
  assert.equal(refunded.fulfilment.state, "cancelled"); assert.equal(refunded.fulfilment.note, "Refunded");
  assert.equal((await record("wr-shop")).sales, sales - 1, "refunded: no longer a sale, and neutral");
  assert.equal((await raw("wr-b", `/api/engagements/${c.id}/report/settle`, { how: "got_it" })).status, 409, "closed once");
});

test("a few reports a day per account", async () => {
  const fact = await shop("rl-s", "rl-shop");
  await as("rl-b", "/api/me", { handle: "rl-b", name: "RL Buyer", areaName: "Indiranagar" });
  for (let i = 0; i < 3; i++) { const e = await paid(by("rl-b"), "rl-s", "rl-shop", fact); await as("rl-b", `/api/engagements/${e.id}/report`, { reason: "not_received" }); }
  const fourth = await paid(by("rl-b"), "rl-s", "rl-shop", fact);
  assert.equal((await raw("rl-b", `/api/engagements/${fourth.id}/report`, { reason: "not_received" })).status, 429);
});

test("locks: no \"it fell through\" once paid, nothing handed over before payment, and a reported deal's pass is paused", async () => {
  const fact = await shop("lk-s", "lk-shop");
  await as("lk-b", "/api/me", { handle: "lk-b", name: "LK Buyer", areaName: "Indiranagar" });
  const inApp = await paid(by("lk-b"), "lk-s", "lk-shop", fact);
  assert.equal((await raw("lk-b", `/api/engagements/${inApp.id}/outcome`, { happened: false })).status, 409, "paid in the app");
  const cash = await deal(by("lk-b"), "lk-s", "lk-shop", fact);
  assert.equal((await raw("lk-s", `/api/engagements/${cash.id}/delivered`, {})).status, 409, "not paid yet: nothing to hand over");
  await as("lk-b", `/api/engagements/${cash.id}/paid-outside`, {});
  await as("lk-s", `/api/engagements/${cash.id}/payment-check`, { got: true });
  assert.equal((await raw("lk-b", `/api/engagements/${cash.id}/outcome`, { happened: false })).status, 409, "paid in cash, confirmed");
  const code = (await as("lk-b", `/api/engagements/${inApp.id}/pickup`)).path.split(".html#")[1].split(".")[1];
  await as("lk-b", `/api/engagements/${inApp.id}/report`, { reason: "not_received" });
  const collect = await raw("lk-s", `/api/pickup/${inApp.id}/collect`, { code });
  assert.equal(collect.status, 409); assert.match((await collect.json()).error, /report open/);
  assert.equal((await (await fetch(`${B}/public/pickup/${inApp.id}?code=${code}`)).json()).paused, true);
});

test("the pass code is the buyer's: the seller sees the same pass without it", async () => {
  const fact = await shop("pc-s", "pc-shop");
  await as("pc-b", "/api/me", { handle: "pc-b", name: "PC Buyer", areaName: "Indiranagar" });
  const e = await paid(by("pc-b"), "pc-s", "pc-shop", fact);
  const mine = await as("pc-b", `/api/engagements/${e.id}/pickup`);
  assert.match(mine.path, /^\/pickup\.html#/);
  const theirs = await as("pc-s", `/api/engagements/${e.id}/pickup`);
  assert.equal(theirs.path, null);
  assert.equal(theirs.item, mine.item); assert.deepEqual(theirs.amount, mine.amount); assert.equal(theirs.paused, false);
});

test("cash or UPI the buyer says they paid: no pass and no stock taken until the seller confirms it arrived", async () => {
  const fact = await shop("cc-s", "cc-shop");
  await as("cc-b", "/api/me", { handle: "cc-b", name: "CC Buyer", areaName: "Indiranagar" });
  const e = await deal(by("cc-b"), "cc-s", "cc-shop", fact);
  const claimed = await as("cc-b", `/api/engagements/${e.id}/paid-outside`, {});
  assert.equal(claimed.payment.status, "outside"); assert.ok(claimed.payment.outsideClaim.at);
  assert.equal(claimed.reservation.state, "held", "the stock isn't taken on the buyer's word");
  assert.equal(claimed.outcome?.requester, undefined, "and nobody's outcome is set by it");
  assert.equal((await raw("cc-b", `/api/engagements/${e.id}/pickup`)).status, 400, "no pass yet");
  assert.equal((await raw("cc-b", `/api/engagements/${e.id}/paid-outside`, {})).status, 409, "marked once");
  assert.equal((await raw("cc-b", `/api/engagements/${e.id}/payment-check`, { got: true })).status, 403, "only the seller confirms");
  const confirmed = await as("cc-s", `/api/engagements/${e.id}/payment-check`, { got: true });
  assert.equal(confirmed.reservation.state, "committed"); assert.ok(confirmed.payment.confirmedAt);
  assert.ok(confirmed.askAt >= confirmed.payment.paidAt);
  const pass = await as("cc-b", `/api/engagements/${e.id}/pickup`);
  assert.equal(pass.markedBy, "buyer"); assert.ok(pass.path);
  assert.equal((await raw("cc-s", `/api/engagements/${e.id}/payment-check`, { got: true })).status, 409, "nothing left to confirm");
});

test("the seller says the cash never came: the deal goes back to unpaid, and a report on it shows as disputed", async () => {
  const fact = await shop("dn-s", "dn-shop");
  await as("dn-b", "/api/me", { handle: "dn-b", name: "DN Buyer", areaName: "Indiranagar" });
  const e = await deal(by("dn-b"), "dn-s", "dn-shop", fact);
  await as("dn-b", `/api/engagements/${e.id}/paid-outside`, {});
  const denied = await as("dn-s", `/api/engagements/${e.id}/payment-check`, { got: false });
  assert.equal(denied.payment.status, "awaiting"); assert.ok(denied.payment.outsideClaim.deniedAt);
  assert.equal(denied.payment.paidAt, undefined);
  assert.ok(denied.reservation.expiresAt <= Math.floor(Date.now() / 1000) + DEFAULT_POLICY.timing.holdTtlSec, "back to the usual hold");
  const again = await raw("dn-b", `/api/engagements/${e.id}/paid-outside`, {});
  assert.equal(again.status, 409, "the seller's answer stands"); assert.match((await again.json()).error, /hasn't arrived/);
  const r = await as("dn-b", `/api/engagements/${e.id}/report`, { reason: "not_received" });
  assert.equal(r.fulfilment.report.payment, "outside_denied");
  assert.equal(r.fulfilment.report.reply.says, "never_paid", "the seller's denial is their answer");
  const rec = await record("dn-shop");
  assert.equal(rec.reports.notReceived, 0, "never shown as \"didn't get it\"");
  assert.equal(rec.reports.disputed, 1);
  assert.deepEqual(rec.recent[0].report, { reason: "not_received", status: "disputed", reply: "never_paid", passScanned: false });
});

test("a cash claim keeps the booked time until the seller answers, and can't be confirmed once the booking is cancelled", async () => {
  const { fact, slots } = await lessons("cb-s", "cb-shop");
  await as("cb-b", "/api/me", { handle: "cb-b", name: "CB Buyer", areaName: "Indiranagar" });
  const e = await deal(by("cb-b"), "cb-s", "cb-shop", fact, slots[0].id);
  const t = Math.floor(Date.now() / 1000);
  const claimed = await as("cb-b", `/api/engagements/${e.id}/paid-outside`, {});
  assert.equal(claimed.reservation.state, "held");
  assert.ok(claimed.reservation.expiresAt >= t + DEFAULT_POLICY.timing.decisionTtlSec, "held while the seller answers, not just the usual few minutes");
  // The seller cancels before answering: there's nothing left to confirm, and the time stays free.
  await as("cb-s", `/api/engagements/${e.id}/booking`, { action: "cancel" });
  for (const got of [true, false]) {
    const r = await raw("cb-s", `/api/engagements/${e.id}/payment-check`, { got });
    assert.equal(r.status, 409, String(got)); assert.match((await r.json()).error, /cancelled/);
  }
  const after = await as("cb-b", `/api/engagements/${e.id}`);
  assert.equal(after.reservation.state, "released"); assert.equal(after.payment.confirmedAt, undefined); assert.equal(after.askAt, undefined);
});

test("a seller who never answers a cash claim: once it was due, the buyer can still report it", async () => {
  const fact = await shop("na-s", "na-shop");
  await as("na-b", "/api/me", { handle: "na-b", name: "NA Buyer", areaName: "Indiranagar" });
  const e = await deal(by("na-b"), "na-s", "na-shop", fact);
  await as("na-b", `/api/engagements/${e.id}/paid-outside`, {});
  const r = await as("na-b", `/api/engagements/${e.id}/report`, { reason: "not_received" });
  assert.equal(r.fulfilment.state, "disputed"); assert.equal(r.fulfilment.report.payment, "outside_unconfirmed");
});

test("moving a paid booking moves \"Did you get it?\" to the new time", async () => {
  const { fact, slots } = await lessons("mv-s", "mv-shop");
  await as("mv-b", "/api/me", { handle: "mv-b", name: "MV Buyer", areaName: "Indiranagar" });
  const e = await paid(by("mv-b"), "mv-s", "mv-shop", fact, slots[0].id);
  assert.equal(e.askAt, slots[0].end, "asked once the booked time is over");
  const moved = await as("mv-b", `/api/engagements/${e.id}/booking`, { action: "move", slotId: slots[2].id });
  assert.equal(moved.reservation.slotId, slots[2].id); assert.equal(moved.askAt, slots[2].end);
});

test("said it fell through, then paid: paying means it went ahead, so nothing counts against the seller", async () => {
  const fact = await shop("ft-s", "ft-shop", null);
  await asGuest("g9", "/api/me", { handle: "guest-g9", name: "Guest Nine", areaName: "Indiranagar" });
  const guest: Call = (path, body) => asGuest("g9", path, body);
  const e = await deal(guest, "ft-s", "ft-shop", fact);
  await guest(`/api/engagements/${e.id}/outcome`, { happened: false });
  const p = await guest(`/api/engagements/${e.id}/pay`, {});
  assert.equal(p.payment.status, "paid"); assert.equal(p.outcome?.requester, undefined, "the earlier \"it fell through\" is dropped");
  const rec = await record("ft-shop");
  assert.equal(rec.problems, 0); assert.equal(rec.recent[0].problem, false);
});

// MARK: - The rules, with an explicit clock and policy

const T = 1_800_000_000, DAY = 86_400, P = DEFAULT_POLICY.reports;
/** A deal paid in the app at T: "buyer" (requester) bought from "seller" (provider). */
const fixture = (over: Record<string, unknown> = {}) => ({ id: "d1", phase: "agreed", requester: { uid: "buyer", handle: "b", name: "Buyer" },
  provider: { uid: "seller", handle: "s", name: "Seller" }, participants: ["buyer", "seller"], offer: { title: "Steel bottle · 500 ml" }, events: [],
  payment: { status: "paid", paidAt: T }, ...over }) as unknown as Engagement;

test("reportWindow: a day after paying (or the booked time's end), at once once handed over, for 30 days; nothing unpaid", () => {
  assert.deepEqual(reportWindow(fixture(), P), { from: T + DAY, until: T + 30 * DAY });
  assert.equal(reportWindow(fixture({ reservation: { slot: { start: T + 3 * DAY - 3600, end: T + 3 * DAY } } }), P)!.from, T + 3 * DAY, "a booking: the end of the slot");
  const D = T + 2 * DAY;
  assert.deepEqual(reportWindow(fixture({ fulfilment: { state: "delivered", deliveredAt: D } }), P), { from: D, until: D + 30 * DAY });
  const far = fixture({ reservation: { slot: { start: T + 45 * DAY - 3600, end: T + 45 * DAY } } });
  assert.deepEqual(reportWindow(far, P), { from: T + 45 * DAY, until: T + 75 * DAY }, "a booking far ahead: open for 30 days after its time");
  assert.deepEqual(canReport(far, "buyer", "not_received", T + 46 * DAY, P), { ok: true });
  assert.equal(reportWindow(fixture({ payment: { status: "awaiting" } }), P), null);
  assert.equal(reportWindow(fixture({ payment: { status: "awaiting", outsideClaim: { at: T - 100, deniedAt: T } } }), P)!.from, T - 100 + DAY, "a denied cash claim counts from the claim");
});

test("canReport: the buyer only, once it's due and not too late, and only on a deal that can still go wrong", () => {
  const due = T + DAY;
  assert.deepEqual(canReport(fixture(), "buyer", "not_received", due, P), { ok: true });
  assert.equal((canReport(fixture(), "seller", "not_received", due, P) as any).status, 403);
  const early = canReport(fixture(), "buyer", "not_received", T + 60, P) as any;
  assert.equal(early.code, "TOO_EARLY"); assert.equal(early.extra.reportFrom, T + DAY);
  assert.equal((canReport(fixture(), "buyer", "not_received", T + 31 * DAY, P) as any).code, "TOO_LATE");
  const asAgreed = canReport(fixture(), "buyer", "not_as_agreed", due, P) as any;
  assert.equal(asAgreed.status, 409); assert.match(asAgreed.message, /Nothing was handed over yet/);
  assert.deepEqual(canReport(fixture({ fulfilment: { state: "delivered", deliveredAt: T } }), "buyer", "not_as_agreed", T + 1, P), { ok: true });
  for (const over of [{ offerLetter: { status: "accepted" } }, { fulfilment: { state: "accepted" } }, { fulfilment: { state: "cancelled" } }, { noPayment: true }])
    assert.equal((canReport(fixture(over), "buyer", "not_received", due, P) as any).status, 409, JSON.stringify(over));
  assert.equal((canReport(fixture({ payment: { status: "awaiting" } }), "buyer", "not_received", due, P) as any).code, "NOT_PAID");
});

test("countsFor: demo sellers, oneself, guests and new accounts don't count publicly", () => {
  const google = { signIn: "google", createdAt: T - 30 * DAY };
  assert.deepEqual(countsFor(fixture({ provider: { uid: "demo-shop", handle: "d", name: "D" } }), google, T, P), { counts: false, notCounted: "demo" });
  assert.deepEqual(countsFor(fixture({ provider: { uid: "buyer", handle: "b", name: "B" } }), google, T, P), { counts: false, notCounted: "self" });
  assert.deepEqual(countsFor(fixture(), { signIn: "anonymous", createdAt: T - 30 * DAY }, T, P), { counts: false, notCounted: "guest" });
  assert.deepEqual(countsFor(fixture(), { signIn: "google", createdAt: T - 2 * DAY }, T, { ...P, minAccountDays: 7 }), { counts: false, notCounted: "new_account" });
  assert.deepEqual(countsFor(fixture(), google, T, P), { counts: true });
});

test("reportStatus: open until the reply deadline, then unanswered or (answered in time) disputed; closed once ended", () => {
  const r = { replyBy: T };
  assert.equal(reportStatus(r, T - 1), "open");
  assert.equal(reportStatus(r, T), "unanswered");
  assert.equal(reportStatus({ ...r, reply: { says: "handed_over" as const, at: T } }, T + 1), "disputed");
  assert.equal(reportStatus({ ...r, reply: { says: "handed_over" as const, at: T - DAY } }, T + 1), "disputed");
  assert.equal(reportStatus({ ...r, reply: { says: "handed_over" as const, at: T + 1 } }, T + 2), "unanswered", "a late reply doesn't change the record");
  assert.equal(reportStatus({ ...r, end: { how: "withdrawn" as const, at: T } }, T + DAY), "closed");
});

test("reportsAgainst: distinct buyers, only counted, standing and recent reports, split by what they say", async () => {
  const db = memoryDocs(), now = T + 10 * DAY;
  const add = (id: string, buyer: string, over: Record<string, unknown> = {}) => db.set(REPORTS, id, { schemaVersion: 1, id, engagementId: id, seller: "s1", buyer,
    reason: "not_received", at: T, replyBy: T + 3 * DAY, payment: "in_app", counts: true, item: "Steel bottle", month: "2027-01", ...over });
  await add("a", "b1"); await add("b", "b1"); // one buyer, two deals: counted once
  await add("c", "b2", { reason: "not_as_agreed" });
  await add("d", "b3", { reply: { says: "handed_over", at: T + DAY } });
  await add("e", "b4", { counts: false, notCounted: "guest" });
  await add("f", "b5", { end: { how: "withdrawn", at: T + DAY } });
  await add("g", "b6", { at: now - DAY, replyBy: now + 2 * DAY }); // still open
  await add("h", "b7", { at: now - 400 * DAY, replyBy: now - 397 * DAY }); // older than a year
  await add("i", "b8", { seller: "s2" });
  const r = await reportsAgainst(db, "s1", now, P);
  assert.deepEqual({ ...r, byEngagement: undefined }, { notReceived: 1, notAsAgreed: 1, disputed: 1, days: 365, byEngagement: undefined });
  assert.deepEqual([...r.byEngagement.keys()].sort(), ["a", "b", "c", "d", "e", "f", "g", "h"], "every report against them, for each sale's row");
});

test("askDidYouGetIt: asks the buyer once when a paid deal's window opens with nothing handed over, and clears every due ask", async () => {
  const db = memoryDocs(), pushes: unknown[][] = [];
  const push = (...a: unknown[]) => { pushes.push(a); };
  await db.set(ENGAGEMENTS, "a", fixture({ id: "a", askAt: T, fulfilment: { state: "not_started" } }));
  await db.set(ENGAGEMENTS, "b", fixture({ id: "b", askAt: T, fulfilment: { state: "delivered", deliveredAt: T } }));
  await db.set(ENGAGEMENTS, "c", fixture({ id: "c", askAt: T, fulfilment: { state: "disputed" } }));
  await db.set(ENGAGEMENTS, "d", fixture({ id: "d", fulfilment: { state: "not_started" } })); // from before asks: nothing to do
  await db.set(ENGAGEMENTS, "e", fixture({ id: "e", askAt: T + DAY, fulfilment: { state: "not_started" } })); // not due yet
  assert.equal(await askDidYouGetIt(db, T + 60, push), 1);
  assert.deepEqual(pushes, [["buyer", "Did you get it? · Steel bottle", "Tap to confirm — or report it if you didn't.", "/?engagement=a"]]);
  const a = await db.get(ENGAGEMENTS, "a");
  assert.equal(a.fulfilment.askedAt, T + 60); assert.ok(!("askAt" in a), "the key is removed, not set to null");
  for (const id of ["b", "c"]) { const x = await db.get(ENGAGEMENTS, id); assert.ok(!("askAt" in x), id); assert.equal(x.fulfilment.askedAt, undefined, id); }
  assert.equal((await db.get(ENGAGEMENTS, "e")).askAt, T + DAY);
  assert.equal(await askDidYouGetIt(db, T + 120, push), 0, "asked once");
  assert.equal(pushes.length, 1);
});
