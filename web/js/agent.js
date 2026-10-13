// The device agent: the half of your agent that runs in this browser and knows everything, private context
// included. It routes what you type, answers from your notes, drafts requests and offerings with you, and handles
// what your always-on agent can't: a move with your private limit (made automatically, the limit sent for that one
// move and never stored), or a question only your private notes answer (drafted here, shared only if you say so).
//
// Model calls over private notes use Gemini Nano in the browser when Chrome has it; otherwise Gemini through the
// server for that one call, which stores and logs nothing.
import { api, insightsLines, session } from "./api.js";
import { local, relevant } from "./local.js";
import { live, onChange, poke } from "./live.js";
import { id, now } from "./ui.js";

export const engine = { nano: false };
export const drafts = new Map(); // inbox item id → { text, notes } drafted from private notes
export const needsLimit = new Set(); // move items this device has no limit for (the owner sets one)

export async function detectNano() {
  try {
    if ("LanguageModel" in self && (await self.LanguageModel.availability()) === "available") engine.nano = true;
  } catch { engine.nano = false; }
  return engine.nano;
}

const norm = s => s.toLowerCase().replace(/,/g, "").replace(/\s+/g, " ");
const nums = s => (s.replace(/(\d),(?=\d)/g, "$1").match(/\d+(?:\.\d+)?/g) ?? []);

/** An answer from these notes only, with the evidence it relied on (checked: quoted from the notes, no new numbers). */
export async function think(question, notes, side = "self") {
  if (!notes.length) return null;
  if (engine.nano) {
    try {
      const lm = await self.LanguageModel.create({ initialPrompts: [{ role: "system", content: "Answer the question using ONLY the notes. Return JSON {\"answer\":\"...\",\"evidence\":[\"exact text copied from the notes\"]} or {\"answer\":null} if the notes don't answer it." }] });
      const raw = await lm.prompt(`Notes:\n${notes.map(n => "- " + n.text).join("\n")}\n\nQuestion: ${question}`, { responseConstraint: { type: "object", properties: { answer: { type: ["string", "null"] }, evidence: { type: "array", items: { type: "string" } } } } });
      lm.destroy?.();
      const o = JSON.parse(raw);
      const corpus = norm(notes.map(n => n.text).join("\n"));
      if (o.answer && (o.evidence ?? []).length && o.evidence.every(e => corpus.includes(norm(e))) && nums(o.answer).every(n => corpus.includes(n))) {
        return { text: o.answer, evidence: o.evidence, on: "device" };
      }
      return null;
    } catch { /* fall through to Gemini */ }
  }
  const r = await api("/api/think", { question, notes: notes.map(n => ({ text: n.text })), side });
  return r.action === "answer" ? { text: r.answer, evidence: r.evidence, on: "gemini" } : null;
}

// MARK: - Your chat

export async function chat(text, recent, area) {
  const route = await api("/api/route", { text, recent });
  switch (route.intent) {
    case "remember": {
      const fact = { id: id(), text, tier: "private", topics: [], createdAt: now() };
      await local.put("facts", fact);
      return { text: "Saved to your context, on this device only.", cards: [{ type: "saved", factId: fact.id, suggestPublic: route.tier === "public" }] };
    }
    case "ask_self": {
      const facts = await local.all("facts");
      const notes = relevant(facts, text);
      const a = notes.length ? await think(text, notes) : null;
      if (!a) return { text: notes.length ? "Your notes don't clearly answer that." : "I don't have anything about that in your context yet.", cards: [] };
      return { text: a.text, cards: [{ type: "sources", notes: notes.filter(n => a.evidence.some(e => norm(n.text).includes(norm(e)))).map(n => ({ text: n.text, tier: n.tier })), on: a.on }] };
    }
    case "request": {
      const d = await api("/api/briefs/draft", { text, here: area });
      if (!d.draft) return { text: d.problem ?? "Couldn't read that as a request — try adding what and where.", cards: [] };
      const insights = await insightsLines({ side: "requester", category: d.draft.need.category, area: d.draft.need.place.name });
      return { text: "Here's what your agent will ask for. Adjust it, then send.", cards: [{ type: "brief", text, draft: d.draft, insights, step: "review" }] };
    }
    case "offer": {
      const d = await api("/api/offers/draft", { text, here: area });
      const insights = d.offer ? await insightsLines({ side: "provider", category: d.offer.category, area: d.offer.place.name, price: d.offer.price.amount }) : [];
      return { text: d.offer ? "Here's how your offering will look in the directory." : "I'll keep this as a public note others' agents can find.", cards: [{ type: "offer", text, publicText: d.publicText ?? text, offer: d.offer ?? null, floor: d.floor ?? null, insights, step: "review" }] };
    }
    default:
      return { text: route.reply ?? "I can remember things for you, answer from your notes, find people for anything you need, or publish what you offer.", cards: [] };
  }
}

// MARK: - What only this device can do

const inflight = new Set();

async function limitFor(item) {
  const e = live.engagements.get(item.engagementId);
  if (!e) return null;
  const key = item.side === "requester" ? `brief:${e.briefId}` : `fact:${e.offer.factId}`;
  return (await local.get("limits", key))?.mandate ?? null;
}

/** Moves with a private limit happen on their own while this page is open; questions get a draft from private notes. */
async function work() {
  for (const item of live.inbox) {
    if (inflight.has(item.id) || item.owner !== session.uid) continue;
    if (item.kind === "move" && !item.question) {
      const mandate = await limitFor(item);
      if (!mandate) { if (!needsLimit.has(item.id)) { needsLimit.add(item.id); for (const fn of live.listeners) fn(); } continue; }
      inflight.add(item.id);
      api(`/api/inbox/${item.id}`, { mandate }).then(poke).catch(() => {}).finally(() => setTimeout(() => inflight.delete(item.id), 5000));
    } else if (item.kind === "answer" && !drafts.has(item.id)) {
      inflight.add(item.id);
      const facts = (await local.all("facts")).filter(f => f.tier === "private");
      const notes = relevant(facts, item.question ?? "");
      think(item.question, notes, item.side).then(a => { drafts.set(item.id, a ? { text: a.text, notes: notes.map(n => n.text), on: a.on } : null); for (const fn of live.listeners) fn(); })
        .catch(() => drafts.set(item.id, null)).finally(() => inflight.delete(item.id));
    }
  }
}

export function startDevice() { onChange(() => { work(); }); }
