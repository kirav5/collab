import { createHmac, timingSafeEqual } from "node:crypto";
import type { Docs } from "../docs.ts";
import type { Engagement } from "./model.ts";
import { buyerOf, sellerOf } from "./pay.ts";

export const PICKUPS = "pickups";
export const passCode = (secret: string, id: string, purpose: "pickup" | "receipt") => createHmac("sha256", secret).update(`${purpose}:v1:${id}`).digest("base64url");
export function validCode(secret: string, id: string, purpose: "pickup" | "receipt", code: unknown) {
  if (typeof code !== "string") return false;
  const expected = Buffer.from(passCode(secret, id, purpose)), got = Buffer.from(code);
  return expected.length === got.length && timingSafeEqual(expected, got);
}
export function pickupDetails(e: Engagement) {
  if (e.phase !== "agreed" || e.payment?.status !== "paid") throw new Error("No paid pickup pass for this deal.");
  return { id: e.id, item: e.offer.title, amount: e.payment.cart.total, buyer: e[buyerOf(e)].name,
    sellerHandle: e[sellerOf(e)].handle, paidAt: e.payment.paidAt, mode: "test" };
}
/** A separate transaction document cannot be reset by an older engagement save or simultaneous scan. */
export async function collect(db: Docs, e: Engagement, uid: string, now: number) {
  pickupDetails(e);
  if (e[sellerOf(e)].uid !== uid) throw new Error("Only the seller can mark collected.");
  const result = await db.update(PICKUPS, e.id, current => current ? null : { id: e.id, collectedAt: now, collectedBy: uid });
  return { ...(result ?? await db.get(PICKUPS, e.id)), alreadyCollected: !result };
}
