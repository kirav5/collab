// Google Calendar, linked with the owner's own Google sign-in (OAuth): its busy times block their bookable slots, the
// same way an iCal feed's do (connectors.ts). Only the free/busy scope is asked for, so Collab never sees event
// titles or guests. The refresh token lives in its own collection, never in a grant and never sent to a browser.
// Without GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET the feature reports itself as not set up.
import { createHmac, timingSafeEqual } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import type { Docs } from "../docs.ts";
import { newId } from "../market/types.ts";
import { ConnectorError, type ConnectorGrant, GRANTS } from "./connectors.ts";
import { RESOURCES, type Resource } from "./resources.ts";

export const GCAL_TOKENS = "connector_secrets";
const SCOPE = "https://www.googleapis.com/auth/calendar.freebusy";

export interface GcalConfig { clientId: string; clientSecret: string; redirectUri: string; secret: string }

export function gcalConfig(env: NodeJS.ProcessEnv, publicUrl: string, secret: string): GcalConfig | null {
  const clientId = (env.GOOGLE_OAUTH_CLIENT_ID ?? "").trim(), clientSecret = (env.GOOGLE_OAUTH_CLIENT_SECRET ?? "").trim();
  return clientId && clientSecret ? { clientId, clientSecret, redirectUri: `${publicUrl}/api/google/calendar/callback`, secret } : null;
}

const client = (c: GcalConfig) => new OAuth2Client({ clientId: c.clientId, clientSecret: c.clientSecret, redirectUri: c.redirectUri });

// The state carried through Google's consent page names the owner and the resource, signed, and expires in 15 minutes.
const sign = (secret: string, body: string) => createHmac("sha256", secret).update(`gcal:${body}`).digest("base64url");
export function makeState(c: GcalConfig, uid: string, resourceId: string, now: number) {
  const body = Buffer.from(JSON.stringify({ uid, resourceId, exp: now + 900 })).toString("base64url");
  return `${body}.${sign(c.secret, body)}`;
}
export function readState(c: GcalConfig, state: string, now: number): { uid: string; resourceId: string } | null {
  const [body, sig] = String(state ?? "").split(".");
  if (!body || !sig) return null;
  const want = Buffer.from(sign(c.secret, body)), got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try { const s = JSON.parse(Buffer.from(body, "base64url").toString()); return s.exp > now ? { uid: String(s.uid), resourceId: String(s.resourceId) } : null; } catch { return null; }
}

/** Where to send the owner to say yes: Google's consent page, asking only for free/busy. */
export async function startLink(db: Docs, c: GcalConfig, uid: string, resourceId: string, now: number): Promise<string> {
  const r = (await db.get(RESOURCES, resourceId)) as Resource | null;
  if (!r || r.owner !== uid) throw new ConnectorError(404, "NOT_FOUND", "No such resource.");
  if (r.type !== "slots") throw new ConnectorError(400, "INVALID_INPUT", "A calendar feeds time slots, not stock.");
  return client(c).generateAuthUrl({ access_type: "offline", prompt: "consent", scope: [SCOPE], state: makeState(c, uid, resourceId, now), include_granted_scopes: false });
}

