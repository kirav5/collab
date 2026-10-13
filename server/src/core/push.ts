// Web push (Firebase Cloud Messaging): a person's devices register a token; the server notifies them when their agent
// needs them, when someone's agent contacts theirs, and when a watch finds someone new — even with the app closed.
// The notification says only what kind of thing happened and the request's title: no prices, no private facts.
import { createHash } from "node:crypto";
import type { Docs } from "../docs.ts";
import { log } from "../log.ts";

export const PUSH = "push_tokens";
let store: Docs | null = null, enabled = false;

export function initPush(db: Docs, on: boolean) { store = db; enabled = on; }

const keyOf = (token: string) => createHash("sha256").update(token).digest("hex").slice(0, 40);

export async function saveToken(uid: string, token: string) {
  if (!store) return;
  await store.set(PUSH, keyOf(token), { uid, token, at: Math.floor(Date.now() / 1000) });
}

/** Notifies every device the person registered; returns how many devices there are and how many got it. */
export async function pushTo(uid: string, title: string, body: string, link = "/"): Promise<{ devices: number; sent: number }> {
  if (!store || !enabled || uid.startsWith("demo-")) return { devices: 0, sent: 0 };
  const rows = (await store.find(PUSH, [["uid", "==", uid]], 20)) as { token: string }[];
  if (!rows.length) return { devices: 0, sent: 0 };
  try {
    const { getMessaging } = await import("firebase-admin/messaging");
    const r = await getMessaging().sendEachForMulticast({ tokens: rows.map(t => t.token),
      webpush: { notification: { title: title.slice(0, 80), body: body.slice(0, 160), icon: "/icon.svg" }, fcmOptions: { link } } });
    // Tokens a browser has dropped are removed.
    await Promise.all(r.responses.map((x, i) => (!x.success && /registration-token-not-registered|invalid-argument/.test(x.error?.code ?? "") ? store!.delete(PUSH, keyOf(rows[i].token)) : null)));
    if (r.failureCount) log.warn("push partly failed", { errors: r.responses.filter(x => !x.success).map(x => x.error?.code).slice(0, 5) });
    return { devices: rows.length, sent: r.successCount };
  } catch (e) { log.warn("push failed", { error: String(e).slice(0, 200) }); return { devices: rows.length, sent: 0 }; }
}
