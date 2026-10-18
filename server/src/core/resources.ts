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
export interface Slot { id: string; start: number; end: number; capacity: number; /** made from the weekly hours */ auto?: boolean }
/** Weekly opening hours (days 0 = Sunday … 6, local "HH:MM", minutes per booking): bookable times are made from them
 *  two weeks ahead, in the resource's time zone, and topped up as days pass — the seller states them once. */
export interface Hours { days: number[]; from: string; to: string; minutes: number }

export interface Resource {
  id: string; schemaVersion: 1; revision: number; owner: string;
  /** The Public offering this is the stock / schedule of. */
  factId: string | null;
  type: "quantity" | "slots"; title: string; unit: string;
  /** quantity: units in hand (committed sales already subtracted). */
  onHand: number;
  /** slots: bookable intervals (epoch seconds) with how many each can take; IANA time zone for display. */
  slots: Slot[]; timezone: string;
  hours?: Hours;
  holds: Hold[];
  /** Busy intervals from a connected calendar: a slot overlapping one isn't bookable. */
  busy?: { start: number; end: number }[];
  /** Where the numbers come from and when they were last confirmed: a ledger the owner keeps here, a manual
   *  count that goes stale, or a connected system. */
  source: "ledger" | "manual" | "connector"; observedAt: number; staleAfterSec: number;
  /** The seller was told stock ran low; cleared when they set a new count. */
  lowAlerted?: boolean;
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
  slots?: Omit<Slot, "id">[]; timezone?: string; hours?: Hours | null; source?: Resource["source"]; staleAfterSec?: number }, now: number): Promise<Resource> {
  if (x.type === "quantity" && !(Number.isInteger(x.onHand) && x.onHand! >= 0)) throw new CapacityError("VERSION_CONFLICT", "Stock must be a whole number, zero or more.");
  const slots = (x.slots ?? []).map(s => ({ id: newId(), start: Math.floor(s.start), end: Math.floor(s.end), capacity: Math.max(1, Math.floor(s.capacity || 1)) }));
  if (slots.some(s => s.end <= s.start)) throw new CapacityError("VERSION_CONFLICT", "A slot must end after it starts.");
  let r: Resource = { id: newId(), schemaVersion: 1, revision: 1, owner, factId: x.factId, type: x.type, title: x.title.slice(0, 120), unit: x.unit ?? (x.type === "quantity" ? "each" : "booking"),
    onHand: x.onHand ?? 0, slots, timezone: zone(x.timezone), holds: [], source: x.source ?? "ledger", observedAt: now,
    staleAfterSec: x.staleAfterSec ?? 86_400, createdAt: now, updatedAt: now };
  if (x.type === "slots" && x.hours) r = fill({ ...r, hours: x.hours }, now);
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
    if (certainty(r, now) === "stale") throw new CapacityError("AVAILABILITY_UNKNOWN", "Stock hasn't been confirmed recently — it needs checking first.");
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

/**
 * A booking moves to another time: the new slot is taken and the old one freed in one update, so the booking is never
 * without a time nor holding two. The hold keeps its state (held stays held; a paid, committed booking stays
 * committed). Only time slots move; goods don't.
 */
export async function moveHold(db: Docs, id: string, holdId: string, slotId: string, now: number): Promise<Slot> {
  let to: Slot | null = null;
  await change(db, id, now, r => {
    if (r.type !== "slots") throw new CapacityError("NOT_FOUND", "Only a booked time can be changed.");
    const h = r.holds.find(x => x.id === holdId && (x.state === "held" || x.state === "committed"));
    if (!h) throw new CapacityError("NOT_FOUND", "This booking isn't active any more.");
    if (h.slotId === slotId) throw new CapacityError("VERSION_CONFLICT", "That's already the booked time.");
    // A time that has started has happened (or been missed): it can't be moved to another one.
    const was = r.slots.find(s => s.id === h.slotId);
    if (was && was.start <= now) throw new CapacityError("VERSION_CONFLICT", "This booking's time has started — it can't be changed now.");
    to = r.slots.find(s => s.id === slotId) ?? null;
    if (!to || to.start <= now) throw new CapacityError("NOT_FOUND", "Pick an upcoming time.");
    if (available(r, now, slotId) < h.qty) throw new CapacityError("CAPACITY_UNAVAILABLE", "That time was just taken — pick another.");
    return { ...r, holds: r.holds.map(x => (x.id === holdId ? { ...x, slotId } : x)) };
  });
  return to!;
}

/** A cancelled booking frees its time even after it was paid for (a slot is capacity, not goods). Idempotent. */
export async function cancelBooking(db: Docs, id: string, holdId: string, now: number): Promise<Resource> {
  return change(db, id, now, r => {
    if (r.type !== "slots") throw new CapacityError("NOT_FOUND", "Only a booked time can be cancelled here.");
    const h = r.holds.find(x => x.id === holdId), was = h ? r.slots.find(s => s.id === h.slotId) : null;
    if (was && was.start <= now) throw new CapacityError("VERSION_CONFLICT", "This booking's time has started — it can't be cancelled now.");
    return { ...r, holds: r.holds.map(x => (x.id === holdId && (x.state === "held" || x.state === "committed") ? { ...x, state: "released" as const } : x)) };
  });
}

/** Releases a live hold (cancellation); committed obligations aren't released here. Idempotent. */
export async function release(db: Docs, id: string, holdId: string, now: number): Promise<Resource> {
  return change(db, id, now, r => ({ ...r, holds: r.holds.map(x => (x.id === holdId && x.state === "held" ? { ...x, state: "released" as const } : x)) }));
}

/**
 * After a sale: if this item's available stock is now at or below `lowAt`, mark it (atomically) and return the units
 * left — once per dip, so the seller is told one time, not after every sale. Null when nothing to tell.
 */
export async function lowStock(db: Docs, id: string, lowAt: number, now: number): Promise<{ left: number; title: string; owner: string; factId: string | null } | null> {
  let told: { left: number; title: string; owner: string; factId: string | null } | null = null;
  await db.update(RESOURCES, id, (r: Resource | null) => {
    told = null;
    if (!r || r.type !== "quantity") return null;
    // What's physically left (sold units are already off); another buyer's short unpaid hold isn't a sale.
    const left = r.onHand;
    // Back above the line (restocked here, or by the shop's billing system): the next dip is told again.
    if (left > lowAt) return r.lowAlerted ? { ...r, lowAlerted: false, updatedAt: now } : null;
    if (r.lowAlerted) return null;
    told = { left, title: r.title, owner: r.owner, factId: r.factId };
    return { ...r, lowAlerted: true, updatedAt: now };
  });
  return told;
}

/** An owner's stock count: sets `onHand` (an adjustment), confirming the count now. */
export async function setStock(db: Docs, id: string, owner: string, onHand: number, now: number): Promise<Resource> {
  if (!(Number.isInteger(onHand) && onHand >= 0)) throw new CapacityError("VERSION_CONFLICT", "Stock must be a whole number, zero or more.");
  return change(db, id, now, r => {
    if (r.owner !== owner) throw new CapacityError("NOT_FOUND", "No such resource.");
    return { ...r, onHand, observedAt: now, lowAlerted: false };
  });
}

/** A valid IANA time zone, else India's. */
export function zone(tz: unknown): string {
  if (typeof tz !== "string" || !tz || tz.length > 60) return "Asia/Kolkata";
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return tz; } catch { return "Asia/Kolkata"; }
}

