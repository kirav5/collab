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
