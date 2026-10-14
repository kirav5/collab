import { createHmac, timingSafeEqual } from "node:crypto";
import type { Docs } from "../docs.ts";
import type { Engagement } from "./model.ts";
import { buyerOf, sellerOf } from "./pay.ts";
import { kindOf } from "./suggest.ts";
import { currencyOf } from "../market/types.ts";

export const PICKUPS = "pickups";
export const passCode = (secret: string, id: string, purpose: "pickup" | "receipt") => createHmac("sha256", secret).update(`${purpose}:v1:${id}`).digest("base64url");
export function validCode(secret: string, id: string, purpose: "pickup" | "receipt", code: unknown) {
  if (typeof code !== "string") return false;
  const expected = Buffer.from(passCode(secret, id, purpose)), got = Buffer.from(code);
  return expected.length === got.length && timingSafeEqual(expected, got);
}
/** What the pass is for: collecting goods, turning up for a booked time, or a handover (keys, a vehicle, a job). */
export function passKind(e: Engagement): "pickup" | "booking" | "handover" {
  if (e.reservation?.slotId) return "booking";
  const k = kindOf(e.offer.category);
  if (["lesson", "service", "pet", "stay", "ride", "event", "freight", "equipment"].includes(k)) return "booking";
  if (["rent", "sale", "vehicle", "job"].includes(k)) return "handover";
  return "pickup";
}

/**
 * A pass exists once the deal is paid: in the app (test mode), or settled outside it (cash, UPI). Outside payments
 * say who marked them, so a seller can check the money arrived before handing over when only the buyer said so.
 */
export function pickupDetails(e: Engagement) {
  const status = e.payment?.status;
  if (e.phase !== "agreed" || !e.payment || (status !== "paid" && status !== "outside")) throw new Error("No pass yet: the deal isn't paid.");
  const amount = e.payment.cart?.total ?? { value: e.negotiation.deal?.price ?? e.offer.price ?? 0, currency: currencyOf(e) };
  const markedBy = status === "outside" ? (e.payment.by === sellerOf(e) ? "seller" : "buyer") : null;
  return { id: e.id, item: e.offer.title, amount, buyer: e[buyerOf(e)].name, sellerHandle: e[sellerOf(e)].handle,
    paidAt: e.payment.paidAt ?? null, kind: passKind(e), slot: e.reservation?.slot?.start ?? null,
    payment: status === "paid" ? "in_app_test" : "outside", markedBy, mode: "test" };
}
/** A separate transaction document cannot be reset by an older engagement save or simultaneous scan. */
export async function collect(db: Docs, e: Engagement, uid: string, now: number) {
  pickupDetails(e);
  if (e[sellerOf(e)].uid !== uid) throw new Error("Only the seller can mark collected.");
  const result = await db.update(PICKUPS, e.id, current => current ? null : { id: e.id, collectedAt: now, collectedBy: uid });
  return { ...(result ?? await db.get(PICKUPS, e.id)), alreadyCollected: !result };
}
