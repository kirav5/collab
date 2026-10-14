// Collab Market on Cloud Run. Each person's always-on agent speaks A2A at /a2a/<handle>; the web app (their device
// agent) uses /api. Storage is Firestore; the model is Gemini (Vertex AI on Cloud Run, or an AI Studio key locally);
// accounts are Firebase Auth. Private context never reaches this server's storage: the few /api calls that carry it
// (/api/think, /api/route) use it for one model call and keep nothing.
//
// STORE=memory and DEV_AUTH=1 run it with no Google project (tests, local development).
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import express, { type NextFunction, type Request, type Response } from "express";
import { type Docs, firestoreDocs, memoryDocs } from "./docs.ts";
import { geminiFromEnv } from "./ai/gemini.ts";
import { fakeModel } from "./ai/fake.ts";
import { decide } from "./ai/decide.ts";
import { AnswerTask } from "./market/answer.ts";
import { budgetBand } from "./market/match.ts";
import { read } from "./market/read.ts";
import { numbers } from "./market/text.ts";
import { domain as domainOf } from "./market/domains.ts";
import { savedKey } from "./market/answer.ts";
import { docId } from "./docs.ts";
import { area, resolve, suggest } from "./market/places.ts";
import type { Mandate, Need, Place } from "./market/types.ts";
import { Problem, byHandle, saveFact, saveProfile, search } from "./core/directory.ts";
import { BRIEFS, draft, saveBrief } from "./core/briefs.ts";
import { ANSWERS, AUDIT, CONTACTS, ENGAGEMENTS, INBOX, LIMITS, Refused, fresh, load, Stale, offerDeal, resolve as resolveItem, save as saveEngagement, setOutgoingScreen, setSigner, type Turn } from "./core/engage.ts";
import { modelArmor } from "./core/armor.ts";
import { capabilities } from "./core/capabilities.ts";
import { GOALS, type Goal, backfillGoals, createGoal, goalView, linkTask } from "./core/goals.ts";
import { loadPolicy, policy, policyHash, setPolicy } from "./config/policy.ts";
import { turnQueue } from "./core/queue.ts";
import { recoverOutbox } from "./core/recovery.ts";
import { expireDecisions } from "./core/decisions.ts";
import { NearbyError, nearby } from "./core/nearby.ts";
import { chooseOffering } from "./core/directory.ts";
import { ap2Pay, verifyAp2, type Ap2Instrument } from "./core/ap2.ts";
import { checkPrice, PriceCheckError, PRICE_CHECKS, quotaStatus } from "./core/price-check.ts";
import { appCheckDecision, replayProtected } from "./core/app-check.ts";
import { signer } from "./core/signatures.ts";
import { PICKUPS, passCode, validCode, pickupDetails, collect } from "./core/pickup.ts";
import { buyerOf, checkPayment, linesOf, pay, sellerOf } from "./core/pay.ts";
import { offeredMoney } from "./core/direct.ts";
import { moneyText } from "./market/types.ts";
import { forProvider, forRequester, insights, receipt, RECEIPTS, registerReceipt, sameItem, stats, verifyReceipt } from "./core/deals.ts";
import type { Brief, Contact, Engagement, Fact, InboxItem, Profile, Rule, SharedBrief } from "./core/model.ts";
import { FACTS, PROFILES, RULES, ruleActive } from "./core/policy.ts";
import { RefineTask, RouteTask, TopicsTask } from "./core/tasks.ts";
import { take } from "./core/limits.ts";
import { TURN, a2aRouter, deliverProviderTurn, sendTurn, signReceipt } from "./a2a/agents.ts";
import { seedDemo } from "./demo.ts";
import { log } from "./log.ts";
import { initPush, pushTo, saveToken } from "./core/push.ts";
import { ALERTS, type Alert, WATCHES, type Watch, runDue, startWatch } from "./core/watch.ts";

// Local development reads server/.env (GEMINI_API_KEY=…); Cloud Run sets its environment itself.
const envFile = new URL("../.env", import.meta.url);
if (existsSync(envFile)) for (const line of readFileSync(envFile, "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const env = process.env;
const port = Number(env.PORT ?? 8080);
const now = () => Math.floor(Date.now() / 1000);
const db: Docs = env.STORE === "memory" ? memoryDocs() : await firestoreDocs();
const model = env.GEMINI_FAKE === "1" ? fakeModel() : geminiFromEnv();
const WEB_DIR = env.WEB_DIR ?? new URL("../../web", import.meta.url).pathname;

let verifier: ((t: string) => Promise<string>) | null = null;
async function verifyIdToken(token: string): Promise<string> {
  if (env.DEV_AUTH === "1" && token.startsWith("dev:")) return token.slice(4, 64);
  if (!verifier) {
    const { initializeApp, getApps } = await import("firebase-admin/app");
    const { getAuth } = await import("firebase-admin/auth");
    if (!getApps().length) initializeApp();
    verifier = async t => (await getAuth().verifyIdToken(t)).uid;
  }
  return verifier(token);
}

const signing = signer(env.RECEIPT_KEY, env.STORE === "memory");
const verifySigned = (uid: string, hash: string, sig: string) => sig.startsWith("ed25519.") ? signing.verify(uid, hash, sig) : signReceipt(cfg.secret, uid, hash) === sig;
// Operational policy: validated at start (an invalid policy stops the server), hashed for /health and task records.
setPolicy(loadPolicy(env));
const POLICY_HASH = policyHash(policy());
const armor = modelArmor(env.GOOGLE_CLOUD_PROJECT, env.MODEL_ARMOR_LOCATION ?? "asia-south1", env.MODEL_ARMOR_INCOMING, env.MODEL_ARMOR_OUTGOING,
  env.MODEL_ARMOR_FAIL_MODE === "closed" ? "closed" : "open");
setOutgoingScreen(armor ? armor.outgoing : null);
const queue = turnQueue(env.TASKS_QUEUE, env.RUN_URL, env.TASKS_SERVICE_ACCOUNT);
const cfg = { db, model, directUrl: env.RUN_URL || undefined, enqueue: queue ? queue.enqueue : undefined, receiptKey: signing.publicKey, receiptSubject: signing.subject, cardKey: { privateKey: signing.privateKey, kid: signing.kid },
  screen: armor ? armor.incoming : undefined, publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ""), secret: (env.AGENT_SECRET ?? randomBytes(32).toString("hex")).trim(), verifyIdToken };
const a2a = a2aRouter(cfg);
setSigner(signing.sign);
initPush(db, env.STORE !== "memory");

// MARK: - Plumbing

// Stable error codes (AUTHORITY_REQUIRED, VERSION_CONFLICT, …) let clients act on routine failures without reading prose;
// the message stays for people. Codes default from the status when a route doesn't name one.
const CODE_BY_STATUS: Record<number, string> = { 400: "INVALID_INPUT", 401: "AUTHENTICATION_REQUIRED", 403: "AUTHORITY_REQUIRED", 404: "NOT_FOUND", 409: "VERSION_CONFLICT", 413: "TOO_LARGE", 429: "RATE_LIMITED", 503: "UNAVAILABLE" };
class HttpError extends Error { status: number; code: string; constructor(status: number, message: string, code?: string) { super(message); this.status = status; this.code = code ?? CODE_BY_STATUS[status] ?? "ERROR"; } }
type Handler = (req: Request & { uid: string }, res: Response) => Promise<unknown>;

async function uidOf(req: Request): Promise<string> {
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) throw new HttpError(401, "sign in first");
  try { return await verifyIdToken(token); } catch { throw new HttpError(401, "sign in again"); }
}

/** Gemini calls cost money: each account gets a steady allowance (a burst of 60, then 1 every 15 s), counted in
 *  Firestore so it holds across every instance. */
async function spend(uid: string, n = 1) {
  if (!(await take(db, `user:${uid}`, n, 60, 1 / 15))) throw new HttpError(429, "Slow down a little — try again in a minute.");
}

const route = (h: Handler, auth = true) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (auth) (req as any).uid = await uidOf(req);
    res.set("cache-control", "no-store").json((await h(req as any, res)) ?? null);
  } catch (e) { next(e); }
};

const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown, lo: number, hi: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null);

function placeFrom(p: any): Place | null {
  const lat = num(p?.lat, -90, 90), lon = num(p?.lon, -180, 180);
  return lat === null || lon === null ? null : { name: text(p.name, 120), lat, lon, isCity: !!p.isCity };
}

