// What the owner has told their agent, kept so they're never asked the same thing twice. Every answer the owner gives
// (to another agent's question, to a request's or a listing's questions) is kept in their own words, with the
// question. When the same question comes up again — from any agent, in other words — their always-on agent gives that
// answer itself: the exact words, matched by the question, no model involved (and recorded in what it shared). On
// their devices the same answers fill in new requests and listings. Contact details are never given out this way;
// the owner can delete an answer, or set it to "ask me first", in About me.
import { createHash } from "node:crypto";
import type { Docs } from "../docs.ts";
import { hasContact } from "../market/text.ts";
import { savedKey } from "../market/answer.ts";
import type { Fact } from "./model.ts";
import { FACTS } from "./policy.ts";

export interface Remembered { question: string; answer: string; about?: string; reuse?: boolean }

const STOP = new Set(["a", "an", "the", "do", "does", "did", "is", "are", "you", "your", "i", "my", "me", "we", "of", "for", "to", "in", "on", "at",
  "what", "which", "how", "would", "will", "can", "could", "should", "it", "this", "that", "and", "or", "be", "have", "has", "any", "prefer", "like", "want"]);
const words = (q: string) => new Set(savedKey(q).split(" ").filter(w => w.length > 1 && !STOP.has(w)));

/** One note per owner and question: asked again, the answer is updated rather than added twice. */
export const memoryId = (owner: string, question: string) => `m${createHash("sha256").update(`${owner}\u0000${savedKey(question)}`).digest("hex").slice(0, 30)}`;

/** How alike two questions are (0–1): the same question in other words scores high, a different one low. */
export function likeness(a: string, b: string): number {
  if (savedKey(a) === savedKey(b)) return 1;
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / Math.max(x.size, y.size);
}

/** Keeps an answer as a Private note. Contact details are never given out again on the owner's behalf. */
export async function rememberAnswer(db: Docs, owner: string, r: Remembered, now: number): Promise<Fact | null> {
  const question = String(r.question ?? "").trim().slice(0, 200), answer = String(r.answer ?? "").trim().slice(0, 400);
  if (question.length < 4 || !answer || /^(not shared\.?|i'd rather not say)$/i.test(answer)) return null;
  const id = memoryId(owner, question);
  const prev = (await db.get(FACTS, id)) as Fact | null;
  if (prev && prev.owner !== owner) return null;
  const fact: Fact = { id, owner, text: `${question.replace(/\?*$/, "?")} — ${answer}`, tier: "private", topics: [], offer: null, source: "answer",
    question, answer, ...(r.about ? { about: String(r.about).slice(0, 80) } : prev?.about ? { about: prev.about } : {}),
    reuse: r.reuse !== false && !hasContact(answer), createdAt: prev?.createdAt ?? now, updatedAt: now };
  await db.set(FACTS, id, fact);
  return fact;
}

export async function savedAnswers(db: Docs, owner: string): Promise<Fact[]> {
  return ((await db.find(FACTS, [["owner", "==", owner]], 500)) as Fact[]).filter(f => f.source === "answer" && f.question && f.answer);
}

/** The owner's earlier answer to this question (or one asked in other words), if there is one. */
export function matchSaved(saved: Fact[], question: string, onlyReuse = false): Fact | null {
  let best: Fact | null = null, score = 0;
  for (const f of saved) {
    if (onlyReuse && !f.reuse) continue;
    const s = likeness(f.question!, question);
    if (s > score) { best = f; score = s; }
  }
  return score >= 0.6 ? best : null;
}