const hhmm = (s: unknown) => (typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : null);
const minutesOf = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
/** Hours as sent by a client, checked: at least one day, a booking fits between opening and closing. */
export function validHours(x: any): Hours | null {
  const days = [...new Set<number>((Array.isArray(x?.days) ? x.days : []).map(Number).filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  const from = hhmm(x?.from), to = hhmm(x?.to), minutes = Number(x?.minutes);
  if (!days.length || !from || !to || !(Number.isInteger(minutes) && minutes >= 10 && minutes <= 480)) return null;
  return minutesOf(to) - minutesOf(from) >= minutes ? { days, from, to, minutes } : null;
}

/** Seconds `tz` is ahead of UTC at the instant `t` (epoch seconds). */
export function tzOffset(tz: string, t: number): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(Math.floor(t) * 1000)).map(x => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(t) * 1000) / 1000;
}

/** The bookable times the hours give, starting half an hour from now and running `days` ahead, in `tz`. */
export function slotsFromHours(h: Hours, tz: string, now: number, days = 14): Omit<Slot, "id">[] {
  const out: Omit<Slot, "id">[] = [];
  for (let d = 0; d < days; d++) {
    const local = new Date((now + d * 86_400 + tzOffset(tz, now + d * 86_400)) * 1000); // its UTC fields are the local date
    if (!h.days.includes(local.getUTCDay())) continue;
    const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) / 1000; // local midnight, read as UTC
    for (let m = minutesOf(h.from); m + h.minutes <= minutesOf(h.to); m += h.minutes) {
      const wall = midnight + m * 60, start = wall - tzOffset(tz, wall - tzOffset(tz, wall));
      if (start > now + 1800) out.push({ start, end: start + h.minutes * 60, capacity: 1, auto: true });
    }
  }
  return out.slice(0, 400);
}

