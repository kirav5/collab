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
import { type Context, NegotiateTask, acceptable, describe } from "../market/negotiate.ts";
import { type Mandate, type Proposal, moneyText, newId } from "../market/types.ts";
import { type PaymentMandate, cartFor, sellerFrom, sellerOf } from "./pay.ts";
import type { Audit, Contact, DelegatedLimit, Engagement, Event, Fact, InboxItem, QA, SharedBrief, Side } from "./model.ts";
import { forProvider, forRequester, insights, recordDeal, registerReceipt } from "./deals.ts";
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
  questions?: { id: string; question: string }[];
  answers?: { id: string; question: string; answer: string }[];
  /** AP2: the buyer's signed payment mandate, delivered to the seller's agent. */
  payment?: PaymentMandate;
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

// MARK: - Storage helpers

export async function load(db: Docs, id: string): Promise<Engagement> {
  const e = (await db.get(ENGAGEMENTS, id)) as Engagement | null;
  if (!e) throw new Refused("engagement not found");
  return e;
}

// The agents' signing key (set by the server at start): AP2 mandates are signed per agent, like deal receipts.
let signer: ((uid: string, hash: string) => string) | null = null;
export const setSigner = (fn: (uid: string, hash: string) => string) => { signer = fn; };

export async function save(db: Docs, e: Engagement) {
  e.updatedAt = now();
  if (e.phase === "agreed" && !e.dealRecorded) { e.dealRecorded = true; await recordDeal(db, e, now()); await registerReceipt(db, e, now()); }
  // AP2: once both owners confirmed, the seller's agent issues the cart the buyer pays against.
  if (e.phase === "agreed" && !e.payment && signer) {
    if (!e.seller && e.offer.price == null) e.seller = sellerInChat(e) ?? undefined;
    const cart = cartFor(e, signer, now());
    if (cart) { e.payment = { cart, status: "awaiting", mode: "test" }; say(e, agentOf(sellerOf(e)), `Cart Mandate issued for ${moneyText({ amount: cart.total.value, currency: "INR", period: e.offer.unit })} (AP2, test mode).`, "rules"); }
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

const say = (e: Engagement, who: Event["who"], text: string, by?: Event["by"]) => { e.events.push({ at: now(), who, text: text.slice(0, 600), ...(by ? { by } : {}) }); };
const agentOf = (s: Side): Event["who"] => (s === "requester" ? "requester_agent" : "provider_agent");
const by = (m: boolean): Event["by"] => (m ? "gemini" : "rules");
const uidOf = (e: Engagement, s: Side) => (s === "requester" ? e.requester.uid : e.provider.uid);

async function limitFor(db: Docs, e: Engagement, s: Side): Promise<DelegatedLimit | null> {
  const key = s === "provider" ? `fact:${e.offer.factId}` : `brief:${e.briefId}`;
  const l = (await db.get(LIMITS, key)) as DelegatedLimit | null;
  // "ask" rows are stored so the owner's devices share the limit; the agent itself still waits on the owner.
  return l && l.owner === uidOf(e, s) && l.autonomy !== "ask" && !(l.expires && l.expires < now()) ? l : null;
}

/** Whether a side has a device that can be asked (our users and demo people do; an outside A2A agent doesn't). */
const hasOwner = (e: Engagement, s: Side) => !!uidOf(e, s);

async function ask(db: Docs, e: Engagement, s: Side, item: Omit<InboxItem, "id" | "owner" | "engagementId" | "side" | "status" | "createdAt" | "title">): Promise<string> {
  const id = newId();
  await db.set(INBOX, id, { ...item, id, owner: uidOf(e, s)!, engagementId: e.id, side: s, status: "open", title: e.title, createdAt: now() } satisfies InboxItem);
  // A move the device makes on its own needs no one's attention; everything else notifies the owner.
  if (!(item.kind === "move" && !item.question)) {
    const what = item.kind === "confirm" ? "Confirm the deal" : item.kind === "move" ? "No deal inside your limit yet" : item.kind === "approve" ? "Check an answer before it's shared" : "A question only you can answer";
    void pushTo(uidOf(e, s)!, `Your agent needs you · ${e.title}`, what, `/?engagement=${e.id}`);
  }
  e.waiting[s] = { kind: item.kind, inbox: [...(e.waiting[s]?.inbox ?? []), id], text: item.question ?? (item.kind === "move" ? "A negotiating move with your private limit" : "Confirm the deal") };
  return id;
}

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

async function answerAs(db: Docs, model: Model | null, e: Engagement, s: Side, q: QA): Promise<{ text: string; src: QA["source"]; review: boolean; byModel: boolean } | null> {
  const owner = uidOf(e, s), asker = uidOf(e, other(s));
  const key = s === "provider" && e.offer.factId ? docId(`${e.offer.factId}:${savedKey(q.question)}`) : null;
  const allowed = owner ? await allowedFor(db, owner, asker, now()) : [];
  let facts = asFacts(allowed);
  if (s === "provider" && e.offer.factId) {
    const entry = allowed.find(a => a.fact.id === e.offer.factId);
    // A cached listing answer is reused only while the offering is still Public (and the owner isn't paused).
    if (key && entry && !entry.via) {
      const cached = await db.get(ANSWERS, key);
      if (cached) return { text: cached.answer, src: "listing", review: false, byModel: false };
    }
    if (entry?.fact.offer) facts = [...offerFacts(entry.fact.offer, {}), ...facts];
  }
  if (s === "requester") {
    const b = e.brief;
    facts = [{ label: "What they need", value: `${b.title}. ${b.summary}` }, ...(b.area ? [{ label: "Area", value: b.area }] : []),
      ...(b.mode ? [{ label: "How", value: b.mode.replace("_", " ") }] : []), ...(b.budget ? [{ label: "Budget", value: b.budget }] : []),
      ...b.requirements.map(r => ({ label: r.label, value: r.value })), ...facts];
  }
  if (!facts.length) return null;
  const d = await decide(model, AnswerTask, { question: q.question, facts, side: s === "provider" ? "seller" : "buyer" });
  if (d.output.action !== "answer") return null;
  const from = source(allowed, d.output.evidence);
  if (key && !from?.via && (!from || from.fact.id === e.offer.factId))
    await db.set(ANSWERS, key, { factId: e.offer.factId, owner, question: q.question, answer: d.output.text, evidence: d.output.evidence, at: now() });
  const text = from?.via ? shapeAnswer(d.output.text, from.via.shape) : d.output.text;
  return { text, src: from ? (from.via ? "protected" : "public") : s === "requester" ? "brief" : "listing", review: from?.via?.approval === "review", byModel: d.byModel };
}

async function audit(db: Docs, owner: string | null, to: string, q: string, a: string, tier: "public" | "protected") {
  if (!owner) return;
  const id = newId();
  await db.set(AUDIT, id, { id, owner, at: now(), to, question: q.slice(0, 300), answer: a.slice(0, 600), tier, rule: null } satisfies Audit);
}

/** This side's agent answers the other side's open questions; what it can't answer goes to its owner. */
async function answerOpen(db: Docs, model: Model | null, e: Engagement, s: Side, out: Turn) {
  const names = await wallNames(db, uidOf(e, s), uidOf(e, other(s)) ?? "");
  const toName = s === "provider" ? e.requester.name : e.provider.name;
  for (const q of e.qa.filter(q => q.from === other(s) && q.status === "open")) {
    const a = await answerAs(db, model, e, s, q);
    if (a && !a.review) {
      q.answer = clean(a.text, names, [toName]);
      q.source = a.src;
      q.status = "answered";
      (out.answers ??= []).push({ id: q.id, question: q.question, answer: q.answer });
      say(e, agentOf(s), q.answer, by(a.byModel));
      if (a.src === "public" || a.src === "protected") await audit(db, uidOf(e, s), toName, q.question, q.answer, a.src);
    } else if (hasOwner(e, s)) {
      q.status = "pending";
      (out.pending ??= []).push(q.question);
      if (a?.review) await ask(db, e, s, { kind: "approve", qaId: q.id, question: q.question, draft: a.text });
      else await ask(db, e, s, { kind: "answer", qaId: q.id, question: q.question });
      say(e, agentOf(s), s === "provider" ? "Let me check with the provider." : "Let me check with my owner.", "rules");
    } else {
      q.status = "declined";
      (out.declined ??= []).push(q.question);
    }
  }
}

// MARK: - Negotiating

function ctx(e: Engagement, s: Side, mandate: Mandate): Context {
  const n = e.negotiation;
  return { side: s === "provider" ? "seller" : "buyer", catalog: catalog(domainOf(e.offer.category ?? "")), mandate, unit: e.offer.unit,
    mine: s === "provider" ? n.provider : n.requester, theirs: s === "provider" ? n.requester : n.provider };
}

/** One move with this side's limit (delegated to the cloud agent, or sent by the owner's device for this one move). */
export async function move(model: Model | null, e: Engagement, s: Side, mandate: Mandate, out: Turn) {
  // A requester never opens above the asking price (a little under it instead).
  if (s === "requester" && e.offer.price && mandate.price.opening >= e.offer.price) {
    mandate = { ...mandate, price: { ...mandate.price, opening: Math.round(e.offer.price * 0.92) } };
  }
  const c = ctx(e, s, mandate);
  const m = await decide(model, NegotiateTask, { ctx: c, listPrice: e.offer.price ?? mandate.price.opening });
  const mv = m.output;
  if (mv.action === "propose") {
    (s === "provider" ? e.negotiation.provider : e.negotiation.requester).push(mv.proposal);
    out.proposal = mv.proposal;
    out.note = mv.message;
    e.phase = "negotiating";
    say(e, agentOf(s), mv.message, by(m.byModel));
  } else if (mv.action === "accept") {
    const theirs = c.theirs.at(-1)!;
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
  const l = await limitFor(db, e, s);
  if (l) {
    const r = await move(model, e, s, l.mandate, out);
    if (r?.escalate && hasOwner(e, s)) { await ask(db, e, s, { kind: "move", question: r.escalate, listPrice: e.offer.price ?? undefined, hint: await hint() }); say(e, "system", s === "provider" ? "The provider's agent is checking with the provider." : "Your agent needs you: no deal inside your limit yet."); }
    return;
  }
  if (hasOwner(e, s)) await ask(db, e, s, { kind: "move", listPrice: e.offer.price ?? undefined, hint: await hint() });
}

const myTurnToMove = (e: Engagement, s: Side) => {
  const n = e.negotiation, mine = s === "provider" ? n.provider.length : n.requester.length, theirs = s === "provider" ? n.requester.length : n.provider.length;
  // The provider opens with its quote once the questions are settled; then turns alternate.
  return s === "provider" ? mine === theirs : theirs > mine;
};

const pendingFor = (e: Engagement, s: Side) => !!e.waiting[s];
const questionsOpen = (e: Engagement) => e.qa.some(q => q.status === "open" || q.status === "pending");

// MARK: - The provider's agent

/** Applies the requester's turn and decides the provider's. */
export async function providerTurn(db: Docs, model: Model | null, e: Engagement, t: Turn): Promise<Turn> {
  const out: Turn = { kind: "collab.turn/v1", from: "provider", engagementId: e.id };
  applyTheirs(e, "provider", t);
  if (["agreed", "declined", "closed"].includes(e.phase)) return out;
  // Requirement gathering, once: what the provider needs to know that the brief doesn't say.
  if (!e.gathered && e.offer.factId) {
    e.gathered = true;
    const fact = (await db.get(FACTS, e.offer.factId)) as Fact | null;
    const usual = domainOf(e.offer.category ?? "")?.sellerAsks ?? [];
    const g = await decide(model, GatherTask, { offering: fact?.text ?? e.offer.title, brief: e.brief, answered: e.qa.filter(q => q.answer).map(q => q.question), usual });
    for (const question of g.output) {
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
        out.decline = "That doesn't work for my owner, so we'll leave it here. Thank you.";
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
  if (e.phase === "deal") {
    if (!e.negotiation.confirmed[s]) {
      // A "close" mandate is the owner's confirmation given in advance, while the deal is inside its limit.
      const l = await limitFor(db, e, s);
      const deal = e.negotiation.deal;
      if (l?.autonomy === "close" && deal && acceptable(deal, ctx(e, s, l.mandate))) {
        e.negotiation.confirmed[s] = true;
        (e.negotiation.confirmedBy ??= {})[s] = "mandate";
        out.confirm = true;
        say(e, s, "Confirmed by a standing mandate (the owner pre-authorised deals inside their limit).", "rules");
      } else {
        const demo = s === "provider" && (await db.get(PROFILES, e.provider.uid))?.demo;
        if (demo) { e.negotiation.confirmed.provider = true; out.confirm = true; say(e, "provider", "Confirmed.", "owner"); }
        else if (hasOwner(e, s)) await ask(db, e, s, { kind: "confirm" });
      }
    }
    settle(e);
    return;
  }
  if (!questionsOpen(e) && myTurnToMove(e, s) && !out.questions?.length) {
    await moveOrAsk(db, model, e, s, out);
    // moveOrAsk may have reached a deal (TypeScript can't see the phase change through the call).
    if ((e.phase as Engagement["phase"]) === "deal") await afterAnswers(db, model, e, s, out);
  }
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
  if (t.proposal && !(them === "provider" ? e.negotiation.provider : e.negotiation.requester).some(p => p.id === t.proposal!.id)) {
    (them === "provider" ? e.negotiation.provider : e.negotiation.requester).push(t.proposal);
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

export interface Resolution { text?: string; share?: boolean; mandate?: Mandate; confirm?: boolean; decline?: boolean }

/** The owner's device resolves an inbox item: an answer (typed, or drafted from private notes and approved), a move
 *  with the private limit (used for this move only, never stored), a confirmation. Returns the turn to send if this
 *  side has nothing else waiting. */
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
    if (r.decline) { e.phase = "closed"; out.decline = "My owner has decided not to go ahead. Thank you."; say(e, agentOf(s), out.decline, "owner"); }
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
        say(e, "system", "No deal inside the limit yet — the owner can change it.");
        await save(db, e);
        return { e, turn: null };
      }
    }
  } else if (item.kind === "confirm") {
    if (r.decline && e.offer.price == null) {
      // A deal offered in a direct chat: saying no keeps the conversation open for another offer.
      say(e, s, `Said no to ${moneyText({ amount: e.negotiation.deal?.price ?? 0, currency: "INR", period: e.offer.unit })}.`, "owner");
      e.phase = "asking"; e.negotiation.deal = null; e.negotiation.dealBy = null; e.negotiation.confirmed = { requester: false, provider: false };
    } else if (r.decline) { e.phase = "closed"; out.decline = "My owner decided not to go ahead. Thank you."; say(e, s, "Walked away.", "owner"); }
    else { e.negotiation.confirmed[s] = true; out.confirm = true; say(e, s, "Confirmed.", "owner"); settle(e); }
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
export async function offerDeal(db: Docs, e: Engagement, s: Side, price: number, text: string | null, said = text ?? "") {
  e.seller = sellerFrom(said, s) ?? e.seller ?? "provider";
  const p = { id: newId(), price, terms: {}, round: (s === "provider" ? e.negotiation.provider : e.negotiation.requester).length + 1 };
  (s === "provider" ? e.negotiation.provider : e.negotiation.requester).push(p);
  e.negotiation.deal = p; e.negotiation.dealBy = s; e.phase = "deal";
  e.negotiation.confirmed = { requester: s === "requester", provider: s === "provider" };
  (e.negotiation.confirmedBy ??= {})[s] = "owner";
  if (text) say(e, s, text, "owner");
  say(e, "system", `Deal offered at ${moneyText({ amount: price, currency: "INR", period: e.offer.unit })}. Nothing is final until both confirm.`);
  const o = other(s);
  // An earlier offer still waiting on them is replaced by this one; questions they haven't answered stay.
  const stale: string[] = [];
  for (const id of e.waiting[o]?.inbox ?? []) {
    const i = (await db.get(INBOX, id)) as InboxItem | null;
    if (i?.kind === "confirm") { stale.push(id); await db.update(INBOX, id, (x: InboxItem | null) => (x ? { ...x, status: "done" } : null)); }
  }
  const keep = (e.waiting[o]?.inbox ?? []).filter(id => !stale.includes(id));
  e.waiting[o] = keep.length ? { ...e.waiting[o]!, inbox: keep } : null;
  await ask(db, e, o, { kind: "confirm" });
  await save(db, e);
}

export function summary(e: Engagement): string {
  const last = e.events.at(-1)?.text ?? "";
  const deal = e.negotiation.deal ? ` · ${moneyText({ amount: e.negotiation.deal.price, currency: "INR", period: e.offer.unit })}` : "";
  return `${e.phase}${deal} · ${last.slice(0, 80)}`;
}

export function fresh(args: { id?: string; briefId: string | null; brief: SharedBrief; requester: Engagement["requester"]; provider: Engagement["provider"];
  offer: Engagement["offer"] }): Engagement {
  return { id: args.id ?? newId(), taskId: null, contextId: null, briefId: args.briefId, requester: args.requester, provider: args.provider,
    participants: [args.requester.uid, args.provider.uid].filter(Boolean) as string[], title: args.brief.title, brief: args.brief, offer: args.offer,
    phase: "asking", waiting: { requester: null, provider: null }, gathered: false,
    qa: args.brief.questions.map(q => ({ id: newId(), from: "requester" as Side, question: q, status: "open" as const, required: true })),
    negotiation: { requester: [], provider: [], deal: null, dealBy: null, confirmed: { requester: false, provider: false } },
    events: [], createdAt: now(), updatedAt: now() };
}
