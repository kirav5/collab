// Connectors: scoped, revocable links from an owner's outside systems to one of their resources. A grant names the
// owner, the adapter, the scopes it may use, the resource it may change, and when it expires; it can be revoked at
// any time, and a revoked or expired grant changes nothing. Two adapters:
//   • inventory-webhook (inventory.write): a shop's POS posts stock changes, signed with a per-grant key (HMAC of the
//     body). Each event id is applied once; an event older than the last one applied can't roll stock back.
//   • ical (availability.read): a provider's calendar feed; its busy times block overlapping slots.
//   • google-calendar (availability.read): the same, read with the owner's Google sign-in (core/gcal.ts).
// An outage (no events, a feed that can't be read) is never filled in: the data goes stale and holds report
// AVAILABILITY_UNKNOWN until the system reports again or the owner recounts.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Docs } from "../docs.ts";
import { newId } from "../market/types.ts";
import { RESOURCES, type Resource } from "./resources.ts";
import { safeWebhook } from "../a2a/agents.ts";

export const GRANTS = "connector_grants", CONNECTOR_EVENTS = "connector_events";

export const ADAPTERS = {
  "inventory-webhook": { scopes: ["inventory.write"], resource: "quantity" as const, title: "Your billing app" },
  "ical": { scopes: ["availability.read"], resource: "slots" as const, title: "Your calendar" },
  // Linked through Google's own sign-in (core/gcal.ts), never through this generic create.
  "google-calendar": { scopes: ["availability.read"], resource: "slots" as const, title: "Your Google Calendar" },
};
export type AdapterId = keyof typeof ADAPTERS;

export interface ConnectorGrant {
  id: string; schemaVersion: 1; owner: string; provider: AdapterId; scopes: string[]; resourceId: string;
  /** ical: the feed URL (https, public host). */
  url: string | null;
  status: "active" | "degraded" | "revoked";
  createdAt: number; expiresAt: number | null; revokedAt: number | null;
  lastEventAt: number | null; lastError: string | null;
}

export class ConnectorError extends Error { status: number; code: string; constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; } }