const booked = (r: Resource, now: number) => new Set(r.holds.filter(h => h.slotId && live(h, now)).map(h => h.slotId));
/** Tops a schedule with hours up to two weeks ahead; free made-up times more than a day past are dropped. */
function fill(r: Resource, now: number): Resource {
  if (r.type !== "slots" || !r.hours) return r;
  const used = booked(r, now);
  const keep = r.slots.filter(s => !s.auto || s.end > now - 86_400 || used.has(s.id));
  const have = new Set(keep.map(s => s.start));
  const add = slotsFromHours(r.hours, r.timezone, now).filter(s => !have.has(s.start)).map(s => ({ id: newId(), ...s }));
  return { ...r, slots: [...keep, ...add].sort((a, b) => a.start - b.start).slice(-600) };
}

/** Does this schedule need topping up — is the furthest time its hours give right now missing? */
export function needsTopUp(r: Resource, now: number): boolean {
  if (r.type !== "slots" || !r.hours) return false;
  const last = slotsFromHours(r.hours, r.timezone, now).at(-1);
  return !!last && !r.slots.some(s => s.start === last.start);
}
export async function topUpHours(db: Docs, id: string, now: number): Promise<Resource> { return change(db, id, now, r => fill(r, now)); }

/** The owner sets (or, with null, stops) weekly hours: free times made from the old hours go; booked ones stay. */
export async function setHours(db: Docs, id: string, owner: string, hours: Hours | null, tz: string | null, now: number): Promise<Resource> {
  return change(db, id, now, r => {
    if (r.owner !== owner || r.type !== "slots") throw new CapacityError("NOT_FOUND", "No such schedule.");
    const used = booked(r, now);
    const { hours: _old, ...rest } = r;
    const slots = r.slots.filter(s => !s.auto || s.start <= now || used.has(s.id));
    return fill({ ...rest, slots, timezone: tz ? zone(tz) : r.timezone, ...(hours ? { hours } : {}) }, now);
  });
}

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "Open Mon–Sat, 10:00–20:00" — runs of days joined, for agents' answers and the seller's own view. */
export function hoursText(h: Hours): string {
  const runs: string[] = [];
  for (let i = 0; i < h.days.length; i++) {
    let j = i;
    while (j + 1 < h.days.length && h.days[j + 1] === h.days[j] + 1) j++;
    runs.push(j - i >= 2 ? `${DAY[h.days[i]]}–${DAY[h.days[j]]}` : h.days.slice(i, j + 1).map(d => DAY[d]).join(", "));
    i = j;
  }
  return `Open ${h.days.length === 7 ? "every day" : runs.join(", ")}, ${h.from}–${h.to}`;
}

export async function resourceFor(db: Docs, factId: string): Promise<Resource | null> {
  return (((await db.find(RESOURCES, [["factId", "==", factId]], 1)) as Resource[])[0]) ?? null;
}

