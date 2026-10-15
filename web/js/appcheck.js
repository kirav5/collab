// App Check tokens on this device. Pure, so it can be tested outside a browser.

/** The token if it's still good for at least `marginMs` (its JWT `exp`), else null — an expired token is never sent. */
export function usableToken(token, nowMs, marginMs = 30_000) {
  if (typeof token !== "string") return null;
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=")));
    return typeof json.exp === "number" && json.exp * 1000 - marginMs > nowMs ? token : null;
  } catch { return null; }
}

/** The SDK's error code ("appCheck/recaptcha-error", "appCheck/throttled"…) or a short description. */
export const appCheckCode = err => String(err?.code ?? err?.message ?? err ?? "unknown").slice(0, 80);