function mandateFrom(m: any): Mandate | null {
  const opening = num(m?.price?.opening, 1, 1e12), limit = num(m?.price?.limit, 1, 1e12);
  if (opening === null || limit === null) return null;
  return { price: { opening, limit }, terms: {}, maxRounds: Math.min(12, Math.max(1, Math.round(num(m.maxRounds, 1, 12) ?? 5))) };
}

/** A need as the device sends it back after the owner reviewed it: shape-checked, never trusted further. */
function needFrom(n: any): Need {
  const place = placeFrom(n?.place);
  if (!n || typeof n.category !== "string" || !place) throw new HttpError(400, "bad request draft");
  const filters = (Array.isArray(n.filters) ? n.filters : []).slice(0, 10).filter((f: any) => typeof f?.id === "string" && typeof f?.value === "string")
    .map((f: any) => ({ id: text(f.id, 40), label: text(f.label, 60), kind: f.kind, comparison: f.comparison, value: text(f.value, 80), unit: f.unit ? text(f.unit, 20) : null,
      strength: f.strength === "required" ? "required" : "preferred", source: f.source === "implied" ? "implied" : "stated", evidence: "", question: f.question ? text(f.question, 160) : null }));
  return { id: text(n.id, 40), category: text(n.category, 40), text: "", place, radiusKm: num(n.radiusKm, 0.5, 100) ?? 8, maxPrice: num(n.maxPrice, 1, 1e12),
    attributes: Object.fromEntries(Object.entries(n.attributes ?? {}).slice(0, 12).map(([k, v]) => [text(k, 40), text(v, 80)])),
    mustAsk: (Array.isArray(n.mustAsk) ? n.mustAsk : []).slice(0, 5).map((q: unknown) => text(q, 160)).filter(Boolean),
    unit: n.unit ? text(n.unit, 20) : null, mode: ["online", "in_person", "either"].includes(n.mode) ? n.mode : null, filters, mandate: n.mandate ? mandateFrom(n.mandate) : null };
}

function sharedFrom(b: any, need: Need): SharedBrief {
  return { title: text(b?.title, 80) || "Request", summary: text(b?.summary, 320), category: need.category, mode: need.mode ?? null,
    area: typeof b?.area === "string" ? text(b.area, 120) : null,
    requirements: (Array.isArray(b?.requirements) ? b.requirements : []).slice(0, 10).map((r: any) => ({ label: text(r?.label, 60), value: text(r?.value, 80), strength: r?.strength === "required" ? "required" : "preferred" })),
    budget: typeof b?.budget === "string" ? text(b.budget, 60) : null, questions: (Array.isArray(b?.questions) ? b.questions : []).slice(0, 4).map((q: unknown) => text(q, 160)).filter(Boolean) };
}

const me = async (uid: string) => {
  const p = (await db.get(PROFILES, uid)) as Profile | null;
  if (!p) throw new HttpError(409, "Choose a handle first.");
  return p;
};
const publicFact = ({ embedding: _, ...f }: Fact) => f;

// MARK: - Routes

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
// One line per request: method, route, status, time and who — never the body.
app.use((req, res, next) => {
  const started = Date.now();
  res.on("finish", () => {
    if (req.path.startsWith("/js/") || req.path.endsWith(".css")) return;
    log.info("request", { httpRequest: { requestMethod: req.method, requestUrl: req.path, status: res.statusCode, latency: `${(Date.now() - started) / 1000}s`, remoteIp: req.ip, userAgent: req.headers["user-agent"]?.slice(0, 120) }, uid: (req as any).uid });
  });
  next();
});
app.use("/a2a", a2a.router);
app.use("/api/chats", express.json({ limit: "700kb" })); // chat history uploads are larger than any other call
app.use("/api", express.json({ limit: "128kb" }));

// App Check: calls to the API come from our own web app. "monitor" logs what would be refused; "enforce" refuses.
// (A2A at /a2a stays open to any agent — that's the point of it — and is rate-limited instead.)
const APPCHECK = env.APPCHECK ?? "off";
let consumeUnavailable: { at: number; error: string } | null = null;
let appCheck: ((t: string, options?: { consume: boolean }) => Promise<{ alreadyConsumed?: boolean }>) | null = null;
app.use("/api", async (req, res, next) => {
  if (APPCHECK === "off" || req.path === "/config") return next();
  const token = req.headers["x-firebase-appcheck"];
  // Consuming a token needs a network call and the Token Verifier IAM role. Do it only for sensitive writes when
  // enforcement is on; monitor mode keeps working with ordinary cached tokens.
  const consume = APPCHECK === "enforce" && replayProtected(req.method, req.path);
  if (!appCheck) {
    const { initializeApp, getApps } = await import("firebase-admin/app");
    const { getAppCheck } = await import("firebase-admin/app-check");
    if (!getApps().length) initializeApp();
    appCheck = (t, options) => getAppCheck().verifyToken(t, options);
  }
  const decision = await appCheckDecision(typeof token === "string" ? token : undefined, consume, appCheck);
  // Fail closed: a sensitive action whose single-use token can't be consumed is refused, and /health shows it.
  if (decision === "unavailable") {
    consumeUnavailable = { at: now(), error: "token consumption failed" };
    log.error("app check replay protection unavailable: sensitive actions refused", { path: req.path });
    return res.status(503).json({ error: "Payments and pickups are paused for a moment while a security check is unavailable. Try again shortly.", code: "SECURITY_CHECK_UNAVAILABLE" });
  }
  if (consume && decision === "ok") consumeUnavailable = null;
  const ok = decision === "ok";
  if (ok) return next();
  log.warn("app check failed", { path: req.path, mode: APPCHECK, hadToken: typeof token === "string", replayProtected: consume });
  if (APPCHECK === "enforce") return res.status(401).json({ error: consume ? "This action needs a fresh app check. Please try again." : "Please use the Collab app (app check failed)." });
  next();
});

app.get("/health", route(async () => ({ ok: true, build: env.BUILD_ID ?? "local", policy: POLICY_HASH, model: model?.status() ?? null, store: env.STORE === "memory" ? "memory" : "firestore", a2a: `${cfg.publicUrl}/a2a/<handle>`,
  modelArmor: armor ? { on: true, ...armor.stats } : { on: false },
  security: { appCheck: APPCHECK, replayProtection: APPCHECK !== "enforce" ? "off" : consumeUnavailable ? "degraded — sensitive actions refused" : "on" } }), false));
app.get("/api/config", route(async () => ({ firebase: env.FIREBASE_WEB_CONFIG ? JSON.parse(env.FIREBASE_WEB_CONFIG) : null, devAuth: env.DEV_AUTH === "1", model: model?.name ?? null,
  a2aBase: `${cfg.publicUrl}/a2a`, appCheckSiteKey: env.RECAPTCHA_SITE_KEY ?? null }), false));

// Goals: what the owner wants done, with each conversation as a task and a state that follows from them.
app.get("/api/goals", route(async req => {
  await backfillGoals(db, req.uid, now());
  const gs = ((await db.find(GOALS, [["owner", "==", req.uid]], 100)) as Goal[]).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50);
  return Promise.all(gs.map(g => goalView(db, g)));
}));
app.get("/api/goals/:id", route(async req => {
  const g = (await db.get(GOALS, String(req.params.id))) as Goal | null;
  if (!g || g.owner !== req.uid) throw new HttpError(404, "goal not found");
  return goalView(db, g);
}));
app.post("/api/goals", route(async req => {
  await me(req.uid);
  const outcome = text(req.body?.outcome, 200).trim();
  if (outcome.length < 2) throw new HttpError(400, "Say what you want done.");
  const kind = ["purchase", "service", "information", "other"].includes(req.body?.kind) ? req.body.kind : "other";
  const amount = num(req.body?.budget?.amount, 1, 1e9), currency = text(req.body?.budget?.currency, 3).toUpperCase() || policy().money.defaultCurrency;
  if (amount && !policy().money.currencies.includes(currency)) throw new HttpError(400, `Budgets in ${currency} aren't supported.`, "UNSUPPORTED_CURRENCY");
  return goalView(db, await createGoal(db, req.uid, outcome, kind, amount ? { amount, currency } : null, now()));
}));
app.post("/api/goals/:id/cancel", route(async req => {
  const r = await db.update(GOALS, String(req.params.id), (g: Goal | null) => (g && g.owner === req.uid ? { ...g, closed: "cancelled", revision: g.revision + 1, updatedAt: now() } : null));
  if (!r) throw new HttpError(404, "goal not found");
  // Its conversations that haven't reached a deal end too; agreed deals keep their obligations.
  for (const id of r.taskIds) await db.update(ENGAGEMENTS, id, (e: Engagement | null) => (e && ["asking", "negotiating", "deal"].includes(e.phase)
    ? { ...e, phase: e.requester.uid === req.uid ? "closed" : "declined", waiting: { requester: null, provider: null }, outbox: null, outboxPending: false,
        events: [...e.events, { at: now(), who: e.requester.uid === req.uid ? "requester" : "provider", text: "Goal cancelled — conversation ended.", by: "owner" }], updatedAt: now() } : null));
  return goalView(db, r);
}));

