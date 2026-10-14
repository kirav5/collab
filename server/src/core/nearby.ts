// When no one on Collab offers what was asked for: real places nearby, from Grounding with Google Maps. Only places
// Google Maps returned are listed (never names the model wrote), each linking to its Maps page, with Google Maps
// credited. Owner-only and capped at five a day, like the price check.
import type { Model } from "../ai/gemini.ts";
import type { Docs } from "../docs.ts";
import { resolve } from "../market/places.ts";

export class NearbyError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }

export async function nearby(db: Docs, model: Model | null, uid: string, item: string, area: string, now: number) {
  if (!item.trim()) throw new NearbyError(400, "Describe what you need first.");
  if (!model?.nearby) throw new NearbyError(503, "Google Maps grounding isn't available here.");
  const day = new Date(now * 1000).toISOString().slice(0, 10);
  const row = await db.update("rate", `nearby:${uid}:${day}`, (cur: any) => ((cur?.used ?? 0) >= 5 ? null : { used: (cur?.used ?? 0) + 1, expireAt: new Date((now + 172800) * 1000) }));
  if (!row) throw new NearbyError(429, "Five Google Maps lookups used today. Resets at 00:00 UTC.");
  const place = area.trim() ? resolve(area) : null;
  const r = await model.nearby(item, area || "Bengaluru", place && place.lat ? { lat: place.lat, lon: place.lon } : null);
  if (!r) throw new NearbyError(503, "Google Maps didn't answer. Try again in a moment.");
  return { places: r.places, summary: r.places.length ? r.text.slice(0, 800) : "", widgetToken: r.widgetToken, remaining: 5 - row.used,
    attribution: "Google Maps", note: "Places from Google Maps. They aren't on Collab, so their agents can't be asked yet." };
}
