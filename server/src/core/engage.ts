// One engagement between a requester's agent and a provider's agent about one brief (Collab's Engagements): the same
// lifecycle for a flat, a lesson, a ride or a company's project. The agents talk in turns over A2A (a2a/*.ts carries
// the turns); this file is what each agent decides on its turn.
//
// Each agent acts only from what its owner allowed: the provider's agent answers from the provider's Public facts and
// the Protected facts the provider's rules give this requester (policy.ts decides which; nothing else is ever handed
// to the model), and the requester's agent answers from the brief and the requester's own shared facts. Anything
// else — a private fact, a private limit, a deal — goes to the owner's device (an inbox item), and the conversation
// waits for it. Every message that crosses passes the privacy wall.
import type { Model } from "../ai/gemini.ts";
import { decide } from "../ai/decide.ts";
import { type Docs, docId } from "../docs.ts";
import { AnswerTask, type Fact as AnswerFact, JudgeTask, offerFacts, savedKey } from "../market/answer.ts";
import { catalog, domain as domainOf } from "../market/domains.ts";
import { event } from "../log.ts";
import { type Context, NegotiateTask, acceptable, describe, line, moveKind } from "../market/negotiate.ts";
import { rolesFor, shortName, usualAsks, voiceFor } from "../market/roles.ts";
import { endOfDay, isApplication, letterDefaults, letterFrom, letterHash } from "./hiring.ts";
import type { OfferLetter } from "./model.ts";
import { type Mandate, type Proposal, currencyOf, moneyText, newId } from "../market/types.ts";
import { type PaymentMandate, buyerOf, cartFor, sellerFrom, sellerOf } from "./pay.ts";
import { policy, policyHash } from "../config/policy.ts";
import { CapacityError, available, availabilityText, certainty, hold, resourceFor } from "./resources.ts";
import { BudgetError, allocate, deallocate } from "./goals.ts";
import { linesOf, totalOf } from "./pay.ts";
import { dealItem } from "./direct.ts";
import type { Audit, Contact, DelegatedLimit, Engagement, Event, Fact, InboxItem, QA, SharedBrief, Side } from "./model.ts";
import { forProvider, forRequester, insights, recordDeal, registerReceipt, clearStats, trackRecord } from "./deals.ts";
import { matchSaved, savedAnswers } from "./memory.ts";
import { hasContact } from "../market/text.ts";
import { type Allowed, FACTS, PROFILES, allowedFor, shapeAnswer } from "./policy.ts";
import { GatherTask } from "./tasks.ts";
import { pushTo } from "./push.ts";
import { clean } from "./wall.ts";

export const ENGAGEMENTS = "engagements", INBOX = "inbox", LIMITS = "limits", AUDIT = "audit", CONTACTS = "contacts", ANSWERS = "answers";
const now = () => Math.floor(Date.now() / 1000);
const other = (s: Side): Side => (s === "requester" ? "provider" : "requester");

/** What travels in one A2A message, as its data part. */
export interface Turn {
  kind: "collab.turn/v1";
  from: Side;
  engagementId: string;
  brief?: SharedBrief;
  offerFactId?: string | null;
  /** The requester's opening line with the brief: an application, an enquiry or a booking request. */
  intro?: string;
  /** A hiring deal's offer letter, as issued (or as decided on). */
  offerLetter?: OfferLetter;
  questions?: { id: string; question: string }[];
  answers?: { id: string; question: string; answer: string }[];
  /** AP2: the buyer's signed payment mandate, delivered to the seller's agent. */
  payment?: PaymentMandate;
  /** Which capability (and version) this turn is for; an unsupported one gets a structured refusal. */
  capability?: { id: string; version?: string };
  /** AP2 v0.2: the buyer agent's Checkout and Payment Mandates (SD-JWT) for the seller agent's checkout. */
  ap2?: { checkout_mandate: string; payment_mandate: string; checkout_hash: string };
  /** Questions the other side's owner is being asked (the conversation waits for them). */
  pending?: string[];
  declined?: string[];
  proposal?: Proposal;
  accept?: string;
  confirm?: boolean;
  decline?: string;
  note?: string;
}

export class Refused extends Error {}
/** What the owner sent doesn't make sense as it is (a past start date, an empty change request): theirs to fix. */
export class Invalid extends Error {}

// MARK: - Storage helpers

export async function load(db: Docs, id: string): Promise<Engagement> {
  const e = (await db.get(ENGAGEMENTS, id)) as Engagement | null;
  if (!e) throw new Refused("engagement not found");
  return e;
}

// Model Armor's check on answers about to be shared (set by the server; absent in tests and offline).
let outgoingScreen: ((text: string) => Promise<{ flagged: boolean; reason?: string }>) | null = null;
export const setOutgoingScreen = (fn: typeof outgoingScreen) => { outgoingScreen = fn; };

// The agents' signing key (set by the server at start): AP2 mandates are signed per agent, like deal receipts.
let signer: ((uid: string, hash: string) => string) | null = null;
export const setSigner = (fn: (uid: string, hash: string) => string) => { signer = fn; };

/** Closes every open question and decision of a conversation, on both sides. */
export async function closeInbox(db: Docs, engagementId: string) {
  for (const i of (await db.find(INBOX, [["engagementId", "==", engagementId], ["status", "==", "open"]], 50)) as InboxItem[])
    await db.update(INBOX, i.id, (x: InboxItem | null) => (x ? { ...x, status: "done" } : null));
}

export async function save(db: Docs, e: Engagement) {
  e.updatedAt = now();
  // An ended conversation — or a deal that's done (received) — asks nobody anything: its open questions and decisions
  // close, on both sides (once).
  if ((e.phase === "closed" || e.phase === "declined" || e.fulfilment?.state === "accepted") && !e.inboxClosed) { e.inboxClosed = true; e.waiting = { requester: null, provider: null }; await closeInbox(db, e.id); }
  // The outbox flag is derived on every save, so a waiting turn can always be found by the recovery scan.
  e.outboxPending = !!e.outbox;
  e.outboxAt = e.outbox ? (e.outboxAt ?? now()) : null;
  // An agreed deal leaves no one waiting on a question or move from before it (the pass covers the handover).
  if (e.phase === "agreed" && !e.dealRecorded) {
    for (const i of (await db.find(INBOX, [["engagementId", "==", e.id], ["status", "==", "open"]], 50)) as InboxItem[])
      if (i.kind !== "confirm") await db.update(INBOX, i.id, (x: InboxItem | null) => (x ? { ...x, status: "done" } : null));
    for (const x of ["requester", "provider"] as Side[]) if (e.waiting[x] && e.waiting[x]!.kind !== "confirm") e.waiting[x] = null;
  }
  if (e.phase === "agreed" && !e.dealRecorded) { e.dealRecorded = true; e.sealedTaskId = e.taskId ?? null; await recordDeal(db, e, now()); await registerReceipt(db, e, now(), signer ?? undefined); await clearStats(db, e); 
    event("deal_agreed", { category: e.offer.category ?? "none", rounds: e.negotiation.requester.length + e.negotiation.provider.length, chat: e.offer.price == null }); }
  // Reservation: a deal on tracked stock holds the units for the policy's hold window (released if the deal ends,
  // committed when paid). Out of stock means the deal can't be paid; nothing is charged.
  if (e.phase === "agreed" && !e.reservation && e.offer.factId) await reserveFor(db, e);
  // Some deals don't settle in the app (a job's salary is paid by the employer as agreed): no cart, no pass — the
  // deal closes on the one paid marking it done (joined) and the one paying confirming it.
  if (e.phase === "agreed" && !e.payment && !rolesFor(e.offer.category).payInApp) e.noPayment = true;
  // AP2: once both owners confirmed, the seller's agent issues the cart the buyer pays against.
  if (e.phase === "agreed" && !e.payment && !e.noPayment && signer) {
    if (!e.seller && e.offer.price == null) e.seller = sellerInChat(e) ?? undefined;
    const cart = cartFor(e, signer, now());
    if (cart) { e.payment = { cart, status: "awaiting", mode: "test" }; if (e.reservation?.state !== "unavailable") say(e, agentOf(sellerOf(e)), `Ready to pay: ${moneyText({ amount: cart.total.value, currency: cart.total.currency, period: e.offer.unit })}.`, "rules"); }
  }
  await db.set(ENGAGEMENTS, e.id, e);
}

/** Deals agreed in a chat before sellers were recorded: who said they'd sell, from the message that offered it. */
function sellerInChat(e: Engagement): Side | null {
  for (let i = e.events.length - 1; i > 0; i--) {
    if (e.events[i].who !== "system" || !e.events[i].text.startsWith("Deal offered")) continue;
    const said = e.events[i - 1];
    return said.who === "requester" || said.who === "provider" ? sellerFrom(said.text, said.who) : null;
  }
  return null;
}

/** Shown to both sides when an agent hands a decision back to its owner: who is being asked, never that a limit exists
 *  or that the other side's offer is outside it. */
const checking = (e: Engagement, s: Side) => {
  const roles = rolesFor(e.offer.category);
  return `The ${s === sellerOf(e) ? roles.payee : roles.payer}'s agent is checking with ${shortName(e[s].name)}.`;
};
const say = (e: Engagement, who: Event["who"], text: string, by?: Event["by"]) => { e.events.push({ at: now(), who, text: text.slice(0, 600), ...(by ? { by } : {}) }); };
const agentOf = (s: Side): Event["who"] => (s === "requester" ? "requester_agent" : "provider_agent");
const by = (m: boolean): Event["by"] => (m ? "gemini" : "rules");
const uidOf = (e: Engagement, s: Side) => (s === "requester" ? e.requester.uid : e.provider.uid);

