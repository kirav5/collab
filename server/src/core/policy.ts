// Who may see what (Collab's PolicyEngine, for facts): deterministic, deny by default. Public facts: anyone who
// contacts the owner's agent. Protected facts: only an asker an active rule names (a person, or "anyone"), and only
// facts carrying a topic that rule names — at most that rule's level of detail, and with the owner's review if the
// rule says so. Private facts are stored here but returned to no one: this function never yields them, whoever asks.
//
// This decides what the answering model is *given*. A fact this doesn't return never reaches the model, so no
// question — however it's worded — can draw it out.
import type { Docs } from "../docs.ts";
import type { Fact, Rule, Shape } from "./model.ts";

export const FACTS = "facts", RULES = "rules", PROFILES = "profiles";

export interface Allowed { fact: Fact; via: Rule | null }

const SHAPES: Shape[] = ["yesNo", "oneLine", "summary", "full"];
export const minShape = (a: Shape, b: Shape) => SHAPES[Math.min(SHAPES.indexOf(a), SHAPES.indexOf(b))];

export function ruleActive(r: Rule, now: number) {
  return !r.revoked && (r.expires === null || r.expires > now);
}

/** The owner's facts this asker may be told (null asker: an agent that didn't sign in — Public only). */
export async function allowedFor(db: Docs, owner: string, asker: string | null, now: number): Promise<Allowed[]> {
  const profile = await db.get(PROFILES, owner);
  if (!profile || profile.paused) return [];
  const facts = (await db.find(FACTS, [["owner", "==", owner]], 500)) as Fact[];
  const rules = asker === owner ? [] : ((await db.find(RULES, [["owner", "==", owner]], 200)) as Rule[])
    .filter(r => ruleActive(r, now) && (r.audience === "anyone" || (asker !== null && r.audience === asker)));
  const out: Allowed[] = [];
  for (const f of facts) {
    if (f.tier === "public") { out.push({ fact: f, via: null }); continue; }
    if (f.tier === "private") continue;
    const topics = new Set(f.topics.map(t => t.toLowerCase()));
    // The most specific rule wins: one naming this asker before an "anyone" rule.
    const via = rules.filter(r => r.topics.some(t => topics.has(t.toLowerCase())))
      .sort((a, b) => Number(b.audience !== "anyone") - Number(a.audience !== "anyone"))[0];
    if (via) out.push({ fact: f, via });
  }
  return out;
}

/** Shapes an answer down to what the rule allows (Collab's AnswerShaper). */
export function shapeAnswer(text: string, shape: Shape, yes?: boolean): string {
  switch (shape) {
    case "yesNo": return yes === undefined ? (/^\s*(no|not|never)\b/i.test(text) ? "No." : "Yes.") : yes ? "Yes." : "No.";
    case "oneLine": { const m = text.trim().match(/^.*?[.!?](\s|$)/); const s = (m?.[0] ?? text).trim(); return s.length > 140 ? s.slice(0, 139) + "…" : s; }
    case "summary": return text.slice(0, 600);
    case "full": return text;
  }
}