// What the app may show about the policy it runs under: quotas with today's remaining use and reset time, currencies,
// features and versions. Never private limits or anything per-owner beyond the caller's own quota use.
app.get("/api/policy", route(async req => {
  const p = policy(), t = now();
  return { version: POLICY_HASH, currencies: p.money.currencies, defaultCurrency: p.money.defaultCurrency, features: p.features,
    negotiation: { maxRounds: p.negotiation.maxRounds }, checkoutValiditySec: p.timing.checkoutValiditySec,
    quotas: { priceCheck: await quotaStatus(db, "price-check", req.uid, p.quotas.priceChecksPerDay, t), nearby: await quotaStatus(db, "nearby", req.uid, p.quotas.nearbyPerDay, t) } };
}));
app.get("/api/insights", route(async req => {
  const i = await insights(db, { category: text(req.query.category, 40), area: text(req.query.area, 120) || null, item: text(req.query.item, 120) || null,
    unit: req.query.unit === undefined ? undefined : text(req.query.unit, 20) || null });
  if (!i) return { insights: null, lines: [] };
  const price = num(Number(req.query.price), 1, 1e12), limit = num(Number(req.query.limit), 1, 1e12);
  const lines = req.query.side === "provider" ? forProvider(i, price) : forRequester(i, limit, price);
  return { insights: i, lines };
}));

app.get("/api/places", route(async req => {
  const near = placeFrom({ lat: Number(req.query.lat), lon: Number(req.query.lon) });
  if (typeof req.query.q === "string") return suggest(text(req.query.q, 60), near);
  return near ? area(near.lat, near.lon) : null;
}, false));

// Profile, people
app.get("/api/me", route(async req => (await db.get(PROFILES, req.uid)) ?? null));
app.post("/api/me", route(async req => {
  const b = req.body ?? {};
  const areaPlace = placeFrom(b.area) ?? (typeof b.areaName === "string" ? resolve(b.areaName) : undefined);
  return saveProfile(db, req.uid, { handle: b.handle, name: b.name, bio: b.bio, ...(areaPlace !== undefined ? { area: areaPlace } : {}) });
}));
app.post("/api/me/pause", route(async req => { const p = await me(req.uid); p.paused = !!req.body?.paused; await db.set(PROFILES, p.uid, p); return p; }));
app.get("/api/people/:handle", route(async req => {
  const p = await byHandle(db, String(req.params.handle));
  if (!p) throw new HttpError(404, "no one by that handle");
  const facts = ((await db.find(FACTS, [["owner", "==", p.uid]], 200)) as Fact[]).filter(f => f.tier === "public").map(publicFact);
  return { profile: { uid: p.uid, handle: p.handle, name: p.name, bio: p.bio, demo: !!p.demo }, stats: await stats(db, p.uid), facts, agentCard: `${cfg.publicUrl}/a2a/${p.handle}/.well-known/agent-card.json` };
}));
// Direct: a QR code (or a link) opens a conversation with one person's or shop's agent — no search. Questions go over
// A2A like any engagement; their agent answers from what they share and can quote, negotiate and close.
app.post("/api/people/:handle/ask", route(async req => {
  const me_ = await me(req.uid);
  const p = await byHandle(db, String(req.params.handle));
  if (!p) throw new HttpError(404, "no one by that handle");
  if (p.uid === req.uid) throw new HttpError(400, "that's you");
  await spend(req.uid, 2);
  const t = text(req.body?.text, 600).trim();
  if (t.length < 2) throw new HttpError(400, "Ask something.");
  // The offering this is about: named, or the only match. Otherwise no price yet — the shop's agent asks which.
  const f = (await chooseOffering(db, p.uid, typeof req.body?.offerFactId === "string" ? req.body.offerFactId : null, t)).fact;
  const questions = (t.match(/[^.?!\n]*\?/g) ?? []).map(q => q.trim()).filter(q => q.length >= 3).slice(0, 4);
  const brief: SharedBrief = { title: t.slice(0, 80), summary: t, category: f?.offer?.category ?? "", mode: null, area: null, requirements: [], budget: null, questions: questions.length ? questions : [t.slice(0, 160)] };
  const e = fresh({ briefId: null, brief, requester: { uid: me_.uid, handle: me_.handle, name: me_.name }, provider: { uid: p.uid, handle: p.handle, name: p.name },
    offer: f?.offer ? { factId: f.id, title: f.offer.title, price: f.offer.price.amount, unit: f.offer.price.period ?? null, category: f.offer.category } : { factId: null, title: t.slice(0, 80), price: null, unit: null, category: null } });
  e.briefId = `direct-${e.id}`; // the requester's private limit for this conversation is keyed by it
  e.events.push({ at: now(), who: "system", text: `You asked ${p.name}'s agent directly.` });
  // A direct question is its own goal: information until a price is involved.
  const goal = await createGoal(db, req.uid, t, f?.offer ? "purchase" : "information", null, now());
  e.goalId = goal.id; await linkTask(db, goal.id, req.uid, e.id, now());
  e.outbox = { kind: TURN, from: "requester", engagementId: e.id, brief, offerFactId: f?.id ?? null };
  await saveEngagement(db, e);
  return e;
}));
// A follow-up in an open conversation, from either side: it goes over A2A like any turn, and the other agent answers
// from what its owner shares or asks its owner (who gets a notification).
app.post("/api/engagements/:id/ask", route(async req => {
  const e = await participant(req.uid, String(req.params.id));
  if (["agreed", "closed", "declined"].includes(e.phase)) throw new HttpError(400, "This conversation has ended — start a new one.");
  await spend(req.uid, 2);
  const q = text(req.body?.text, 300).trim();
  if (q.length < 2) throw new HttpError(400, "Ask something.");
  const side = e.requester.uid === req.uid ? "requester" : "provider";
  // Naming a price in a chat with no listed price offers a deal: the other person confirms or says no.
  // A named price offers a deal — in a currency this deployment supports, and the one the conversation already uses.
  const offered = e.offer.price == null && e.phase !== "deal" ? offeredMoney(q, e.offer.currency ?? policy().money.defaultCurrency) : null;
  if (offered) {
    if (!policy().money.currencies.includes(offered.currency))
      throw new HttpError(400, `Payments in ${offered.currency} aren't supported yet — use ${policy().money.currencies.join(" or ")}.`, "UNSUPPORTED_CURRENCY");
    if (e.offer.currency && e.offer.currency !== offered.currency)
      throw new HttpError(400, `This conversation is in ${e.offer.currency}; offer in ${e.offer.currency}.`, "UNSUPPORTED_CURRENCY");
    e.offer.currency = offered.currency;
    await offerDeal(db, e, side, offered.amount, q);
    return load(db, e.id);
  }
  e.events.push({ at: now(), who: side, text: q, by: "owner" });
  await saveEngagement(db, e);
  const turn: Turn = { kind: TURN, from: side, engagementId: e.id, questions: [{ id: Math.random().toString(36).slice(2, 12), question: q }] };
  if (side === "requester") await sendTurn(cfg, e.id, turn);
  else await deliverProviderTurn(cfg, a2a.store, e.id, turn);
  return load(db, e.id);
}));

