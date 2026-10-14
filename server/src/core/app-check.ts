/** Only these POSTs need a fresh, single-use App Check token. Other API calls keep the cached token. */
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
): Promise<"ok" | "replay" | "invalid" | "unavailable"> {
  if (!token) return "invalid";
  try { return (await verifyAppCheckToken(token, consume, verify)) ? "ok" : "replay"; }
  catch (e) {
    if (consume && /permission|PERMISSION_DENIED|403|forbidden|unavailable|ECONN|timeout/i.test(String(e))) return "unavailable";
    return "invalid";
  }
}