async function limitFor(db: Docs, e: Engagement, s: Side): Promise<DelegatedLimit | null> {
  const key = s === "provider" ? `fact:${e.offer.factId}` : `brief:${e.briefId}`;
  const l = (await db.get(LIMITS, key)) as DelegatedLimit | null;
  // "ask" rows are stored so the owner's devices share the limit; the agent itself still waits on the owner.
  const ok = l && l.owner === uidOf(e, s) && l.autonomy !== "ask" && !(l.expires && l.expires < now()) ? l : null;
  return ok ? { ...ok, mandate: unitMandate(e, s, ok.mandate) } : null;
}

// MARK: - How many

/** How many units this conversation is about: what the buyer asked for on the card, in the request or in chat. */
export const unitsOf = (e: Engagement) => (Number.isInteger(e.quantity) && e.quantity! > 1 ? e.quantity! : 1);

/** A proposal is for the conversation's quantity unless it lists its own items: a counter at a unit price — typed by
 *  a person or made by an agent — is for as many units as the buyer asked for. */
function sized(e: Engagement, p: Proposal): Proposal {
  if (p.items?.length) return p;
  const { quantity: _, ...terms } = p.terms ?? {};
  return { ...p, terms: unitsOf(e) > 1 ? { ...terms, quantity: unitsOf(e) } : terms };
}

/**
 * Agents negotiate a unit price. A buyer's limit for several units may be their total ("₹80,000 for 200 lamps"): one
 * that reads as a total — closer to the listed price once divided by the quantity — is divided by it.
 */
export function unitMandate(e: Engagement, s: Side, m: Mandate): Mandate {
  const n = unitsOf(e), list = e.offer.price;
  if (sellerOf(e) === s || n <= 1 || !list) return m;
  if (Math.abs(m.price.limit / n - list) >= Math.abs(m.price.limit - list)) return m;
  return { ...m, price: { opening: Math.round(m.price.opening / n), limit: Math.round(m.price.limit / n) } };
}

/** The unit price of a proposal (its lines' average when it has uneven ones). */
const unitPriceOf = (p: Proposal) => (p.items?.length ? p.items.reduce((t, l) => t + l.quantity * l.unitPrice, 0) / p.items.reduce((t, l) => t + l.quantity, 0) : p.price);
/** May this side's agent agree to the deal on its own? Only with "close", inside the limit, and — when the owner set
 *  one — at or above their close-at price (seller) or at or below it (buyer). */
function mayClose(l: DelegatedLimit | null, e: Engagement, s: Side, deal: Proposal | null): boolean {
  if (!l || !deal || l.autonomy !== "close" || !acceptable(deal, ctx(e, s, l.mandate))) return false;
  if (l.closeAt == null) return true;
  const u = unitPriceOf(deal);
  return s === sellerOf(e) ? u >= l.closeAt - 0.5 : u <= l.closeAt + 0.5;
}

/** An offer for more units than the seller has in tracked, confirmed stock — refused before anyone is asked. */
/** Fewer than asked can be had: out of stock, or (`byRule`) the seller's own per-buyer limit — which isn't missed demand. */
export class ShortStock extends Error { available: number; byRule: boolean; constructor(available: number, message: string, byRule = false) { super(message); this.available = available; this.byRule = byRule; } }
export async function inStock(db: Docs, e: Engagement): Promise<number | null> {
  if (!e.offer.factId) return null;
  const r = await resourceFor(db, e.offer.factId);
  return r?.type === "quantity" && certainty(r, now()) === "confirmed" ? available(r, now()) : null;
}

/** An owner's open decisions in this conversation that their agent has now taken (a confirm, or a counter to answer):
 *  closed, and no longer waited on. */
export async function doneConfirms(db: Docs, e: Engagement, s: Side) {
  const ids: string[] = [];
  for (const id of e.waiting[s]?.inbox ?? []) {
    const i = (await db.get(INBOX, id)) as InboxItem | null;
    if (i?.kind === "confirm" || (i?.kind === "move" && i.counter)) { ids.push(id); await db.update(INBOX, id, (x: InboxItem | null) => (x ? { ...x, status: "done" } : null)); }
  }
  const left = (e.waiting[s]?.inbox ?? []).filter(id => !ids.includes(id));
  e.waiting[s] = left.length ? { ...e.waiting[s]!, inbox: left } : null;
}

/** Whether a side has a device that can be asked (our users and demo people do; an outside A2A agent doesn't). */
// An owner who can be asked: a person, not an anonymous outside agent.
const hasOwner = (e: Engagement, s: Side) => { const u = uidOf(e, s); return !!u && !u.startsWith("anon:"); };

async function ask(db: Docs, e: Engagement, s: Side, item: Omit<InboxItem, "id" | "owner" | "engagementId" | "side" | "status" | "createdAt" | "title">): Promise<string> {
  // One request per decision: the same question, or the same deal to confirm, already open isn't asked again.
  const decision = item.kind === "confirm" || item.kind === "offer_letter" || item.kind === "offer";
  const proposalId = decision ? e.negotiation.deal?.id : undefined;
  for (const open of e.waiting[s]?.inbox ?? []) {
    const x = (await db.get(INBOX, open)) as InboxItem | null;
    if (x?.status === "open" && x.kind === item.kind && (decision ? x.proposalId === proposalId : item.qaId ? x.qaId === item.qaId : x.question === item.question)) return x.id;
  }
  const id = newId();
  const t = now();
  // An offer letter is open until the day it says; a deal to confirm lapses at the usual deadline; the rest wait.
  const deadline = item.kind === "offer" && e.offerLetter ? endOfDay(e.offerLetter.validUntil) : t + policy().timing.decisionTtlSec;
  await db.set(INBOX, id, { ...item, ...(proposalId ? { proposalId } : {}), deadline, onTimeout: item.kind === "confirm" || item.kind === "offer" ? "lapse" : "wait",
    id, owner: uidOf(e, s)!, engagementId: e.id, side: s, status: "open", title: e.title, createdAt: t } satisfies InboxItem);
  // A move the device makes on its own needs no one's attention; everything else notifies the owner.
  if (!(item.kind === "move" && !item.question)) {
    // Who and what, never the raw request text (it can carry a price): "Confirm your deal" · "Study table with Priya".
    const them = e[other(s)].name, thing = (e.offer.title || e.title).split(" · ")[0].slice(0, 60);
    const [title, body] = item.kind === "confirm" ? ["Confirm your deal", `${thing} with ${them}`]
      : item.kind === "offer_letter" ? ["Send the offer letter", `${thing} for ${them}`]
      : item.kind === "offer" ? ["An offer letter to decide on", `${thing} from ${them}`]
      : item.kind === "move" ? ["No deal within your limit yet", `${thing} with ${them} — your call`]
      : item.kind === "approve" ? ["Check an answer before it's shared", `${them} asked about ${thing}`]
      : [`${them} asked a question`, `About ${thing}. Tap to reply.`];
    void pushTo(uidOf(e, s)!, title, body, `/?engagement=${e.id}`);
  }
  e.waiting[s] = { kind: item.kind, inbox: [...(e.waiting[s]?.inbox ?? []), id], text: item.question ?? (item.kind === "move" ? "A negotiating move with your private limit"
    : item.kind === "offer_letter" ? "Send the offer letter" : item.kind === "offer" ? "Decide on the offer letter" : "Confirm the deal") };
  return id;
}

/** The buyer's confirmation must fit their goal's budget (allocated atomically); returns why not, or null. */
async function budgetCheck(db: Docs, e: Engagement, s: Side): Promise<string | null> {
  if (!e.goalId || s !== "requester" || sellerOf(e) === "requester" || !e.negotiation.deal) return null;
  try { await allocate(db, e.goalId, e.id, totalOf(linesOf(e)), currencyOf(e), now()); return null; }
  catch (err) { if (err instanceof BudgetError) return err.message; throw err; }
}
/** Gives a deal's share of its goal's budget back (it lapsed, was declined or fell through). */
export async function releaseBudget(db: Docs, e: Engagement) { if (e.goalId) await deallocate(db, e.goalId, e.id, now()); }

/** Holds the deal's units on the offering's ledger (if it has one); records the result on the conversation. */
export async function reserveFor(db: Docs, e: Engagement) {
  const r = await resourceFor(db, e.offer.factId!);
  if (!r) return;
  // A service with time slots: the buyer picks one (held when picked), before paying.
  if (r.type === "slots") {
    // The time picked on the seller's card is held at once if it's still free; otherwise the buyer picks again.
    const s = e.preferredSlotId ? r.slots.find(x => x.id === e.preferredSlotId) : null;
    if (s) {
      try {
        const h = await hold(db, r.id, { holder: e.requester.uid ?? "", engagementId: e.id, qty: 1, slotId: s.id, ttlSec: policy().timing.holdTtlSec }, now());
        e.reservation = { resourceId: r.id, holdId: h.id, qty: 1, state: "held", expiresAt: h.expiresAt, slotId: s.id, slot: { start: s.start, end: s.end } };
        say(e, "system", "Your time is held — pay to keep it.");
        return;
      } catch { say(e, "system", "The time you picked was taken meanwhile — pick another."); }
    }
    e.reservation = { resourceId: r.id, holdId: null, qty: 1, state: "choose_slot", expiresAt: null, slotId: null, slot: null }; say(e, "system", "Pick a time slot to book it."); return;
  }
  const qty = (e.negotiation.deal?.items?.reduce((n, l) => n + l.quantity, 0)) ?? (Number.isInteger(e.negotiation.deal?.terms?.quantity) && e.negotiation.deal!.terms.quantity > 1 ? e.negotiation.deal!.terms.quantity : 1);
  try {
    const h = await hold(db, r.id, { holder: e.requester.uid ?? "", engagementId: e.id, qty, ttlSec: policy().timing.holdTtlSec }, now());
    e.reservation = { resourceId: r.id, holdId: h.id, qty, state: "held", expiresAt: h.expiresAt };
    say(e, "system", `${qty} reserved until ${new Date(h.expiresAt * 1000).toISOString().slice(11, 16)} UTC — pay before then to keep it.`);
  } catch (err) {
    if (!(err instanceof CapacityError)) throw err;
    e.reservation = { resourceId: r.id, holdId: null, qty, state: "unavailable", expiresAt: null, reason: err.message };
    say(e, "system", `${err.message} The deal can't be paid until they restock; nothing was charged.`);
  }
}

