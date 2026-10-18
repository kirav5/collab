// A request becomes a brief (Collab's EngagementBrief): Gemini reads the category, the request's own filters and the
// owner's limit; providers get a brief with no exact budget, no coordinates and nothing private. The draft goes back
// to the owner's device for review — the limit stays there unless the owner hands it to their always-on agent.
import type { Model } from "../ai/gemini.ts";
import { decide } from "../ai/decide.ts";
import type { Docs } from "../docs.ts";
import { budgetBand, budgetLower, budgetUpper } from "../market/match.ts";
import { ClassifyTask, read } from "../market/read.ts";
import { domain as domainOf } from "../market/domains.ts";
import { type Mandate, type Need, type Place, newId } from "../market/types.ts";
import type { Brief, SharedBrief } from "./model.ts";
import { rolesFor } from "../market/roles.ts";
import { type Clarify, ClarifyTask, type ProfileQuestion, ProfileTask, SharedBriefTask } from "./tasks.ts";

export const BRIEFS = "briefs";

/** `clarify`: what Gemini suggests the owner adds before sending (tap-to-answer options). `profile`: for someone looking
 *  for work, what they share about themselves (experience, skills…) — in place of `clarify`. */
export interface BriefDraft { need: Need; shared: SharedBrief; mandate: Mandate | null; clarify: Clarify[]; profile?: ProfileQuestion[]; byModel: Record<string, boolean>;
  /** Who this goes to, in the request's own words ("electricians"), for the app's wording; null when unknown. */
  who?: string | null }

export async function draft(model: Model | null, text: string, here: Place | null, now: number, category?: string | null): Promise<{ draft: BriefDraft | null; problem?: string }> {
  // Which kind of request it is comes first (unless the app already knows). Then everything else is read at once: the
  // request's fields and filters, the words providers see, and the questions — the questions are checked against the
  // request's own words, so they don't wait for the filters. One model round after the category, not two.
  const kind = category && domainOf(category) ? category : model ? (await decide(model, ClassifyTask, { text })).output : null;
  const cat = kind && kind !== "none" && domainOf(kind) ? kind : null, asked = here?.name ? [`area: ${here.name}`] : [];
  const profileAsks = cat ? rolesFor(cat).profile : undefined;
  const [r, s0, c0, pr0] = await Promise.all([
    read(text, "find", model, now, here, category, true),
    cat ? decide(model, SharedBriefTask, { text, category: cat, limit: null }) : null,
    cat ? decide(model, ClarifyTask, { text, category: cat, known: asked }) : null,
    cat && profileAsks?.length ? decide(model, ProfileTask, { text, category: cat, asks: profileAsks }) : null,
  ]);
  if (r.draft?.kind !== "need") return { draft: null, problem: r.problem ?? "Couldn't read that as a request." };
  const need = r.draft.need, same = need.category === cat;
  const limit = need.mandate?.price.limit ?? need.maxPrice ?? need.minPrice ?? null;
  // Someone looking for work shares a short profile (what an employer screens for) instead of answering generic
  // questions; the profile is theirs to fill, and never filters what they find.
  const asks = need.requesterPaid ? rolesFor(need.category).profile : undefined;
  const known = [`area: ${need.place.name}`, ...(need.mode ? [`how: ${need.mode}`] : []), ...need.filters.map(f => `${f.label}: ${f.value}${f.upTo ? `–${f.upTo}` : ""}${f.unit ? ` ${f.unit}` : ""}`)];
  // Read in another category than first thought (rare): those pieces are asked again for the right one.
  const [s, c, pr] = await Promise.all([
    same && s0 ? s0 : decide(model, SharedBriefTask, { text, category: need.category, limit }),
    asks ? null : same && c0 ? c0 : decide(model, ClarifyTask, { text, category: need.category, known }),
    asks ? (same && pr0 ? pr0 : decide(model, ProfileTask, { text, category: need.category, asks })) : null,
  ]);
  // The words providers see never repeat the private limit (checked now that the limit is known).
  const words = SharedBriefTask.validate(s.output, { text, category: need.category, limit }) ?? SharedBriefTask.fallback({ text, category: need.category, limit });
  return { draft: { need, shared: share(need, words), who: words.who ?? null, mandate: need.mandate ?? null, clarify: c?.output ?? [], ...(pr ? { profile: pr.output } : {}),
    byModel: { ...r.byModel, brief: s.byModel, ...(c ? { clarify: c.byModel } : {}), ...(pr ? { profile: pr.byModel } : {}) } } };
}

/** What crosses to providers: requirements without money or coordinates, and the budget as a band. */
export function share(need: Need, words: { title: string; summary: string }): SharedBrief {
  const band = budgetBand(need);
  return {
    title: words.title, summary: words.summary, category: need.category, mode: need.mode ?? null,
    area: need.place.name === "Online" ? null : need.place.name,
    // A number reads as written: "2–3 years", not "2".
    requirements: need.filters.filter(f => f.kind !== "price" && f.kind !== "place").map(f => ({ label: f.label,
      value: f.kind === "number" ? `${f.value}${f.upTo ? `–${f.upTo}` : ""}${f.unit && !/^(count|number|none)$/i.test(f.unit) ? ` ${f.unit}` : ""}` : f.value, strength: f.strength })),
    budget: band, questions: need.mustAsk.slice(0, 4),
  };
}

/** Stores the brief the owner sent: the need for matching keeps only the band, never the exact limit. */
export async function saveBrief(db: Docs, owner: string, need: Need, shared: SharedBrief, now: number): Promise<Brief> {
  // The owner's own words can hold the exact budget ("…up to 36,000"): only the shared wording and the band are kept,
  // and filters keep no quoted evidence.
  const banded: Need = { ...need, text: `${shared.title}. ${shared.summary}`, mandate: null, maxPrice: budgetUpper(need),
    ...(need.requesterPaid ? { minPrice: budgetLower(need) } : {}),
    filters: need.filters.filter(f => f.kind !== "price").map(f => ({ ...f, evidence: "" })) };
  const b: Brief = { id: newId(), owner, shared, need: banded, createdAt: now };
  await db.set(BRIEFS, b.id, b);
  return b;
}