/** What may be said about availability, by anyone: a count only when it's confirmed. */
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
/** The day a question asks about, as a weekday (0–6) in the seller's zone: "this Saturday", "Sunday evening",
 *  "today", "tomorrow"; and the part of the day when said ("morning" 5–12, "afternoon" 12–17, "evening" 17–23). */
export function askedDay(q: string, now: number, tz: string): { day: number; from: number; to: number; label: string } | null {
  const t = q.toLowerCase();
  const local = (x: number) => new Date(new Date(x * 1000).toLocaleString("en-US", { timeZone: tz }));
  let day: number | null = null, label = "";
  const named = DAYS.findIndex(d => new RegExp(`\\b${d}s?\\b|\\b${d.slice(0, 3)}\\b`).test(t));
  if (named >= 0) { day = named; label = DAYS[named][0].toUpperCase() + DAYS[named].slice(1); }
  else if (/\btoday\b|\btonight\b/.test(t)) { day = local(now).getDay(); label = "today"; }
  else if (/\btomorrow\b/.test(t)) { day = (local(now).getDay() + 1) % 7; label = "tomorrow"; }
  else if (/\bweekend\b/.test(t)) { day = 6; label = "Saturday"; }
  if (day === null) return null;
  const [from, to] = /\bmorning\b/.test(t) ? [5, 12] : /\bafternoon\b/.test(t) ? [12, 17] : /\bevening\b|\btonight\b/.test(t) ? [17, 23] : [0, 24];
  return { day, from, to, label };
}

export function availabilityText(r: Resource | null, now: number, question = ""): string {
  if (!r) return "Availability isn't tracked — they'll confirm.";
  if (certainty(r, now) === "stale") return "Availability needs to be confirmed first.";
  if (r.type === "quantity") { const n = available(r, now); return n > 0 ? `${n} ${r.unit === "each" ? "available" : r.unit + " available"}` : "Out of stock right now."; }
  // The next free times themselves, in the seller's time zone — "105 open slots" answers nothing.
  const free = r.slots.filter(s => s.start > now && available(r, now, s.id) > 0).sort((a, b) => a.start - b.start);
  if (!free.length) return r.hours ? `${hoursText(r.hours)}, and every time is taken right now.` : "No open slots right now.";
  const fmt = (t: number) => new Date(t * 1000).toLocaleString("en-IN", { timeZone: r.timezone || "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const mins = Math.round((free[0].end - free[0].start) / 60);
  // A question about a day ("free this Saturday afternoon?") gets that day's times, the nearest such day first — not
  // the next free times overall, which once read as "no" to a Saturday request and ended the conversation.
  const asked = askedDay(question, now, r.timezone || "Asia/Kolkata");
  if (asked) {
    const local = (x: number) => new Date(new Date(x * 1000).toLocaleString("en-US", { timeZone: r.timezone || "Asia/Kolkata" }));
    const onDay = free.filter(sl => { const d = local(sl.start); return d.getDay() === asked.day && d.getHours() >= asked.from && d.getHours() < asked.to; });
    const first = onDay[0] ? local(onDay[0].start).toDateString() : null;
    const that = onDay.filter(sl => local(sl.start).toDateString() === first);
    const part = asked.to - asked.from < 24 ? (asked.from === 5 ? " morning" : asked.from === 12 ? " afternoon" : " evening") : "";
    if (that.length) return `Yes — ${asked.label}${part} is open: ${that.slice(0, 3).map(sl => fmt(sl.start)).join("; ")}${that.length > 3 ? ` (${that.length} times that day)` : ""}. Each takes about ${mins} minutes.`;
    return `${asked.label}${part} is fully booked. Next free: ${free.slice(0, 3).map(sl => fmt(sl.start)).join("; ")}. Each takes about ${mins} minutes.`;
  }
  return `${r.hours ? `${hoursText(r.hours)}. ` : ""}Next free: ${free.slice(0, 3).map(s => fmt(s.start)).join("; ")}${free.length > 3 ? ` (${free.length} open in all)` : ""}. Each takes about ${mins} minutes.`;
}
