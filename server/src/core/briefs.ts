// A request becomes a brief (Collab's EngagementBrief): Gemini reads the category, the request's own filters and the
// owner's limit; providers get a brief with no exact budget, no coordinates and nothing private. The draft goes back
// to the owner's device for review — the limit stays there unless the owner hands it to their always-on agent.
import type { Model } from "../ai/gemini.ts";
import { decide } from "../ai/decide.ts";
import type { Docs } from "../docs.ts";
import { budgetBand, budgetUpper } from "../market/match.ts";
import { read } from "../market/read.ts";
import { type Mandate, type Need, type Place, newId } from "../market/types.ts";
import type { Brief, SharedBrief } from "./model.ts";
import { type Clarify, ClarifyTask, SharedBriefTask } from "./tasks.ts";

export const BRIEFS = "briefs";

/** `clarify`: what Gemini suggests the owner adds before sending (tap-to-answer options). */
export interface BriefDraft { need: Need; shared: SharedBrief; mandate: Mandate | null; clarify: Clarify[]; byModel: Record<string, boolean> }

export async function draft(model: Model | null, text: string, here: Place | null, now: number, category?: string | null): Promise<{ draft: BriefDraft | null; problem?: string }> {
  const r = await read(text, "find", model, now, here, category);
  if (r.draft?.kind !== "need") return { draft: null, problem: r.problem ?? "Couldn't read that as a request." };
  const need = r.draft.need;
  const known = [`area: ${need.place.name}`, ...(need.mode ? [`how: ${need.mode}`] : []), ...need.filters.map(f => `${f.label}: ${f.value}`)];
  const [s, c] = await Promise.all([
    decide(model, SharedBriefTask, { text, category: need.category, limit: need.mandate?.price.limit ?? need.maxPrice ?? null }),
    decide(model, ClarifyTask, { text, category: need.category, known }),
  ]);
  return { draft: { need, shared: share(need, s.output), mandate: need.mandate ?? null, clarify: c.output, byModel: { ...r.byModel, brief: s.byModel, clarify: c.byModel } } };
}

/** What crosses to providers: requirements without money or coordinates, and the budget as a band. */
export function share(need: Need, words: { title: string; summary: string }): SharedBrief {
  const band = budgetBand(need);
  return {
    title: words.title, summary: words.summary, category: need.category, mode: need.mode ?? null,
    area: need.place.name === "Online" ? null : need.place.name,
    requirements: need.filters.filter(f => f.kind !== "price" && f.kind !== "place").map(f => ({ label: f.label, value: f.value, strength: f.strength })),
    budget: band, questions: need.mustAsk.slice(0, 4),
  };
}

/** Stores the brief the owner sent: the need for matching keeps only the band, never the exact limit. */
export async function saveBrief(db: Docs, owner: string, need: Need, shared: SharedBrief, now: number): Promise<Brief> {
  // The owner's own words can hold the exact budget ("…up to 36,000"): only the shared wording and the band are kept,
  // and filters keep no quoted evidence.
  const banded: Need = { ...need, text: `${shared.title}. ${shared.summary}`, mandate: null, maxPrice: budgetUpper(need),
    filters: need.filters.filter(f => f.kind !== "price").map(f => ({ ...f, evidence: "" })) };
  const b: Brief = { id: newId(), owner, shared, need: banded, createdAt: now };
  await db.set(BRIEFS, b.id, b);
  return b;
}