/** Back from Google with a code: keep the refresh token aside, make the grant, and read busy times straight away. */
export async function finishLink(db: Docs, c: GcalConfig, code: string, state: string, now: number): Promise<ConnectorGrant> {
  const s = readState(c, state, now);
  if (!s) throw new ConnectorError(400, "INVALID_INPUT", "That link has expired — start again from About me.");
  const r = (await db.get(RESOURCES, s.resourceId)) as Resource | null;
  if (!r || r.owner !== s.uid) throw new ConnectorError(404, "NOT_FOUND", "No such resource.");
  const { tokens } = await client(c).getToken(code);
  if (!tokens.refresh_token) throw new ConnectorError(400, "INVALID_INPUT", "Google didn't give a lasting permission — try again and tick the calendar permission.");
  // One Google Calendar per resource: linking again replaces the old grant.
  for (const old of (await db.find(GRANTS, [["resourceId", "==", r.id]], 20)) as ConnectorGrant[]) if (old.provider === "google-calendar" && old.status !== "revoked") await unlink(db, old, now);
  const g: ConnectorGrant = { id: newId(), schemaVersion: 1, owner: s.uid, provider: "google-calendar", scopes: ["availability.read"], resourceId: r.id, url: null,
    status: "active", createdAt: now, expiresAt: null, revokedAt: null, lastEventAt: null, lastError: null };
  await db.set(GCAL_TOKENS, g.id, { grantId: g.id, owner: s.uid, refreshToken: tokens.refresh_token, createdAt: now });
  await db.set(GRANTS, g.id, g);
  await syncGcal(db, c, g, now);
  return (await db.get(GRANTS, g.id)) as ConnectorGrant;
}

/** Revokes the grant, forgets the token, and tells Google to drop the permission (best effort). */
export async function unlink(db: Docs, g: ConnectorGrant, now: number) {
  const t = (await db.get(GCAL_TOKENS, g.id)) as { refreshToken: string } | null;
  await db.delete(GCAL_TOKENS, g.id);
  await db.merge(GRANTS, g.id, { status: "revoked", revokedAt: now });
  if (t?.refreshToken) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.refreshToken)}`, { method: "POST" }).catch(() => {});
}

type FreeBusy = (accessToken: string, timeMin: string, timeMax: string) => Promise<{ start: string; end: string }[]>;
const freeBusy: FreeBusy = async (accessToken, timeMin, timeMax) => {
  const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", { method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ timeMin, timeMax, items: [{ id: "primary" }] }), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Google Calendar answered ${res.status}`);
  const j: any = await res.json();
  const cal = j?.calendars?.primary;
  if (cal?.errors?.length) throw new Error(String(cal.errors[0]?.reason ?? "calendar error"));
  return Array.isArray(cal?.busy) ? cal.busy : [];
};

/** Reads the next 60 days of busy times into the resource. A failure marks the grant degraded; the data goes stale. */
export async function syncGcal(db: Docs, c: GcalConfig, g: ConnectorGrant, now: number, fb: FreeBusy = freeBusy, days = 60) {
  if (g.provider !== "google-calendar" || g.status === "revoked") return { synced: false, reason: "not usable" };
  try {
    const t = (await db.get(GCAL_TOKENS, g.id)) as { refreshToken: string } | null;
    if (!t?.refreshToken) throw new Error("no permission on file — link the calendar again");
    const r = (await db.get(RESOURCES, g.resourceId)) as Resource | null;
    if (!r) return { synced: false, reason: "no resource" };
    const oc = client(c); oc.setCredentials({ refresh_token: t.refreshToken });
    const { token } = await oc.getAccessToken();
    if (!token) throw new Error("couldn't get an access token");
    const raw = await fb(token, new Date(now * 1000).toISOString(), new Date((now + days * 86_400) * 1000).toISOString());
    const busy = raw.map(b => ({ start: Math.floor(Date.parse(b.start) / 1000), end: Math.floor(Date.parse(b.end) / 1000) }))
      .filter(b => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start).sort((a, b) => a.start - b.start).slice(0, 2000);
    await db.update(RESOURCES, g.resourceId, (cur: Resource | null) => (cur ? { ...cur, busy, source: "connector", observedAt: now, staleAfterSec: 3 * 3600, revision: cur.revision + 1, updatedAt: now } : null));
    await db.merge(GRANTS, g.id, { status: "active", lastEventAt: now, lastError: null });
    return { synced: true, busy: busy.length };
  } catch (e) {
    const reason = String((e as Error).message ?? e).slice(0, 160);
    await db.merge(GRANTS, g.id, { status: "degraded", lastError: reason });
    return { synced: false, reason };
  }
}
