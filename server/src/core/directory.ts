// Profiles, shared facts and the public directory. A Public fact is discoverable: it gets an embedding (search by
// meaning) and, when it offers something, Gemini reads what/price/where from it (the listing reader). Search takes a
// brief, finds the nearest Public facts by meaning, applies the request's hard filters (area, budget, must-haves)
// where an offering states them, and lets Gemini order the rest and say why.
import type { Model } from "../ai/gemini.ts";
import { decide } from "../ai/decide.ts";
import { type Docs, docId } from "../docs.ts";
import { ANSWERS } from "./engage.ts";
import { savedKey } from "../market/answer.ts";
import { RankTask, rank } from "../market/match.ts";
import { BROAD, sameItem, stats } from "./deals.ts";
import { read } from "../market/read.ts";
import { moneyText, newId } from "../market/types.ts";
import type { Brief, Fact, Profile, Tier } from "./model.ts";
import { FACTS, PROFILES } from "./policy.ts";
import { TopicsTask } from "./tasks.ts";
import { buyerQuestions } from "./intake.ts";

export const HANDLES = "handles";
const now = () => Math.floor(Date.now() / 1000);

export class Problem extends Error {}

const handleOk = (h: string) => /^[a-z0-9][a-z0-9-]{2,23}$/.test(h);

/** Creates or updates the owner's profile; a handle is theirs once claimed. */
export async function saveProfile(db: Docs, uid: string, p: { handle?: string; name?: string; bio?: string; area?: Profile["area"] }, created?: () => void): Promise<Profile> {
  const cur = (await db.get(PROFILES, uid)) as Profile | null;
  let handle = cur?.handle;
  if (p.handle !== undefined && p.handle !== cur?.handle) {
    const h = p.handle.toLowerCase().trim();
    if (!handleOk(h)) throw new Problem("A handle is 3–24 letters, numbers or dashes.");
    const claimed = await db.update(HANDLES, h, (c: { uid: string } | null) => (c && c.uid !== uid ? null : { uid }));
    if (!claimed || claimed.uid !== uid) throw new Problem(`@${h} is taken.`);
    if (cur?.handle) await db.delete(HANDLES, cur.handle);
    handle = h;
  }
  if (!handle) throw new Problem("Choose a handle first.");
  const next: Profile = { uid, handle, name: (p.name ?? cur?.name ?? handle).slice(0, 60), bio: (p.bio ?? cur?.bio ?? "").slice(0, 280),
    area: p.area !== undefined ? p.area : cur?.area ?? null, createdAt: cur?.createdAt ?? now(), ...(cur?.demo ? { demo: true } : {}), ...(cur?.paused ? { paused: true } : {}) };
  await db.set(PROFILES, uid, next);
  if (!cur) created?.();
  return next;
}

export async function byHandle(db: Docs, handle: string): Promise<Profile | null> {
  const h = await db.get(HANDLES, handle.toLowerCase().replace(/^@/, ""));
  return h ? db.get(PROFILES, h.uid) : null;
}

/** Saves a fact of any tier. Private facts are stored plain: no topics, no offer read, no embedding — the model
    never touches them, and the policy gate never returns them. */
