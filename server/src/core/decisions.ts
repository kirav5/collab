// Decision deadlines. Every request to an owner has a deadline and a stated fallback; silence is never approval. At
// the deadline a deal waiting for confirmation lapses (a chat reopens for a new offer; a negotiation goes back to
// offers), and an unanswered question keeps waiting with one reminder. Run every minute with the outbox recovery.
import type { Docs } from "../docs.ts";
import type { Engagement, InboxItem } from "./model.ts";
import { ENGAGEMENTS, INBOX } from "./engage.ts";
import { deallocate } from "./goals.ts";
import { release } from "./resources.ts";

export async function expireDecisions(db: Docs, now: number, remind: (i: InboxItem) => Promise<void>, max = 50) {
  const due = ((await db.find(INBOX, [["deadline", "<=", now]], max)) as InboxItem[]).filter(i => i.status === "open");
  let lapsed = 0, reminded = 0;
  for (const i of due) {
    if (i.onTimeout === "lapse") {
      const closed = await db.update(INBOX, i.id, (x: InboxItem | null) => (x?.status === "open" ? { ...x, status: "expired" } : null));
      if (!closed) continue;
      await db.update(ENGAGEMENTS, i.engagementId, (e: Engagement | null) => {
        if (!e || e.phase !== "deal" || (i.proposalId && e.negotiation.deal?.id !== i.proposalId)) return null;
        const w = e.waiting[i.side];
        // An offer letter not accepted by the day it said: the offer has lapsed, and the application ends there.
        if (i.kind === "offer" && e.offerLetter) return { ...e, phase: "closed", offerLetter: { ...e.offerLetter, status: "lapsed", decidedAt: now },
          waiting: { requester: null, provider: null },
          events: [...e.events, { at: now, who: "system", text: `The offer lapsed — it wasn't accepted by ${e.offerLetter.validUntil}. Nothing was agreed.` }], updatedAt: now };
        const chat = e.offer.price == null;
        return { ...e, phase: chat ? "asking" : "negotiating", negotiation: { ...e.negotiation, deal: null, dealBy: null, confirmed: { requester: false, provider: false } },
          waiting: { ...e.waiting, [i.side]: w && w.inbox.filter(x => x !== i.id).length ? { ...w, inbox: w.inbox.filter(x => x !== i.id) } : null },
          events: [...e.events, { at: now, who: "system", text: "The deal lapsed — it wasn't confirmed in time. Nothing was agreed." }], updatedAt: now };
      });
      const e = (await db.get(ENGAGEMENTS, i.engagementId)) as Engagement | null;
      if (e?.goalId) await deallocate(db, e.goalId, e.id, now);
      // Stock or a slot held for the lapsed deal goes back.
      if (e?.reservation?.state === "held" && e.reservation.holdId) {
        await release(db, e.reservation.resourceId, e.reservation.holdId, now).catch(() => {});
        await db.update(ENGAGEMENTS, e.id, (cur: Engagement | null) => (cur?.reservation ? { ...cur, reservation: { ...cur.reservation, state: "released" } } : null));
      }
      lapsed++;
    } else if (!(i as any).reminded) {
      await db.update(INBOX, i.id, (x: any) => (x?.status === "open" && !x.reminded ? { ...x, reminded: true } : null));
      await remind(i).catch(() => {});
      reminded++;
    }
  }
  return { lapsed, reminded };
}