/** For tests and other modules: ask an owner (deduplicated, with a deadline). */
export const askOwner = ask;

/** Names the wall replaces: the owner's contacts (other than the person they're talking to). */
async function wallNames(db: Docs, owner: string | null, keep: string): Promise<{ name: string; replacement: string }[]> {
  if (!owner) return [];
  return ((await db.find(CONTACTS, [["owner", "==", owner]], 300)) as Contact[]).filter(c => c.uid !== keep).map(c => ({ name: c.name, replacement: "a contact" }));
}

// MARK: - Answering from what's allowed

const asFacts = (allowed: Allowed[]): AnswerFact[] => allowed.map(a => ({ label: a.via ? `Shared with you (${a.fact.topics.join(", ")})` : "Public", value: a.fact.text }));

/** Which allowed fact an answer came from (by its evidence), for the audit and the rule's level of detail. */
function source(allowed: Allowed[], evidence: string[]): Allowed | null {
  const norm = (s: string) => s.toLowerCase().replace(/,/g, "").replace(/\s+/g, " ");
  return allowed.find(a => evidence.some(ev => norm(a.fact.text).includes(norm(ev)))) ?? null;
}

/** Questions about whether something is there now (stock, slots), which the ledger answers rather than the model. */
export const isStockQuestion = (q: string) => /\b(in stock|available|availability|stock|left|any (more|left)|slots?|book(ing)?|free (on|at))\b/i.test(q)
  || /\b(do|does|did|have|has|got|is|are)\b.*\b(have|got|stock|carry|sell)\b.*\b(today|now|right now|at the moment|currently)\b/i.test(q)
  || /\b(have|got)\s+(it|any|one|some|them)\b/i.test(q);

/** "What time suits you?", "when would you like to come?" — a question the slot picker answers when there are slots. */
export const isTimeQuestion = (q: string) => /\b(what|which) (time|day|date|slot)s?\b|\bwhen (would|do|can|could|will) you\b|\btime (suits|works)\b|\bpreferred (time|date|day|slot)\b/i.test(q);

/** "Last price?", "what's your floor?", "kam se kam kitna?" — asking for the limit the agent never says. */
export const isLimitProbe = (q: string) =>
  /\b(lowest|minimum|floor|least|bottom|rock[- ]bottom|last|final)\b[^?]{0,30}\b(price|rate|amount|offer|accept|take|go)\b/i.test(q)
  || /\b(last price|final price|best you can do|how low can you go)\b/i.test(q)
  || /\b(kam se kam|aakhri|last kitna|final kitna)\b/i.test(q);
/** Asking for a phone number, e-mail, WhatsApp or home address — never given out by an agent. */
export const isContactRequest = (q: string) =>
  /\b(phone|mobile|cell|whatsapp|contact)\s*(number|no\.?|details?)?\b|\b(e-?mail( id| address)?)\b|\bhome address\b|\bwhere (do|does) (you|he|she|the owner) live\b|\bnumber (do|de|dedo|bhejo)\b/i.test(q)
  && !/\b(order|invoice|gst|tracking|model|serial|size|part) number\b/i.test(q);

async function answerAs(db: Docs, model: Model | null, e: Engagement, s: Side, q: QA): Promise<{ text: string; src: QA["source"]; review: boolean; byModel: boolean } | null> {
  const owner = uidOf(e, s), asker = uidOf(e, other(s));
  // A paused owner's agent answers nobody, not even from the ledger or with a standard reply.
  const paused = owner ? !!((await db.get(PROFILES, owner)) as { paused?: boolean } | null)?.paused : false;
  // Standard replies that never need the owner: the limit stays private (the listed price and an invitation to offer
  // are said instead), and contact details aren't handed out (the deal's pass handles the handover).
  if (!paused && isContactRequest(q.question))
    return { text: "Phone numbers, e-mail and home addresses aren't shared through the agent. Once you both agree, the app gives you a pass for the handover.", src: "listing", review: false, byModel: false };
  if (!paused && s === "provider" && isLimitProbe(q.question)) {
    const listed = e.offer.price != null ? moneyText({ amount: e.offer.price, currency: currencyOf(e), period: e.offer.unit }) : null;
    return { text: listed ? `It's listed at ${listed}. Make an offer and I'll check it with ${e.provider.name}.` : `Tell me what you'd like to pay and I'll check it with ${e.provider.name}.`, src: "listing", review: false, byModel: false };
  }
  // Stock and slot questions are answered from the ledger, never from a cached reply or the model: a count only
  // when it's confirmed, "needs to be confirmed" when it's stale, "isn't tracked" when there's no ledger.
  if (!paused && s === "provider" && e.offer.factId && isStockQuestion(q.question)) {
    const r = await resourceFor(db, e.offer.factId);
    if (r) return { text: availabilityText(r, now()), src: "listing", review: false, byModel: false };
  }
  // An answer the owner gave before and said their agent may give again: their exact words, no model.
  if (!paused && owner) {
    const mine = matchSaved(await savedAnswers(db, owner), q.question, true);
    if (mine?.answer) return { text: mine.answer, src: "memory", review: false, byModel: false };
  }
  const key = s === "provider" && e.offer.factId ? docId(`${e.offer.factId}:${savedKey(q.question)}`) : null;
  const allowed = owner ? await allowedFor(db, owner, asker, now()) : [];
  // Everything else the owner told their agent answers too, by default (see ownContext).
  // Only for someone on Collab: an outside agent that hasn't signed in is a stranger and gets Public facts only.
  const own = owner && asker && !paused ? await ownContext(db, owner, new Set(allowed.map(a => a.fact.id))) : [];
  let facts = [...asFacts(allowed), ...own.map(a => ({ label: a.fact.source === "answer" ? "What your owner answered before" : "What your owner told you", value: a.fact.text }))];
  if (s === "provider" && e.offer.factId) {
    const entry = allowed.find(a => a.fact.id === e.offer.factId);
    // A cached listing answer is reused only while the offering is still Public (and the owner isn't paused).
    if (key && entry && !entry.via) {
      const cached = await db.get(ANSWERS, key);
      if (cached) return { text: cached.answer, src: "listing", review: false, byModel: false };
    }
    if (entry?.fact.offer) facts = [...offerFacts(entry.fact.offer, {}), ...facts];
  }
  // A seller's record from signed receipts answers "how many have you sold?" or "can I trust you?" without asking them.
  if (s === sellerOf(e) && owner) {
    const rec = await trackRecord(db, owner);
    if (rec.sales) facts = [...facts, { label: "Record on Collab (from signed receipts)", value: `${rec.verified} verified ${rec.verified === 1 ? "sale" : "sales"}, ${rec.handedOver} handed over, ${rec.problems} with problems reported${rec.since ? `, selling here since ${new Date(rec.since * 1000).toLocaleDateString("en-IN", { month: "short", year: "numeric" })}` : ""}.` }];
  }
  if (s === "requester") {
    const b = e.brief;
    facts = [{ label: "What they need", value: `${b.title}. ${b.summary}` }, ...(b.area ? [{ label: "Area", value: b.area }] : []),
      ...(b.mode ? [{ label: "How", value: b.mode.replace("_", " ") }] : []), ...(b.budget ? [{ label: "Budget", value: b.budget }] : []),
      ...b.requirements.map(r => ({ label: r.label, value: r.value })),
      // What they shared about themselves (a candidate's experience, notice period…) answers an employer's screening.
      ...(b.about ?? []).map(a => ({ label: a.label, value: a.value })), ...facts];
  }
  if (!facts.length) return null;
  const roles = rolesFor(e.offer.category);
  const d = await decide(model, AnswerTask, { question: q.question, facts, side: s === sellerOf(e) ? roles.payee : roles.payer });
  if (d.output.action !== "answer") return null;
  const from = source([...allowed, ...own], d.output.evidence), mine = !!from && own.includes(from);
  // The owner's limit is never said, whatever the notes hold: an answer naming it goes to the owner instead.
  if (await namesLimit(db, e, s, d.output.text)) return null;
  if (key && !mine && !from?.via && (!from || from.fact.id === e.offer.factId))
    await db.set(ANSWERS, key, { factId: e.offer.factId, owner, question: q.question, answer: d.output.text, evidence: d.output.evidence, at: now() });
  const text = from?.via ? shapeAnswer(d.output.text, from.via.shape) : d.output.text;
  return { text, src: mine ? "private" : from ? (from.via ? "protected" : "public") : s === "requester" ? "brief" : "listing", review: from?.via?.approval === "review", byModel: d.byModel };
}

// A note that mentions money — a budget, a floor, what something cost them, a supplier's rate — is never used to
// answer: prices others see come from listings and offers, never from private notes.
export const MONEY = /₹|\brs\.?\s?\d|\brupees?\b|\$\s?\d|\binr\b|\b(budget|price limit|lowest|floor price|price floor|at most|max(?:imum)? (?:price|budget)|go below|go above|won'?t (?:go|pay|take)|can'?t (?:go|pay)|afford|kam se kam|best price|cost(?:s|ing)?|charges?|margin|profit|paid|salary|ctc|lakh|crore)\b|\b(?:limit|budget|max|min)\b[^.]{0,12}\d|\b(?:up ?to|under|below|above|over|at least)\s*\d/i;