// Chat history follows the account (an installed app and a browser tab keep separate storage, and so do phones):
// each chat is stored under its owner only, read back only by them. Like Private facts, it's never shared.
const CHATS = "chats";
const chatKey = (uid: string, id: string) => `${uid}_${id.replace(/[^\w-]/g, "").slice(0, 40)}`;
app.get("/api/chats", route(async req => {
  const rows = (await db.find(CHATS, [["owner", "==", req.uid]], 200)) as { id: string; updatedAt: number; json: string }[];
  return rows.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100).flatMap(r => { try { return [JSON.parse(r.json)]; } catch { return []; } });
}));
app.post("/api/chats", route(async req => {
  const c = req.body?.chat;
  if (!c || typeof c.id !== "string" || !Array.isArray(c.messages)) throw new HttpError(400, "not a chat");
  const json = JSON.stringify({ ...c, messages: c.messages.slice(-200) });
  if (json.length > 600_000) throw new HttpError(413, "This chat is too long to keep in your account; it stays on this device.");
  const updatedAt = Number(c.updatedAt) || now();
  const stored = await db.update(CHATS, chatKey(req.uid, c.id), cur => cur && cur.updatedAt > updatedAt ? null : { owner: req.uid, id: c.id, updatedAt, json });
  return { ok: true, stale: !stored };
}));
app.post("/api/chats/clear", route(async req => {
  const rows = (await db.find(CHATS, [["owner", "==", req.uid]], 500)) as { id: string }[];
  await Promise.all(rows.map(r => db.delete(CHATS, chatKey(req.uid, r.id))));
  return { deleted: rows.length };
}));

app.get("/api/contacts", route(async req => db.find(CONTACTS, [["owner", "==", req.uid]], 300)));
app.post("/api/contacts", route(async req => {
  const p = await byHandle(db, text(req.body?.handle, 40));
  if (!p || p.uid === req.uid) throw new HttpError(404, "no one by that handle");
  const c: Contact = { owner: req.uid, uid: p.uid, handle: p.handle, name: p.name, addedAt: now() };
  await db.set(CONTACTS, `${req.uid}_${p.uid}`, c);
  return c;
}));
app.post("/api/contacts/remove", route(async req => { await db.delete(CONTACTS, `${req.uid}_${text(req.body?.uid, 128)}`); return { ok: true }; }));

// Context (all tiers; Private is stored but the policy gate never shares it)
app.get("/api/facts", route(async req => ((await db.find(FACTS, [["owner", "==", req.uid]], 500)) as Fact[]).map(publicFact).sort((a, b) => b.updatedAt - a.updatedAt)));
app.post("/api/facts", route(async req => {
  const b = req.body ?? {};
  if (!["private", "protected", "public"].includes(b.tier)) throw new HttpError(400, "Tier must be private, protected or public.");
  await spend(req.uid, 2);
  return publicFact(await saveFact(db, model, await me(req.uid), { id: b.id ? text(b.id, 40) : undefined, text: text(b.text, 1000), tier: b.tier, topics: Array.isArray(b.topics) ? b.topics.map((t: unknown) => text(t, 24)) : undefined, negotiable: b.negotiable === true,
    // A chat memory is always Private: sharing it means rewriting it as a fact of its own.
    ...(b.source === "chat" ? { source: "chat" as const, tier: "private" as const } : {}) }));
}));
app.post("/api/facts/:id/delete", route(async req => {
  const f = (await db.get(FACTS, String(req.params.id))) as Fact | null;
  if (!f || f.owner !== req.uid) throw new HttpError(404, "not found");
  await db.delete(FACTS, f.id);
  await db.delete(LIMITS, `fact:${f.id}`);
  for (const a of await db.find(ANSWERS, [["factId", "==", f.id]], 200)) await db.delete(ANSWERS, docId(`${f.id}:${savedKey(a.question)}`));
  return { ok: true };
}));
/** Hand an offering's floor to the always-on agent (so it negotiates while the owner is away), or take it back. */
app.post("/api/facts/:id/limit", route(async req => {
  const f = (await db.get(FACTS, String(req.params.id))) as Fact | null;
  if (!f || f.owner !== req.uid || !f.offer) throw new HttpError(404, "not found");
  const m = mandateFrom(req.body?.mandate);
  if (m) {
    const days = num(req.body?.days, 1, 365);
    await db.set(LIMITS, `fact:${f.id}`, { key: `fact:${f.id}`, owner: req.uid, mandate: { ...m, price: { opening: f.offer.price.amount, limit: Math.min(m.price.limit, f.offer.price.amount) } },
      autonomy: ["close", "ask"].includes(req.body?.autonomy) ? req.body.autonomy : "negotiate", expires: days ? now() + days * 86_400 : null, createdAt: now() });
    // A floor below the ask means the price can move: the matcher may show it to near-budget requests.
    if (m.price.limit < f.offer.price.amount && f.offer.attributes.negotiable !== "yes")
      await db.set(FACTS, f.id, { ...f, offer: { ...f.offer, attributes: { ...f.offer.attributes, negotiable: "yes" } } });
  } else await db.delete(LIMITS, `fact:${f.id}`);
  return { delegated: !!m };
}));
app.get("/api/limits", route(async req => (await db.find(LIMITS, [["owner", "==", req.uid]], 200)).map((l: any) => ({ key: l.key, mandate: l.mandate, limit: l.mandate.price.limit, autonomy: l.autonomy ?? "negotiate", expires: l.expires ?? null }))));
app.post("/api/topics", route(async req => {
  await spend(req.uid);
  const existing = [...new Set(((await db.find(FACTS, [["owner", "==", req.uid]], 300)) as Fact[]).flatMap(f => f.topics))];
  return (await decide(model, TopicsTask, { text: text(req.body?.text, 400), existing })).output;
}));

// Rules (who sees which Protected topics)
app.get("/api/rules", route(async req => ((await db.find(RULES, [["owner", "==", req.uid]], 200)) as Rule[]).filter(r => ruleActive(r, now())).sort((a, b) => b.createdAt - a.createdAt)));
app.post("/api/rules", route(async req => {
  const b = req.body ?? {};
  let audience = "anyone", audienceName = "Anyone who contacts my agent";
  if (b.audience && b.audience !== "anyone") {
    const p = await byHandle(db, text(b.audience, 40));
    if (!p) throw new HttpError(404, "no one by that handle");
    audience = p.uid; audienceName = `${p.name} (@${p.handle})`;
  }
  const topics = (Array.isArray(b.topics) ? b.topics : []).map((t: unknown) => text(t, 24).toLowerCase().trim()).filter(Boolean).slice(0, 8);
  if (!topics.length) throw new HttpError(400, "Name at least one topic.");
  const days = num(b.days, 1, 365);
  const r: Rule = { id: `${req.uid}-${Date.now().toString(36)}`, owner: req.uid, audience, audienceName, topics,
    shape: ["yesNo", "oneLine", "summary", "full"].includes(b.shape) ? b.shape : "oneLine", approval: b.approval === "auto" ? "auto" : "review",
    expires: days ? now() + days * 86_400 : null, createdAt: now() };
  await db.set(RULES, r.id, r);
  return r;
}));
app.post("/api/rules/:id/revoke", route(async req => {
  const r = (await db.get(RULES, String(req.params.id))) as Rule | null;
  if (!r || r.owner !== req.uid) throw new HttpError(404, "not found");
  await db.set(RULES, r.id, { ...r, revoked: true });
  return { ok: true };
}));
app.get("/api/activity", route(async req => (await db.find(AUDIT, [["owner", "==", req.uid]], 200)).sort((a: any, b: any) => b.at - a.at)));

// The device agent's model calls: what it sends is used for this one call and not stored or logged.
app.post("/api/route", route(async req => {
  await spend(req.uid);
  return (await decide(model, RouteTask, { text: text(req.body?.text, 600), recent: (Array.isArray(req.body?.recent) ? req.body.recent : []).slice(-4).map((r: unknown) => text(r, 200)),
    open: typeof req.body?.open === "string" ? text(req.body.open, 120) : null })).output;
}));
app.post("/api/think", route(async req => {
  await spend(req.uid);
  const notes = (Array.isArray(req.body?.notes) ? req.body.notes : []).slice(0, 12).map((n: any) => ({ label: "Note", value: text(n?.text, 600) })).filter((n: any) => n.value);
  if (!notes.length) return { action: "ask_owner" };
  const d = await decide(model, AnswerTask, { question: text(req.body?.question, 300), facts: notes, side: req.body?.side === "provider" ? "seller" : "buyer" });
  return { ...d.output, byModel: d.byModel };
}));

