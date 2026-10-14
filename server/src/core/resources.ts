// Resources: what a provider can actually hand over — a quantity of stock, or time slots — and the holds on them.
// One interface for both: check → hold → commit / release, with expiry. A resource and its holds live in one
// document, changed only inside a transaction, so concurrent requests for the last unit or the same slot give at
// most one hold, and available stock never goes below zero. Holds expire on their own; an expired hold frees its
// capacity at the next change. A listing without a resource has unknown availability — never "one in stock".
import type { Docs } from "../docs.ts";
import { newId } from "../market/types.ts";

export const RESOURCES = "resources";

export type HoldState = "held" | "committed" | "released" | "expired";
export interface Hold { id: string; holder: string; engagementId: string | null; qty: number; slotId: string | null; state: HoldState; createdAt: number; expiresAt: number }
export interface Slot { id: string; start: number; end: number; capacity: number }

export interface Resource {
  id: string; schemaVersion: 1; revision: number; owner: string;
  /** The Public offering this is the stock / schedule of. */
  factId: string | null;
  type: "quantity" | "slots"; title: string; unit: string;
  /** quantity: units in hand (committed sales already subtracted). */
  onHand: number;
  /** slots: bookable intervals (epoch seconds) with how many each can take; IANA time zone for display. */
  slots: Slot[]; timezone: string;
  holds: Hold[];
  /** Busy intervals from a connected calendar: a slot overlapping one isn't bookable. */
  busy?: { start: number; end: number }[];
  /** Where the numbers come from and when they were last confirmed: a ledger the owner keeps here, a manual
   *  count that goes stale, or a connected system. */
  source: "ledger" | "manual" | "connector"; observedAt: number; staleAfterSec: number;
  createdAt: number; updatedAt: number;
}

export class CapacityError extends Error { code: string; constructor(code: "CAPACITY_UNAVAILABLE" | "AVAILABILITY_UNKNOWN" | "NOT_FOUND" | "VERSION_CONFLICT", message: string) { super(message); this.code = code; } }

const live = (h: Hold, now: number) => h.state === "committed" || (h.state === "held" && h.expiresAt > now);

/** Expired holds become "expired" (and stop counting); old finished holds are dropped to keep the document small. */
function tidy(r: Resource, now: number): Resource {
  const holds = r.holds.map(h => (h.state === "held" && h.expiresAt <= now ? { ...h, state: "expired" as const } : h))
    .filter(h => h.state === "held" || h.state === "committed" || now - h.expiresAt < 7 * 86_400).slice(-300);
  return { ...r, holds };
}

/** Is the availability known? Ledger and connector counts are; a manual count older than its window is stale. */
export function certainty(r: Resource, now: number): "confirmed" | "stale" {
  // A manual count, or a connected system that has stopped reporting, goes stale after its window.
  return r.source !== "ledger" && now - r.observedAt > r.staleAfterSec ? "stale" : "confirmed";
}

/** Units free for new holds (quantity), or places free in a slot. */
export function available(r: Resource, now: number, slotId: string | null = null): number {
  if (r.type === "quantity") return Math.max(0, r.onHand - r.holds.filter(h => h.state === "held" && h.expiresAt > now).reduce((n, h) => n + h.qty, 0));
  const slot = r.slots.find(s => s.id === slotId);
  if (!slot) return 0;
  if ((r.busy ?? []).some(b => b.start < slot.end && b.end > slot.start)) return 0;
  return Math.max(0, slot.capacity - r.holds.filter(h => h.slotId === slotId && live(h, now)).reduce((n, h) => n + h.qty, 0));
}

export async function createResource(db: Docs, owner: string, x: { factId: string | null; type: Resource["type"]; title: string; unit?: string; onHand?: number;
  slots?: Omit<Slot, "id">[]; timezone?: string; source?: Resource["source"]; staleAfterSec?: number }, now: number): Promise<Resource> {
  if (x.type === "quantity" && !(Number.isInteger(x.onHand) && x.onHand! >= 0)) throw new CapacityError("VERSION_CONFLICT", "Stock must be a whole number, zero or more.");
  const slots = (x.slots ?? []).map(s => ({ id: newId(), start: Math.floor(s.start), end: Math.floor(s.end), capacity: Math.max(1, Math.floor(s.capacity || 1)) }));
  if (slots.some(s => s.end <= s.start)) throw new CapacityError("VERSION_CONFLICT", "A slot must end after it starts.");
  const r: Resource = { id: newId(), schemaVersion: 1, revision: 1, owner, factId: x.factId, type: x.type, title: x.title.slice(0, 120), unit: x.unit ?? (x.type === "quantity" ? "each" : "booking"),
    onHand: x.onHand ?? 0, slots, timezone: x.timezone ?? "Asia/Kolkata", holds: [], source: x.source ?? "ledger", observedAt: now,
    staleAfterSec: x.staleAfterSec ?? 86_400, createdAt: now, updatedAt: now };
  await db.set(RESOURCES, r.id, r);
  return r;
}