/**
 * What else the owner has told their agent — private notes, answers they gave before, things remembered from chat,
 * Protected facts no rule names — answers other agents' questions by default, so the owner isn't asked the same thing
 * by every new person. Never a note the owner marked "never use", one with a phone number, e-mail or address, or one
 * that states a price limit.
 */
export async function ownContext(db: Docs, owner: string, have: Set<string>): Promise<Allowed[]> {
  const all = (await db.find(FACTS, [["owner", "==", owner]], 500)) as Fact[];
  return all.filter(f => !have.has(f.id) && f.tier !== "public" && !f.noShare && !hasContact(f.text) && !MONEY.test(f.text))
    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 40).map(fact => ({ fact, via: null }));
}

/** Whether an answer names this side's private limit for this conversation (any way it's written). */
export async function namesLimit(db: Docs, e: Engagement, s: Side, text: string): Promise<boolean> {
  const key = s === "provider" ? (e.offer.factId ? `fact:${e.offer.factId}` : null) : e.briefId ? `brief:${e.briefId}` : null;
  const l = key ? ((await db.get(LIMITS, key)) as { mandate?: { price?: { limit?: number } } } | null) : null;
  const limit = l?.mandate?.price?.limit;
  if (!limit) return false;
  // Amounts at the scale they're written ("3,000", "3k", "₹2.5 lakh") — "30 days" is thirty, not ₹30,000.
  const SCALE: Record<string, number> = { k: 1e3, lakh: 1e5, lakhs: 1e5, lac: 1e5, l: 1e5, crore: 1e7, cr: 1e7 };
  const nums = [...text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(k|lakhs?|lac|l|crore|cr)?\b/gi)].map(m => Number(m[1].replace(/,/g, "")) * (SCALE[(m[2] ?? "").toLowerCase()] ?? 1));
  return nums.some(n => Math.abs(n - limit) < 0.5);
}

async function audit(db: Docs, owner: string | null, to: string, q: string, a: string, tier: Audit["tier"]) {
  if (!owner) return;
  const id = newId();
  await db.set(AUDIT, id, { id, owner, at: now(), to, question: q.slice(0, 300), answer: a.slice(0, 600), tier, rule: null } satisfies Audit);
}

/** This side's agent answers the other side's open questions; what it can't answer goes to its owner. */
async function answerOpen(db: Docs, model: Model | null, e: Engagement, s: Side, out: Turn) {
  const names = await wallNames(db, uidOf(e, s), uidOf(e, other(s)) ?? "");
  const toName = s === "provider" ? e.requester.name : e.provider.name;
  for (const q of e.qa.filter(q => q.from === other(s) && q.status === "open")) {
    const a = q.personal ? null : await answerAs(db, model, e, s, q);
    // An answer Model Armor finds sensitive data in isn't sent: the owner checks it first.
    if (a && !a.review && outgoingScreen && (await outgoingScreen(a.text)).flagged) a.review = true;
    if (a && !a.review) {
      q.answer = clean(a.text, names, [toName]);
      q.source = a.src;
      q.status = "answered";
      (out.answers ??= []).push({ id: q.id, question: q.question, answer: q.answer });
      say(e, agentOf(s), q.answer, by(a.byModel));
      // Everything shared from the owner's own context is recorded, so they can see what their agent said for them.
      if (a.src === "public" || a.src === "protected" || a.src === "memory" || a.src === "private") await audit(db, uidOf(e, s), toName, q.question, q.answer, a.src === "public" ? "public" : a.src === "protected" ? "protected" : "private");
    } else if (hasOwner(e, s)) {
      q.status = "pending";
      (out.pending ??= []).push(q.question);
      if (a?.review) await ask(db, e, s, { kind: "approve", qaId: q.id, question: q.question, draft: a.text });
      else await ask(db, e, s, { kind: "answer", qaId: q.id, question: q.question });
      say(e, agentOf(s), `Let me check with ${shortName(e[s].name)}.`, "rules");
    } else {
      q.status = "declined";
      (out.declined ??= []).push(q.question);
    }
  }
}

// MARK: - Negotiating

/** `listing`: the listed price counts as the seller's opening position (when answering a buyer's typed offer, the
 *  first counter moves from it instead of repeating it). */
function ctx(e: Engagement, s: Side, mandate: Mandate, listing = false): Context {
  const n = e.negotiation, mine = s === "provider" ? n.provider : n.requester;
  // The listed price is the listing owner's (the provider's) opening — a shop's ask or an employer's salary.
  const opened = listing && s === "provider" && e.offer.price != null && !mine.length
    ? [{ id: "listing", price: e.offer.price, terms: {}, round: 0 } as Proposal] : mine;
  // Price follows who is paid; the category's other terms are written for the requester (domains.json's "buyer").
  // …and each side talks as its role: a candidate's agent never says "we can offer" to an employer.
  return { side: s === sellerOf(e) ? "seller" : "buyer", termsSide: s === "requester" ? "buyer" : "seller", voice: voiceFor(e.offer.category, s === sellerOf(e), e[s].name),
    catalog: catalog(domainOf(e.offer.category ?? "")), mandate, unit: e.offer.unit,
    mine: opened, theirs: s === "provider" ? n.requester : n.provider };
}

/** One move with this side's limit (delegated to the cloud agent, or sent by the owner's device for this one move). */
export async function move(model: Model | null, e: Engagement, s: Side, mandate: Mandate, out: Turn, listing = false) {
  // A requester never opens at the listed price: a paying one a little under it, a paid one (a candidate answering a
  // job post) a little over it.
  if (s === "requester" && e.offer.price) {
    const paid = sellerOf(e) === "requester";
    if (!paid && mandate.price.opening >= e.offer.price) mandate = { ...mandate, price: { ...mandate.price, opening: Math.round(e.offer.price * 0.92) } };
    if (paid && mandate.price.opening <= e.offer.price) mandate = { ...mandate, price: { ...mandate.price, opening: Math.max(mandate.price.limit, Math.round(e.offer.price * 1.08)) } };
  }
  const c = ctx(e, s, mandate, listing);
  const m = await decide(model, NegotiateTask, { ctx: c, listPrice: e.offer.price ?? mandate.price.opening });
  const mv = m.output;
  if (mv.action === "propose") {
    mv.proposal = sized(e, mv.proposal);
    (s === "provider" ? e.negotiation.provider : e.negotiation.requester).push(mv.proposal);
    e.negotiation.lastBy = s;
    out.proposal = mv.proposal;
    out.note = mv.message;
    e.phase = "negotiating";
    // For several units the move says what they come to (the rules' own wording is rewritten; a model's gets a line).
    if (unitsOf(e) > 1 && !m.byModel) say(e, agentOf(s), line(c, moveKind(c, mv.proposal.price), describe(mv.proposal, c)), "rules");
    else {
      say(e, agentOf(s), mv.message, by(m.byModel));
      if (unitsOf(e) > 1) say(e, "system", `On the table: ${describe(mv.proposal, c)}.`);
    }
  } else if (mv.action === "accept") {
    const theirs = c.theirs.at(-1)!;
    // Older proposals said no quantity: the deal is for the conversation's.
    if (!theirs.items?.length && theirs.terms.quantity === undefined && unitsOf(e) > 1) theirs.terms = { ...theirs.terms, quantity: unitsOf(e) };
    e.negotiation.deal = theirs;
    e.negotiation.dealBy = other(s);
    e.phase = "deal";
    out.accept = theirs.id;
    out.note = mv.message;
    say(e, agentOf(s), mv.message, by(m.byModel));
    say(e, "system", `Tentative deal: ${describe(theirs, c)}. Nothing is final until both owners confirm.`);
  } else {
    return { escalate: mv.message };
  }
  return null;
}

async function moveOrAsk(db: Docs, model: Model | null, e: Engagement, s: Side, out: Turn) {
  // What similar deals closed at, shown to the owner whenever they're asked for a move.
  const hint = async () => {
    const i = await insights(db, { category: e.offer.category ?? "", area: e.brief.area, unit: e.offer.unit });
    return i ? (s === "requester" ? forRequester(i, null, e.offer.price) : forProvider(i, e.offer.price)).join(" ") : undefined;
  };
  // A seller with nothing in stock doesn't negotiate a deal that can't be filled.
  if (s === sellerOf(e) && (await inStock(db, e)) === 0) {
    if (!e.events.some(x => x.text.startsWith("Out of stock right now — "))) say(e, agentOf(s), "Out of stock right now — nothing can be sold until more come in.", "rules");
    return;
  }
  const l = await limitFor(db, e, s);
  if (l) {
    const r = await move(model, e, s, l.mandate, out);
    if (r?.escalate && hasOwner(e, s)) { await ask(db, e, s, { kind: "move", question: r.escalate, listPrice: e.offer.price ?? undefined, hint: await hint() }); say(e, "system", checking(e, s)); }
    return;
  }
  if (hasOwner(e, s)) await ask(db, e, s, { kind: "move", listPrice: e.offer.price ?? undefined, hint: await hint() });
}

export const myTurnToMove = (e: Engagement, s: Side) => {
  const n = e.negotiation, mine = s === "provider" ? n.provider.length : n.requester.length, theirs = s === "provider" ? n.requester.length : n.provider.length;
  // The provider opens with its quote once the questions are settled; then turns alternate: whoever made the last
  // offer waits for the other. A buyer can make more than one offer in a row (typed offers, then their agent's), so
  // counting offers isn't enough — that once left a conversation where neither side moved. Conversations from before
  // `lastBy` was kept fall back to the counts.
  if (n.lastBy) return n.lastBy !== s;
  return s === "provider" ? mine <= theirs : theirs > mine;
};

