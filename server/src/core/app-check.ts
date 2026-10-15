/**
 * Whether a call must carry an App Check token when enforcement is on. Reads of the caller's own data (and public
 * profiles) are already bound to their sign-in and cost nothing to serve, so they don't wait for reCAPTCHA on a first
 * visit; writes, and reads that can run the model (a goal's plan advances on read), still need it.
 */
export function appCheckRequired(method: string, path: string): boolean {
  return method !== "GET" || /^\/goals(\/|$)/.test(path);
}

export function replayProtected(method: string, path: string): boolean {
  return method === "POST" && (path === "/price-check"
    || /^\/engagements\/[^/]+\/pay$/.test(path)
    || /^\/pickup\/[^/]+\/collect$/.test(path));
}

export async function verifyAppCheckToken(
  token: string,
  consume: boolean,
  verify: (token: string, options?: { consume: boolean }) => Promise<{ alreadyConsumed?: boolean }>,
): Promise<boolean> {
  const result = await verify(token, consume ? { consume: true } : undefined);
  return !consume || result.alreadyConsumed !== true;
}

/** The decision for one request. A sensitive action whose single-use token can't be consumed (missing role, App Check
 *  outage) is "unavailable" — refused, never downgraded to a reusable-token check. */
export async function appCheckDecision(
  token: string | undefined,
  consume: boolean,
  verify: (token: string, options?: { consume: boolean }) => Promise<{ alreadyConsumed?: boolean }>,
): Promise<"ok" | "replay" | "invalid" | "expired" | "unavailable"> {
  if (!token) return "invalid";
  try { return (await verifyAppCheckToken(token, consume, verify)) ? "ok" : "replay"; }
  catch (e) {
    if (consume && /permission|PERMISSION_DENIED|403|forbidden|unavailable|ECONN|timeout/i.test(String(e))) return "unavailable";
    return /expire/i.test(String(e)) ? "expired" : "invalid";
  }
}

/**
 * "off": no checks. "monitor": check and log, refuse nothing. "enforce": verified-or-limited — a call without a valid
 * token still works, under a tighter limit, because a real person's browser can fail Google reCAPTCHA (content blockers,
 * private windows, the SDK throttling itself after an error), while payments, pickups and price checks always need a
 * fresh single-use token. "strict": refuse anything unverified.
 */
export type AppCheckMode = "off" | "monitor" | "enforce" | "strict";
export const appCheckMode = (v: string | undefined): AppCheckMode => (["off", "monitor", "enforce", "strict"].includes(v ?? "") ? v as AppCheckMode : "off");

/** What happens to one call, given the mode and the token's decision ("unavailable" is handled before: fail closed). */
export function appCheckOutcome(mode: AppCheckMode, decision: "ok" | "replay" | "invalid" | "expired", consume: boolean): "verified" | "unverified" | "refuse" {
  if (decision === "ok") return "verified";
  if (consume || mode === "strict") return "refuse";
  return "unverified";
}

/** Writes from an unverified browser that don't cost a limited-budget charge: its own chat history and push address. */
export const freeUnverified = (method: string, path: string) => method === "GET" || /^\/api\/(chats|push\/token)$/.test(path);

/** A ceiling on unverified writes per server instance (in memory: a shared counter document would be a hot spot). */
export function instanceBucket(capacity: number, perSecond: number, clock = () => Date.now()) {
  let tokens = capacity, at = clock();
  return () => {
    const now = clock();
    tokens = Math.min(capacity, tokens + ((now - at) / 1000) * perSecond); at = now;
    if (tokens < 1) return false;
    tokens -= 1; return true;
  };
}