/** Changes a resource inside a transaction: `fn` sees it tidied and may throw to refuse. */
async function change(db: Docs, id: string, now: number, fn: (r: Resource) => Resource): Promise<Resource> {
  let refusal: Error | null = null;
  const out = await db.update(RESOURCES, id, (cur: Resource | null) => {
    if (!cur) { refusal = new CapacityError("NOT_FOUND", "No such resource."); return null; }
    try { const next = fn(tidy(cur, now)); return { ...next, revision: cur.revision + 1, updatedAt: now }; }
    catch (e) { refusal = e as Error; return null; }
  });
  if (refusal) throw refusal;
  return out as Resource;
}

/** Holds `qty` units (or a place in `slotId`) for `ttlSec`. Fails when the capacity isn't there or isn't known. */
export async function hold(db: Docs, id: string, x: { holder: string; engagementId?: string | null; qty?: number; slotId?: string | null; ttlSec: number }, now: number): Promise<Hold> {
  const qty = Math.max(1, Math.floor(x.qty ?? 1));
  let made: Hold | null = null;
  await change(db, id, now, r => {
    if (certainty(r, now) === "stale") throw new CapacityError("AVAILABILITY_UNKNOWN", "Stock hasn't been confirmed recently — the seller needs to check it.");
    if (r.type === "slots" && !r.slots.some(s => s.id === x.slotId)) throw new CapacityError("NOT_FOUND", "No such slot.");
    if (available(r, now, x.slotId ?? null) < qty) throw new CapacityError("CAPACITY_UNAVAILABLE", r.type === "quantity" ? "Not enough in stock." : "That slot is full.");
    made = { id: newId(), holder: x.holder, engagementId: x.engagementId ?? null, qty, slotId: x.slotId ?? null, state: "held", createdAt: now, expiresAt: now + x.ttlSec };
    return { ...r, holds: [...r.holds, made] };
  });
  return made!;
}

/** Turns a live hold into a commitment (stock leaves `onHand`). Idempotent for an already committed hold. */
export async function commit(db: Docs, id: string, holdId: string, now: number): Promise<Resource> {
  return change(db, id, now, r => {
    const h = r.holds.find(x => x.id === holdId);
    if (!h) throw new CapacityError("NOT_FOUND", "No such hold.");
    if (h.state === "committed") return r;
    if (h.state !== "held") throw new CapacityError("CAPACITY_UNAVAILABLE", "The reservation expired or was released.");
    return { ...r, onHand: r.type === "quantity" ? r.onHand - h.qty : r.onHand, holds: r.holds.map(x => (x.id === holdId ? { ...x, state: "committed" as const } : x)) };
  });
}

/** Releases a live hold (cancellation); committed obligations aren't released here. Idempotent. */
export async function release(db: Docs, id: string, holdId: string, now: number): Promise<Resource> {
  return change(db, id, now, r => ({ ...r, holds: r.holds.map(x => (x.id === holdId && x.state === "held" ? { ...x, state: "released" as const } : x)) }));
}

/** An owner's stock count: sets `onHand` (an adjustment), confirming the count now. */
export async function setStock(db: Docs, id: string, owner: string, onHand: number, now: number): Promise<Resource> {
  if (!(Number.isInteger(onHand) && onHand >= 0)) throw new CapacityError("VERSION_CONFLICT", "Stock must be a whole number, zero or more.");
  return change(db, id, now, r => {
    if (r.owner !== owner) throw new CapacityError("NOT_FOUND", "No such resource.");
    return { ...r, onHand, observedAt: now };
  });
}

export async function resourceFor(db: Docs, factId: string): Promise<Resource | null> {
  return (((await db.find(RESOURCES, [["factId", "==", factId]], 1)) as Resource[])[0]) ?? null;
}

/** What may be said about availability, by anyone: a count only when it's confirmed. */
export function availabilityText(r: Resource | null, now: number): string {
  if (!r) return "Availability isn't tracked — the seller will confirm.";
  if (certainty(r, now) === "stale") return "Availability needs to be confirmed by the seller.";
  if (r.type === "quantity") { const n = available(r, now); return n > 0 ? `${n} ${r.unit === "each" ? "available" : r.unit + " available"}` : "Out of stock right now."; }
  const free = r.slots.filter(s => s.start > now && available(r, now, s.id) > 0);
  return free.length ? `${free.length} open slot${free.length === 1 ? "" : "s"}` : "No open slots right now.";
}
