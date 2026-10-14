/** Only these POSTs need a fresh, single-use App Check token. Other API calls keep the cached token. */
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
