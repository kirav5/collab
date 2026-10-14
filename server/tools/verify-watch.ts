// Live Cloud Scheduler integration check with synthetic data only.
// VERIFY_LIVE=1 GOOGLE_CLOUD_PROJECT=collab-55 node tools/verify-watch.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { firestoreDocs } from "../src/docs.ts";
import { geminiFromEnv } from "../src/ai/gemini.ts";
import { saveProfile, saveFact } from "../src/core/directory.ts";
import { saveBrief } from "../src/core/briefs.ts";
import { startWatch } from "../src/core/watch.ts";
import { resolve } from "../src/market/places.ts";

const project = process.env.GOOGLE_CLOUD_PROJECT;
if (!project || process.env.VERIFY_LIVE !== "1") throw new Error("Set VERIFY_LIVE=1 and GOOGLE_CLOUD_PROJECT for a synthetic watch test.");
const db = await firestoreDocs(), model = geminiFromEnv(), now = Math.floor(Date.now() / 1000);
const id = `watchcheck-${now.toString(36)}`, place = resolve("Indiranagar")!;
let watchId: string | null = null, factId: string | null = null, sellerUid: string | null = null;
const report: Record<string, unknown> = { at: new Date().toISOString(), project, fixture: id, status: "error",
  push: "Not tested: synthetic account has no registered device" };
try {
  const buyer = await saveProfile(db, `${id}-b`, { handle: `${id}-b`, name: "Synthetic watch buyer", area: place });
  const seller = await saveProfile(db, `${id}-s`, { handle: `${id}-s`, name: "Synthetic watch shop", area: place });
  sellerUid = seller.uid;
  const existing = await db.find("facts", [["tier", "==", "public"]], 1000);
  const brief = await saveBrief(db, buyer.uid,
    { id, category: "goods", text: "", place, radiusKm: 8, maxPrice: null, attributes: {}, mustAsk: [], unit: null, mode: "in_person", filters: [], mandate: null },
    { title: "Steel water bottle", summary: "A new steel water bottle for pickup in Indiranagar", category: "goods", mode: "in_person", area: place.name, requirements: [], budget: null, questions: [] }, now);
  const watch = await startWatch(db, buyer.uid, brief.id, existing.map(f => f.id), 15, 1);
  watchId = watch.id;
  const fact = await saveFact(db, model, seller, { tier: "public", text: "Steel water bottles, 1 litre, ₹450 each, new, pickup in Indiranagar." });
  factId = fact.id;
  await db.merge("watches", watch.id, { nextRun: now - 1 });
  report.watchId = watch.id;
  report.factId = fact.id;
  report.forcedDue = true;
  execFileSync("gcloud", ["scheduler", "jobs", "run", "collab-watches", "--location", "asia-south1", "--project", project], { stdio: "pipe" });
  for (let n = 0; n < 24; n++) {
    await new Promise(r => setTimeout(r, 2000));
    const w = await db.get("watches", watch.id);
    if (w.runs > 0) { report.runs = w.runs; report.lastRun = w.lastRun; break; }
  }
  const alerts = await db.find("alerts", [["watchId", "==", watch.id]], 100);
  report.matchAlert = alerts.some(a => a.factId === fact.id);
  report.alerts = alerts.length;
  report.status = report.matchAlert ? "pass" : "fail";
} catch (e) { report.error = String(e).slice(0, 240); }
finally {
  if (watchId) await db.merge("watches", watchId, { active: false });
  if (factId) await db.merge("facts", factId, { tier: "private", embedding: null, offer: null });
  if (sellerUid) await db.merge("profiles", sellerUid, { paused: true });
  mkdirSync(new URL("../../docs/bench", import.meta.url), { recursive: true });
  writeFileSync(new URL("../../docs/bench/watch.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify(report));
process.exitCode = report.status === "pass" ? 0 : 1;