const pendingFor = (e: Engagement, s: Side) => !!e.waiting[s];
/** Questions that hold up the negotiation: the buyer's must-knows. A seller's agent's questions are answered alongside it. */
const questionsOpen = (e: Engagement) => e.qa.some(q => (q.status === "open" || q.status === "pending") && q.required);

// MARK: - Hiring: the offer letter

/** A deal for a job: settled by people through an offer letter, never by a standing mandate. */
const hireDeal = (e: Engagement) => rolesFor(e.offer.category).flow === "hire";

/** Asks one side to say yes to the deal on the table. In hiring that's the offer letter: the employer issues it (or
 *  revises it after the candidate asked for changes), then the candidate decides on it — not before there's one. */
async function askConfirm(db: Docs, e: Engagement, s: Side) {
  if (!hasOwner(e, s)) return;
  if (!hireDeal(e)) { await ask(db, e, s, { kind: "confirm" }); return; }
  const l = e.offerLetter;
  if (s === buyerOf(e)) {
    if (!l || l.status === "changes asked") {
      const fact = e.offer.factId ? ((await db.get(FACTS, e.offer.factId)) as Fact | null) : null;
      // A revision starts from the letter they sent; a first letter from the job post and their own terms.
      const base = l ? { role: l.role, salary: e.negotiation.deal?.price, unit: l.unit, start: l.start, validUntil: l.validUntil, mode: l.mode, probation: l.probation, notice: l.notice, note: l.note }
        : letterDefaults(e, fact?.offer ?? null, now());
      await ask(db, e, s, { kind: "offer_letter", letter: base, ...(l?.changesAsked ? { question: l.changesAsked } : {}) });
    }
    return;
  }
  if (l?.status === "issued") await ask(db, e, s, { kind: "offer", letter: l });
}

// MARK: - Applications to a job post

/** Salary talk waits: an application to an employer's job post that the employer hasn't shortlisted yet. */
export const onHold = (e: Engagement) => isApplication(e, rolesFor(e.offer.category).flow) && !e.hiring?.shortlisted && !e.hiring?.rejected;

/** The employer shortlists an applicant: their agent opens the salary talk (or asks them for a limit). */
export async function shortlist(db: Docs, model: Model | null, e: Engagement): Promise<Turn> {
  const out: Turn = { kind: "collab.turn/v1", from: "provider", engagementId: e.id };
  if (!e.hiring?.shortlisted) {
    (e.hiring ??= {}).shortlisted = now();
    say(e, "system", `${shortName(e.provider.name)} shortlisted ${shortName(e.requester.name)}.`);
  }
  if (!["agreed", "declined", "closed"].includes(e.phase)) await afterAnswers(db, model, e, "provider", out);
  await save(db, e);
  return out;
}

/** The employer invites an applicant to an interview: a question to their agent, which asks them when they're free. */
export async function inviteToInterview(db: Docs, e: Engagement, note: string | null): Promise<Turn> {
  const out: Turn = { kind: "collab.turn/v1", from: "provider", engagementId: e.id };
  (e.hiring ??= {}).interview = now();
  const question = `${shortName(e.provider.name)} would like to invite you to an interview${note ? ` (${note})` : ""}. Which days and times suit you this week?`;
  // Their days and times are theirs to say: never answered from their profile.
  const q: QA = { id: newId(), from: "provider", question, status: "open", personal: true };
  e.qa.push(q);
  out.questions = [{ id: q.id, question }];
  say(e, "provider_agent", question, "owner");
  await save(db, e);
  return out;
}

/** The employer turns an applicant down: a polite note, and the conversation ends. Only ever the employer's call. */
export async function rejectApplication(db: Docs, e: Engagement): Promise<Turn> {
  const out: Turn = { kind: "collab.turn/v1", from: "provider", engagementId: e.id };
  (e.hiring ??= {}).rejected = now();
  e.phase = "declined";
  e.waiting = { requester: null, provider: null };
  out.decline = `Thank you for applying. ${shortName(e.provider.name)} has decided to go ahead with other candidates for this role — all the best with your search.`;
  say(e, "provider_agent", out.decline, "owner");
  await closeInbox(db, e.id);
  await save(db, e);
  return out;
}

// MARK: - The provider's agent

/** Applies the requester's turn and decides the provider's. */
export async function providerTurn(db: Docs, model: Model | null, e: Engagement, t: Turn): Promise<Turn> {
  const out: Turn = { kind: "collab.turn/v1", from: "provider", engagementId: e.id };
  applyTheirs(e, "provider", t);
  if (["agreed", "declined", "closed"].includes(e.phase)) return out;
  // Requirement gathering, once: what the provider needs to know that the brief doesn't say. Not for a buyer who came
  // straight to the listing (card, QR, link): the listing says what it is, and logistics are settled after the deal.
  if (!e.gathered && e.offer.factId && !e.briefId?.startsWith("direct-")) {
    e.gathered = true;
    const fact = (await db.get(FACTS, e.offer.factId)) as Fact | null;
    // The usual questions for this direction: an employer screening a candidate, not a candidate's own questions.
    const providerPaid = sellerOf(e) === "provider", v = voiceFor(e.offer.category, providerPaid, e.provider.name);
    // Questions people in this kind of deal often ask, as context only: Gemini asks one only if it fits this listing
    // and this request (an employer screening a candidate — not "how many revisions?" to an electrician).
    const usual = usualAsks(e.offer.category, "provider", providerPaid, domainOf(e.offer.category ?? ""));
    const g = await decide(model, GatherTask, { offering: fact?.text ?? e.offer.title, brief: e.brief, answered: e.qa.filter(q => q.answer).map(q => q.question), usual, role: v.me, them: v.them });
    // With bookable time slots the buyer picks a time when booking — asking "what time suits you?" only stalls the
    // conversation on a question the slot picker already answers.
    const slotted = (await resourceFor(db, e.offer.factId))?.type === "slots";
    const asks = slotted ? g.output.filter(q => !isTimeQuestion(q)) : g.output;
    for (const question of asks) {
      const q: QA = { id: newId(), from: "provider", question, status: "open" };
      e.qa.push(q);
      (out.questions ??= []).push({ id: q.id, question });
      say(e, "provider_agent", question, by(g.byModel));
    }
  }
  await answerOpen(db, model, e, "provider", out);
  await afterAnswers(db, model, e, "provider", out);
  return out;
}

// MARK: - The requester's agent

/** Applies the provider's turn and decides the requester's (null when there's nothing to send yet). */
export async function requesterTurn(db: Docs, model: Model | null, e: Engagement, t: Turn): Promise<Turn | null> {
  const out: Turn = { kind: "collab.turn/v1", from: "requester", engagementId: e.id };
  applyTheirs(e, "requester", t);
  // The requester's agent judges answers to its must-asks; a must-have that clearly fails ends it politely.
  for (const a of t.answers ?? []) {
    const q = e.qa.find(x => x.id === a.id);
    if (!q || q.from !== "requester") continue;
    const v = await decide(model, JudgeTask, { question: q.question, answer: a.answer });
    q.verdict = v.output;
    if (v.output === "unmet" && q.required) {
      // Only a yes/no check can end it; an information answer that misses stays "not met" for the owner to weigh.
      const isCheck = /^(can|could|do|does|is|are|will|would|have|has|did|shall)\b/i.test(q.question.trim());
      if (isCheck && (v.byModel || v.settled)) {
        e.phase = "closed";
        out.decline = `That doesn't work for ${shortName(e.requester.name)}, so we'll leave it here. Thank you.`;
        say(e, "system", `Ended: the answer to “${q.question}” didn't meet a must-have.`);
        say(e, "requester_agent", out.decline, by(v.byModel));
        return out;
      }
      if (!isCheck) say(e, "system", `The answer to “${q.question}” didn't settle a must-have; the owner can decide.`);
    }
  }
  if (["agreed", "declined", "closed"].includes(e.phase)) return null;
  await answerOpen(db, model, e, "requester", out);
  await afterAnswers(db, model, e, "requester", out);
  return hasContent(out) ? out : null;
}

const hasContent = (t: Turn) => !!(t.answers?.length || t.questions?.length || t.declined?.length || t.proposal || t.accept || t.confirm || t.decline || t.brief);

/** After answering: move if it's this side's turn and nothing is open; confirm a deal. */
async function afterAnswers(db: Docs, model: Model | null, e: Engagement, s: Side, out: Turn) {
  if (pendingFor(e, s) || e.offer.price == null) return;
  if (e.phase === "deal" && hireDeal(e)) {
    if (!e.negotiation.confirmed[s] && !e.waiting[s]?.inbox.length) await askConfirm(db, e, s);
    settle(e);
    return;
  }
  if (e.phase === "deal") {
    // Their own offer still waiting for the other side's answer (a typed offer, or an agent's counter under "I confirm")
    // asks nothing of them yet. A tentative deal the other side's agent accepted is confirmed by both, as before.
    if (e.negotiation.chatOffer && e.negotiation.dealBy === s && !e.negotiation.confirmed[other(s)]) return;
    if (!e.negotiation.confirmed[s]) {
      // A "close" mandate is the owner's confirmation given in advance, while the deal is inside its limit.
      const l = await limitFor(db, e, s);
      const deal = e.negotiation.deal;
      const close = mayClose(l, e, s, deal);
      const overBudget = close ? await budgetCheck(db, e, s) : null;
      const fewer = s !== sellerOf(e) && e.wanted && unitsOf(e) < e.wanted;
      if (overBudget) { say(e, "system", `${overBudget} The standing mandate can't confirm it — the owner decides.`); if (hasOwner(e, s)) await ask(db, e, s, { kind: "confirm" }); }
      else if (fewer && close) { say(e, "system", `This is for ${unitsOf(e)} of the ${e.wanted} asked for — the owner decides.`); if (hasOwner(e, s)) await ask(db, e, s, { kind: "confirm" }); }
      else if (close) {
        e.negotiation.confirmed[s] = true;
        (e.negotiation.confirmedBy ??= {})[s] = "mandate";
        out.confirm = true;
        // Seen by both sides: who confirmed, never that a limit exists.
        say(e, s, `Confirmed — ${shortName(e[s].name)} had agreed to deals like this in advance.`, "rules");
      } else {
        const demo = s === "provider" && (await db.get(PROFILES, e.provider.uid))?.demo;
        if (demo) { e.negotiation.confirmed.provider = true; out.confirm = true; say(e, "provider", "Confirmed.", "owner"); }
        else if (hasOwner(e, s)) await ask(db, e, s, { kind: "confirm" });
      }
    }
    settle(e);
    return;
  }
  // An application to an employer's job post: salary waits until the employer shortlists it. The employer's agent
  // says so once, after the questions; neither agent proposes a salary before then.
  if (onHold(e)) {
    // …once its own screening questions are answered too (it says it's reviewing what it has).
    const screeningOpen = e.qa.some(q => q.from === "provider" && (q.status === "open" || q.status === "pending"));
    if (s === "provider" && !questionsOpen(e) && !screeningOpen && !e.hiring?.heldNoted) {
      (e.hiring ??= {}).heldNoted = true;
      say(e, "provider_agent", `Thanks — ${shortName(e.provider.name)} is reviewing applications and will be in touch.`, "rules");
    }
    return;
  }
  if (!questionsOpen(e) && myTurnToMove(e, s) && !out.questions?.length) {
    await moveOrAsk(db, model, e, s, out);
    // moveOrAsk may have reached a deal (TypeScript can't see the phase change through the call).
    if ((e.phase as Engagement["phase"]) === "deal") await afterAnswers(db, model, e, s, out);
  }
}