export async function saveFact(db: Docs, model: Model | null, owner: Profile, input: { id?: string; text: string; tier: Tier; topics?: string[]; negotiable?: boolean; source?: "chat" }): Promise<Fact> {
  const text = input.text.trim().slice(0, 1000);
  if (text.length < 3) throw new Problem("Say a bit more.");
  const prev = input.id ? ((await db.get(FACTS, input.id)) as Fact | null) : null;
  if (prev && prev.owner !== owner.uid) throw new Problem("not yours");
  // Answers other requesters got from this fact are stale once its text or tier changes.
  if (prev && (prev.text !== text || prev.tier !== input.tier))
    for (const a of await db.find(ANSWERS, [["factId", "==", prev.id]], 200)) await db.delete(ANSWERS, docId(`${prev.id}:${savedKey(a.question)}`));
  const fresh = input.id && /^[a-z0-9]{6,40}$/.test(input.id) ? input.id : newId();
  if (input.tier === "private") {
    const fact: Fact = { id: prev?.id ?? fresh, owner: owner.uid, text, tier: "private", topics: [], offer: null,
      ...(input.source === "chat" || prev?.source === "chat" ? { source: "chat" as const } : {}),
      // A remembered answer stays one (and keeps answering its question) while its words are unchanged.
      ...(prev?.source === "answer" && prev.text === text ? { source: "answer" as const, question: prev.question, answer: prev.answer, about: prev.about, reuse: prev.reuse } : {}),
      createdAt: prev?.createdAt ?? now(), updatedAt: now() };
    await db.set(FACTS, fact.id, fact);
    return fact;
  }
  let topics = (input.topics ?? []).map(t => t.toLowerCase().trim()).filter(Boolean).slice(0, 5);
  if (input.tier === "protected" && !topics.length) {
    const existing = [...new Set(((await db.find(FACTS, [["owner", "==", owner.uid]], 300)) as Fact[]).flatMap(f => f.topics))];
    topics = (await decide(model, TopicsTask, { text, existing })).output;
  }
  let offer: Fact["offer"] = null, embedding: number[] | undefined;
  if (input.tier === "public" && prev && prev.tier === "public" && prev.text === text) {
    offer = prev.offer; embedding = prev.embedding;
  } else if (input.tier === "public") {
    // An offering (a price and a place, or something done online) becomes a listing the matcher understands.
    const r = await read(text, "sell", model, now(), owner.area);
    if (r.draft?.kind === "offer") offer = r.draft.offer;
    // The questions buyers can tap are written for this listing, alongside its embedding.
    const [v, questions] = await Promise.all([model?.embed?.([offer ? `${offer.title}. ${text}` : text], "document"), offer ? buyerQuestions(model, offer, text).catch(() => null) : null]);
    embedding = v?.[0];
    if (offer && questions) offer = { ...offer, questions };
  }
  // The owner said the price can move (a floor was stated or is delegated): near-budget requests may still match.
  if (offer && input.negotiable) offer = { ...offer, attributes: { ...offer.attributes, negotiable: "yes" } };
  const fact: Fact = { id: prev?.id ?? fresh, owner: owner.uid, text, tier: input.tier, topics, offer,
    ...(embedding ? { embedding } : {}), createdAt: prev?.createdAt ?? now(), updatedAt: now() };
  await db.set(FACTS, fact.id, fact);
  return fact;
}

export interface Found {
  profile: Pick<Profile, "uid" | "handle" | "name" | "bio" | "demo"> & { stats: { deals: number; kept: number; fellThrough: number } };
  fact: { id: string; text: string; offer: Fact["offer"] };
  why: string | null;
  distanceKm: number | null;
  met: string[]; unknown: string[];
  score: number;
}

