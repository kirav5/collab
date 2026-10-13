// The device agent: the half of your agent that runs in this browser. It routes what you type, answers from your
// notes, drafts requests and offerings with you, and handles what your always-on agent can't alone: a move with
// your private limit, or a question only your private notes answer (drafted here, shared only if you say so).
// Private facts live in Firestore with everything else; the policy gate never shares them.
//
// Model calls over private notes use Gemini Nano in the browser when Chrome has it; otherwise Gemini through the
// server for that one call, which logs nothing.
import { api, insightsLines, session } from "./api.js";
import { relevant } from "./local.js";
import { live, onChange, poke } from "./live.js";

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
  return r.action === "answer" ? { text: r.text ?? r.answer, evidence: r.evidence, on: "gemini" } : null;
}

/** What a request is for, for comparing with past deals ("water bottle", else the brief's title). */
export const itemOf = draft => draft.need.attributes?.item ?? draft.shared.requirements.find(r => /^item$/i.test(r.label))?.value ?? draft.shared.title;

// MARK: - Your chat

/** `open`: the latest request card in this chat ({ draft, autonomy, days }), so follow-ups can change it. */
export async function chat(text, recent, area, open = null) {
  const route = await api("/api/route", { text, recent, open: open?.draft.shared.title ?? null });
  switch (route.intent) {
    case "remember": {
      const fact = await api("/api/facts", { text, tier: "private" });
      return { text: "Saved to your context — only your agent can use it; it's never shared.", cards: [{ type: "saved", factId: fact.id, suggestPublic: route.tier === "public" }] };
    }
    case "ask_self": {
      const facts = await api("/api/facts").catch(() => []);
      const notes = relevant(facts, text);
      const a = notes.length ? await think(text, notes) : null;
      if (!a) return { text: notes.length ? "Your notes don't clearly answer that." : "I don't have anything about that in your context yet.", cards: [] };
      return { text: a.text, cards: [{ type: "sources", notes: notes.filter(n => a.evidence.some(e => norm(n.text).includes(norm(e)))).map(n => ({ text: n.text, tier: n.tier })), on: a.on }] };
    }
    case "request": {
      const d = await api("/api/briefs/draft", { text, here: area });
      if (!d.draft) return { text: d.problem ?? "Couldn't read that as a request — try adding what and where.", cards: [] };
      const insights = await insightsLines({ side: "requester", category: d.draft.need.category, area: d.draft.need.place.name, unit: d.draft.need.unit, item: itemOf(d.draft) });
      return { text: "Here's what your agent will ask for. Adjust it, then send.", cards: [{ type: "brief", text, draft: d.draft, insights, step: "review" }] };
    }
    case "offer": {
      const d = await api("/api/offers/draft", { text, here: area });
      const insights = d.offer ? await insightsLines({ side: "provider", category: d.offer.category, area: d.offer.place.name, price: d.offer.price.amount, unit: d.offer.price.period, item: d.offer.title }) : [];
      return { text: d.offer ? "Here's how your offering will look in the directory." : "I'll keep this as a public note others' agents can find.", cards: [{ type: "offer", text, publicText: d.publicText ?? text, offer: d.offer ?? null, floor: d.floor ?? null, insights, step: "review" }] };
    }
    case "refine": {
      // Change the open request and search again — for real; the reply says exactly what changed and what was found.
      const d = open.draft;
      const r = await api("/api/briefs/refine", { need: d.need, shared: d.shared, text, limit: d.mandate?.price.limit ?? null });
      const mandate = r.limit ? { price: { opening: Math.round(r.limit * 0.9), limit: r.limit }, terms: {}, maxRounds: d.mandate?.maxRounds ?? 5 } : d.mandate;
      const draft = { ...d, need: { ...r.need, mandate }, shared: r.shared, mandate };
      const s = await api("/api/briefs", { need: draft.need, shared: draft.shared, delegate: mandate && open.autonomy ? { mandate, autonomy: open.autonomy, days: open.days ?? 7 } : null });
      const found = [...s.found, ...(s.overBudget ?? []).map(f => ({ ...f, over: true }))];
      const what = r.changes.length ? `Searched again — ${r.changes.join(", ")}.` : "Searched again with the same request.";
      const result = s.found.length ? `${s.found.length} ${s.found.length === 1 ? "match" : "matches"}.` : s.overBudget?.length ? "Still no exact match." : "Still no one — try a different area, or fewer requirements.";
      return { text: `${what} ${result}`, cards: found.length ? [{ type: "brief", step: "matches", text, draft, briefId: s.brief.id, found, rankedByModel: s.rankedByModel, picked: s.found.length ? [0] : [], autonomy: open.autonomy, days: open.days }] : [] };
    }
    case "ask": {
      // A plain answer first; finding sellers is offered, never started on its own. The question and its answer are
      // kept as a Private chat memory (your agent can recall them; they're never shared).
      api("/api/facts", { tier: "private", source: "chat", text: `Asked: “${text.slice(0, 300)}” — answer: ${route.reply}` }).catch(() => {});
      return { text: route.reply, cards: route.find ? [{ type: "suggest", options: [{ label: "Find sellers near me", text: route.find }] }] : [] };
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
  const ls = await api("/api/limits").catch(() => []);
  return ls.find(l => l.key === key)?.mandate ?? null;
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
      const facts = (await api("/api/facts").catch(() => [])).filter(f => f.tier === "private");
      const notes = relevant(facts, item.question ?? "");
      think(item.question, notes, item.side).then(a => { drafts.set(item.id, a ? { text: a.text, notes: notes.map(n => n.text), on: a.on } : null); for (const fn of live.listeners) fn(); })
        .catch(() => drafts.set(item.id, null)).finally(() => inflight.delete(item.id));
    }
  }
}

export function startDevice() { onChange(() => { work(); }); }