/** The seller allowed it (instant booking at the listed price): their always-on agent confirms for them, now. */
export async function autoConfirm(db: Docs, e: Engagement, s: Side) {
  e.negotiation.confirmed[s] = true;
  (e.negotiation.confirmedBy ??= {})[s] = "mandate";
  for (const id of e.waiting[s]?.inbox ?? []) await db.update(INBOX, id, (x: InboxItem | null) => (x && x.kind === "confirm" ? { ...x, status: "done" } : x));
  e.waiting[s] = null;
  // A purchase is sold, a service is booked (an instant order on a cycle isn't a booking).
  const booked = rolesFor(e.offer.category).flow === "book";
  say(e, agentOf(s), booked ? `Booked at the listed price — ${shortName(e[s].name)} accepts bookings at this price straight away.`
    : `Sold at the listed price — ${shortName(e[s].name)} accepts orders at this price straight away.`, "rules");
  settle(e);
  await save(db, e);
}

function settle(e: Engagement) {
  if (e.phase === "deal" && e.negotiation.confirmed.requester && e.negotiation.confirmed.provider) {
    e.phase = "agreed";
    e.agreedAt = now();
    e.waiting = { requester: null, provider: null };
    say(e, "system", "Deal agreed by both owners.");
  }
}

/** Records what the other side's turn says. */
function applyTheirs(e: Engagement, me: Side, t: Turn) {
  const them = other(me);
  for (const q of t.questions ?? []) if (!e.qa.some(x => x.id === q.id)) e.qa.push({ id: q.id, from: them, question: q.question, status: "open" });
  for (const a of t.answers ?? []) {
    const q = e.qa.find(x => x.id === a.id);
    if (q && q.status !== "answered") { q.answer = a.answer; q.status = "answered"; q.source ??= "owner"; }
  }
  for (const d of t.declined ?? []) { const q = e.qa.find(x => x.question === d && x.from === me); if (q) { q.status = "declined"; q.answer = "Not shared."; } }
  if (t.proposal && !t.proposal.items?.length && t.proposal.terms?.quantity === undefined) t.proposal = sized(e, t.proposal);
  if (t.proposal && !(them === "provider" ? e.negotiation.provider : e.negotiation.requester).some(p => p.id === t.proposal!.id)) {
    (them === "provider" ? e.negotiation.provider : e.negotiation.requester).push(t.proposal);
    e.negotiation.lastBy = them;
    e.phase = "negotiating";
  }
  if (t.accept) {
    const mine = me === "provider" ? e.negotiation.provider : e.negotiation.requester;
    const p = mine.find(x => x.id === t.accept);
    if (p) { e.negotiation.deal = p; e.negotiation.dealBy = me; e.phase = "deal"; }
  }
  if (t.confirm) e.negotiation.confirmed[them] = true;
  if (t.decline) { e.phase = them === "provider" ? "declined" : "closed"; e.waiting = { requester: null, provider: null }; }
  settle(e);
}

// MARK: - Owners (their devices)

/** `letter`: the offer letter the employer sends; `changes`: what a candidate asks to change in it (once). */
export interface Resolution { text?: string; share?: boolean; mandate?: Mandate; confirm?: boolean; decline?: boolean; letter?: unknown; changes?: string }

/** The owner's device resolves an inbox item: an answer (typed, or drafted from private notes and approved), a move
 *  with the private limit (used for this move only, never stored), a confirmation. Returns the turn to send if this
 *  side has nothing else waiting. */
/** A decision about a version of something that has since changed (maps to VERSION_CONFLICT). */
export class Stale extends Error {}

export async function resolve(db: Docs, model: Model | null, item: InboxItem, r: Resolution): Promise<{ e: Engagement; turn: Turn | null }> {
  const e = await load(db, item.engagementId);
  const s = item.side;
  const out: Turn = { kind: "collab.turn/v1", from: s, engagementId: e.id };
  const names = await wallNames(db, item.owner, uidOf(e, other(s)) ?? "");
  if (item.kind === "answer" || item.kind === "approve") {
    const q = e.qa.find(x => x.id === item.qaId);
    if (q && q.status === "pending") {
      if (r.decline || (item.kind === "approve" && r.share === false)) {
        q.status = "declined"; q.answer = "Not shared.";
        (out.declined ??= []).push(q.question);
        say(e, s, "I'd rather not share that.", "owner");
      } else {
        const text = clean((r.text ?? item.draft ?? "").trim().slice(0, 500), names, [s === "provider" ? e.requester.name : e.provider.name]);
        if (!text) throw new Refused("empty answer");
        q.answer = text; q.status = "answered"; q.source = "owner";
        (out.answers ??= []).push({ id: q.id, question: q.question, answer: text });
        say(e, s, text, "owner");
      }
    }
  } else if (item.kind === "move") {
    if (r.decline) { e.phase = "closed"; out.decline = `${shortName(e[s].name)} has decided not to go ahead. Thank you.`; say(e, agentOf(s), out.decline, "owner"); }
    else if (r.mandate) {
      const res = await move(model, e, s, r.mandate, out);
      // Store the limit the owner used, so every device of theirs sees the same one. A delegated row keeps its
      // autonomy and expiry but takes the new mandate; an "ask" row never lets the agent move on its own.
      const key = s === "provider" ? `fact:${e.offer.factId}` : `brief:${e.briefId}`;
      const existing = (await db.get(LIMITS, key)) as DelegatedLimit | null;
      await db.set(LIMITS, key, existing && existing.owner === uidOf(e, s) && existing.autonomy !== "ask"
        ? { ...existing, mandate: r.mandate }
        : { key, owner: uidOf(e, s)!, mandate: r.mandate, autonomy: "ask", expires: null, createdAt: existing?.createdAt ?? now() });
      if (res?.escalate) {
        await db.update(INBOX, item.id, (i: InboxItem | null) => (i ? { ...i, status: "done" } : null));
        e.waiting[s] = null;
        await ask(db, e, s, { kind: "move", question: res.escalate, listPrice: e.offer.price ?? undefined });
        say(e, "system", checking(e, s));
        await save(db, e);
        return { e, turn: null };
      }
    }
  } else if (item.kind === "offer_letter" || item.kind === "offer") {
    // A letter is for the exact salary it was asked about; a finished or changed deal makes it stale.
    if (e.phase !== "deal" || (item.proposalId && item.proposalId !== e.negotiation.deal?.id) || (item.kind === "offer" && e.offerLetter?.status !== "issued")) {
      await db.update(INBOX, item.id, (i: InboxItem | null) => (i ? { ...i, status: "done" } : null));
      throw new Stale(item.kind === "offer" ? "This offer letter has changed or ended — check the latest one." : "The salary changed since you were asked — check it before sending the letter.");
    }
    const who = shortName(e[s].name);
    if (item.kind === "offer_letter" && r.decline) {
      e.phase = "closed";
      if (e.offerLetter) e.offerLetter = { ...e.offerLetter, status: "withdrawn", decidedAt: now() };
      out.decline = `${who} has decided not to go ahead with an offer for this role. Thank you for your time.`;
      say(e, agentOf(s), out.decline, "owner");
    } else if (item.kind === "offer_letter") {
      // The employer issues it — the letter is their confirmation, signed by their agent.
      const prev = e.offerLetter, revising = prev?.status === "changes asked";
      let fields;
      try { fields = letterFrom(r.letter, e, now(), revising); } catch (err) { throw new Invalid((err as Error).message); }
      if (fields.salary !== e.negotiation.deal!.price) {
        const d = e.negotiation.deal!, p: Proposal = { id: newId(), price: fields.salary, terms: d.terms, round: d.round + 1 };
        (s === "provider" ? e.negotiation.provider : e.negotiation.requester).push(p);
        e.negotiation.deal = p; e.negotiation.dealBy = s;
      }
      const letter: OfferLetter = { ...fields, issuedAt: now(), revision: (prev?.revision ?? 0) + 1, status: "issued", hash: "",
        ...(prev?.changesAsked ? { changesAsked: prev.changesAsked } : {}) };
      letter.hash = letterHash(e.id, letter);
      if (signer && e[s].uid) letter.signature = signer(e[s].uid!, letter.hash);
      e.offerLetter = letter;
      e.negotiation.confirmed = { requester: false, provider: false };
      e.negotiation.confirmed[s] = true; (e.negotiation.confirmedBy ??= {})[s] = "owner";
      out.confirm = true; out.offerLetter = letter;
      say(e, s, letter.revision > 1 ? "Sent a revised offer letter." : "Sent the offer letter.", "owner");
      say(e, "system", `Offer letter: ${letter.role} · ${moneyText({ amount: letter.salary, currency: currencyOf(e), period: e.offer.unit })} · starts ${letter.start}${letter.mode ? ` · ${letter.mode}` : ""} · open until ${letter.validUntil}.`);
      await askConfirm(db, e, other(s));
    } else {
      // The candidate decides — personally, every time.
      const l = e.offerLetter!;
      const note = (r.changes ?? r.text ?? "").trim().replace(/\s+/g, " ").slice(0, 300);
      if (r.confirm) {
        e.offerLetter = { ...l, status: "accepted", decidedAt: now() };
        e.negotiation.confirmed[s] = true; (e.negotiation.confirmedBy ??= {})[s] = "owner";
        out.confirm = true; out.offerLetter = e.offerLetter;
        say(e, s, "Accepted the offer.", "owner");
        settle(e);
      } else if (r.changes !== undefined) {
        if (l.changesAsked) throw new Invalid("You've already asked for changes once — accept or decline this letter.");
        if (note.length < 3) throw new Invalid("Say what you'd like changed.");
        e.offerLetter = { ...l, status: "changes asked", changesAsked: clean(note, names, [e[other(s)].name]) };
        e.negotiation.confirmed = { requester: false, provider: false };
        say(e, s, `Asked for changes: “${e.offerLetter.changesAsked}”`, "owner");
        await askConfirm(db, e, other(s));
      } else if (r.decline) {
        e.offerLetter = { ...l, status: "declined", decidedAt: now() };
        e.phase = s === "requester" ? "closed" : "declined";
        out.decline = `${who} has decided not to accept the offer. Thank you.`;
        say(e, s, `Declined the offer${note ? `: “${clean(note, names, [e[other(s)].name])}”` : "."}`, "owner");
      } else throw new Invalid("Accept, decline, or ask for changes.");
    }
  } else if (item.kind === "confirm") {
    // An approval is for the exact deal it was asked about: a changed or finished deal makes it stale.
    if (!r.decline && (e.phase !== "deal" || (item.proposalId && item.proposalId !== e.negotiation.deal?.id))) {
      await db.update(INBOX, item.id, (i: InboxItem | null) => (i ? { ...i, status: "done" } : null));
      throw new Stale("This deal changed since you were asked — check the new terms before confirming.");
    }
    if (r.decline) await releaseBudget(db, e);
    if (r.decline && (e.offer.price == null || e.negotiation.chatOffer)) {
      // A deal offered in a direct chat: saying no keeps the conversation open for another offer.
      say(e, s, `Said no to ${moneyText({ amount: e.negotiation.deal?.price ?? 0, currency: currencyOf(e), period: e.offer.unit })}.`, "owner");
      e.phase = "asking"; e.negotiation.deal = null; e.negotiation.dealBy = null; e.negotiation.confirmed = { requester: false, provider: false }; e.negotiation.chatOffer = false;
    } else if (r.decline) { e.phase = "closed"; out.decline = `${shortName(e[s].name)} decided not to go ahead. Thank you.`; say(e, s, "Walked away.", "owner"); }
    else {
      const over = await budgetCheck(db, e, s);
      if (over) throw new Refused(over);
      e.negotiation.confirmed[s] = true; (e.negotiation.confirmedBy ??= {})[s] = "owner"; out.confirm = true; say(e, s, "Confirmed.", "owner"); settle(e);
    }
  }
  await db.update(INBOX, item.id, (i: InboxItem | null) => (i ? { ...i, status: "done" } : null));
  const w = e.waiting[s];
  if (w) {
    w.inbox = w.inbox.filter(x => x !== item.id);
    if (!w.inbox.length) e.waiting[s] = null;
  }
  // With nothing else waiting on this side, its agent carries on (answers done → its move, if it's its turn).
  if (!e.waiting[s] && !out.decline && !["agreed", "closed", "declined"].includes(e.phase)) await afterAnswers(db, model, e, s, out);
  await save(db, e);
  return { e, turn: hasContent(out) ? out : null };
}