/** People whose Public facts fit a brief, best first. */
export async function search(db: Docs, model: Model | null, brief: Brief, me: string): Promise<{ found: Found[]; overBudget: Found[]; rankedByModel: boolean; considered: number }> {
  const query = `${brief.shared.title}. ${brief.shared.summary} ${brief.shared.requirements.map(r => `${r.label}: ${r.value}`).join("; ")}`;
  const v = await model?.embed?.([query], "query");
  let near = v ? await db.nearest(FACTS, "embedding", v[0], [["tier", "==", "public"]], 60) : [];
  // Without embeddings (the model is down), every Public fact is a candidate and Gemini's ranking — or the rules — order them.
  if (!near.length) near = (await db.find(FACTS, [["tier", "==", "public"]], 200)).map(doc => ({ doc, distance: 0.5 }));
  const t = now();
  // How close the best match is sets the bar for everything outside the request's category: a loosely related note
  // (an electrician for a water bottle) doesn't ride along just because nothing else is near.
  const closest = Math.min(...(near as { distance: number }[]).map(n => n.distance), 1);
  const wanted = brief.need.attributes.item ?? brief.shared.requirements.find(r => /^item$/i.test(r.label))?.value ?? brief.shared.title;
  const bar = Math.min(0.55, closest + 0.08);
  // One entry per person: their closest Public fact.
  const best = new Map<string, { fact: Fact; distance: number }>();
  for (const { doc, distance } of near as { doc: Fact; distance: number }[]) {
    // Offerings in the request's own category always count (the hard filters below decide); anything else has to be
    // about as close in meaning as the best match.
    // In a broad category ("goods" holds bicycles and bottles) sharing the category isn't enough: the listing must also
    // name the same kind of item as the request ("cycle"), or be about as close in meaning as the best match.
    const sameKind = doc.offer?.category === brief.need.category
      && (!BROAD.has(brief.need.category) || sameItem(`${doc.offer.title} ${doc.text}`, wanted));
    if (doc.owner === me || (!sameKind && distance > bar)) continue;
    const cur = best.get(doc.owner);
    if (!cur || distance < cur.distance) best.set(doc.owner, { fact: doc, distance });
  }
  // Offerings in the request's own category go through the request's hard filters; other close matches stay
  // (they're judged by meaning, and asked about in the conversation).
  const candidates: (Found & { fact: Fact })[] = [];
  const overBudget: Found[] = [];
  const profiles = new Map(await Promise.all([...best.keys()].map(async uid => [uid, (await db.get(PROFILES, uid)) as Profile | null] as const)));
  for (const [uid, { fact, distance }] of best) {
    const profile = profiles.get(uid) ?? null;
    if (!profile || profile.paused) continue;
    let distanceKm: number | null = null, met: string[] = [], unknown: string[] = [], score = 1 - distance;
    if (fact.offer && fact.offer.category === brief.need.category) {
      const [m] = rank([{ key: fact.id, offer: fact.offer }], brief.need, t);
      if (!m) {
        // Only the price is in the way: say so (the owner may raise their limit) instead of dropping it silently.
        const [priced] = rank([{ key: fact.id, offer: fact.offer }], { ...brief.need, maxPrice: null }, t);
        if (priced) overBudget.push({ profile: { uid, handle: profile.handle, name: profile.name, bio: profile.bio, ...(profile.demo ? { demo: true } : {}), stats: await stats(db, uid) },
          fact: { id: fact.id, text: fact.text, offer: fact.offer }, why: null, distanceKm: priced.distanceKm || null, met: priced.met, unknown: priced.unknown, score: 0 });
        continue;
      }
      distanceKm = m.distanceKm || null; met = m.met; unknown = m.unknown;
      score += m.score * 0.5;
    }
    candidates.push({ profile: { uid, handle: profile.handle, name: profile.name, bio: profile.bio, ...(profile.demo ? { demo: true } : {}), stats: await stats(db, uid) },
      fact, why: null, distanceKm, met, unknown, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  let list = candidates.slice(0, 12), byModel = false;
  if (list.length > 1) {
    const r = await decide(model, RankTask, { need: `${brief.shared.title}. ${brief.shared.summary}`,
      candidates: list.map(c => ({ id: c.fact.id, summary: `${c.profile.name}: ${c.fact.offer ? `${c.fact.offer.title}; ${moneyText(c.fact.offer.price)}; ${c.fact.offer.place.name}; ` : ""}${c.fact.text}` })) });
    const order = new Map(r.output.order.map((id, i) => [id, i]));
    list = list.filter(c => order.has(c.fact.id)).sort((a, b) => order.get(a.fact.id)! - order.get(b.fact.id)!);
    for (const c of list) c.why = r.output.why[c.fact.id] ?? null;
    byModel = r.byModel;
  }
  return { found: list.slice(0, 8).map(c => ({ ...c, fact: { id: c.fact.id, text: c.fact.text, offer: c.fact.offer } })), overBudget: overBudget.slice(0, 3), rankedByModel: byModel, considered: best.size };
}

/**
 * Which of a provider's offerings a request is about — chosen explicitly, never by storage order: the one named (it
 * must be theirs and Public), else the only one that matches the request's words, else their only offering. Several
 * possible matches means the agent asks; `options` are what it offers.
 */
export async function chooseOffering(db: Docs, providerUid: string, named: string | null | undefined, text: string): Promise<{ fact: Fact | null; options: Fact[] }> {
  const offers = ((await db.find(FACTS, [["owner", "==", providerUid]], 100)) as Fact[]).filter(f => f.tier === "public" && f.offer);
  if (named) { const f = offers.find(o => o.id === named); return { fact: f ?? null, options: f ? [] : offers.slice(0, 5) }; }
  if (offers.length <= 1) return { fact: offers[0] ?? null, options: [] };
  const matching = offers.filter(o => sameItem(`${o.offer!.title} ${o.text}`, text));
  if (matching.length === 1) return { fact: matching[0], options: [] };
  return { fact: null, options: (matching.length ? matching : offers).slice(0, 5) };
}
