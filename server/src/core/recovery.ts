// Outbox recovery: every waiting agent turn is recorded on its conversation (`outboxPending`). This scan finds turns
// that have waited longer than a minute — because enqueueing failed, a task was lost, or the instance stopped — and
// queues them again under the same stable name (so a turn already queued isn't duplicated). Without a queue (local,
// tests) it runs them directly, a few at a time.
import { createHash } from "node:crypto";
import type { Docs } from "../docs.ts";
import type { Engagement } from "./model.ts";
import { ENGAGEMENTS } from "./engage.ts";

export const outboxKey = (outbox: unknown) => createHash("sha256").update(JSON.stringify(outbox ?? null)).digest("hex").slice(0, 16);

export async function recoverOutbox(db: Docs, now: number, enqueue: ((id: string, delay?: number, dedupe?: string) => Promise<boolean>) | null,
  runNow: (id: string) => Promise<void>, max = 20): Promise<{ found: number; queued: number; ran: number; failed: number }> {
  const waiting = ((await db.find(ENGAGEMENTS, [["outboxPending", "==", true]], max * 3)) as Engagement[])
    .filter(e => e.outbox && !["agreed", "closed", "declined"].includes(e.phase) && now - (e.outboxAt ?? e.updatedAt) >= 60).slice(0, max);
  let queued = 0, ran = 0, failed = 0;
  for (const e of waiting) {
    if (enqueue) { if (await enqueue(e.id, 1, outboxKey(e.outbox))) queued++; else failed++; }
    else { try { await runNow(e.id); ran++; } catch { failed++; } }
  }
  return { found: waiting.length, queued, ran, failed };
}
