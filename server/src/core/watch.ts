// Scheduled agents: a request the owner asks their agent to keep watching. Cloud Scheduler calls /cron/run every
// 15 minutes; each due watch searches the directory again (the same search, with the same private-safe brief) and an
// alert goes to the owner for every person who wasn't there before. Nothing is sent to anyone: the owner decides
// from the alert whether their agent asks them. Watches end on their own (14 days by default).
import type { Model } from "../ai/gemini.ts";
import type { Docs } from "../docs.ts";
import { newId } from "../market/types.ts";
import { moneyText } from "../market/types.ts";
import { BRIEFS } from "./briefs.ts";
import { search } from "./directory.ts";
import type { Brief } from "./model.ts";

export const WATCHES = "watches", ALERTS = "alerts";

export interface Watch {
  id: string; owner: string; briefId: string; title: string;
  /** Minutes between runs. */
  every: number;
  /** Facts already shown to the owner (the matches they saw, and earlier alerts). */
  seen: string[];
  nextRun: number; lastRun: number | null; runs: number;
  expires: number; active: boolean; createdAt: number;
}

export interface Alert {
  id: string; owner: string; watchId: string; briefId: string; factId: string;
  title: string; text: string; price: number | null; unit: string | null; handle: string; name: string;
  status: "new" | "done"; at: number;
}

const now = () => Math.floor(Date.now() / 1000);

export async function startWatch(db: Docs, owner: string, briefId: string, seen: string[], every = 60, days = 14): Promise<Watch> {
  const b = (await db.get(BRIEFS, briefId)) as Brief | null;
  if (!b || b.owner !== owner) throw new Error("request not found");
  const w: Watch = { id: newId(), owner, briefId, title: b.shared.title, every: Math.min(Math.max(every, 15), 24 * 60), seen: seen.slice(0, 200),
    nextRun: now() + Math.min(Math.max(every, 15), 24 * 60) * 60, lastRun: null, runs: 0, expires: now() + Math.min(days, 60) * 86_400, active: true, createdAt: now() };
  await db.set(WATCHES, w.id, w);
  return w;
}

/** Runs every watch that's due (at most `max` per call); returns how many ran and how many alerts were raised. */
export async function runDue(db: Docs, model: Model | null, onAlert: (a: Alert) => Promise<void>, max = 25): Promise<{ ran: number; alerts: number }> {
  const t = now();
  const due = ((await db.find(WATCHES, [["active", "==", true], ["nextRun", "<=", t]], max)) as Watch[]);
  let alerts = 0;
  for (const w of due) {
    if (w.expires <= t) { await db.merge(WATCHES, w.id, { active: false }); continue; }
    const b = (await db.get(BRIEFS, w.briefId)) as Brief | null;
    if (!b) { await db.merge(WATCHES, w.id, { active: false }); continue; }
    const r = await search(db, model, b, w.owner).catch(() => null);
    const fresh = (r?.found ?? []).filter(f => !w.seen.includes(f.fact.id));
    for (const f of fresh.slice(0, 3)) {
      const a: Alert = { id: newId(), owner: w.owner, watchId: w.id, briefId: w.briefId, factId: f.fact.id, title: w.title,
        text: `${f.profile.name} — ${f.fact.offer?.title ?? f.fact.text.slice(0, 80)}${f.fact.offer ? ` · ${moneyText(f.fact.offer.price)}` : ""}`,
        price: f.fact.offer?.price.amount ?? null, unit: f.fact.offer?.price.period ?? null, handle: f.profile.handle, name: f.profile.name, status: "new", at: t };
      await db.set(ALERTS, a.id, a);
      await onAlert(a).catch(() => {});
      alerts++;
    }
    await db.merge(WATCHES, w.id, { seen: [...w.seen, ...fresh.map(f => f.fact.id)].slice(-200), lastRun: t, runs: w.runs + 1, nextRun: t + w.every * 60 });
  }
  return { ran: due.length, alerts };
}
