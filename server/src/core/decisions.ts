// Decision deadlines. Every request to an owner has a deadline and a stated fallback; silence is never approval. At
// the deadline a deal waiting for confirmation lapses (a chat reopens for a new offer; a negotiation goes back to
// offers), and an unanswered question keeps waiting with one reminder. Run every minute with the outbox recovery.
import type { Docs } from "../docs.ts";
import type { Engagement, InboxItem } from "./model.ts";
import { ENGAGEMENTS, INBOX } from "./engage.ts";

export async function expireDecisions(db: Docs, now: number, remind: (i: InboxItem) => Promise<void>, max = 50) {
  const due = ((await db.find(INBOX, [["deadline", "<=", now]], max)) as InboxItem[]).filter(i => i.status === "open");
  let lapsed = 0, reminded = 0;
  for (const i of due) {
    if (i.onTimeout === "lapse") {
      const closed = await db.update(INBOX, i.id, (x: InboxItem | null) => (x?.status === "open" ? { ...x, status: "expired" } : null));
      if (!closed) continue;
      await db.update(ENGAGEMENTS, i.engagementId, (e: Engagement | null) => {
        if (!e || e.phase !== "deal" || (i.proposalId && e.negotiation.deal?.id !== i.proposalId)) return null;
        const chat = e.offer.price == null;
        const w = e.waiting[i.side];
        return { ...e, phase: chat ? "asking" : "negotiating", negotiation: { ...e.negotiation, deal: null, dealBy: null, confirmed: { requester: false, provider: false } },
          waiting: { ...e.waiting, [i.side]: w && w.inbox.filter(x => x !== i.id).length ? { ...w, inbox: w.inbox.filter(x => x !== i.id) } : null },
          events: [...e.events, { at: now, who: "system", text: "The deal lapsed — it wasn't confirmed in time. Nothing was agreed." }], updatedAt: now };
      });
      lapsed++;
    } else if (!(i as any).reminded) {
      await db.update(INBOX, i.id, (x: any) => (x?.status === "open" && !x.reminded ? { ...x, reminded: true } : null));
      await remind(i).catch(() => {});
      reminded++;
    }
  }
  return { lapsed, reminded };
}