/** The grant's signing key, derived from the server secret (nothing extra to store; revocation is the grant's status). */
export const grantKey = (secret: string, grantId: string) => createHmac("sha256", secret).update(`connector:${grantId}`).digest("base64url");
export const signBody = (key: string, body: string) => `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;

const usable = (g: ConnectorGrant | null, now: number) => !!g && g.status !== "revoked" && (!g.expiresAt || g.expiresAt > now);

export async function createGrant(db: Docs, owner: string, provider: string, resourceId: string, url: string | null, now: number, days = 365): Promise<ConnectorGrant> {
  const a = provider === "google-calendar" ? null : ADAPTERS[provider as AdapterId];
  if (!a) throw new ConnectorError(400, "UNSUPPORTED_CAPABILITY", `Unknown connector. Supported: inventory-webhook, ical (Google Calendar is linked from About me).`);
  const r = (await db.get(RESOURCES, resourceId)) as Resource | null;
  if (!r || r.owner !== owner) throw new ConnectorError(404, "NOT_FOUND", "No such resource.");
  if (r.type !== a.resource) throw new ConnectorError(400, "INVALID_INPUT", `This connector feeds ${a.resource === "quantity" ? "stock" : "time slots"}.`);
  if (provider === "ical" && (!url || !safeWebhook(url))) throw new ConnectorError(400, "INVALID_INPUT", "The calendar feed must be a public https URL.");
  const g: ConnectorGrant = { id: newId(), schemaVersion: 1, owner, provider: provider as AdapterId, scopes: [...a.scopes], resourceId, url: provider === "ical" ? url : null,
    status: "active", createdAt: now, expiresAt: now + days * 86_400, revokedAt: null, lastEventAt: null, lastError: null };
  await db.set(GRANTS, g.id, g);
  return g;
}

/** Revokes a grant. Its resource's data stops being refreshed, so it goes stale (unknown) unless the owner recounts. */
export async function revokeGrant(db: Docs, owner: string, id: string, now: number): Promise<ConnectorGrant> {
  const g = await db.update(GRANTS, id, (cur: ConnectorGrant | null) => (cur && cur.owner === owner ? { ...cur, status: "revoked", revokedAt: now } : null));
  if (!g) throw new ConnectorError(404, "NOT_FOUND", "No such connector.");
  await db.update(RESOURCES, g.resourceId, (r: Resource | null) => (r && r.source === "connector" ? { ...r, source: "manual", staleAfterSec: Math.min(r.staleAfterSec, 3600), revision: r.revision + 1, updatedAt: now } : null));
  return g;
}

/** A signed stock event from a POS. Returns what happened; throws ConnectorError for refusals. */
export async function ingestInventory(db: Docs, secret: string, grantId: string, rawBody: string, signature: string | undefined, now: number) {
  const g = (await db.get(GRANTS, grantId)) as ConnectorGrant | null;
  // Unknown and revoked grants look the same to the caller as a bad signature would: nothing about them is revealed.
  if (!g || g.provider !== "inventory-webhook") throw new ConnectorError(401, "AUTHENTICATION_REQUIRED", "Unknown connector or bad signature.");
  const want = Buffer.from(signBody(grantKey(secret, g.id), rawBody)), got = Buffer.from(String(signature ?? ""));
  if (want.length !== got.length || !timingSafeEqual(want, got)) throw new ConnectorError(401, "AUTHENTICATION_REQUIRED", "Unknown connector or bad signature.");
  if (!usable(g, now)) throw new ConnectorError(403, "AUTHORITY_REQUIRED", "This connector has been revoked or has expired.");
  if (!g.scopes.includes("inventory.write")) throw new ConnectorError(403, "AUTHORITY_REQUIRED", "This connector may not change stock.");
  let ev: any;
  try { ev = JSON.parse(rawBody); } catch { throw new ConnectorError(400, "INVALID_INPUT", "Body must be JSON."); }
  const eventId = String(ev?.id ?? "").slice(0, 80), observedAt = Number(ev?.observedAt ?? now);
  if (!eventId || !["stock.set", "stock.adjust"].includes(ev?.type)) throw new ConnectorError(400, "INVALID_INPUT", "Events need an id and a type of stock.set or stock.adjust.");
  // Each event id once: a retried delivery changes nothing the second time.
  const first = await db.update(CONNECTOR_EVENTS, `${g.id}:${eventId}`.replace(/[^\w:-]/g, "_"), (cur: unknown) => (cur ? null : { grantId: g.id, eventId, at: now }));
  if (!first) return { applied: false, duplicate: true };
  let ignored = false;
  await db.update(RESOURCES, g.resourceId, (r: Resource | null) => {
    if (!r || r.owner !== g.owner) return null;
    // An event older than the count already applied can't roll stock back.
    if (r.source === "connector" && observedAt < r.observedAt) { ignored = true; return null; }
    const onHand = ev.type === "stock.set" ? Number(ev.onHand) : r.onHand + Number(ev.delta);
    if (!Number.isInteger(onHand) || onHand < 0) { ignored = true; return null; }
    // A restock from the shop's own system re-arms the low-stock alert, as a count set here does.
    return { ...r, onHand, source: "connector", observedAt: Math.min(observedAt, now), revision: r.revision + 1, updatedAt: now, ...(onHand > r.onHand ? { lowAlerted: false } : {}) };
  });
  await db.merge(GRANTS, g.id, { lastEventAt: now, ...(g.status === "degraded" ? { status: "active", lastError: null } : {}) });
  return { applied: !ignored, duplicate: false, ...(ignored ? { reason: "older than the current count, or invalid" } : {}) };
}

// MARK: - iCal

/** Busy intervals (epoch seconds) in an iCal feed, for the next `days`. Handles UTC, floating/TZID local times and all-day events. */
export function parseIcal(text: string, timezone: string, now: number, days = 60): { start: number; end: number }[] {
  const lines = text.replace(/\r\n[ \t]/g, "").split(/\r?\n/);
  const out: { start: number; end: number }[] = [];
  let cur: Record<string, string> | null = null;
  const when = (key: string, raw: string): number | null => {
    const tz = key.match(/TZID=([^;:]+)/)?.[1] ?? timezone;
    const m = raw.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
    if (!m) return null;
    const [, y, mo, d, h = "00", mi = "00", s = "00", z] = m;
    const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) / 1000;
    if (z) return utc;
    // Local time in `tz`: subtract that zone's offset at this moment.
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(utc * 1000));
    const g = (t: string) => Number(parts.find(p => p.type === t)?.value);
    const asLocal = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) / 1000;
    return utc - (asLocal - utc);
  };
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") cur = {};
    else if (line === "END:VEVENT" && cur) {
      const sk = Object.keys(cur).find(k => k.startsWith("DTSTART")), ek = Object.keys(cur).find(k => k.startsWith("DTEND"));
      const start = sk ? when(sk, cur[sk]) : null;
      const end = ek ? when(ek, cur[ek]) : start !== null && sk && /^\d{8}$/.test(cur[sk]) ? start + 86_400 : null;
      const free = cur.TRANSP === "TRANSPARENT" || cur.STATUS === "CANCELLED";
      if (start !== null && end !== null && end > start && end > now && start < now + days * 86_400 && !free) out.push({ start, end });
      cur = null;
    } else if (cur) { const i = line.indexOf(":"); if (i > 0) cur[line.slice(0, i)] = line.slice(i + 1); }
  }
  return out.sort((a, b) => a.start - b.start).slice(0, 2000);
}

/** Reads a calendar grant's feed into its resource's busy times. A failure marks the grant degraded and leaves the
 *  data to go stale — the last busy times aren't presented as current. */
export async function syncIcal(db: Docs, g: ConnectorGrant, fetchText: (url: string) => Promise<string>, now: number) {
  if (!usable(g, now) || g.provider !== "ical" || !g.url) return { synced: false, reason: "not usable" };
  try {
    const r = (await db.get(RESOURCES, g.resourceId)) as Resource | null;
    if (!r) return { synced: false, reason: "no resource" };
    const busy = parseIcal(await fetchText(g.url), r.timezone, now);
    await db.update(RESOURCES, g.resourceId, (cur: Resource | null) => (cur ? { ...cur, busy, source: "connector", observedAt: now, staleAfterSec: 3 * 3600, revision: cur.revision + 1, updatedAt: now } : null));
    await db.merge(GRANTS, g.id, { status: "active", lastEventAt: now, lastError: null });
    return { synced: true, busy: busy.length };
  } catch (e) {
    await db.merge(GRANTS, g.id, { status: "degraded", lastError: String((e as Error).message ?? e).slice(0, 160) });
    return { synced: false, reason: String((e as Error).message ?? e).slice(0, 160) };
  }
}