/** An offering, read before publishing: what the directory will show, and the private floor kept apart from it. A
 *  clause stating the floor ("lowest 600") is taken out of the public text — the owner sees both before publishing. */
app.post("/api/offers/draft", route(async req => {
  await spend(req.uid, 2);
  const t = text(req.body?.text, 1000).trim();
  if (t.length < 4) throw new HttpError(400, "Say a bit more.");
  const here = placeFrom(req.body?.here) ?? ((await db.get(PROFILES, req.uid)) as Profile | null)?.area ?? null;
  const r = await read(t, "sell", model, now(), here, null, true);
  if (r.draft?.kind !== "offer") return { offer: null, floor: null, publicText: t };
  // The model reads a stated floor; a written one ("lowest 600", "won't go below 600") is caught either way, so the
  // directory never shows it whatever the model does.
  const written = statedFloor(t);
  const read_ = r.draft.mandate.price.limit < r.draft.mandate.price.opening ? r.draft.mandate.price.limit : null;
  const floor = read_ ?? (written !== null && written < r.draft.offer.price.amount ? written : null);
  const publicText = floor ? withoutAmount(t, floor) : t;
  return { offer: { ...r.draft.offer, details: publicText }, floor, publicText };
}));

function statedFloor(t: string): number | null {
  const m = t.replace(/(\d),(?=\d)/g, "$1").match(/\b(?:lowest|minimum|min\.?|at least|won'?t go below|not (?:go )?below|can go (?:down )?to|floor(?: is)?|bottom line)\s*(?:is\s*)?(?:₹|rs\.?\s*|inr\s*)?(\d+(?:\.\d+)?)\s*(k|thousand|lakh|l)?\b/i);
  if (!m) return null;
  const scale = /^(k|thousand)$/i.test(m[2] ?? "") ? 1_000 : /^(lakh|l)$/i.test(m[2] ?? "") ? 100_000 : 1;
  return Math.round(Number(m[1]) * scale);
}

/** The text without the clauses that state this amount (in any written scale: 600, 6,000, 1.2 lakh). */
function withoutAmount(t: string, amount: number): string {
  const clauses = t.split(/(?<=[,.;])\s+|\s+(?=but\b|and lowest\b|lowest\b|minimum\b|won't go below\b|wont go below\b|can go down\b)/i);
  const kept = clauses.filter(c => !numbers(c).some(n => [1, 1_000, 100_000, 10_000_000].some(k => Math.round(n * k) === Math.round(amount))));
  return kept.join(" ").replace(/\s+([,.;])/g, "$1").replace(/[,;]\s*$/, ".").trim();
}

// Requests: draft (with Gemini's clarifying questions) → send (search the directory) → engage chosen people over A2A
app.post("/api/briefs/draft", route(async req => {
  const hint = domainOf(text(req.body?.category, 40)) ? text(req.body?.category, 40) : null;
  await spend(req.uid, hint ? 3 : 4);
  const t = text(req.body?.text, 600).trim();
  if (t.length < 4) throw new HttpError(400, "Say a bit more.");
  const here = placeFrom(req.body?.here) ?? ((await db.get(PROFILES, req.uid)) as Profile | null)?.area ?? null;
  return draft(model, t, here, now(), hint);
}));
/** The owner changes their open request ("try a wider area", "up to 600", "in Koramangala instead"): Gemini reads the
 *  change, code checks it, and the updated request comes back to be searched again. Says exactly what changed. */
app.post("/api/briefs/refine", route(async req => {
  await spend(req.uid);
  const need = needFrom(req.body?.need), shared = sharedFrom(req.body?.shared, need);
  const limit = num(req.body?.limit, 1, 1e12);
  const r = (await decide(model, RefineTask, { text: text(req.body?.text, 300), area: need.place.name, radiusKm: need.radiusKm, limit,
    requirements: shared.requirements.map(q => ({ label: q.label, value: q.value })) })).output;
  const changes: string[] = [];
  if (r.area) {
    const p = resolve(r.area, need.place);
    if (p) { need.place = p; shared.area = p.name; changes.push(`area: ${p.name}`); }
  }
  if (r.radiusKm) { need.radiusKm = r.radiusKm; changes.push(`within ${r.radiusKm} km`); }
  if (r.drop.length) {
    const gone = new Set(r.drop.map(d => d.toLowerCase()));
    shared.requirements = shared.requirements.filter(q => !gone.has(q.label.toLowerCase()));
    need.filters = need.filters.filter(f => !gone.has(f.label.toLowerCase()));
    changes.push(`dropped ${r.drop.join(", ")}`);
  }
  if (r.limit) { shared.budget = budgetBand({ ...need, maxPrice: r.limit, mandate: null }); changes.push("new limit (private)"); }
  return { need, shared, limit: r.limit ?? limit, changes };
}));

app.post("/api/briefs", route(async req => {
  await me(req.uid);
  await spend(req.uid, 2);
  const need = needFrom(req.body?.need);
  const b = await saveBrief(db, req.uid, need, sharedFrom(req.body?.shared, need), now());
  // Every request is a goal; the conversations it starts are that goal's tasks.
  const goal = await createGoal(db, req.uid, b.shared.title, /service|lesson|task|repair|clean/i.test(need.category ?? "") ? "service" : "purchase", null, now());
  await db.merge(BRIEFS, b.id, { goalId: goal.id }); b.goalId = goal.id;
  const del = req.body?.delegate;
  const m = mandateFrom(del?.mandate ?? del);
  if (m) { const days = num(del?.days, 1, 365);
    await db.set(LIMITS, `brief:${b.id}`, { key: `brief:${b.id}`, owner: req.uid, mandate: m, autonomy: ["close", "ask"].includes(del?.autonomy) ? del.autonomy : "negotiate", expires: days ? now() + days * 86_400 : null, createdAt: now() }); }
  return { brief: b, goal, ...(await search(db, model, b, req.uid)) };
}));
app.post("/api/briefs/:id/engage", route(async req => {
  const owner = await me(req.uid);
  const brief = (await db.get(BRIEFS, String(req.params.id))) as Brief | null;
  if (!brief || brief.owner !== req.uid) throw new HttpError(404, "request not found");
  const picks = (Array.isArray(req.body?.providers) ? req.body.providers : []).slice(0, 5);
  const out: Engagement[] = [];
  for (const pick of picks) {
    const f = (await db.get(FACTS, text(pick?.factId, 60))) as Fact | null;
    const p = f ? ((await db.get(PROFILES, f.owner)) as Profile | null) : null;
    if (!f || !p || f.tier !== "public" || p.uid === req.uid) continue;
    const e = fresh({ briefId: brief.id, brief: brief.shared, requester: { uid: owner.uid, handle: owner.handle, name: owner.name }, provider: { uid: p.uid, handle: p.handle, name: p.name },
      offer: f.offer ? { factId: f.id, title: f.offer.title, price: f.offer.price.amount, unit: f.offer.price.period ?? null, category: f.offer.category } : { factId: f.id, title: f.text.slice(0, 80), price: null, unit: null, category: null } });
    e.events.push({ at: now(), who: "system", text: `Your agent is contacting ${p.name}'s agent over A2A.` });
    if (brief.goalId) { e.goalId = brief.goalId; await linkTask(db, brief.goalId, req.uid, e.id, now()); }
    // The first turn waits in the outbox; the device starts it with /run (each run is one bounded request).
    e.outbox = { kind: TURN, from: "requester", engagementId: e.id, brief: brief.shared, offerFactId: f.id };
    await saveEngagement(db, e);
    out.push(e);
  }
  return out;
}));

app.post("/api/push/token", route(async req => { const t = text(req.body?.token, 4096); if (t.length > 20) await saveToken(req.uid, t); return { ok: true }; }));
// A test notification to every device this person turned notifications on for.
app.post("/api/push/test", route(async req => {
  await spend(req.uid, 1);
  const r = await pushTo(req.uid, "Collab · test notification", "Notifications work on this device. You'll hear here when your agent needs you.", "/?screen=settings");
  if (!r.devices) throw new HttpError(400, "No device has notifications turned on for this account yet.");
  return r;
}));

// Scheduled agents: watch a request and alert the owner when someone new fits.
app.post("/api/watches", route(async req => {
  const b = req.body ?? {};
  try { return await startWatch(db, req.uid, text(b.briefId, 40), Array.isArray(b.seen) ? b.seen.map((x: unknown) => text(x, 60)) : [], num(b.every, 15, 1440) ?? 60, num(b.days, 1, 60) ?? 14); }
  catch (e) { throw new HttpError(404, (e as Error).message); }
}));
app.get("/api/watches", route(async req => ((await db.find(WATCHES, [["owner", "==", req.uid]], 100)) as Watch[]).filter(w => w.active).sort((a, b) => b.createdAt - a.createdAt)));
app.post("/api/watches/:id/stop", route(async req => {
  const w = (await db.get(WATCHES, String(req.params.id))) as Watch | null;
  if (!w || w.owner !== req.uid) throw new HttpError(404, "not found");
  await db.merge(WATCHES, w.id, { active: false });
  return { ok: true };
}));
app.get("/api/alerts", route(async req => ((await db.find(ALERTS, [["owner", "==", req.uid]], 100)) as Alert[]).filter(a => a.status === "new").sort((a, b) => b.at - a.at)));
app.post("/api/alerts/:id/done", route(async req => {
  const a = (await db.get(ALERTS, String(req.params.id))) as Alert | null;
  if (!a || a.owner !== req.uid) throw new HttpError(404, "not found");
  await db.merge(ALERTS, a.id, { status: "done" });
  return { ok: true };
}));

app.post("/api/price-check", route(async req => {
  try { return await checkPrice(db, model, req.uid, text(req.body?.item, 200), text(req.body?.area, 120), now()); }
  catch (err) { if (err instanceof PriceCheckError) throw new HttpError(err.status, err.message); throw err; }
}));
app.get("/api/price-check", route(async req => db.get(PRICE_CHECKS, req.uid)));
app.post("/api/nearby", route(async req => {
  try { return await nearby(db, model, req.uid, text(req.body?.item, 200), text(req.body?.area, 120), now()); }
  catch (err) { if (err instanceof NearbyError) throw new HttpError(err.status, err.message); throw err; }
}));

app.get("/api/engagements", route(async req => ((await db.find(ENGAGEMENTS, [["participants", "array-contains", req.uid]], 200)) as Engagement[]).sort((a, b) => b.updatedAt - a.updatedAt)));
async function participant(uid: string, id: string): Promise<Engagement> {
  const e = await load(db, id).catch(() => null);
  if (!e || !e.participants.includes(uid)) throw new HttpError(404, "conversation not found");
  return e;
}
app.get("/api/engagements/:id", route(async req => participant(req.uid, String(req.params.id))));
app.post("/api/engagements/:id/run", route(async req => {
  const e = await participant(req.uid, String(req.params.id));
  if (e.requester.uid === req.uid && e.outbox) { await spend(req.uid, 2); await sendTurn(cfg, e.id, null); }
  return load(db, e.id);
}));
app.get("/api/engagements/:id/receipt", route(async req => {
  const e = await participant(req.uid, String(req.params.id));
  return receiptBundle(e);
}));
async function receiptBundle(e: Engagement) {
  if (e.phase !== "agreed" || !e.negotiation.deal) throw new HttpError(404, "no deal yet");
  const check = await verifyReceipt(db, e);
  if (!check.registered || !check.matches) throw new HttpError(409, "The agreement does not match its registered receipt.");
  const registered = await db.get(RECEIPTS, e.id);
  const r = registered.receipt ?? receipt(e, signing.sign);
  const ap2Check = e.payment?.ap2 ? await verifyAp2(e.payment.ap2, signing.publicKey as any, e.payment.cart.dealHash) : null;
  const payment = e.payment ? { ...e.payment, buyer: buyerOf(e), seller: sellerOf(e), check: { ...checkPayment(e, verifySigned), ap2: ap2Check } } : null;
  return { ...r, ...check, payment, publicKey: signing.publicKey,
    subjects: { requester: e.requester.uid ? signing.subject(e.requester.uid) : null, provider: signing.subject(e.provider.uid) },
    legacyAttestation: !registered.receipt, signatureAuthority: "Collab server, on behalf of its agents",
    verifyPath: `/verify.html#${e.id}.${passCode(cfg.secret, e.id, "receipt")}` };
}
// Bearer receipt links share only the sealed deal, never the conversation, notes or private limits.
// Versioned capability discovery: what agents here can do and what their requests look like (no sign-in).
app.get("/public/capabilities", route(async () => ({ schemaVersion: 1, policy: POLICY_HASH, capabilities: capabilities() }), false));
app.get("/public/keys", route(async () => ({ keys: [signing.publicKey] }), false));
app.get("/public/receipts/:id", route(async req => {
  const id = String(req.params.id);
  if (!validCode(cfg.secret, id, "receipt", req.query.code)) throw new HttpError(404, "receipt not found");
  return receiptBundle(await load(db, id));
}, false));
app.get("/api/engagements/:id/pickup", route(async req => {
  const e = await participant(req.uid, String(req.params.id));
  let details;
  try { details = pickupDetails(e); } catch (err) { throw new HttpError(400, (err as Error).message); }
  const check = checkPayment(e, verifySigned);
  if (!check?.cartOk || !check.paymentOk || !(await verifyReceipt(db, e)).matches) throw new HttpError(409, "Payment or agreement cannot be verified.");
  return { ...details, collectedAt: (await db.get(PICKUPS, e.id))?.collectedAt ?? null,
    path: `/pickup.html#${e.id}.${passCode(cfg.secret, e.id, "pickup")}` };
}));
app.get("/public/pickup/:id", route(async req => {
  const id = String(req.params.id);
  if (!validCode(cfg.secret, id, "pickup", req.query.code)) throw new HttpError(404, "pass not found");
  const e = await load(db, id), check = checkPayment(e, verifySigned);
  if (!check?.cartOk || !check.paymentOk || !(await verifyReceipt(db, e)).matches) throw new HttpError(409, "Payment or agreement cannot be verified.");
  return { ...pickupDetails(e), collectedAt: (await db.get(PICKUPS, id))?.collectedAt ?? null };
}, false));
app.post("/api/pickup/:id/collect", route(async req => {
  const id = String(req.params.id);
  if (!validCode(cfg.secret, id, "pickup", req.body?.code)) throw new HttpError(404, "pass not found");
  const e = await participant(req.uid, id), check = checkPayment(e, verifySigned);
  if (e[sellerOf(e)].uid !== req.uid) throw new HttpError(403, "Only the seller can mark collected.");
  if (!check?.cartOk || !check.paymentOk || !(await verifyReceipt(db, e)).matches) throw new HttpError(409, "Payment or agreement cannot be verified.");
  const result = await collect(db, e, req.uid, now());
  if (result.alreadyCollected) throw new HttpError(409, `Already collected at ${new Date(result.collectedAt * 1000).toISOString()}`);
  await markDelivered(e.id, sellerOf(e), result.collectedAt, "Collected with the pickup pass.");
  const buyer = e[buyerOf(e)];
  if (buyer.uid) void pushTo(buyer.uid, "Collected", e.offer.title, `/?engagement=${e.id}`);
  return { collectedAt: result.collectedAt };
}));
/** Anyone signed in who has the engagement id can check a deal against its registered receipt (yes/no, nothing else). */
app.get("/api/engagements/:id/verify", route(async req => {
  const e = (await db.get(ENGAGEMENTS, String(req.params.id))) as Engagement | null;
  if (!e) return { registered: false, matches: false, registeredAt: null };
  return verifyReceipt(db, e);
}));
// AP2, test mode: the buyer pays against the seller agent's Cart Mandate; their agent signs the Payment Mandate and
// sends it to the seller's agent over A2A. No money moves.
app.post("/api/engagements/:id/pay", route(async req => {
  const id = String(req.params.id);
  const before = await participant(req.uid, id);
  const side = before.requester.uid === req.uid ? "requester" : "provider";
  const key = text(req.body?.idempotencyKey, 80).replace(/[^\w-]/g, "") || randomUUID();
  // The same tap again returns what the first one did.
  if (before.payment?.claim?.key === key && before.payment.status === "paid") return before;
  if (side !== buyerOf(before)) throw new HttpError(403, "Only the buyer pays.", "AUTHORITY_REQUIRED");
  await spend(req.uid, 1);
  // Exactly one tap claims the payment (a transaction moves awaiting → paying); a claim stuck for two minutes (a
  // crashed request) can be taken over.
  const t0 = now();
  const claimable = (p: any) => p?.status === "awaiting" || (p?.status === "paying" && t0 - (p.claim?.at ?? 0) > policy().timing.paymentClaimStaleSec);
  const claimed = (await db.update(ENGAGEMENTS, id, (cur: Engagement | null) => (cur && cur.phase === "agreed" && claimable(cur.payment)
    ? { ...cur, payment: { ...cur.payment!, status: "paying", claim: { key, at: t0 } } } : null))) as Engagement | null;
  if (!claimed) {
    const cur = await load(db, id);
    if (cur.payment?.claim?.key === key) { if (cur.payment.status === "paid") return cur; throw new HttpError(409, "This payment is already in progress.", "IN_PROGRESS"); }
    throw new HttpError(409, cur.payment?.status === "paid" ? "Already paid." : cur.payment?.status === "paying" ? "Another payment is in progress." : "Nothing to pay.", "VERSION_CONFLICT");
  }
  const e = claimed;
  const release = () => db.update(ENGAGEMENTS, id, (cur: Engagement | null) => {
    if (cur?.payment?.status !== "paying" || cur.payment.claim?.key !== key) return null;
    const { claim: _c, ...rest } = cur.payment;
    return { ...cur, payment: { ...rest, status: "awaiting" } };
  });
  let mandate;
  try {
    mandate = pay(e, side, signing.sign, now());
    // AP2 v0.2 shapes: a 10-minute checkout authorised by the seller's agent, and the buyer agent's Checkout and Payment
    // Mandates (SD-JWT) bound to its hash. Google Pay (TEST environment) supplies the instrument when the buyer used it.
    const gp = req.body?.googlePay;
    const instrument: Ap2Instrument = gp && typeof gp.token === "string"
      ? { id: "instr_1", type: "google_pay", environment: "TEST", network: text(gp.network, 20) || undefined, description: text(gp.description, 60) || undefined,
          token_sha256: createHash("sha256").update(gp.token).digest("base64url") }
      : { id: "instr_1", type: "test", environment: "TEST" };
    const seller_ = sellerOf(e) === "requester" ? e.requester : e.provider, buyer_ = sellerOf(e) === "requester" ? e.provider : e.requester;
    e.payment!.ap2 = await ap2Pay({ key: signing.privateKey, kid: signing.kid, base: cfg.publicUrl, now: now(), dealHash: e.payment!.cart.dealHash, idempotencyKey: key,
      currency: e.payment!.cart.total.currency, lines: linesOf(e), merchant: seller_, buyer: buyer_, checkoutId: `chk_${e.payment!.cart.id}`, instrument });
  } catch (err) { await release(); throw new HttpError(400, (err as Error).message); }
  const paidEvent = { at: now(), who: side, text: `Paid ${moneyText({ amount: mandate.amount.value, currency: mandate.amount.currency, period: e.offer.unit })} — Payment Mandate signed (AP2, test mode: no money moved).`, by: "owner" as const };
  // Commit only while this tap still holds the claim.
  const committed = await db.update(ENGAGEMENTS, id, (cur: Engagement | null) => (cur?.payment?.status === "paying" && cur.payment.claim?.key === key
    ? { ...cur, payment: { ...e.payment!, claim: { key, at: t0 } }, fulfilment: e.fulfilment, events: [...cur.events, paidEvent], updatedAt: now() } : null));
  if (!committed) throw new HttpError(409, "This payment changed while it was being made. Try again.", "VERSION_CONFLICT");
  const turn: Turn = { kind: TURN, from: side, engagementId: e.id, payment: mandate, ap2: { checkout_mandate: e.payment!.ap2!.checkout_mandate, payment_mandate: e.payment!.ap2!.payment_mandate, checkout_hash: e.payment!.ap2!.checkout_hash } };
  if (side === "requester") await sendTurn(cfg, e.id, turn).catch(() => {});
  else await deliverProviderTurn(cfg, a2a.store, e.id, turn).catch(() => {});
  const seller = sellerOf(e) === "requester" ? e.requester : e.provider;
  if (seller.uid) void pushTo(seller.uid, `Payment received · ${e.title}`, `${moneyText({ amount: mandate.amount.value, currency: mandate.amount.currency, period: e.offer.unit })} (test mode)`, `/?engagement=${e.id}`);
  return load(db, e.id);
}));
// Deals agreed before AP2 carts existed get theirs when a participant opens them (saving issues it).
app.post("/api/engagements/:id/cart", route(async req => {
  const e = await participant(req.uid, String(req.params.id));
  if (e.phase === "agreed" && !e.payment) await saveEngagement(db, e);
  return load(db, e.id);
}));
// Fulfilment, separate from payment: the seller hands over (pickup pass) or marks delivered; the buyer then accepts or
// reports a problem. Each side's report also feeds the other side's track record.
async function markDelivered(id: string, seller: "requester" | "provider", at: number, note: string) {
  await db.update(ENGAGEMENTS, id, (cur: Engagement | null) => {
    if (!cur || cur.phase !== "agreed" || ["delivered", "accepted", "disputed"].includes(cur.fulfilment?.state ?? "")) return null;
    return { ...cur, fulfilment: { state: "delivered", deliveredAt: at, note }, outcome: { ...(cur.outcome ?? {}), [seller]: "happened" },
      events: [...cur.events, { at, who: seller, text: note, by: "owner" }], updatedAt: at };
  });
}
app.post("/api/engagements/:id/delivered", route(async req => {
  const e = await participant(req.uid, String(req.params.id));
  if (e[sellerOf(e)].uid !== req.uid) throw new HttpError(403, "Only the seller can mark this delivered.", "AUTHORITY_REQUIRED");
  if (e.phase !== "agreed") throw new HttpError(409, "There's no agreed deal to deliver.", "VERSION_CONFLICT");
  await markDelivered(e.id, sellerOf(e), now(), "Marked as delivered.");
  const buyer = e[buyerOf(e)];
  if (buyer.uid) void pushTo(buyer.uid, `Delivered · ${e.title}`, "Check it and tell your agent if it's right.", `/?engagement=${e.id}`);
  return load(db, e.id);
}));
app.post("/api/engagements/:id/received", route(async req => {
  const e = await participant(req.uid, String(req.params.id));
  const buyer = buyerOf(e);
  if (e[buyer].uid !== req.uid) throw new HttpError(403, "Only the buyer can accept or dispute.", "AUTHORITY_REQUIRED");
  if (e.phase !== "agreed") throw new HttpError(409, "There's no agreed deal.", "VERSION_CONFLICT");
  const ok = req.body?.ok !== false, note = text(req.body?.note, 300);
  const t = now();
  await db.update(ENGAGEMENTS, e.id, (cur: Engagement | null) => {
    if (!cur || ["accepted", "disputed", "cancelled"].includes(cur.fulfilment?.state ?? "")) return null;
    return { ...cur, fulfilment: { ...(cur.fulfilment ?? { state: "not_started" }), state: ok ? "accepted" : "disputed", acceptedAt: t, ...(note ? { note } : {}) },
      outcome: { ...(cur.outcome ?? {}), [buyer]: ok ? "happened" : "fell_through" },
      events: [...cur.events, { at: t, who: buyer, text: ok ? "Received it — all good." : `Reported a problem${note ? `: ${note}` : "."}`, by: "owner" }], updatedAt: t };
  });
  const seller = e[sellerOf(e)];
  if (seller.uid) void pushTo(seller.uid, ok ? `Accepted · ${e.title}` : `Problem reported · ${e.title}`, ok ? "The buyer confirmed it arrived as agreed." : "The buyer reported a problem.", `/?engagement=${e.id}`);
  return load(db, e.id);
}));
// Paid some other way (cash, UPI outside the app): either side can say so; it counts as the deal having gone ahead.
app.post("/api/engagements/:id/paid-outside", route(async req => {
  const e = await participant(req.uid, String(req.params.id));
  if (e.phase !== "agreed" || !e.payment || e.payment.status === "paid") throw new HttpError(400, "Nothing to settle.");
  const side = e.requester.uid === req.uid ? "requester" : "provider";
  e.payment = { ...e.payment, status: "outside", by: side, paidAt: now() };
  (e.outcome ??= {})[side] = "happened";
  e.events.push({ at: now(), who: side, text: "Settled outside the app (cash or UPI).", by: "owner" });
  await saveEngagement(db, e);
  return e;
}));
app.post("/api/engagements/:id/outcome", route(async req => {
  const e = await participant(req.uid, String(req.params.id));
  if (e.phase !== "agreed") throw new HttpError(400, "no deal yet");
  const side = e.requester.uid === req.uid ? "requester" : "provider";
  (e.outcome ??= {})[side] = req.body?.happened ? "happened" : "fell_through";
  await saveEngagement(db, e);
  return e;
}));
app.post("/api/engagements/:id/close", route(async req => {
  const e = await participant(req.uid, String(req.params.id));
  if (["agreed", "closed", "declined"].includes(e.phase)) return e;
  const side = e.requester.uid === req.uid ? "requester" : "provider";
  e.phase = side === "requester" ? "closed" : "declined";
  e.waiting = { requester: null, provider: null };
  e.events.push({ at: now(), who: side, text: "Ended the conversation.", by: "owner" });
  await saveEngagement(db, e);
  return e;
}));

// The owner's device: what only it can do
async function inboxFor(uid: string): Promise<InboxItem[]> {
  const mine = (await db.find(INBOX, [["owner", "==", uid], ["status", "==", "open"]], 100)) as InboxItem[];
  // Demo people's devices are simulated: their items show up for the person talking to them.
  const demo: InboxItem[] = [];
  for (const e of (await db.find(ENGAGEMENTS, [["participants", "array-contains", uid]], 100)) as Engagement[]) {
    if (e.requester.uid === uid && e.provider.uid.startsWith("demo-") && e.waiting.provider) {
      demo.push(...((await db.find(INBOX, [["engagementId", "==", e.id], ["status", "==", "open"]], 20)) as InboxItem[]).filter(i => i.side === "provider"));
    }
  }
  return [...mine, ...demo].sort((a, b) => b.createdAt - a.createdAt);
}
app.get("/api/inbox", route(async req => inboxFor(req.uid)));
app.post("/api/inbox/:id", route(async req => {
  const found = (await db.get(INBOX, String(req.params.id))) as InboxItem | null;
  if (!found || found.status !== "open") throw new HttpError(404, "already handled");
  const e = await load(db, found.engagementId);
  const asDemo = found.owner.startsWith("demo-") && e.requester.uid === req.uid;
  if (found.owner !== req.uid && !asDemo) throw new HttpError(403, "not yours");
  await spend(req.uid, 2);
  // Claimed in a transaction: two devices (or two taps) can't both resolve it.
  let claimed = false;
  await db.update(INBOX, found.id, (cur: InboxItem | null) => { claimed = cur?.status === "open"; return claimed ? { ...cur!, status: "working" } : null; });
  if (!claimed) throw new HttpError(409, "already handled");
  const item = { ...found, status: "open" as const };
  const b = req.body ?? {};
  const reopen = () => db.update(INBOX, item.id, (cur: InboxItem | null) => (cur?.status === "working" ? { ...cur, status: "open" } : null));
  const r = await resolveItem(db, model, item, { text: typeof b.text === "string" ? b.text : undefined, share: b.share, decline: !!b.decline, confirm: !!b.confirm,
    mandate: item.kind === "move" ? mandateFrom(b.mandate) ?? undefined : undefined }).catch(async err => { await reopen(); throw err; });
  if (r.turn) {
    if (item.side === "requester") await sendTurn(cfg, e.id, r.turn);
    else await deliverProviderTurn(cfg, a2a.store, e.id, r.turn);
  }
  // An answer that names a price ("ok, I'll take it for 80rs") in a chat with no listed price offers that deal.
  const named = item.kind === "answer" && typeof b.text === "string" ? offeredMoney(b.text, e.offer.currency ?? policy().money.defaultCurrency) : null;
  if (named && policy().money.currencies.includes(named.currency)) {
    const now_ = await load(db, e.id);
    if (now_.offer.price == null && ["asking", "negotiating"].includes(now_.phase) && (!now_.offer.currency || now_.offer.currency === named.currency)) {
      now_.offer.currency = named.currency;
      await offerDeal(db, now_, item.side, named.amount, null, b.text);
    }
  }
  return load(db, e.id);
}));

// Cloud Scheduler runs the due watches every 15 minutes. Outside /api (no App Check — it's not the web app);
// it must carry the cron token derived from the agent secret.
// Cloud Tasks delivers waiting agent turns here (outside /api: it isn't the web app). Only this service's own
// account, by OIDC, may call it; it always answers 200 once checked, so a finished conversation isn't retried.
app.post("/tasks/turns", express.json({ limit: "4kb" }), async (req, res) => {
  if (!queue || !(await queue.verify(req.headers.authorization))) return res.status(401).json({ error: "not Cloud Tasks" });
  const id = text(req.body?.engagementId, 40);
  try { const e = await load(db, id); if (e.outbox) await sendTurn(cfg, e.id, null); }
  catch (err) { log.warn("queued turn failed", { id, error: String(err).slice(0, 160) }); return res.status(500).json({ error: "retry" }); }
  res.json({ ok: true });
});
export const cronToken = (secret: string) => createHmac("sha256", secret).update("collab-cron").digest("base64url");
app.post("/cron/run", async (req, res, next) => {
  try {
    const got = Buffer.from(String(req.headers["x-collab-cron"] ?? "")), want = Buffer.from(cronToken(cfg.secret));
    if (got.length !== want.length || !timingSafeEqual(got, want)) return res.status(401).json({ error: "not the scheduler" });
    const r = await runDue(db, model, async a => { await notifyAlert(a); });
    const recovered = await recoverOutbox(db, now(), queue ? queue.enqueue : null, id => sendTurn(cfg, id, null));
    log.info("cron", { ...r, recovered });
    res.json({ ...r, recovered });
  } catch (e) { next(e); }
});
// Every minute: waiting agent turns that weren't queued (or whose task was lost) are queued again.
app.post("/cron/recover", async (req, res, next) => {
  try {
    const got = Buffer.from(String(req.headers["x-collab-cron"] ?? "")), want = Buffer.from(cronToken(cfg.secret));
    if (got.length !== want.length || !timingSafeEqual(got, want)) return res.status(401).json({ error: "not the scheduler" });
    const recovered = await recoverOutbox(db, now(), queue ? queue.enqueue : null, id => sendTurn(cfg, id, null));
    const decisions = await expireDecisions(db, now(), i => pushTo(i.owner, `Still waiting for you · ${i.title}`, i.question ?? "A decision is due.", `/?engagement=${i.engagementId}`).then(() => {}));
    if (recovered.found || decisions.lapsed || decisions.reminded) log.info("minute jobs", { recovered, decisions });
    res.json({ ...recovered, decisions });
  } catch (e) { next(e); }
});

/** Push for a new alert (Firebase Cloud Messaging); the app also shows alerts when opened. */
async function notifyAlert(a: Alert) { await pushTo(a.owner, `New match: ${a.title}`, a.text, "/?alerts=1"); }

// MARK: - Web app (local development and the Cloud Run URL itself; Firebase Hosting serves it in production)

app.use(express.static(WEB_DIR, { setHeaders: res => res.set("cache-control", "no-cache") }));
app.get(/^\/(?!api\/|a2a\/).*/, (_, res) => res.sendFile(`${WEB_DIR}/index.html`));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
  if (err instanceof Problem) return res.status(400).json({ error: err.message, code: "INVALID_INPUT" });
  if (err instanceof Refused) return res.status(403).json({ error: err.message, code: "AUTHORITY_REQUIRED" });
  if (err instanceof Stale) return res.status(409).json({ error: err.message, code: "VERSION_CONFLICT" });
  log.error("unhandled", err, { path: _req.path });
  res.status(500).json({ error: "something went wrong" });
});

if (env.SEED_DEMO === "1") await seedDemo(db, model, now());
const server = app.listen(port, () => log.info(`collab-market on :${port}`, { store: env.STORE === "memory" ? "memory" : "firestore", model: model?.status().model ?? null, backend: model?.status().backend ?? null, a2a: `${cfg.publicUrl}/a2a` }));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));