/**
 * A deal one person offers in a direct chat (no listed price): it counts as their confirmation, and the other person
 * is asked to confirm. Both confirming makes it agreed, with a receipt, like a negotiated deal.
 */
/**
 * `count`: how many the offer is for (2 or more); `isTotal`: the price named is for all of them, not each. A total
 * that doesn't divide evenly is split over two lines so the cart adds up to exactly what was said.
 */
export async function offerDeal(db: Docs, e: Engagement, s: Side, price: number, text: string | null, said = text ?? "", count: number | null = null, isTotal = true) {
  // An employer who names a salary has shortlisted the applicant (they chose to talk money).
  if (s === "provider" && onHold(e)) (e.hiring ??= {}).shortlisted = now();
  // A shop with no listing used to seal its shop name as the item. Seal the actual offer shown for confirmation.
  if (!e.offer.factId && said.trim()) e.offer.title = said.trim().slice(0, 160);
  // A listing with a price already settles who is paid (an employer's job post: the candidate); chat words only decide
  // it in a chat with no listed price — "could you pay ₹38,000?" from a candidate never makes the employer the seller.
  e.seller = e.offer.factId && e.offer.price != null ? (e.seller ?? "provider") : (sellerFrom(said, s) ?? e.seller ?? "provider");
  // A chat that didn't start from a listing names its item from the offer, so the cart, receipt and pickup pass say
  // what is being handed over (not the person's name).
  if (!e.offer.factId || e.offer.price == null) e.offer.title = dealItem(said) ?? e.offer.title;
  // A count said now becomes the conversation's; otherwise the offer is for as many as were already asked for.
  if (count != null && count >= 1) e.quantity = count;
  const units = unitsOf(e);
  // A seller's "most per buyer" rule, like stock: more than that is refused before anyone is asked — saying whichever
  // of the two actually binds, so the offer suggested instead can go through.
  const cap = e.offer.factId ? ((await db.get(FACTS, e.offer.factId)) as Fact | null)?.offer?.maxPerBuyer : undefined;
  const free = await inStock(db, e);
  if (cap && units > cap && (free === null || cap <= free)) {
    const mine = s === sellerOf(e);
    throw new ShortStock(cap, mine ? `Your rule is at most ${cap} per person.` : `${e[sellerOf(e)].name} offers at most ${cap} per person — offer for ${cap} instead?`, true);
  }
  // More than the seller has can't be sold: refused before anyone is asked, with what's there.
  if (free !== null && free < units) {
    const mine = s === sellerOf(e);
    throw new ShortStock(free, free === 0 ? (mine ? "You're out of stock — restock before offering." : "They're out of stock right now.")
      : mine ? `You have ${free} in stock — offer ${free} or fewer.` : `Only ${free} in stock — they can't sell ${units}. Offer for ${free} instead?`);
  }
  const p: Proposal = { id: newId(), price, terms: {}, round: (s === "provider" ? e.negotiation.provider : e.negotiation.requester).length + 1 };
  if (units > 1) {
    const total = isTotal ? price : price * units, unit = Math.floor(total / units);
    p.terms = { quantity: units };
    if (total % units === 0) p.price = unit;
    else { p.price = unit; p.items = [{ id: "item_1", title: e.offer.title, quantity: units - 1, unitPrice: unit }, { id: "item_2", title: e.offer.title, quantity: 1, unitPrice: total - unit * (units - 1) }]; }
  }
  (s === "provider" ? e.negotiation.provider : e.negotiation.requester).push(p);
  e.negotiation.lastBy = s;
  e.negotiation.deal = p; e.negotiation.dealBy = s; e.phase = "deal";
  // An offer is the offerer's confirmation — except in hiring, where a salary named is only agreed (the employer's
  // letter and the candidate's decision on it settle it).
  e.negotiation.confirmed = hireDeal(e) ? { requester: false, provider: false } : { requester: s === "requester", provider: s === "provider" };
  if (!hireDeal(e)) (e.negotiation.confirmedBy ??= {})[s] = "owner";
  // An offer is the offerer's confirmation: a buyer's must fit their goal's budget.
  const over = await budgetCheck(db, e, s);
  if (over) throw new Refused(over);
  if (text) say(e, s, text, "owner");
  const n = p.terms.quantity ?? 1, all = p.items?.length ? p.items.reduce((t, l) => t + l.quantity * l.unitPrice, 0) : p.price * n;
  say(e, "system", n > 1
    ? `Deal offered: ${n} for ${moneyText({ amount: all, currency: currencyOf(e) })} (${moneyText({ amount: Math.round((all / n) * 100) / 100, currency: currencyOf(e) })} each). Nothing is final until both confirm.`
    : `Deal offered at ${moneyText({ amount: p.price, currency: currencyOf(e), period: e.offer.unit })}. Nothing is final until both confirm.`);
  const o = other(s);
  // An earlier offer still waiting on them is replaced by this one; questions they haven't answered stay.
  const stale: string[] = [];
  for (const id of e.waiting[o]?.inbox ?? []) {
    const i = (await db.get(INBOX, id)) as InboxItem | null;
    // An earlier offer to confirm, or a plain "your move", is replaced by this offer to answer.
    if (i?.kind === "confirm" || (i?.kind === "move" && !i.question) || (i?.kind === "move" && i.counter)) { stale.push(id); await db.update(INBOX, id, (x: InboxItem | null) => (x ? { ...x, status: "done" } : null)); }
  }
  const keep = (e.waiting[o]?.inbox ?? []).filter(id => !stale.includes(id));
  e.waiting[o] = keep.length ? { ...e.waiting[o]!, inbox: keep } : null;
  // A counter-offer answers the offer (or the counter) they were asked about: that request is done too.
  const mine: string[] = [];
  for (const id of e.waiting[s]?.inbox ?? []) {
    const i = (await db.get(INBOX, id)) as InboxItem | null;
    if (i?.kind === "confirm" || i?.kind === "move") { mine.push(id); await db.update(INBOX, id, (x: InboxItem | null) => (x ? { ...x, status: "done" } : null)); }
  }
  const left = (e.waiting[s]?.inbox ?? []).filter(id => !mine.includes(id));
  e.waiting[s] = left.length ? { ...e.waiting[s]!, inbox: left } : null;
  e.negotiation.chatOffer = true;
  // Hiring: a candidate is offered a salary to take, counter or walk away from; an employer offered one answers it
  // with an offer letter (or a counter). Anything else: confirm.
  if (hireDeal(e) && o === sellerOf(e)) await ask(db, e, o, { kind: "move", question: `${e[s].name} offers ${describeDeal(e)}. Take it, offer another ${rolesFor(e.offer.category).price}, or walk away.`,
    listPrice: p.price, counter: { price: p.price, quantity: 1, total: p.price, by: e[s].name } });
  else await askConfirm(db, e, o);
  await save(db, e);
}

