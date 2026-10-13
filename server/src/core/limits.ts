// Rate limits and leases that hold across every Cloud Run instance: both live in Firestore and change only inside a
// transaction, so two instances can't both spend the last token or both run the same conversation.
import { randomUUID } from "node:crypto";
import { type Docs, docId } from "../docs.ts";

const RATE = "rate", LEASES = "leases";

/** A token bucket: `capacity` tokens, refilled at `perSecond`. True if `cost` tokens were taken. */
export async function take(db: Docs, key: string, cost: number, capacity: number, perSecond: number): Promise<boolean> {
  let allowed = false;
  await db.update(RATE, docId(key), (cur: { tokens: number; at: number } | null) => {
    const now = Date.now();
    const tokens = Math.min(capacity, (cur?.tokens ?? capacity) + ((now - (cur?.at ?? now)) / 1000) * perSecond);
    allowed = tokens >= cost;
    return { tokens: allowed ? tokens - cost : tokens, at: now, expireAt: new Date(now + 86_400_000) };
  });
  return allowed;
}

/** Runs `fn` while holding the lease on `key` (null if someone else holds it). A lease lapses after `ms` even if its
 *  holder crashed, so nothing stays locked. */
export async function withLease<T>(db: Docs, key: string, ms: number, fn: () => Promise<T>): Promise<T | null> {
  const me = randomUUID();
  let got = false;
  await db.update(LEASES, docId(key), (cur: { owner: string; until: number } | null) => {
    got = !cur || cur.until < Date.now();
    return got ? { owner: me, until: Date.now() + ms, expireAt: new Date(Date.now() + 86_400_000) } : null;
  });
  if (!got) return null;
  try { return await fn(); } finally {
    await db.update(LEASES, docId(key), (cur: { owner: string } | null) => (cur?.owner === me ? { owner: "", until: 0, expireAt: new Date(Date.now() + 86_400_000) } : null));
  }
}