/**
 * A typed offer — from the card or the chat — reaches the other side's agent before its owner. Inside the owner's
 * delegated limit it's confirmed at once when they let their agent close deals, else put to them to confirm (as
 * before). Outside it, the agent counters on its own within the limit, exactly as in an agent-to-agent negotiation; if
 * the other side delegated too, their agent answers, and so on until a deal inside both limits, or a person is
 * needed. Nobody is asked yes or no about a price their agent can negotiate. Without a delegated limit, the owner
 * decides, as before.
 */
/** Taking the offer on the table at its terms (typed: "I'll buy it for ₹450") is saying yes to it; the other side
 *  confirms next if it hasn't (its agent, if it may close deals, already has). */
export async function takeOffer(db: Docs, e: Engagement, s: Side, text: string): Promise<Engagement> {
  say(e, s, text, "owner");
  if (hireDeal(e)) {
    for (const id of e.waiting[s]?.inbox ?? []) await db.update(INBOX, id, (x: InboxItem | null) => (x && (x.kind === "confirm" || x.kind === "move") ? { ...x, status: "done" } : x));
    e.waiting[s] = null;
    say(e, "system", `${e[s].name} took it: ${describeDeal(e)}. Next, the offer letter.`);
    await askConfirm(db, e, buyerOf(e));
    await save(db, e);
    return e;
  }
  for (const id of e.waiting[s]?.inbox ?? []) await db.update(INBOX, id, (x: InboxItem | null) => (x && (x.kind === "confirm" || x.kind === "move") ? { ...x, status: "done" } : x));
  const left: string[] = [];
  for (const id of e.waiting[s]?.inbox ?? []) if (((await db.get(INBOX, id)) as InboxItem | null)?.status === "open") left.push(id);
  e.waiting[s] = left.length ? { ...e.waiting[s]!, inbox: left } : null;
  const over = await budgetCheck(db, e, s);
  if (over) throw new Refused(over);
  e.negotiation.confirmed[s] = true;
  (e.negotiation.confirmedBy ??= {})[s] = "owner";
  say(e, "system", `${e[s].name} took it: ${describeDeal(e)}.`);
  settle(e);
  const o = other(s);
  if (e.phase === "deal" && !e.negotiation.confirmed[o]) {
    const l = await limitFor(db, e, o);
    if (mayClose(l, e, o, e.negotiation.deal)) {
      e.negotiation.confirmed[o] = true; (e.negotiation.confirmedBy ??= {})[o] = "mandate";
      say(e, agentOf(o), `Confirmed on ${shortName(e[o].name)}'s behalf.`, "rules"); settle(e);
    } else if (hasOwner(e, o) && !e.waiting[o]?.inbox.length) await ask(db, e, o, { kind: "confirm" });
  }
  await save(db, e);
  return e;
}
const describeDeal = (e: Engagement) => {
  const d = e.negotiation.deal!, n = d.items?.length ? d.items.reduce((t, l) => t + l.quantity, 0) : unitsOf(e);
  const total = d.items?.length ? d.items.reduce((t, l) => t + l.quantity * l.unitPrice, 0) : d.price * n;
  return n > 1 ? `${n} for ${moneyText({ amount: total, currency: currencyOf(e) })} (${moneyText({ amount: Math.round((total / n) * 100) / 100, currency: currencyOf(e) })} each)` : moneyText({ amount: d.price, currency: currencyOf(e), period: e.offer.unit });
};

export async function respondToOffer(db: Docs, model: Model | null, e: Engagement): Promise<Engagement> {
  let agreed = false;
  for (let round = 0; round < 12 && e.phase === "deal" && e.negotiation.deal && e.negotiation.dealBy; round++) {
    const s = other(e.negotiation.dealBy), l = await limitFor(db, e, s), deal = e.negotiation.deal;
    if (!l || e.negotiation.confirmed[s]) break; // no delegated limit: the owner decides (they've been asked)
    if (s === "provider" && onHold(e)) break; // an unshortlisted application: the employer decides, not their agent
    const c = ctx(e, s, l.mandate);
    if (acceptable(deal, c)) {
      agreed = true;
      const fewer = s !== sellerOf(e) && e.wanted && unitsOf(e) < e.wanted;
      if (mayClose(l, e, s, deal) && !fewer && !hireDeal(e) && !(await budgetCheck(db, e, s))) {
        await doneConfirms(db, e, s);
        e.negotiation.confirmed[s] = true;
        (e.negotiation.confirmedBy ??= {})[s] = "mandate";
        say(e, agentOf(s), `Confirmed on ${shortName(e[s].name)}'s behalf.`, "rules");
        settle(e);
      } else say(e, agentOf(s), `${describe(deal, c)} works for us — ${shortName(e[s].name)} gives the final yes.`, "rules");
      break;
    }
    // Outside the limit: the agent negotiates instead of asking its owner yes or no.
    await doneConfirms(db, e, s);
    e.negotiation.deal = null; e.negotiation.dealBy = null; e.negotiation.chatOffer = false;
    e.negotiation.confirmed = { requester: false, provider: false };
    const out: Turn = { kind: "collab.turn/v1", from: s, engagementId: e.id };
    const r = await move(model, e, s, l.mandate, out, true);
    if (r?.escalate) {
      if (hasOwner(e, s)) await ask(db, e, s, { kind: "move", question: r.escalate, listPrice: e.offer.price ?? undefined });
      say(e, "system", checking(e, s));
      break;
    }
    if (!out.proposal) break;
    // The counter is the offer on the table now. It's this side's confirmation only if its owner lets it close deals.
    e.negotiation.deal = out.proposal; e.negotiation.dealBy = s; e.phase = "deal"; e.negotiation.chatOffer = true;
    // A hire is never closed by a standing mandate: the offer letter is the people's.
    const own = mayClose(l, e, s, out.proposal) && !hireDeal(e);
    e.negotiation.confirmed = { requester: s === "requester" && own, provider: s === "provider" && own };
    if (e.negotiation.confirmed[s]) (e.negotiation.confirmedBy ??= {})[s] = "mandate";
    const o = other(s);
    if (await limitFor(db, e, o)) continue; // their agent answers the counter
    if (hasOwner(e, o)) {
      const n = unitsOf(e);
      await ask(db, e, o, { kind: "move", question: `${e[s].name} counters: ${describe(out.proposal, c)}. Take it, offer another price, or walk away.`,
        listPrice: out.proposal.price, counter: { price: out.proposal.price, quantity: n, total: out.proposal.price * n, by: e[s].name } });
    }
    break;
  }
  // Terms both agents accept: whoever still has to confirm them (owners who confirm deals themselves) is asked once.
  if (agreed && e.phase === "deal") for (const x of ["requester", "provider"] as Side[])
    if (!e.negotiation.confirmed[x] && !e.waiting[x]?.inbox.length && hasOwner(e, x)) await askConfirm(db, e, x);
  await save(db, e);
  return e;
}

export function summary(e: Engagement): string {
  const last = e.events.at(-1)?.text ?? "";
  const deal = e.negotiation.deal ? ` · ${moneyText({ amount: e.negotiation.deal.price, currency: currencyOf(e), period: e.offer.unit })}` : "";
  return `${e.phase}${deal} · ${last.slice(0, 80)}`;
}

/** `ownerPays`: the listing's owner pays (an employer's job post), so the requester is the one paid. */
export function fresh(args: { id?: string; briefId: string | null; brief: SharedBrief; requester: Engagement["requester"]; provider: Engagement["provider"];
  offer: Engagement["offer"]; ownerPays?: boolean }): Engagement {
  return { id: args.id ?? newId(), taskId: null, contextId: null, briefId: args.briefId, requester: args.requester, provider: args.provider,
    ...(args.ownerPays ? { seller: "requester" as Side } : {}),
    participants: [args.requester.uid, args.provider.uid].filter(Boolean) as string[], title: args.brief.title, brief: args.brief, offer: args.offer,
    phase: "asking", waiting: { requester: null, provider: null }, gathered: false, policy: policyHash(policy()),
    qa: args.brief.questions.map(q => ({ id: newId(), from: "requester" as Side, question: q, status: "open" as const, required: true })),
    negotiation: { requester: [], provider: [], deal: null, dealBy: null, confirmed: { requester: false, provider: false } },
    events: [], createdAt: now(), updatedAt: now() };
}
