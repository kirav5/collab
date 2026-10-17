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
import { hasContact, numbers } from "./market/text.ts";
import { domain as domainOf } from "./market/domains.ts";
import { savedKey } from "./market/answer.ts";
import { docId } from "./docs.ts";
import { area, resolve, suggest } from "./market/places.ts";
import type { Mandate, Need, Place } from "./market/types.ts";
import { Problem, byHandle, saveFact, saveProfile, search } from "./core/directory.ts";
import { BRIEFS, draft, saveBrief } from "./core/briefs.ts";
import { ANSWERS, AUDIT, CONTACTS, ENGAGEMENTS, INBOX, LIMITS, Refused, fresh, load, Stale, offerDeal, releaseBudget, reserveFor, resolve as resolveItem, save as saveEngagement, setOutgoingScreen, setSigner, type Turn, closeInbox, autoConfirm, respondToOffer, ShortStock, unitsOf, inStock, takeOffer, doneConfirms } from "./core/engage.ts";
import { modelArmor } from "./core/armor.ts";
import { advancePlan, planGoal } from "./core/plans.ts";
import { compensate, runRecurrence } from "./core/composed.ts";
import { ADAPTERS, ConnectorError, type ConnectorGrant, GRANTS, createGrant, grantKey, ingestInventory, revokeGrant, syncIcal } from "./core/connectors.ts";
import { finishLink, gcalConfig, startLink, syncGcal, unlink } from "./core/gcal.ts";
import { getSafe } from "./a2a/webhooks.ts";
import { CapacityError, RESOURCES, type Resource, available as availableIn, commit as commitResource, lowStock, moveHold, cancelBooking, createResource, hold as holdResource, release as releaseResource, resourceFor, setStock, certainty, needsTopUp, setHours, topUpHours, validHours } from "./core/resources.ts";
import { capabilities } from "./core/capabilities.ts";
import { GOALS, type Goal, backfillGoals, cancelGoal, createGoal, goalView, linkTask } from "./core/goals.ts";
import { type Tracked, suggestionsFor } from "./core/suggest.ts";
import { suggestTerms } from "./core/terms.ts";
import { AnswersTask, NoteIdeasTask, SellerAsksTask, buyerQuestions, qualityOf } from "./core/intake.ts";
import { type DemandMiss, recordMiss, shopInsights } from "./core/shop-insights.ts";
import { analytics } from "./core/analytics.ts";
import { MAX_PHOTO_BYTES, PHOTOS, type PhotoRecord, deletePhoto, loadPhoto, photoIdOk, readPhoto, savePhoto } from "./core/photos.ts";
import { CommunityError, POST_KINDS, type Post, RIDES as POSTS, closePost, createCommunity, draftPost, joinPost, join as joinCommunity, kindOf as communityKind, listFor as communitiesFor, member as communityMember, postsIn, createPost } from "./core/communities.ts";
import { type AgentRules, type RulesContext, RulesTask, checkRules, readRules, rulesLines } from "./core/rules.ts";
import { orderText, storefront } from "./core/storefront.ts";
import { event } from "./log.ts";
import { loadPolicy, policy, policyHash, setPolicy } from "./config/policy.ts";
import { turnQueue } from "./core/queue.ts";
import { recoverOutbox } from "./core/recovery.ts";
import { expireDecisions } from "./core/decisions.ts";
import { NearbyError, nearby } from "./core/nearby.ts";
import { chooseOffering } from "./core/directory.ts";
import { ap2Pay, verifyAp2, type Ap2Instrument } from "./core/ap2.ts";
import { checkPrice, PriceCheckError, PRICE_CHECKS, priceEvidence, priceUnit, quotaStatus } from "./core/price-check.ts";
import { appCheckDecision, appCheckMode, appCheckOutcome, appCheckRequired, freeUnverified, instanceBucket, replayProtected } from "./core/app-check.ts";
import { signer } from "./core/signatures.ts";
import { PICKUPS, passCode, validCode, pickupDetails, collect } from "./core/pickup.ts";
import { buyerOf, checkPayment, linesOf, pay, sellerOf } from "./core/pay.ts";
import { offeredMoney, explicitOffer, offeredQuantity, amountIsTotal } from "./core/direct.ts";
import { currencyOf, moneyText } from "./market/types.ts";
import { forProvider, forRequester, insights, receipt, RECEIPTS, registerReceipt, sameItem, stats, verifyReceipt, clearStats, trackRecord } from "./core/deals.ts";
import type { Brief, Contact, DelegatedLimit, Engagement, Fact, InboxItem, Profile, Rule, SharedBrief } from "./core/model.ts";
import { FACTS, PROFILES, RULES, ruleActive } from "./core/policy.ts";
import { RefineTask, RouteTask, TopicsTask } from "./core/tasks.ts";
import { take } from "./core/limits.ts";
import { TURN, a2aRouter, deliverProviderTurn, sendTurn, signReceipt } from "./a2a/agents.ts";
import { seedDemo } from "./demo.ts";
import { log } from "./log.ts";
import { initPush, pushTo, saveToken } from "./core/push.ts";
import { clean as cleanText } from "./core/wall.ts";
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

const previousKeys = (() => { try { return env.RECEIPT_KEYS_PREVIOUS ? JSON.parse(env.RECEIPT_KEYS_PREVIOUS) : []; } catch { throw new Error("RECEIPT_KEYS_PREVIOUS must be a JSON array of public JWKs"); } })();
const signing = signer(env.RECEIPT_KEY, env.STORE === "memory", previousKeys);
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
// Google Calendar linking (OAuth, free/busy only): on when the OAuth client is configured.
const gcal = gcalConfig(env, cfg.publicUrl, cfg.secret);
// Commerce events copied to BigQuery (anonymous rows) and the demand forecast — only when BQ_DATASET is set.
const bq = analytics(env.GOOGLE_CLOUD_PROJECT, env.BQ_DATASET, cfg.secret);
setSigner(signing.sign);
initPush(db, env.STORE !== "memory");

// MARK: - Plumbing

// Stable error codes (AUTHORITY_REQUIRED, VERSION_CONFLICT, …) let clients act on routine failures without reading prose;
// the message stays for people. Codes default from the status when a route doesn't name one.
const CODE_BY_STATUS: Record<number, string> = { 400: "INVALID_INPUT", 401: "AUTHENTICATION_REQUIRED", 403: "AUTHORITY_REQUIRED", 404: "NOT_FOUND", 409: "VERSION_CONFLICT", 413: "TOO_LARGE", 429: "RATE_LIMITED", 503: "UNAVAILABLE" };
class HttpError extends Error { status: number; code: string; extra?: Record<string, unknown>; constructor(status: number, message: string, code?: string, extra?: Record<string, unknown>) { super(message); this.status = status; this.code = code ?? CODE_BY_STATUS[status] ?? "ERROR"; this.extra = extra; } }
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
    if (auth && (req as any).appCheck === "unverified" && APPCHECK === "enforce" && !freeUnverified(req.method, req.path)) await spendUnverified((req as any).uid);
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
app.use("/api/offers/photo", express.json({ limit: "1300kb" })); // one photo, downsized on the phone
app.use("/api", express.json({ limit: "128kb" }));

// App Check: calls to the API come from our own web app. "monitor" logs what would be refused; "enforce" refuses.
// (A2A at /a2a stays open to any agent — that's the point of it — and is rate-limited instead.)
const APPCHECK = appCheckMode(env.APPCHECK);
const appCheckStats = { verified: 0, unverified: { none: 0, invalid: 0, expired: 0 }, refused: 0 };
// Unverified writes: 20 per account then one every 6 s, and at most ~300 a minute per server instance in all.
const unverifiedCeiling = instanceBucket(300, 5);
async function spendUnverified(uid: string) {
  if (!unverifiedCeiling() || !(await take(db, `unverified:${uid}`, 1, 20, 1 / 6)))
    throw new HttpError(429, "Too many requests from a browser that couldn't be verified by Google reCAPTCHA. Wait a minute, or reload Collab.", "APP_CHECK_LIMITED");
}
let consumeUnavailable: { at: number; error: string } | null = null;
let appCheck: ((t: string, options?: { consume: boolean }) => Promise<{ alreadyConsumed?: boolean }>) | null = null;
app.use("/api", async (req, res, next) => {
  if (APPCHECK === "off" || req.path === "/config") return next();
  const token = req.headers["x-firebase-appcheck"];
  // A read with no token yet (a first visit, before reCAPTCHA has answered) goes through; a token that is sent is checked.
  if (!appCheckRequired(req.method, req.path) && typeof token !== "string") return next();
  // Consuming a token needs a network call and the Token Verifier IAM role. Do it only for sensitive writes when
  // enforcement is on; monitor mode keeps working with ordinary cached tokens.
  const consume = (APPCHECK === "enforce" || APPCHECK === "strict") && replayProtected(req.method, req.path);
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
  const outcome = appCheckOutcome(APPCHECK, decision, consume);
  if (outcome === "verified") { appCheckStats.verified++; (req as any).appCheck = "verified"; return next(); }
  const reason = typeof token !== "string" ? "none" : decision === "expired" ? "expired" : "invalid";
  if (outcome === "refuse") {
    appCheckStats.refused++;
    log.warn("app check refused", { path: req.path, mode: APPCHECK, reason, replayProtected: consume });
    return res.status(401).json({ code: "APP_CHECK", error: consume
      ? "Payments, pickups and price checks need a browser check by Google reCAPTCHA, and this browser couldn't pass it. Reload Collab; if a content blocker is on, allow google.com for this site."
      : "This browser couldn't be verified by Google reCAPTCHA. Reload Collab and try again; a content blocker or private window can stop the check." });
  }
  // Allowed, marked unverified: writes draw on a tighter budget (route()), and it's counted and logged.
  appCheckStats.unverified[reason]++;
  (req as any).appCheck = "unverified";
  log.warn("app check unverified", { path: req.path, mode: APPCHECK, reason, method: req.method });
  event("appcheck_unverified", { reason, write: req.method !== "GET" });
  next();
});

app.get("/health", route(async () => ({ ok: true, build: env.BUILD_ID ?? "local", policy: POLICY_HASH, model: model?.status() ?? null, store: env.STORE === "memory" ? "memory" : "firestore", a2a: `${cfg.publicUrl}/a2a/<handle>`,
  modelArmor: armor ? { on: true, ...armor.stats } : { on: false },
  security: { appCheck: APPCHECK, replayProtection: APPCHECK !== "enforce" && APPCHECK !== "strict" ? "off" : consumeUnavailable ? "degraded — sensitive actions refused" : "on", verification: appCheckStats } }), false));
app.get("/api/config", route(async () => ({ firebase: env.FIREBASE_WEB_CONFIG ? JSON.parse(env.FIREBASE_WEB_CONFIG) : null, devAuth: env.DEV_AUTH === "1", model: model?.name ?? null,
  a2aBase: `${cfg.publicUrl}/a2a`, appCheckSiteKey: env.RECAPTCHA_SITE_KEY ?? null }), false));

// Goals: what the owner wants done, with each conversation as a task and a state that follows from them.
app.get("/api/goals", route(async req => {
  await backfillGoals(db, req.uid, now());
  const gs = ((await db.find(GOALS, [["owner", "==", req.uid]], 100)) as Goal[]).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50);
  return Promise.all(gs.map(g => goalView(db, g)));
}));
app.get("/api/goals/:id", route(async req => {
  let g = (await db.get(GOALS, String(req.params.id))) as Goal | null;
  if (!g || g.owner !== req.uid) throw new HttpError(404, "goal not found");
  if (g.plan?.length) { await advancePlan(db, model, g, ((await db.get(PROFILES, req.uid)) as Profile | null)?.area ?? null, now()); g = (await db.get(GOALS, g.id)) as Goal; }
  if (g.allOrNothing && !g.compensation && (await compensate(db, g, now()))) g = (await db.get(GOALS, g.id)) as Goal;
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
// Plans: split a goal into steps (several providers, in order); ready steps search, the owner chooses whom to ask.
app.post("/api/goals/:id/plan", route(async req => {
  const g = (await db.get(GOALS, String(req.params.id))) as Goal | null;
  if (!g || g.owner !== req.uid) throw new HttpError(404, "goal not found");
  await spend(req.uid, 4);
  await planGoal(db, model, g, now());
  const here = ((await db.get(PROFILES, req.uid)) as Profile | null)?.area ?? null;
  await advancePlan(db, model, (await db.get(GOALS, g.id)) as Goal, here, now());
  return goalView(db, (await db.get(GOALS, g.id)) as Goal);
}));
app.get("/api/goals/:id/steps/:step/matches", route(async req => {
  const g = (await db.get(GOALS, String(req.params.id))) as Goal | null;
  const step = g?.owner === req.uid ? g.plan?.find(s => s.id === String(req.params.step)) : null;
  if (!step?.briefId) throw new HttpError(404, "That step hasn't searched yet.", "NOT_FOUND");
  const b = (await db.get(BRIEFS, step.briefId)) as Brief | null;
  if (!b) throw new HttpError(404, "request not found");
  return { briefId: b.id, ...(await search(db, model, b, req.uid)) };
}));
// Recurring goals and all-or-nothing settings.
app.post("/api/goals/:id/recurrence", route(async req => {
  const every = num(req.body?.everyDays, 1, 90), days = num(req.body?.days, 1, 365) ?? 90;
  const g = await db.update(GOALS, String(req.params.id), (cur: Goal | null) => (cur && cur.owner === req.uid
    ? { ...cur, recurrence: every ? { everyDays: every, nextAt: now() + every * 86_400, until: now() + days * 86_400, rounds: 0, stopped: null } : null, revision: cur.revision + 1, updatedAt: now() } : null));
  if (!g) throw new HttpError(404, "goal not found");
  return goalView(db, g);
}));
app.post("/api/goals/:id/settings", route(async req => {
  const g = await db.update(GOALS, String(req.params.id), (cur: Goal | null) => (cur && cur.owner === req.uid
    ? { ...cur, allOrNothing: !!req.body?.allOrNothing, revision: cur.revision + 1, updatedAt: now() } : null));
  if (!g) throw new HttpError(404, "goal not found");
  return goalView(db, g);
}));
// A goal's budget across all its deals; it can't be set below what's already committed.
app.post("/api/goals/:id/budget", route(async req => {
  const amount = num(req.body?.amount, 0, 1e9), currency = text(req.body?.currency, 3).toUpperCase() || policy().money.defaultCurrency;
  if (!policy().money.currencies.includes(currency)) throw new HttpError(400, `Budgets in ${currency} aren't supported.`, "UNSUPPORTED_CURRENCY");
  let refusal: HttpError | null = null;
  const g = await db.update(GOALS, String(req.params.id), (cur: Goal | null) => {
    if (!cur || cur.owner !== req.uid) { refusal = new HttpError(404, "goal not found"); return null; }
    const used = (cur.allocations ?? []).reduce((n, a) => n + a.amount, 0);
    if (amount !== null && amount > 0 && amount < used) { refusal = new HttpError(409, `${used} ${currency} is already committed to this goal's deals.`, "VERSION_CONFLICT"); return null; }
    if (used && cur.budget && cur.budget.currency !== currency) { refusal = new HttpError(409, `This goal's deals are in ${cur.budget.currency}.`, "VERSION_CONFLICT"); return null; }
    return { ...cur, budget: amount ? { amount, currency } : null, revision: cur.revision + 1, updatedAt: now() };
  });
  if (refusal) throw refusal;
  return goalView(db, g);
}));
app.post("/api/goals/:id/cancel", route(async req => {
  const r = await cancelGoal(db, req.uid, String(req.params.id), now());
  if (!r) throw new HttpError(404, "goal not found");
  event("goal_cancelled");
  return goalView(db, r);
}));

// What the app may show about the policy it runs under: quotas with today's remaining use and reset time, currencies,
// features and versions. Never private limits or anything per-owner beyond the caller's own quota use.
/** A sale left an item low: the seller hears once (until they set a new count), with how many are left. */
async function warnLowStock(resourceId: string) {
  const low = await lowStock(db, resourceId, policy().stock.lowAt, now()).catch(() => null);
  if (low) await pushTo(low.owner, `Low stock: ${low.title.split(" · ")[0]}`, low.left ? `${low.left} left. Update your count when you restock.` : "Sold out. Update your count when you restock.", "/?screen=context").catch(() => {});
}

/** Kept for the seller's insights, and copied to BigQuery (counts only, the seller hashed) when that's set up. */
const missed = (m: Omit<DemandMiss, "id">, category: string | null, area: string | null) => { bq.miss(m, category, area); return recordMiss(db, m).catch(() => {}); };

/** What the seller can learn from their own conversations and from demand near them nobody met (see core/shop-insights),
 *  with next week's demand forecast by BigQuery when it's set up (kept for the day; see core/analytics). */
app.get("/api/shop/insights", route(async req => {
  const p = await me(req.uid);
  await spend(req.uid, 1);
  const [i, forecast] = await Promise.all([shopInsights(db, model, req.uid, p.area ?? null, now(), num(req.query.days, 7, 90) ?? 30),
    bq.forecastFor(db, req.uid, p.area?.name ?? null, now())]);
  return { ...i, forecast };
}));

app.get("/api/policy", route(async req => {
  const p = policy(), t = now();
  return { version: POLICY_HASH, currencies: p.money.currencies, defaultCurrency: p.money.defaultCurrency, features: p.features, stock: { lowAt: p.stock.lowAt },
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
  return saveProfile(db, req.uid, { handle: b.handle, name: b.name, bio: b.bio, ...(areaPlace !== undefined ? { area: areaPlace } : {}) }, () => event("signup"));

}));
app.post("/api/me/pause", route(async req => { const p = await me(req.uid); p.paused = !!req.body?.paused; await db.set(PROFILES, p.uid, p); return p; }));
app.get("/api/people/:handle", route(async req => {
  const p = await byHandle(db, String(req.params.handle));
  if (!p) throw new HttpError(404, "no one by that handle");
  const [all, resources, record] = await Promise.all([db.find(FACTS, [["owner", "==", p.uid]], 200) as Promise<Fact[]>,
    db.find(RESOURCES, [["owner", "==", p.uid]], 100) as Promise<Resource[]>, stats(db, p.uid)]);
  const sales = await trackRecord(db, p.uid);
  const facts = all.filter(f => f.tier === "public").map(publicFact);
  const tracked = Object.fromEntries(resources.filter(r => r.factId).map(r => [r.factId!, r.type])) as Record<string, Tracked>;
  return { profile: { uid: p.uid, handle: p.handle, name: p.name, bio: p.bio, demo: !!p.demo }, stats: record, facts,
    offers: facts.filter(f => f.offer).length, suggestions: suggestionsFor(p.name, facts as Fact[], tracked),
    shop: storefront(all, resources, now(), !!p.paused), paused: !!p.paused, record: sales, agentCard: `${cfg.publicUrl}/a2a/${p.handle}/.well-known/agent-card.json` };
}));
// A seller's record, for anyone and any agent (no sign-in): verified sales, handovers, problems, receipt fingerprints.
app.get("/public/people/:handle/record", route(async req => {
  const p = await byHandle(db, String(req.params.handle));
  if (!p) throw new HttpError(404, "no one by that handle");
  return { handle: p.handle, ...(await trackRecord(db, p.uid)), verifyWith: `${cfg.publicUrl}/public/keys`,
    note: "Each receipt fingerprint is the SHA-256 of the sealed deal, signed for the person offering it. The receipt itself stays with the two people." };
}, false));
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
  // A first message that's an offer ("I'll take 12 at ₹400 each", "₹380") is handled as one, like any later one.
  const offered = (f?.offer?.price == null || explicitOffer(t)) ? offeredMoney(t, f?.offer?.price.currency ?? policy().money.defaultCurrency) : null;
  if (offered && f?.offer && !p.paused) {
    const count = offeredQuantity(t, f.offer.price.period ?? null), n = count ?? 1;
    const isTotal = amountIsTotal(t, f.offer.price.period ?? null, offered.amount, n, f.offer.price.amount ?? null);
    // More than they have (or than one buyer may have) is refused before a conversation is opened.
    const r = await resourceFor(db, f.id), at = now();
    const inHand = r?.type === "quantity" && certainty(r, at) === "confirmed" ? availableIn(r, at) : null;
    if (f.offer.maxPerBuyer && n > f.offer.maxPerBuyer && (inHand === null || f.offer.maxPerBuyer <= inHand))
      throw shortStock(`${p.name} offers at most ${f.offer.maxPerBuyer} per person — offer for ${f.offer.maxPerBuyer} instead?`, f.offer.maxPerBuyer, offered.amount, n, isTotal);
    if (r?.type === "quantity" && certainty(r, at) === "confirmed" && availableIn(r, at) < n)
      throw shortStock(availableIn(r, at) ? `Only ${availableIn(r, at)} in stock — they can't sell ${n}. Offer for ${availableIn(r, at)} instead?` : "They're out of stock right now.", availableIn(r, at), offered.amount, n, isTotal);
    const { e } = await directConversation(me_, p, f, t, "question");
    e.qa = []; // the offer is the message, not a question waiting for an answer
    await typedOffer(e, "requester", t, offered, count, isTotal, req.uid);
    return load(db, e.id);
  }
  const { e, brief } = await directConversation(me_, p, f, t, "question");
  e.outbox = { kind: TURN, from: "requester", engagementId: e.id, brief, offerFactId: f?.id ?? null };
  await saveEngagement(db, e);
  return e;
}));

/** A conversation opened directly with one person's agent (QR, link or their card): its own goal, or a task of the
 *  request it came from (booking a match from a request's results keeps one goal). */
async function directConversation(me_: Profile, p: Profile, f: Fact | null, t: string, via: "question" | "order", goalId: string | null = null) {
  // An order from the card is an offer, not a question for the seller to answer.
  const questions = via === "order" ? [] : (t.match(/[^.?!\n]*\?/g) ?? []).map(q => q.trim()).filter(q => q.length >= 3).slice(0, 4);
  const brief: SharedBrief = { title: t.slice(0, 80), summary: t, category: f?.offer?.category ?? "", mode: null, area: null, requirements: [], budget: null, questions: questions.length || via === "order" ? questions : [t.slice(0, 160)] };
  const e = fresh({ briefId: null, brief, requester: { uid: me_.uid, handle: me_.handle, name: me_.name }, provider: { uid: p.uid, handle: p.handle, name: p.name },
    offer: f?.offer ? { factId: f.id, title: f.offer.title, price: f.offer.price.amount, unit: f.offer.price.period ?? null, category: f.offer.category, ...(f.offer.policies?.length ? { policies: f.offer.policies } : {}) } : { factId: null, title: t.slice(0, 80), price: null, unit: null, category: null } });
  e.briefId = `direct-${e.id}`; // the requester's private limit for this conversation is keyed by it
  e.events.push({ at: now(), who: "system", text: via === "order" ? `You ordered from ${p.name}'s card.` : `You asked ${p.name}'s agent directly.` });
  // A direct question is its own goal (information until a price is involved); from a request, it's that request's.
  e.goalId = goalId ?? (await createGoal(db, me_.uid, t, f?.offer ? "purchase" : "information", null, now())).id;
  await linkTask(db, e.goalId, me_.uid, e.id, now());
  event("agents_contacted", { category: e.offer.category ?? "none", via: via === "order" ? "card" : "qr" });
  return { e, brief };
}

// Ordering from someone's card: buy a number of items, book a free time, or offer a price — one step. The seller
// confirms (nothing is final until both do); stock and slots are checked now and held when they confirm.
app.post("/api/people/:handle/order", route(async req => {
  const me_ = await me(req.uid);
  const p = await byHandle(db, String(req.params.handle));
  if (!p) throw new HttpError(404, "no one by that handle");
  if (p.uid === req.uid) throw new HttpError(400, "that's you");
  if (p.paused) throw new HttpError(409, `${p.name} isn't taking requests right now.`, "PAUSED");
  await spend(req.uid, 2);
  const f = (await db.get(FACTS, text(req.body?.offerFactId, 60))) as Fact | null;
  if (!f || f.owner !== p.uid || f.tier !== "public" || !f.offer || f.offer.status === "sold") throw new HttpError(404, "That isn't on offer any more.");
  const quantity = Number(req.body?.quantity ?? 1);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) throw new HttpError(400, "Choose how many: 1 to 999.");
  const listed = f.offer.price?.amount ?? null;
  const each = req.body?.price == null ? listed : Number(req.body.price);
  if (each == null || !Number.isFinite(each) || each <= 0 || each > 1e9) throw new HttpError(400, "Name a price.");
  const r = await resourceFor(db, f.id), t = now();
  const inHand = r?.type === "quantity" && certainty(r, t) === "confirmed" ? availableIn(r, t) : null;
  if (f.offer.maxPerBuyer && quantity > f.offer.maxPerBuyer && (inHand === null || f.offer.maxPerBuyer <= inHand))
    throw new HttpError(409, `${p.name} offers at most ${f.offer.maxPerBuyer} per person.`, "CAPACITY_UNAVAILABLE", { available: f.offer.maxPerBuyer });
  if (r?.type === "quantity" && certainty(r, t) === "confirmed" && availableIn(r, t) < quantity) {
    // Kept for the seller's insights: someone wanted more than was in stock.
    await missed({ seller: p.uid, factId: f.id, item: f.offer.title.split(" · ")[0], wanted: quantity, available: availableIn(r, t), buyer: req.uid, at: t }, f.offer.category, p.area?.name ?? null);
    throw new HttpError(409, availableIn(r, t) ? `Only ${availableIn(r, t)} left.` : "Out of stock right now.", "CAPACITY_UNAVAILABLE", { available: availableIn(r, t) });
  }
  let slotLabel: string | null = null, slotId: string | null = null;
  if (req.body?.slotId) {
    slotId = text(req.body.slotId, 40);
    const s = r?.type === "slots" ? r.slots.find(x => x.id === slotId) : null;
    if (!s || availableIn(r!, t, slotId) < 1) throw new HttpError(409, "That time was just taken — pick another.", "CAPACITY_UNAVAILABLE");
    slotLabel = new Date(s.start * 1000).toLocaleString("en-IN", { timeZone: r!.timezone, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  }
  // Booked from a request's matches: the deal joins that request's goal, and a second tap (or another device) on the
  // same match gets the deal already started instead of a second purchase.
  const brief = req.body?.briefId ? ((await db.get(BRIEFS, text(req.body.briefId, 60))) as Brief | null) : null;
  const goalId = brief && brief.owner === req.uid ? brief.goalId ?? null : null;
  if (goalId) {
    const g = (await db.get(GOALS, goalId)) as Goal | null;
    const started = g ? ((await Promise.all(g.taskIds.map(id => db.get(ENGAGEMENTS, id)))) as (Engagement | null)[])
      .find(x => x && x.offer.factId === f.id && !["closed", "declined"].includes(x.phase)) : null;
    if (started) return load(db, started.id);
  }
  const item = storefront([f], r ? [r] : [], t)[0];
  const said = orderText(item, quantity, each, listed, slotLabel);
  const { e } = await directConversation(me_, p, f, said, "order", goalId);
  e.preferredSlotId = slotId;
  try { await offerDeal(db, e, "requester", each, said, said, quantity, false); }
  catch (err) {
    if (err instanceof ShortStock) {
      if (!err.byRule) await missed({ seller: p.uid, factId: f.id, item: f.offer.title.split(" · ")[0], wanted: quantity, available: err.available, buyer: req.uid, at: now() }, f.offer.category, p.area?.name ?? null);
      throw new HttpError(409, err.message, "CAPACITY_UNAVAILABLE", { available: err.available });
    }
    if (err instanceof Refused) throw new HttpError(409, err.message); throw err;
  }
  // "Up to ₹X" with the offer: the buyer's agent negotiates against the seller's from here (never shown to them).
  const max = num(req.body?.max, 1, 1e9);
  if (max !== null && max >= each) await db.set(LIMITS, `brief:${e.briefId}`, { key: `brief:${e.briefId}`, owner: req.uid, mandate: { price: { opening: each, limit: max }, terms: {}, maxRounds: 5 }, autonomy: "close", expires: now() + 7 * 86_400, createdAt: now() });
  // Instant booking: at the listed price, on an offering whose seller turned it on, their agent confirms at once.
  if (f.offer.instant && each === listed) await autoConfirm(db, await load(db, e.id), "provider");
  // An offer below the listed price goes to the seller's agent first: inside their limit it's confirmed or put to
  // them; below it, the agent counters on its own.
  else await respondToOffer(db, model, await load(db, e.id));
  event("order_sent", { category: f.offer.category, quantity, offer: each !== listed, slot: !!slotId });
  return load(db, e.id);
}));
/**
 * "Let my agent handle it, up to ₹X" — said once, privately, by either side of a conversation: their agent gets that
 * limit (a buyer's for this conversation; a seller's for the offering) and takes it from there, against the other
 * side's agent, until a deal inside both limits. `close`: it may also agree for them (the default when they name the
 * limit themselves); `negotiate`: they give the final yes. Never shown to the other side.
 */
async function delegate(e: Engagement, uid: string, limit: number, autonomy: "close" | "negotiate", extra: { closeAt?: number | null; rulesText?: string } = {}) {
  const side = e.requester.uid === uid ? "requester" : "provider", selling = (e.seller ?? "provider") === side;
  if (side === "provider" && !e.offer.factId) throw new HttpError(400, "Name a price in the chat instead.");
  const key = side === "provider" ? `fact:${e.offer.factId}` : `brief:${e.briefId}`;
  const mine = side === "provider" ? e.negotiation.provider : e.negotiation.requester, last = mine.at(-1)?.price;
  const opening = selling ? Math.max(limit, e.offer.price ?? limit, last ?? 0) : Math.min(limit, last ?? Math.round(limit * 0.85));
  await db.set(LIMITS, key, { key, owner: uid, mandate: { price: { opening, limit }, terms: {}, maxRounds: 5 }, autonomy, expires: now() + 7 * 86_400, createdAt: now(),
    ...(extra.closeAt != null ? { closeAt: extra.closeAt } : {}), ...(extra.rulesText ? { rulesText: extra.rulesText } : {}) });
  await doneConfirms(db, e, side); await saveEngagement(db, e);
  return respondToOffer(db, model, await load(db, e.id));
}

// MARK: - Rules in the owner's own words

const rulesCtx = (side: "seller" | "buyer", o: { title: string; price: number | null; unit: string | null } | null): RulesContext =>
  ({ side, item: o ? o.title.split(" · ")[0] : null, price: o?.price ?? null, unit: o?.unit ?? null });
/** What the owner confirmed, re-checked against their own words (shape, grounding, consistency). */
function confirmedRules(body: any, words: string, ctx: RulesContext): AgentRules {
  const parsed = RulesTask.parse(body?.rules ?? {}, { text: words, ctx });
  const r = parsed ? checkRules(parsed, words, ctx) : null;
  if (!r) throw new HttpError(400, "There's nothing in that your agent can follow — say a price, a limit or a condition.");
  return r;
}
/** A seller's rules for one offering: the private lowest price and where the agent may close (its limit), the most
 *  per buyer and the terms (public, on the offering). Rules replace the earlier ones. */
async function applySellerRules(f: Fact, uid: string, r: AgentRules, words: string) {
  const o = f.offer!, key = `fact:${f.id}`, existing = (await db.get(LIMITS, key)) as DelegatedLimit | null;
  const floor = r.floor ?? (existing && existing.owner === uid ? existing.mandate.price.limit : null);
  if (floor != null) await db.set(LIMITS, key, { key, owner: uid, mandate: { price: { opening: o.price.amount, limit: Math.min(floor, o.price.amount) }, terms: {}, maxRounds: 5 },
    autonomy: r.autonomy, ...(r.closeAt != null ? { closeAt: r.closeAt } : {}), rulesText: words, expires: now() + 30 * 86_400, createdAt: existing?.createdAt ?? now() });
  const { maxPerBuyer: _old, ...rest } = o;
  const policies = [...(o.policies ?? []).filter(p => !r.terms.some(t => t.label.toLowerCase() === p.label.toLowerCase())), ...r.terms].slice(0, 8);
  const offer = { ...rest, ...(r.maxPerBuyer ? { maxPerBuyer: r.maxPerBuyer } : {}), ...(policies.length ? { policies } : {}),
    ...(floor != null && floor < o.price.amount ? { attributes: { ...o.attributes, negotiable: "yes" } } : {}) };
  await db.set(FACTS, f.id, { ...f, offer, updatedAt: now() });
  return { needsFloor: floor == null };
}
/** Read an instruction into rules, for the owner to see back and confirm. Nothing is saved here. */
app.post("/api/rules/read", route(async req => {
  await spend(req.uid, 2);
  const words = text(req.body?.text, 600).trim();
  if (words.length < 4) throw new HttpError(400, "Tell your agent a little more.");
  const side = req.body?.side === "buyer" ? "buyer" : "seller";
  let o: { title: string; price: number | null; unit: string | null; currency?: string } | null = null;
  if (typeof req.body?.factId === "string") { const f = (await db.get(FACTS, text(req.body.factId, 60))) as Fact | null; if (f?.offer && f.owner === req.uid) o = { title: f.offer.title, price: f.offer.price.amount, unit: f.offer.price.period ?? null, currency: f.offer.price.currency }; }
  else if (typeof req.body?.engagementId === "string") { const e = await participant(req.uid, text(req.body.engagementId, 40)); o = { title: e.offer.title, price: e.offer.price, unit: e.offer.unit, currency: e.offer.currency ?? undefined }; }
  else if (req.body?.offer && typeof req.body.offer.title === "string") o = { title: text(req.body.offer.title, 160), price: num(req.body.offer.price, 0, 1e12), unit: typeof req.body.offer.unit === "string" ? text(req.body.offer.unit, 20) : null };
  const { rules, byModel } = await readRules(model, words, rulesCtx(side, o));
  return { rules, lines: rulesLines(rules, o?.currency ?? "INR", o?.unit ?? null), byModel };
}));
app.post("/api/facts/:id/rules", route(async req => {
  const f = (await db.get(FACTS, String(req.params.id))) as Fact | null;
  if (!f || f.owner !== req.uid || !f.offer) throw new HttpError(404, "Not one of your offerings.");
  const words = text(req.body?.text, 600).trim();
  const r = confirmedRules(req.body, words, rulesCtx("seller", { title: f.offer.title, price: f.offer.price.amount, unit: f.offer.price.period ?? null }));
  const { needsFloor } = await applySellerRules(f, req.uid, r, words);
  return { fact: publicFact((await db.get(FACTS, f.id)) as Fact), lines: rulesLines(r, f.offer.price.currency, f.offer.price.period ?? null), needsFloor };
}));
/** Either side's rules inside a conversation: a buyer's limit, close-at, how many and must-be-yes checks; a seller's
 *  rules for the offering it's about. Their agent takes it from there. */
app.post("/api/engagements/:id/rules", route(async req => {
  const e = await participant(req.uid, String(req.params.id));
  if (["agreed", "closed", "declined"].includes(e.phase)) throw new HttpError(400, "This conversation has ended.");
  const side = e.requester.uid === req.uid ? "requester" : "provider", selling = (e.seller ?? "provider") === side;
  const words = text(req.body?.text, 600).trim();
  const r = confirmedRules(req.body, words, rulesCtx(selling ? "seller" : "buyer", { title: e.offer.title, price: e.offer.price, unit: e.offer.unit }));
  if (selling) {
    const f = e.offer.factId ? ((await db.get(FACTS, e.offer.factId)) as Fact | null) : null;
    if (!f?.offer || f.owner !== req.uid) throw new HttpError(400, "Name a price in the chat instead.");
    await applySellerRules(f, req.uid, r, words);
    await doneConfirms(db, e, side); await saveEngagement(db, e);
    await respondToOffer(db, model, await load(db, e.id));
    return load(db, e.id);
  }
  // The buyer: how many (while nothing's agreed), and must-be-yes checks their agent asks the seller.
  if (r.quantity && !e.negotiation.deal) e.quantity = r.quantity;
  await saveEngagement(db, e);
  // The agent negotiates first, in this request; the must-be-yes questions go to the seller's agent after, so its turn
  // (which runs in the background) starts from the agent's latest move instead of overwriting it.
  if (r.limit != null) await delegate(await load(db, e.id), req.uid, r.limit, r.autonomy, { closeAt: r.closeAt, rulesText: words });
  const cur = await load(db, e.id);
  const asks = r.mustAsk.filter(q => !cur.qa.some(x => x.question.toLowerCase() === q.toLowerCase()));
  if (asks.length) {
    for (const q of asks) cur.qa.push({ id: randomUUID().slice(0, 12), from: "requester", question: q, status: "open", required: true });
    await saveEngagement(db, cur);
    await sendTurn(cfg, cur.id, { kind: TURN, from: "requester", engagementId: cur.id, questions: cur.qa.filter(x => asks.includes(x.question)).map(x => ({ id: x.id, question: x.question })) });
  }
  return load(db, e.id);
}));
app.post("/api/engagements/:id/delegate", route(async req => {
  const e = await participant(req.uid, String(req.params.id));
  if (["agreed", "closed", "declined"].includes(e.phase)) throw new HttpError(400, "This conversation has ended.");
  const limit = num(req.body?.limit, 1, 1e9);
  if (limit === null) throw new HttpError(400, "Name the most you'd pay (or least you'd take).");
  await delegate(e, req.uid, limit, req.body?.autonomy === "negotiate" ? "negotiate" : "close");
  return load(db, e.id);
}));

// MARK: - Communities: an office park, an apartment block, a campus — members' posts, offers and gigs in one feed.

const asHttp = (e: unknown) => (e instanceof CommunityError ? new HttpError(e.status, e.message) : e);
const GIGS = new Set(["jobs", "tasks"]);
app.get("/api/communities", route(async req => { const p = await me(req.uid); return communitiesFor(db, req.uid, p.area ?? null); }));
app.post("/api/communities", route(async req => {
  const p = await me(req.uid);
  await spend(req.uid, 2);
  const where = text(req.body?.place, 80).trim(), place = where ? resolve(where, p.area ?? null) : p.area ?? null;
  if (!place) throw new HttpError(400, "Pick an area we know — e.g. Whitefield or Koramangala.", "INVALID_INPUT", { suggestions: suggest(where, p.area ?? null, 5).map(x => x.name) });
  try { return await createCommunity(db, req.uid, text(req.body?.name, 60), communityKind(req.body?.kind), place, now()); } catch (e) { throw asHttp(e); }
}));
app.post("/api/communities/:id/join", route(async req => {
  await me(req.uid);
  try { const c = await joinCommunity(db, String(req.params.id), req.uid, req.body?.leave !== true); return { id: c.id, members: c.members.length, joined: c.members.includes(req.uid) }; } catch (e) { throw asHttp(e); }
}));
/** The feed, for members: their posts (trips nearest you first), and what members already offer publicly — gigs apart. */
app.get("/api/communities/:id", route(async req => {
  const p = await me(req.uid);
  let c; try { c = await communityMember(db, String(req.params.id), req.uid); } catch (e) { throw asHttp(e); }
  const people = (await Promise.all(c.members.slice(0, 100).map(uid => db.get(PROFILES, uid)))).filter(Boolean) as Profile[];
  const byUid = new Map(people.map(x => [x.uid, x]));
  const facts = (await Promise.all(c.members.slice(0, 60).map(uid => db.find(FACTS, [["owner", "==", uid]], 40) as Promise<Fact[]>))).flat()
    .filter(f => f.tier === "public" && f.offer && f.offer.status !== "sold");
  const item = (f: Fact) => ({ factId: f.id, title: f.offer!.title.split(" · ")[0], price: f.offer!.price.amount, unit: f.offer!.price.period ?? null, currency: f.offer!.price.currency,
    category: f.offer!.category, area: f.offer!.place.name, mine: f.owner === req.uid, name: byUid.get(f.owner)?.name ?? "", handle: byUid.get(f.owner)?.handle ?? "" });
  const posts = await postsIn(db, c, now(), { place: p.area ?? null, at: num(req.query.at, 0, 4e9) });
  return { community: { id: c.id, name: c.name, kind: c.kind, place: c.place, members: c.members.length, createdBy: c.createdBy === req.uid ? "you" : null },
    members: people.slice(0, 30).map(x => ({ name: x.name, handle: x.handle, you: x.uid === req.uid })),
    posts: await Promise.all(posts.map(x => postView(x, req.uid, byUid))),
    offers: facts.filter(f => !GIGS.has(f.offer!.category)).map(item), gigs: facts.filter(f => GIGS.has(f.offer!.category)).map(item) };
}));
/** A post as a member sees it: no internal ids; the poster also sees who's in, to coordinate. */
async function postView(x: Post & { km?: number | null }, uid: string, known = new Map<string, Profile>()) {
  const { owner, joined, notified: _n, ...rest } = x as typeof x & { notified?: string[] };
  const mine = owner === uid;
  const who = mine ? (await Promise.all(joined.map(async j => known.get(j) ?? (await db.get(PROFILES, j)) as Profile | null))).filter(Boolean).map(w => ({ name: w!.name, handle: w!.handle })) : undefined;
  return { ...rest, km: x.km ?? null, mine, count: joined.length, youJoined: joined.includes(uid), people: who };
}
/** Whatever a member writes ("anyone driving to the office from HSR at 9 tomorrow? 2 seats") shaped into a post to check. */
app.post("/api/communities/:id/posts/draft", route(async req => {
  const p = await me(req.uid);
  await spend(req.uid, 1);
  let c; try { c = await communityMember(db, String(req.params.id), req.uid); } catch (e) { throw asHttp(e); }
  const t = text(req.body?.text, 400).trim();
  if (t.length < 4) throw new HttpError(400, "Say what you'd like to post — e.g. “Cab to the office from HSR at 9 tomorrow, 2 seats”.");
  return draftPost(model, c, t, p.area ?? null, now());
}));
/** Post it — as checked in the draft (with any edits), or straight from the words when nothing else is given. */
app.post("/api/communities/:id/posts", route(async req => {
  const p = await me(req.uid);
  await spend(req.uid, 2);
  let c; try { c = await communityMember(db, String(req.params.id), req.uid); } catch (e) { throw asHttp(e); }
  const t = text(req.body?.text, 400).trim();
  if (t.length < 4) throw new HttpError(400, "Say what you'd like to post.");
  const b = req.body ?? {}, given = POST_KINDS.includes(b.kind);
  const d = given ? { kind: b.kind as Post["kind"], title: text(b.title, 80).trim() || t.slice(0, 60), at: num(b.at, 0, 4e9) ?? null, spots: b.spots == null || b.spots === "" ? null : Number(b.spots), from: null as Place | null, to: null as Place | null, place: null as Place | null }
    : await draftPost(model, c, t, p.area ?? null, now());
  const at = (k: string, near: Place | null) => { const n = text(b[k], 80).trim(); if (!n) return undefined; const r = resolve(n, near); if (!r) throw new HttpError(400, `“${n}” isn't an area we know.`, "INVALID_INPUT", { suggestions: suggest(n, near, 5).map(x => x.name) }); return r; };
  const from = at("from", p.area ?? c.place) ?? (given ? (d.kind === "trip" ? p.area ?? null : null) : d.from), to = at("to", c.place) ?? (given ? (d.kind === "trip" ? c.place : null) : d.to), place = at("place", c.place) ?? (given ? null : d.place);
  if (d.kind === "trip" && (!from || !to)) throw new HttpError(400, `Add ${!from ? "where you start" : "where you're going"}.`);
  if (hasContact(`${d.title} ${t}`)) throw new HttpError(400, "Leave phone numbers and links out — people reach you through your agent.");
  try { return await postView(await createPost(db, c, { uid: req.uid, name: p.name, handle: p.handle }, { kind: d.kind, title: d.title, text: t, at: d.at, from, to, place, spots: d.spots }, now()), req.uid); }
  catch (e) { throw asHttp(e); }
}));
/** "I'm in" (or out). The poster hears who's in. */
app.post("/api/posts/:id/join", route(async req => {
  const p = await me(req.uid);
  const on = req.body?.leave !== true;
  const cur = (await db.get(POSTS, String(req.params.id))) as Post | null;
  if (!cur) throw new HttpError(404, "No such post.");
  try { await communityMember(db, cur.communityId, req.uid); } catch (e) { throw asHttp(e); }
  if (on) await spend(req.uid, 1);
  let r; try { r = await joinPost(db, cur.id, req.uid, on); } catch (e) { throw asHttp(e); }
  const x = r.post;
  if (r.fresh) void pushTo(x.owner, `${p.name} is in`, `${x.title}${x.spots ? ` · ${x.joined.length + (x.kind === "group" ? 1 : 0)} of ${x.spots}` : ""}`, `/?screen=communities&community=${x.communityId}`).catch(() => {});
  return postView(x, req.uid);
}));
app.post("/api/posts/:id/close", route(async req => { try { await closePost(db, String(req.params.id), req.uid); return { ok: true }; } catch (e) { throw asHttp(e); } }));

/** A few optional notes the buyer might send once it's agreed — written once by Gemini for this deal, then kept. */
app.get("/api/engagements/:id/note-ideas", route(async req => {
  const e = await participant(req.uid, String(req.params.id));
  if (e.phase !== "agreed" || (e.seller ?? "provider") === (e.requester.uid === req.uid ? "requester" : "provider")) return { notes: [] };
  if (e.noteIdeas) return { notes: e.noteIdeas };
  const d = e.negotiation.deal!, n = d.terms?.quantity > 1 ? d.terms.quantity : 1;
  const out = await decide(model, NoteIdeasTask, { item: e.offer.title.split(" · ")[0], terms: (e.offer.policies ?? []).map(p => `${p.label}: ${p.text}`),
    deal: n > 1 ? `${n} units` : "one", kind: e.reservation?.slotId ? "booked time" : "pickup or handover" });
  await db.update(ENGAGEMENTS, e.id, (cur: Engagement | null) => (cur ? { ...cur, noteIdeas: out.output } : null));
  return { notes: out.output };
}));

// A follow-up in an open conversation, from either side: it goes over A2A like any turn, and the other agent answers
// from what its owner shares or asks its owner (who gets a notification).
app.post("/api/engagements/:id/ask", route(async req => {
  const e = await participant(req.uid, String(req.params.id));
  // Once it's agreed the two people can talk directly — before paying, at pickup, after. Messages, not offers: the
  // agreed terms don't change here.
  if (e.phase === "agreed") {
    await spend(req.uid, 1);
    const said = text(req.body?.text, 500).trim();
    if (said.length < 1) throw new HttpError(400, "Write a message.");
    const side = e.requester.uid === req.uid ? "requester" : "provider", them = side === "requester" ? e.provider : e.requester;
    const names = await db.find(CONTACTS, [["owner", "==", req.uid]], 300).catch(() => []) as Contact[];
    const clean_ = cleanText(said, names.filter(c => c.uid !== them.uid).map(c => ({ name: c.name, replacement: "a contact" })), [them.name]);
    await db.update(ENGAGEMENTS, e.id, (cur: Engagement | null) => (cur ? { ...cur, events: [...cur.events, { at: now(), who: side, text: clean_, by: "owner", chat: true }], updatedAt: now() } : null));
    if (them.uid) await pushTo(them.uid, `Message from ${e[side].name}`, clean_.slice(0, 120), `/?engagement=${e.id}`).catch(() => {});
    return load(db, e.id);
  }
  if (["closed", "declined"].includes(e.phase)) throw new HttpError(400, "This conversation has ended — start a new one.");
  await spend(req.uid, 2);
  const q = text(req.body?.text, 300).trim();
  if (q.length < 2) throw new HttpError(400, "Ask something.");
  const side = e.requester.uid === req.uid ? "requester" : "provider";
  // Naming a price in a chat with no listed price offers a deal: the other person confirms or says no.
  // A named price offers a deal — in a currency this deployment supports, and the one the conversation already uses.
  // While a deal waits for confirmation, only words that clearly make a new offer replace it ("I'll do ₹448"); the
  // same price again is just chat. A replaced offer's pending confirmation goes stale (offerDeal).
  const canOffer = e.phase === "deal" ? explicitOffer(q) : e.offer.price == null || explicitOffer(q);
  let offered = canOffer ? offeredMoney(q, e.offer.currency ?? policy().money.defaultCurrency) : null;
  // How many it's for: a count said now, else what the conversation is already about. Whether the amount is each or
  // in all: the words, else the reading closer to the price on the table.
  const count = offeredQuantity(q, e.offer.unit), n = count ?? unitsOf(e), table = e.negotiation.deal;
  const ref = table ? (table.items?.length ? table.items.reduce((t, l) => t + l.quantity * l.unitPrice, 0) / table.items.reduce((t, l) => t + l.quantity, 0) : table.price) : e.offer.price;
  const isTotal = offered ? amountIsTotal(q, e.offer.unit, offered.amount, n, ref ?? null) : true;
  // A count the buyer says ("do you have 40 lamps?") is what the conversation is about from now on, offer or not.
  if (count && !offered && side !== (e.seller ?? "provider") && count !== unitsOf(e)) {
    e.quantity = count;
    await db.update(ENGAGEMENTS, e.id, (cur: Engagement | null) => (cur ? { ...cur, quantity: count } : null));
  }
  if (offered && e.phase === "deal" && e.negotiation.deal) {
    // The same offer again (same number of items, same total) is chat; a different count or total replaces it.
    const total = isTotal || n === 1 ? offered.amount : offered.amount * n;
    const pending = e.negotiation.deal, pn = pending.items?.length ? pending.items.reduce((t, l) => t + l.quantity, 0) : pending.terms?.quantity > 1 ? pending.terms.quantity : 1;
    const ptotal = pending.items?.length ? pending.items.reduce((t, l) => t + l.quantity * l.unitPrice, 0) : pending.price * pn;
    if (n === pn && total === ptotal) {
      // The other side's offer at its own terms: that's a yes. One's own offer again is just chat.
      if (e.negotiation.dealBy && e.negotiation.dealBy !== side && !e.negotiation.confirmed[side]) {
        try { await takeOffer(db, e, side, q); } catch (err) { if (err instanceof Refused) throw new HttpError(409, err.message); throw err; }
        return load(db, e.id);
      }
      offered = null;
    }
  }
  if (offered) { await typedOffer(e, side, q, offered, count, isTotal, req.uid); return load(db, e.id); }
  // A reply typed while their agent waits on them for an answer is that answer — not a new question for the other side.
  if (!/\?\s*$/.test(q) && !/^(why|is|are|was|does|did|do|can|could|will|would|when|where|which|who|what|how)\b/i.test(q)) {
    const waiting = await openAnswer(e.id, req.uid);
    if (waiting) { await answerWith(waiting, q); return load(db, e.id); }
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
  // A written floor ("lowest 29,000") never reaches public text, however it's published — the offering card keeps it
  // as the private limit; here it's simply left out. Small numbers ("minimum 2 hours") aren't floors.
  const raw = text(b.text, 1000), floor = b.tier === "public" && b.source !== "chat" ? statedFloor(raw) : null;
  const body = floor !== null && floor >= 50 && (numbers(raw).some(n => n > floor) || STRONG_FLOOR.test(raw)) ? withoutAmount(raw, floor) : raw;
  const fact = publicFact(await saveFact(db, model, await me(req.uid), { id: b.id ? text(b.id, 40) : undefined, text: body, tier: b.tier, topics: Array.isArray(b.topics) ? b.topics.map((t: unknown) => text(t, 24)) : undefined, negotiable: b.negotiable === true,
    // A chat memory is always Private: sharing it means rewriting it as a fact of its own.
    ...(b.source === "chat" ? { source: "chat" as const, tier: "private" as const } : {}) }));
  // A photo the owner took for this listing goes on it (only their own photo, only on a public offering).
  const photoId = photoIdOk(b.photoId) ? b.photoId : null;
  const ph = photoId && fact.offer && b.tier === "public" ? ((await db.get(PHOTOS, photoId)) as PhotoRecord | null) : null;
  const withPhoto = ph && ph.owner === req.uid ? ((await db.update(FACTS, fact.id, (cur: Fact | null) => (cur?.offer ? { ...cur, offer: { ...cur.offer, photo: `/public/photos/${ph.id}` } } : null))) as Fact | null) : null;
  if (withPhoto && ph) await db.merge(PHOTOS, ph.id, { factId: fact.id });
  const out = withPhoto ? publicFact(withPhoto) : fact;
  return body === raw ? out : { ...out, floorKeptPrivate: true };
}));
/** Suggested answers to a listing's common questions (one of each question's options, or none) — see AnswersTask. */
app.post("/api/offers/answers", route(async req => {
  await spend(req.uid, 1);
  const questions = (Array.isArray(req.body?.questions) ? req.body.questions : []).slice(0, 6).map((q: any) => ({ label: text(q?.label, 60), ask: text(q?.ask, 160),
    options: (Array.isArray(q?.options) ? q.options : []).slice(0, 6).map((o: unknown) => text(o, 60)).filter(Boolean) })).filter((q: any) => q.label && q.options.length);
  if (!questions.length) return { answers: {} };
  return { answers: (await decide(model, AnswersTask, { text: text(req.body?.text, 600), questions })).output };
}));
/** A photo of something to sell → a listing sentence (Gemini reads it), and the photo kept for the listing. */
app.post("/api/offers/photo", route(async req => {
  const p = await me(req.uid);
  await spend(req.uid, 3);
  const mimeType = ["image/jpeg", "image/png", "image/webp"].includes(req.body?.mimeType) ? req.body.mimeType : null;
  const data = typeof req.body?.image === "string" ? req.body.image.replace(/^data:[^,]*,/, "") : "";
  if (!mimeType || !/^[A-Za-z0-9+/=]+$/.test(data.slice(0, 2000)) || data.length < 100) throw new HttpError(400, "Send a JPEG, PNG or WebP photo.", "INVALID_INPUT");
  if ((data.length * 3) / 4 > MAX_PHOTO_BYTES) throw new HttpError(413, "That photo is too large — try again (it's made smaller on your phone).", "INVALID_INPUT");
  const read = await readPhoto(model, { mimeType, data }, text(req.body?.caption, 200), p.area?.name ?? "");
  if (!read) throw new HttpError(422, "Couldn't tell what's in the photo. Try a closer, brighter shot — or type what it is.", "UNREADABLE");
  const photo = await savePhoto(db, req.uid, mimeType, data, env.PHOTO_BUCKET, now());
  event("photo_listing", { stored: photo.where });
  return { text: read.text, item: read.item, details: read.details, condition: read.condition, photo: { id: photo.id, url: `/public/photos/${photo.id}`, stored: photo.where } };
}));
/** A listing's photo, for anyone (listings are public). */
app.get("/public/photos/:id", async (req, res) => {
  const p = await loadPhoto(db, String(req.params.id).slice(0, 40), env.PHOTO_BUCKET).catch(() => null);
  if (!p) { res.status(404).json({ error: "photo not found" }); return; }
  // Kept by browsers only, not the CDN: a photo whose listing is deleted (or made private) stops showing at once.
  res.set({ "content-type": p.mimeType, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" }).send(p.body);
});
app.post("/api/facts/:id/delete", route(async req => {
  const f = (await db.get(FACTS, String(req.params.id))) as Fact | null;
  if (!f || f.owner !== req.uid) throw new HttpError(404, "not found");
  await db.delete(FACTS, f.id);
  const photo = f.offer?.photo?.match(/^\/public\/photos\/([a-z0-9]+)$/i)?.[1];
  if (photo) await deletePhoto(db, photo, env.PHOTO_BUCKET).catch(() => {});
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
app.get("/api/limits", route(async req => (await db.find(LIMITS, [["owner", "==", req.uid]], 200)).map((l: any) => ({ key: l.key, mandate: l.mandate, limit: l.mandate.price.limit, autonomy: l.autonomy ?? "negotiate", expires: l.expires ?? null, closeAt: l.closeAt ?? null, rulesText: l.rulesText ?? null }))));
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
  // Something being made public from the notes is read strictly (a plain fact stays a plain note); something the
  // owner said they're selling is read as an offering even when it's vague.
  const r = await read(t, "sell", model, now(), here, null, req.body?.note !== true);
  const dom = domainOf(r.draft?.kind === "offer" ? r.draft.offer.category : r.category ?? "");
  // What buyers of this kind would otherwise ask, picked by Gemini for this offering, with tap-to-answer options.
  const asks = async (attrs: Record<string, unknown>) => {
    const hints = (dom?.terms ?? []).filter(x => x.ask && !(x.key in attrs)).map(x => ({ label: x.label, ask: x.ask! }));
    return (await decide(model, SellerAsksTask, { text: t, category: dom?.label ?? "", known: Object.entries(attrs).map(([k, v]) => `${k}: ${v}`), hints })).output;
  };
  if (r.draft?.kind !== "offer") {
    if (!dom) return { offer: null, floor: null, publicText: t, problem: r.problem ?? null };
    // An offering too vague to list (no price, or no place): the card asks for the basics, then reads it again. A
    // written floor is kept for the card, never in the text.
    const written = statedFloor(t);
    const [missing, gate] = await Promise.all([asks({}), qualityOf(model, t, "sell", dom.label, [])]);
    return { offer: null, floor: written, publicText: written !== null ? withoutAmount(t, written) : t, problem: r.problem ?? null, missing, gate,
      basics: { category: dom.id, label: dom.label, unit: dom.priceUnit ?? null, area: here?.name ?? null } };
  }
  // The model reads a stated floor; a written one ("lowest 600", "won't go below 600") is caught either way, so the
  // directory never shows it whatever the model does.
  const written = statedFloor(t);
  const read_ = r.draft.mandate.price.limit < r.draft.mandate.price.opening ? r.draft.mandate.price.limit : null;
  const floor = read_ ?? (written !== null && written < r.draft.offer.price.amount ? written : null);
  const publicText = floor ? withoutAmount(t, floor) : t;
  // What buyers of this kind usually ask that the offering doesn't say yet — the seller can answer now, publicly.
  const o = r.draft.offer;
  const [missing, gate] = await Promise.all([asks(o.attributes), qualityOf(model, publicText, "sell", dom?.label ?? "", [`price ${o.price.amount}`, `place ${o.place.name}`, ...Object.entries(o.attributes).map(([k, v]) => `${k}: ${v}`)])]);
  return { offer: { ...o, details: publicText }, floor, publicText, missing, gate };
}));

// What others charge for this kind of thing near here, for the price a seller is about to set: Google-grounded
// asking prices (the same evidence as a fair-price check), cached a day per item and area so making a listing doesn't
// spend a search each time. Without grounded search the card just asks for the price.
const PRICE_HINTS = "price_hints";
app.post("/api/offers/price-hints", route(async req => {
  const item = text(req.body?.item, 200).trim(), area = text(req.body?.area, 120).trim(), per = priceUnit(req.body?.unit);
  if (!item) throw new HttpError(400, "Describe the offering first.");
  if (!policy().features.priceCheck || !model?.grounded) return { status: "unavailable" };
  const key = `${item}|${area}|${per}`.toLowerCase().replace(/[^\p{L}\p{N}|]+/gu, "-").slice(0, 300);
  const cached = (await db.get(PRICE_HINTS, key)) as any;
  if (cached && cached.checkedAt > now() - 86_400) return cached;
  await spend(req.uid, 2);
  const g = await model.grounded(item, area, per);
  if (!g) return { status: "unavailable" };
  const e = priceEvidence(g, per);
  const out = { status: e.status, low: e.low, typical: e.typical, high: e.high, unit: e.unit, sources: e.sources.slice(0, 4), note: e.note, checkedAt: now(), expireAt: new Date((now() + 2 * 86_400) * 1000) };
  await db.set(PRICE_HINTS, key, out);
  return out;
}));

// Terms a seller might state, suggested for their kind of offering — returned for them to edit; nothing is saved here.
app.post("/api/terms/suggest", route(async req => {
  await spend(req.uid, 2);
  const out = await suggestTerms(model, text(req.body?.category, 40), text(req.body?.text, 600));
  return { terms: out.terms, starters: out.starters, byModel: out.byModel, grounded: out.grounded };
}));

/** Words that only ever mean a floor ("minimum" or "at least" can mean a quantity). */
const STRONG_FLOOR = /\b(lowest|won'?t go below|not (?:go )?below|can go (?:down )?to|floor|bottom line)\b/i;
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
  // Read and judged at the same time: the gate says whether it's specific enough for sellers' agents to act on.
  const [out, gate] = await Promise.all([draft(model, t, here, now(), hint), qualityOf(model, t, "buy", hint ?? "", [])]);
  return { ...out, gate };
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
    const closeAt = num(del?.closeAt, 1, 1e12);
    await db.set(LIMITS, `brief:${b.id}`, { key: `brief:${b.id}`, owner: req.uid, mandate: m, autonomy: ["close", "ask"].includes(del?.autonomy) ? del.autonomy : "negotiate", expires: days ? now() + days * 86_400 : null, createdAt: now(),
      ...(closeAt != null && closeAt <= m.price.limit ? { closeAt } : {}), ...(typeof del?.rulesText === "string" ? { rulesText: text(del.rulesText, 600) } : {}) }); }
  const found = await search(db, model, b, req.uid);
  event("request_sent", { category: b.shared.category || "none", found: found.found.length });
  bq.request(b, wantedUnits(need), b.createdAt);
  return { brief: b, goal, ...found };
}));
/** How many a request asks for ("200 lamps"), as read from it: its quantity, else 1. */
function wantedUnits(n: Need): number {
  const raw = n.attributes?.quantity ?? n.filters?.find(f => f.id === "quantity")?.value;
  const v = Number(String(raw ?? "").replace(/,/g, "").match(/\d+/)?.[0]);
  return Number.isInteger(v) && v > 1 && v <= 100_000 ? v : 1;
}
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
      offer: f.offer ? { factId: f.id, title: f.offer.title, price: f.offer.price.amount, unit: f.offer.price.period ?? null, category: f.offer.category, ...(f.offer.policies?.length ? { policies: f.offer.policies } : {}) } : { factId: f.id, title: f.text.slice(0, 80), price: null, unit: null, category: null } });
    e.events.push({ at: now(), who: "system", text: `Your agent is contacting ${p.name}'s agent over A2A.` });
    // How many the request is for: every offer in this conversation is for that many. A seller with fewer in stock
    // can sell what they have — the buyer is told, and decides (their agent never closes a smaller deal for them).
    const want = wantedUnits(brief.need);
    if (want > 1) e.quantity = want;
    const cap = f.offer?.maxPerBuyer;
    const free = want > 1 && f.offer ? Math.min(await inStock(db, e) ?? Infinity, cap ?? Infinity) : null;
    if (free !== null && Number.isFinite(free) && free < want) {
      if (free > 0) { e.quantity = free; e.wanted = want; e.wantedLimit = cap === free && (await inStock(db, e) ?? Infinity) > free ? "rule" : "stock"; e.events.push({ at: now(), who: "system", text: `${p.name} ${cap === free ? `offers at most ${free} per person` : `has ${free} in stock`} — you asked for ${want}. Your agent negotiates for ${free}; you decide before anything is final.` }); }
      else e.events.push({ at: now(), who: "system", text: `${p.name} is out of stock right now — you can still ask when more come in.` });
    }
    if (brief.goalId) { e.goalId = brief.goalId; await linkTask(db, brief.goalId, req.uid, e.id, now()); }
    // The first turn waits in the outbox; the device starts it with /run (each run is one bounded request).
    e.outbox = { kind: TURN, from: "requester", engagementId: e.id, brief: brief.shared, offerFactId: f.id };
    await saveEngagement(db, e);
    event("agents_contacted", { category: e.offer.category ?? "none", via: "search" });
    out.push(e);
  }
  return out;
}));

app.post("/api/push/token", route(async req => { const t = text(req.body?.token, 4096); if (t.length > 20) await saveToken(req.uid, t); return { ok: true }; }));
// A test notification to every device this person turned notifications on for.
app.post("/api/push/test", route(async req => {
  await spend(req.uid, 1);
  const r = await pushTo(req.uid, "Notifications are on", "You'll hear here when a decision is yours.", "/?screen=settings");
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
  try { return await checkPrice(db, model, req.uid, text(req.body?.item, 200), text(req.body?.area, 120), now(), req.body?.unit); }
  catch (err) { if (err instanceof PriceCheckError) throw new HttpError(err.status, err.message); throw err; }
}));
app.get("/api/price-check", route(async req => db.get(PRICE_CHECKS, req.uid)));

// An offering's stated policies and instant booking — set by its owner only. Collab shows them as the seller wrote them
// and seals them into each deal; it never writes terms for a seller.
app.post("/api/facts/:id/policies", route(async req => {
  const f = (await db.get(FACTS, String(req.params.id))) as Fact | null;
  if (!f || f.owner !== req.uid || !f.offer) throw new HttpError(404, "offering not found");
  const list = Array.isArray(req.body?.policies) ? req.body.policies : [];
  const policies = list.slice(0, 8).map((p: any) => ({ label: text(p?.label, 40).trim(), text: text(p?.text, 240).trim() })).filter((p: { label: string; text: string }) => p.label && p.text);
  const offer = { ...f.offer, policies, instant: req.body?.instant === true };
  await db.set(FACTS, f.id, { ...f, offer, updatedAt: now() });
  return publicFact({ ...f, offer });
}));
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
app.get("/public/keys", route(async () => ({ keys: signing.keys }), false));
app.get("/public/receipts/:id", route(async req => {
  const id = String(req.params.id);
  if (!validCode(cfg.secret, id, "receipt", req.query.code)) throw new HttpError(404, "receipt not found");
  return receiptBundle(await load(db, id));
}, false));
/**
 * A pass is honoured when the agreement record matches and the seller's signed cart is intact; an in-app payment
 * must also carry a valid payment signature. Paid outside the app (cash, UPI) has no payment signature to check —
 * the pass says who marked it paid instead.
 */
async function passVerified(e: Engagement, _check?: unknown) {
  if (!(await verifyReceipt(db, e)).matches) return false;
  const check = checkPayment(e, verifySigned);
  if (!check?.cartOk) return false;
  return e.payment?.status === "outside" || !!check.paymentOk;
}
app.get("/api/engagements/:id/pickup", route(async req => {
  const e = await participant(req.uid, String(req.params.id));
  let details;
  try { details = pickupDetails(e); } catch (err) { throw new HttpError(400, (err as Error).message); }
  const check = checkPayment(e, verifySigned);
  if (!(await passVerified(e, check))) throw new HttpError(409, "Payment or agreement cannot be verified.");
  return { ...details, sellerHandle: await handleNow(e, details.sellerHandle), collectedAt: (await db.get(PICKUPS, e.id))?.collectedAt ?? null,
    path: `/pickup.html#${e.id}.${passCode(cfg.secret, e.id, "pickup")}` };
}));
app.get("/public/pickup/:id", route(async req => {
  const id = String(req.params.id);
  if (!validCode(cfg.secret, id, "pickup", req.query.code)) throw new HttpError(404, "pass not found");
  const e = await load(db, id), check = checkPayment(e, verifySigned);
  if (!(await passVerified(e, check))) throw new HttpError(409, "Payment or agreement cannot be verified.");
  const details = pickupDetails(e);
  return { ...details, sellerHandle: await handleNow(e, details.sellerHandle), collectedAt: (await db.get(PICKUPS, id))?.collectedAt ?? null };
}, false));
/** The seller's handle as it is now: a handle can change after a deal (the signed receipt keeps the one agreed under). */
async function handleNow(e: Engagement, fallback: string) { const uid = e[sellerOf(e)].uid; return (uid ? ((await db.get(PROFILES, uid)) as Profile | null)?.handle : null) ?? fallback; }
app.post("/api/pickup/:id/collect", route(async req => {
  const id = String(req.params.id);
  if (!validCode(cfg.secret, id, "pickup", req.body?.code)) throw new HttpError(404, "pass not found");
  const e = await participant(req.uid, id), check = checkPayment(e, verifySigned);
  if (e[sellerOf(e)].uid !== req.uid) throw new HttpError(403, "Only the person handing it over can mark it collected.");
  if (!(await passVerified(e, check))) throw new HttpError(409, "Payment or agreement cannot be verified.");
  if (e.fulfilment?.state === "cancelled") throw new HttpError(409, "This booking was cancelled.", "VERSION_CONFLICT");
  const result = await collect(db, e, req.uid, now());
  if (result.alreadyCollected) throw new HttpError(409, `Already collected at ${new Date(result.collectedAt * 1000).toISOString()}`);
  await markDelivered(e.id, sellerOf(e), result.collectedAt, "Collected with the pickup pass."); await clearStats(db, e);
  event("collected");
  const buyer = e[buyerOf(e)];
  if (buyer.uid) void pushTo(buyer.uid, `Collected: ${e.offer.title.split(" · ")[0]}`, "Got it as agreed? Tap to confirm.", `/?engagement=${e.id}`);
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
  if (side !== buyerOf(before)) throw new HttpError(403, "Only the person getting it pays.", "AUTHORITY_REQUIRED");
  await spend(req.uid, 1);
  // Exactly one tap claims the payment (a transaction moves awaiting → paying); a claim stuck for two minutes (a
  // crashed request) can be taken over.
  const t0 = now();
  const claimable = (p: any) => p?.status === "awaiting" || (p?.status === "paying" && t0 - (p.claim?.at ?? 0) > policy().timing.paymentClaimStaleSec);
  if (before.fulfilment?.state === "cancelled") throw new HttpError(409, "This deal was cancelled — nothing to pay.", "VERSION_CONFLICT");
  const claimed = (await db.update(ENGAGEMENTS, id, (cur: Engagement | null) => (cur && cur.phase === "agreed" && cur.fulfilment?.state !== "cancelled" && claimable(cur.payment)
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
  // Tracked stock: the reservation must be live. An expired or missing hold is taken again if the stock is there;
  // if not, nothing is charged and the claim is released.
  if (!e.reservation && e.offer.factId && (await resourceFor(db, e.offer.factId))) await reserveFor(db, e); // deals from before tracking
  if (e.reservation && e.reservation.state !== "committed") {
    const live = e.reservation.state === "held" && (e.reservation.expiresAt ?? 0) > now();
    if (!live) {
      try {
        if (e.reservation.state === "choose_slot" || (e.reservation.slotId === null && e.reservation.state !== "unavailable" && (await db.get(RESOURCES, e.reservation.resourceId))?.type === "slots")) {
          await release();
          throw new HttpError(409, "Pick a time slot first.", "INVALID_INPUT");
        }
        const h = await holdResource(db, e.reservation.resourceId, { holder: req.uid, engagementId: e.id, qty: e.reservation.qty, slotId: e.reservation.slotId ?? null, ttlSec: policy().timing.holdTtlSec }, now());
        e.reservation = { ...e.reservation, holdId: h.id, state: "held", expiresAt: h.expiresAt };
      } catch (err) {
        await release();
        if (err instanceof CapacityError) throw new HttpError(409, `${err.message} Nothing was charged.`, err.code);
        throw err;
      }
    }
  }
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
  const paidEvent = { at: now(), who: side, text: `Paid ${moneyText({ amount: mandate.amount.value, currency: mandate.amount.currency, period: e.offer.unit })}.`, by: "owner" as const };
  // Commit only while this tap still holds the claim.
  const committed = await db.update(ENGAGEMENTS, id, (cur: Engagement | null) => (cur?.payment?.status === "paying" && cur.payment.claim?.key === key
    ? { ...cur, payment: { ...e.payment!, claim: { key, at: t0 } }, fulfilment: e.fulfilment, ...(e.reservation ? { reservation: e.reservation } : {}), events: [...cur.events, paidEvent], updatedAt: now() } : null));
  if (!committed) throw new HttpError(409, "This payment changed while it was being made. Try again.", "VERSION_CONFLICT");
  // Paid: the held units become a commitment (they leave the seller's stock).
  if (e.reservation?.holdId && e.reservation.state === "held") {
    await commitResource(db, e.reservation.resourceId, e.reservation.holdId, now()).catch(err => log.error("reservation commit failed after payment", { id, error: String(err).slice(0, 160) }));
    await db.update(ENGAGEMENTS, id, (cur: Engagement | null) => (cur?.reservation ? { ...cur, reservation: { ...cur.reservation, state: "committed" } } : null));
    void warnLowStock(e.reservation.resourceId);
  }
  const turn: Turn = { kind: TURN, from: side, engagementId: e.id, payment: mandate, ap2: { checkout_mandate: e.payment!.ap2!.checkout_mandate, payment_mandate: e.payment!.ap2!.payment_mandate, checkout_hash: e.payment!.ap2!.checkout_hash } };
  if (side === "requester") await sendTurn(cfg, e.id, turn).catch(() => {});
  else await deliverProviderTurn(cfg, a2a.store, e.id, turn).catch(() => {});
  event("paid", { currency: mandate.amount.currency, amount: mandate.amount.value, instrument: e.payment!.ap2?.instrument.type ?? "test" });
  bq.deal(e, now());
  const seller = sellerOf(e) === "requester" ? e.requester : e.provider;
  if (seller.uid) void pushTo(seller.uid, "Payment received", `${e[buyerOfSide(e)].name} paid for ${e.offer.title.split(" · ")[0]}. Hand over with their pass.`, `/?engagement=${e.id}`);
  return load(db, e.id);
}));
// Deals agreed before AP2 carts existed get theirs when a participant opens them (saving issues it).
app.post("/api/engagements/:id/cart", route(async req => {
  const e = await participant(req.uid, String(req.params.id));
  if (e.phase === "agreed" && !e.payment) await saveEngagement(db, e);
  return load(db, e.id);
}));
// Slots for a deal: the open ones, and the buyer's pick (held atomically; another buyer can't take it meanwhile).
app.get("/api/engagements/:id/slots", route(async req => {
  const e = await participant(req.uid, String(req.params.id));
  const r = e.reservation ? ((await db.get(RESOURCES, e.reservation.resourceId)) as Resource | null) : null;
  if (!r || r.type !== "slots") return { timezone: null, slots: [] };
  const t = now();
  return { timezone: r.timezone, slots: r.slots.filter(s => s.start > t && availableIn(r, t, s.id) > 0).sort((a, b) => a.start - b.start).slice(0, 50) };
}));
app.post("/api/engagements/:id/slot", route(async req => {
  const e = await participant(req.uid, String(req.params.id));
  if (e[buyerOf(e)].uid !== req.uid) throw new HttpError(403, "Only the person booking picks the time.", "AUTHORITY_REQUIRED");
  if (!e.reservation || e.payment?.status === "paid") throw new HttpError(409, "There's no slot to pick for this deal.", "VERSION_CONFLICT");
  const slotId = text(req.body?.slotId, 40);
  try {
    if (e.reservation.holdId && e.reservation.state === "held") await releaseResource(db, e.reservation.resourceId, e.reservation.holdId, now());
    const h = await holdResource(db, e.reservation.resourceId, { holder: req.uid, engagementId: e.id, qty: 1, slotId, ttlSec: policy().timing.holdTtlSec }, now());
    const r = (await db.get(RESOURCES, e.reservation.resourceId)) as Resource;
    const s = r.slots.find(x => x.id === slotId)!;
    await db.update(ENGAGEMENTS, e.id, (cur: Engagement | null) => (cur ? { ...cur, reservation: { ...cur.reservation!, holdId: h.id, slotId, slot: { start: s.start, end: s.end }, state: "held", expiresAt: h.expiresAt },
      events: [...cur.events, { at: now(), who: buyerOf(cur), text: `Picked ${new Date(s.start * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC — held until paid.`, by: "owner" }], updatedAt: now() } : null));
  } catch (err) { if (err instanceof CapacityError) throw new HttpError(409, err.message, err.code); throw err; }
  return load(db, e.id);
}));
/**
 * After booking: either side changes the time (to a free upcoming slot) or cancels, until it has happened. Cancelling
 * frees the time for others; the other side is told. A demo payment needs no refund; a payment made outside the app
 * is settled between the two of them.
 */
app.post("/api/engagements/:id/booking", route(async req => {
  const e = await participant(req.uid, String(req.params.id));
  const side = e.requester.uid === req.uid ? "requester" : "provider", r = e.reservation;
  if (e.phase !== "agreed" || !r?.holdId || !r.slotId || !["held", "committed"].includes(r.state)) throw new HttpError(409, "There's no booked time to change.", "VERSION_CONFLICT");
  if (["delivered", "accepted", "disputed", "cancelled"].includes(e.fulfilment?.state ?? "")) throw new HttpError(409, "This booking has already happened or ended.", "VERSION_CONFLICT");
  // Only a paid booking is changed here (before paying, the buyer just picks another time), and only before it starts.
  if (!["paid", "outside"].includes(e.payment?.status ?? "")) throw new HttpError(409, "Pay for the booking first, or pick another time before paying.", "VERSION_CONFLICT");
  if (r.slot && r.slot.start <= now()) throw new HttpError(409, "This booking's time has started — it can't be changed or cancelled now.", "VERSION_CONFLICT");
  const me_ = e[side], other = e[side === "requester" ? "provider" : "requester"], item = e.offer.title.split(" · ")[0];
  const tz = ((await db.get(RESOURCES, r.resourceId)) as Resource | null)?.timezone || "Asia/Kolkata";
  const when = (s: { start: number }) => new Date(s.start * 1000).toLocaleString("en-IN", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  if (req.body?.action === "cancel") {
    try { await cancelBooking(db, r.resourceId, r.holdId, now()); } catch (err) { if (err instanceof CapacityError) throw new HttpError(409, err.message, err.code); throw err; }
    const settle = e.payment?.status === "paid" ? " The demo payment needs no refund." : e.payment?.status === "outside" ? " Settle any refund between you." : "";
    await db.update(ENGAGEMENTS, e.id, (cur: Engagement | null) => (cur ? { ...cur, reservation: { ...cur.reservation!, state: "released" }, fulfilment: { ...(cur.fulfilment ?? { state: "not_started" }), state: "cancelled", note: `Cancelled by ${me_.name}` },
      events: [...cur.events, { at: now(), who: side, text: `Cancelled the booking for ${r.slot ? when(r.slot) : "the booked time"}.${settle}`, by: "owner" }], updatedAt: now() } : null));
    await clearStats(db, e);
    if (other.uid) void pushTo(other.uid, `Booking cancelled: ${item}`, `${me_.name} cancelled ${r.slot ? when(r.slot) : "the booking"}. The time is free again.`, `/?engagement=${e.id}`).catch(() => {});
    return load(db, e.id);
  }
  const slotId = text(req.body?.slotId, 40);
  let to;
  try { to = await moveHold(db, r.resourceId, r.holdId, slotId, now()); } catch (err) { if (err instanceof CapacityError) throw new HttpError(409, err.message, err.code); throw err; }
  await db.update(ENGAGEMENTS, e.id, (cur: Engagement | null) => (cur ? { ...cur, preferredSlotId: slotId, reservation: { ...cur.reservation!, slotId, slot: { start: to.start, end: to.end } },
    events: [...cur.events, { at: now(), who: side, text: `Moved the booking to ${when(to)}${r.slot ? ` (was ${when(r.slot)})` : ""}.`, by: "owner" }], updatedAt: now() } : null));
  if (other.uid) void pushTo(other.uid, `New time: ${item}`, `${me_.name} moved the booking to ${when(to)}.`, `/?engagement=${e.id}`).catch(() => {});
  return load(db, e.id);
}));
app.post("/api/resources/:id/slots", route(async req => {
  const id = String(req.params.id);
  const add = (Array.isArray(req.body?.slots) ? req.body.slots : []).slice(0, 50).map((x: any) => ({ start: num(x?.start, 0, 4e9) ?? 0, end: num(x?.end, 0, 4e9) ?? 0, capacity: num(x?.capacity, 1, 1000) ?? 1 }));
  if (!add.length || add.some((s: any) => s.end <= s.start)) throw new HttpError(400, "Each slot needs a start before its end.", "INVALID_INPUT");
  const r = await db.update(RESOURCES, id, (cur: Resource | null) => (cur && cur.owner === req.uid && cur.type === "slots"
    ? { ...cur, slots: [...cur.slots, ...add.map((s: any) => ({ id: randomUUID().slice(0, 12), ...s }))].slice(-500), revision: cur.revision + 1, updatedAt: now(), observedAt: now() } : null));
  if (!r) throw new HttpError(404, "No such schedule.", "NOT_FOUND");
  return r;
}));

// Connectors: an owner links an outside system to one resource, with scopes, an expiry and revocation.
app.get("/api/connectors", route(async req => ((await db.find(GRANTS, [["owner", "==", req.uid]], 50)) as ConnectorGrant[]).map(g => ({ ...g, title: ADAPTERS[g.provider]?.title }))));
app.post("/api/connectors", route(async req => {
  try {
    const g = await createGrant(db, req.uid, text(req.body?.provider, 40), text(req.body?.resourceId, 40), typeof req.body?.url === "string" ? text(req.body.url, 500) : null, now());
    if (g.provider === "ical") await syncIcal(db, g, url => getSafe(url), now());
    // The POS signing key is shown once here; Collab derives it again to check events and never displays it later.
    return { grant: (await db.get(GRANTS, g.id)) as ConnectorGrant, ...(g.provider === "inventory-webhook" ? { eventsUrl: `${cfg.publicUrl}/connectors/${g.id}/events`, signingKey: grantKey(cfg.secret, g.id),
      howTo: "POST JSON {id, type: 'stock.set'|'stock.adjust', onHand|delta, observedAt} with header X-Collab-Signature: sha256=<hex HMAC-SHA256 of the body with the signing key>." } : {}) };
  } catch (err) { if (err instanceof ConnectorError) throw new HttpError(err.status, err.message, err.code); throw err; }
}));
app.post("/api/connectors/:id/revoke", route(async req => {
  try {
    const g = await revokeGrant(db, req.uid, String(req.params.id), now());
    if (g.provider === "google-calendar") await unlink(db, g, now());
    return g;
  } catch (err) { if (err instanceof ConnectorError) throw new HttpError(err.status, err.message, err.code); throw err; }
}));
app.post("/api/connectors/:id/sync", route(async req => {
  const g = (await db.get(GRANTS, String(req.params.id))) as ConnectorGrant | null;
  if (!g || g.owner !== req.uid) throw new HttpError(404, "No such connector.", "NOT_FOUND");
  if (g.provider === "google-calendar") return gcal ? syncGcal(db, gcal, g, now()) : { synced: false, reason: "Google Calendar linking isn't set up on this server" };
  return syncIcal(db, g, url => getSafe(url), now());
}));

// Google Calendar: the owner says yes on Google's page, comes back here, and their busy times block their slots.
app.get("/api/google/calendar/start", route(async req => {
  if (!gcal) throw new HttpError(503, "Google Calendar linking isn't set up on this server yet — paste your calendar's iCal address instead.", "UNSUPPORTED_CAPABILITY");
  try { return { url: await startLink(db, gcal, req.uid, text(req.query.resourceId, 60), now()) }; }
  catch (err) { if (err instanceof ConnectorError) throw new HttpError(err.status, err.message, err.code); throw err; }
}));
app.get("/api/google/calendar/callback", async (req, res) => {
  const back = (q: string) => res.redirect(`${cfg.publicUrl}/?screen=context&calendar=${q}`);
  if (!gcal) return back("failed");
  if (typeof req.query.error === "string") return back("declined");
  try { await finishLink(db, gcal, text(req.query.code, 400), text(req.query.state, 600), now()); return back("linked"); }
  catch (err) { log.warn("google calendar link failed", { error: String((err as Error).message ?? err).slice(0, 200) }); return back("failed"); }
});

// Stock and slots for an owner's offerings (the ledger the reservations come from).
app.get("/api/resources", route(async req => db.find(RESOURCES, [["owner", "==", req.uid]], 100)));
app.post("/api/resources", route(async req => {
  const factId = text(req.body?.factId, 60);
  const f = (await db.get(FACTS, factId)) as Fact | null;
  if (!f || f.owner !== req.uid || f.tier !== "public" || !f.offer) throw new HttpError(404, "Track stock for one of your public offerings.", "NOT_FOUND");
  if (await resourceFor(db, factId)) throw new HttpError(409, "This offering already has a ledger — update it instead.", "VERSION_CONFLICT");
  const type = req.body?.type === "slots" ? "slots" : "quantity";
  // Weekly opening hours: bookable times are made from them and kept two weeks ahead — the seller states them once.
  const hours = req.body?.hours != null ? validHours(req.body.hours) : null;
  if (req.body?.hours != null && !hours) throw new HttpError(400, "Opening hours need at least one day, and a booking has to fit between opening and closing.", "INVALID_INPUT");
  const slots = Array.isArray(req.body?.slots) ? req.body.slots.slice(0, 100).map((x: any) => ({ start: num(x?.start, 0, 4e9) ?? 0, end: num(x?.end, 0, 4e9) ?? 0, capacity: num(x?.capacity, 1, 1000) ?? 1 })) : [];
  try { return await createResource(db, req.uid, { factId, type, title: f.offer.title, onHand: type === "quantity" ? Number(req.body?.onHand) : 0, slots, timezone: text(req.body?.timezone, 60) || undefined, hours: type === "slots" ? hours : null }, now()); }
  catch (err) { if (err instanceof CapacityError) throw new HttpError(400, err.message, "INVALID_INPUT"); throw err; }
}));
app.post("/api/resources/:id/hours", route(async req => {
  const hours = req.body?.hours === null ? null : validHours(req.body?.hours);
  if (req.body?.hours !== null && !hours) throw new HttpError(400, "Opening hours need at least one day, and a booking has to fit between opening and closing.", "INVALID_INPUT");
  try { return await setHours(db, String(req.params.id), req.uid, hours, typeof req.body?.timezone === "string" ? req.body.timezone : null, now()); }
  catch (err) { if (err instanceof CapacityError) throw new HttpError(404, err.message, "NOT_FOUND"); throw err; }
}));
app.post("/api/resources/:id/stock", route(async req => {
  try { return await setStock(db, String(req.params.id), req.uid, Number(req.body?.onHand), now()); }
  catch (err) { if (err instanceof CapacityError) throw new HttpError(err.code === "NOT_FOUND" ? 404 : 400, err.message, err.code === "NOT_FOUND" ? "NOT_FOUND" : "INVALID_INPUT"); throw err; }
}));

// Fulfilment, separate from payment: the seller hands over (pickup pass) or marks delivered; the buyer then accepts or
// reports a problem. Each side's report also feeds the other side's track record.
async function markDelivered(id: string, seller: "requester" | "provider", at: number, note: string) {
  await db.update(ENGAGEMENTS, id, (cur: Engagement | null) => {
    if (!cur || cur.phase !== "agreed" || ["delivered", "accepted", "disputed", "cancelled"].includes(cur.fulfilment?.state ?? "")) return null;
    return { ...cur, fulfilment: { state: "delivered", deliveredAt: at, note }, outcome: { ...(cur.outcome ?? {}), [seller]: "happened" },
      events: [...cur.events, { at, who: seller, text: note, by: "owner" }], updatedAt: at };
  });
}
app.post("/api/engagements/:id/delivered", route(async req => {
  const e = await participant(req.uid, String(req.params.id));
  if (e[sellerOf(e)].uid !== req.uid) throw new HttpError(403, "Only the person handing it over can mark it delivered.", "AUTHORITY_REQUIRED");
  if (e.phase !== "agreed") throw new HttpError(409, "There's no agreed deal to deliver.", "VERSION_CONFLICT");
  if (e.fulfilment?.state === "cancelled") throw new HttpError(409, "This booking was cancelled.", "VERSION_CONFLICT");
  await markDelivered(e.id, sellerOf(e), now(), "Marked as delivered."); await clearStats(db, e);
  const buyer = e[buyerOf(e)];
  if (buyer.uid) void pushTo(buyer.uid, `Handed over: ${e.offer.title.split(" · ")[0]}`, "Confirm it's as agreed, or report a problem.", `/?engagement=${e.id}`);
  return load(db, e.id);
}));
app.post("/api/engagements/:id/received", route(async req => {
  const e = await participant(req.uid, String(req.params.id));
  const buyer = buyerOf(e);
  if (e[buyer].uid !== req.uid) throw new HttpError(403, "Only the person receiving it can confirm it or report a problem.", "AUTHORITY_REQUIRED");
  if (e.phase !== "agreed") throw new HttpError(409, "There's no agreed deal.", "VERSION_CONFLICT");
  const ok = req.body?.ok !== false, note = text(req.body?.note, 300);
  const t = now();
  await db.update(ENGAGEMENTS, e.id, (cur: Engagement | null) => {
    if (!cur || ["accepted", "disputed", "cancelled"].includes(cur.fulfilment?.state ?? "")) return null;
    return { ...cur, fulfilment: { ...(cur.fulfilment ?? { state: "not_started" }), state: ok ? "accepted" : "disputed", acceptedAt: t, ...(note ? { note } : {}) },
      outcome: { ...(cur.outcome ?? {}), [buyer]: ok ? "happened" : "fell_through" },
      events: [...cur.events, { at: t, who: buyer, text: ok ? "Received it — all good." : `Reported a problem${note ? `: ${note}` : "."}`, by: "owner" }], updatedAt: t,
      ...(ok ? { inboxClosed: true } : {}) };
  });
  if (ok) await closeInbox(db, e.id); // done: nothing more to ask either side
  await clearStats(db, e);
  const seller = e[sellerOf(e)];
  if (seller.uid) void pushTo(seller.uid, ok ? `Deal complete: ${e.offer.title.split(" · ")[0]}` : `Problem reported: ${e.offer.title.split(" · ")[0]}`, ok ? `${e[buyerOfSide(e)].name} confirmed it's as agreed.` : "They reported a problem. Tap to reply.", `/?engagement=${e.id}`);
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
  // Paid is paid, however it was paid: the held units leave the seller's stock, as with an in-app payment. A hold that
  // lapsed meanwhile is taken again if the units are still there; if not, both sides are told.
  if (e.reservation && ["held", "released"].includes(e.reservation.state) && e.reservation.qty > 0) {
    const r = e.reservation;
    try {
      let holdId = r.holdId;
      if (r.state !== "held" || !holdId || (r.expiresAt ?? 0) <= now()) holdId = (await holdResource(db, r.resourceId, { holder: e.requester.uid ?? "", engagementId: e.id, qty: r.qty, ttlSec: 300 }, now())).id;
      await commitResource(db, r.resourceId, holdId, now());
      e.reservation = { ...r, holdId, state: "committed" };
      void warnLowStock(r.resourceId);
    } catch (err) {
      e.reservation = { ...r, state: "unavailable", reason: (err as Error).message };
      e.events.push({ at: now(), who: "system", text: "Paid, but the stock count couldn't be updated — check how many are left.", by: "rules" });
      log.warn("stock not committed after an outside payment", { id: e.id, error: String(err).slice(0, 160) });
    }
  }
  await saveEngagement(db, e);
  event("paid", { currency: currencyOf(e), amount: e.payment.cart?.total?.value ?? e.negotiation.deal?.price ?? 0, instrument: "outside" });
  bq.deal(e, now());
  return e;
}));
app.post("/api/engagements/:id/outcome", route(async req => {
  const e = await participant(req.uid, String(req.params.id));
  if (e.phase !== "agreed") throw new HttpError(400, "no deal yet");
  const side = e.requester.uid === req.uid ? "requester" : "provider";
  (e.outcome ??= {})[side] = req.body?.happened ? "happened" : "fell_through";
  await clearStats(db, e);
  if (!req.body?.happened) await releaseBudget(db, e);
  // A deal that fell through before payment gives its held stock back.
  if (!req.body?.happened && e.reservation?.state === "held" && e.reservation.holdId) {
    await releaseResource(db, e.reservation.resourceId, e.reservation.holdId, now());
    e.reservation = { ...e.reservation, state: "released" };
    e.fulfilment = { ...(e.fulfilment ?? { state: "not_started" }), state: "cancelled" };
  }
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
  const es = (await db.find(ENGAGEMENTS, [["participants", "array-contains", uid]], 100)) as Engagement[];
  // A conversation that has ended asks nobody anything: leftovers from before that rule are closed as they're found.
  const ended = new Set(es.filter(e => e.phase === "closed" || e.phase === "declined" || e.fulfilment?.state === "accepted").map(e => e.id));
  // Demo people's devices are simulated: their items show up for the person talking to them.
  const demo: InboxItem[] = [];
  for (const e of es) {
    if (e.requester.uid === uid && e.provider.uid.startsWith("demo-") && e.waiting.provider) {
      demo.push(...((await db.find(INBOX, [["engagementId", "==", e.id], ["status", "==", "open"]], 20)) as InboxItem[]).filter(i => i.side === "provider"));
    }
  }
  const all = [...mine, ...demo];
  for (const i of all.filter(x => ended.has(x.engagementId))) void db.update(INBOX, i.id, (x: InboxItem | null) => (x ? { ...x, status: "done" } : null)).catch(() => {});
  return all.filter(i => !ended.has(i.engagementId)).sort((a, b) => b.createdAt - a.createdAt);
}
app.get("/api/inbox", route(async req => inboxFor(req.uid)));
app.post("/api/inbox/:id", route(async req => {
  const found = (await db.get(INBOX, String(req.params.id))) as InboxItem | null;
  if (!found || found.status !== "open") throw new HttpError(404, "already handled");
  const e = await load(db, found.engagementId);
  const asDemo = found.owner.startsWith("demo-") && e.requester.uid === req.uid;
  if (found.owner !== req.uid && !asDemo) throw new HttpError(403, "not yours");
  // A deal decision is yes or no, said explicitly — a missing or false "confirm" is never taken as yes.
  if (found.kind === "confirm" && (req.body?.confirm === true) === (req.body?.decline === true))
    throw new HttpError(400, "Say confirm: true to accept the deal, or decline: true to say no.");
  await spend(req.uid, 2);
  // Claimed in a transaction: two devices (or two taps) can't both resolve it.
  let claimed = false;
  await db.update(INBOX, found.id, (cur: InboxItem | null) => { claimed = cur?.status === "open"; return claimed ? { ...cur!, status: "working" } : null; });
  if (!claimed) throw new HttpError(409, "already handled");
  const item = { ...found, status: "open" as const };
  const b = req.body ?? {};
  const reopen = () => db.update(INBOX, item.id, (cur: InboxItem | null) => (cur?.status === "working" ? { ...cur, status: "open" } : null));
  // An answer that states an amount is also an offer: made first, so the other side's agent answers the offer, not a
  // stale position.
  await offerFromAnswer(item, typeof b.text === "string" ? b.text : "");
  const r = await resolveItem(db, model, item, { text: typeof b.text === "string" ? b.text : undefined, share: b.share, decline: !!b.decline, confirm: !!b.confirm,
    mandate: item.kind === "move" ? mandateFrom(b.mandate) ?? undefined : undefined }).catch(async err => { await reopen(); throw err; });
  if (r.turn) {
    if (item.side === "requester") await sendTurn(cfg, e.id, r.turn);
    else await deliverProviderTurn(cfg, a2a.store, e.id, r.turn);
  }
  return load(db, e.id);
}));

/**
 * A typed offer in a conversation — the first message or a later one. More than the seller has is refused with the
 * offer that fits; an instant-booking seller's listed price is booked at once; otherwise the other side's agent
 * answers it within its owner's limit (or the owner decides).
 */
async function typedOffer(e: Engagement, side: "requester" | "provider", q: string, offered: { amount: number; currency: string }, count: number | null, isTotal: boolean, uid: string) {
  if (!policy().money.currencies.includes(offered.currency))
    throw new HttpError(400, `Payments in ${offered.currency} aren't supported yet — use ${policy().money.currencies.join(" or ")}.`, "UNSUPPORTED_CURRENCY");
  if (e.offer.currency && e.offer.currency !== offered.currency)
    throw new HttpError(400, `This conversation is in ${e.offer.currency}; offer in ${e.offer.currency}.`, "UNSUPPORTED_CURRENCY");
  e.offer.currency = offered.currency;
  const n = count ?? unitsOf(e);
  try { await offerDeal(db, e, side, offered.amount, q, q, count, isTotal); }
  catch (err) {
    if (err instanceof ShortStock) {
      const seller = e[e.seller ?? "provider"];
      // Missed demand is a buyer asking for more than the stock; not the seller's own offer, nor their per-buyer rule.
      if (seller.uid && side !== (e.seller ?? "provider") && !err.byRule) await missed({ seller: seller.uid, factId: e.offer.factId, item: e.offer.title.split(" · ")[0], wanted: n, available: err.available, buyer: uid, at: now() }, e.offer.category, e.brief?.area ?? null);
      throw shortStock(err.message, err.available, offered.amount, n, isTotal);
    }
    if (err instanceof Refused) throw new HttpError(409, err.message); throw err;
  }
  // A buyer taking an instant-booking seller's listed price is booked at once, as from the seller's card.
  const d = (await load(db, e.id)).negotiation.deal;
  if (side === "requester" && e.offer.factId && e.offer.price != null && d && !d.items?.length && d.price === e.offer.price) {
    const f = (await db.get(FACTS, e.offer.factId)) as Fact | null;
    if (f?.offer?.instant) await autoConfirm(db, await load(db, e.id), "provider");
  }
  // A question about money they were waiting to answer ("what's your budget?") is answered by the offer itself.
  const waiting = await openAnswer(e.id, uid);
  if (waiting && /budget|price|pay|spend|offer|rate|cost|how much/i.test(waiting.question ?? "")) await answerWith(waiting, q).catch(() => {});
  await respondToOffer(db, model, await load(db, e.id));
}
/** "Only 15 in stock" — with the offer that fits, at the same price each, ready to send. */
const shortStock = (message: string, available: number, amount: number, n: number, isTotal: boolean) =>
  new HttpError(409, message, "CAPACITY_UNAVAILABLE", { available, ...(available > 0 ? { suggest: `I'll take ${available} at ₹${Math.round(isTotal ? amount / n : amount).toLocaleString("en-IN")} each` } : {}) });

/** The open question this person's agent is waiting on them to answer in a conversation, if any. */
async function openAnswer(engagementId: string, uid: string): Promise<InboxItem | null> {
  const open = (await db.find(INBOX, [["engagementId", "==", engagementId], ["status", "==", "open"]], 20)) as InboxItem[];
  return open.find(i => i.owner === uid && i.kind === "answer") ?? null;
}
/** Answers it with what they typed (claimed first, so two devices can't both answer), and sends the turn on. */
async function answerWith(item: InboxItem, text: string) {
  let claimed = false;
  await db.update(INBOX, item.id, (cur: InboxItem | null) => { claimed = cur?.status === "open"; return claimed ? { ...cur!, status: "working" } : null; });
  if (!claimed) return;
  await offerFromAnswer(item, text);
  const r = await resolveItem(db, model, { ...item, status: "open" }, { text })
    .catch(async err => { await db.update(INBOX, item.id, (cur: InboxItem | null) => (cur?.status === "working" ? { ...cur, status: "open" } : null)); throw err; });
  if (r.turn) {
    if (item.side === "requester") await sendTurn(cfg, item.engagementId, r.turn);
    else await deliverProviderTurn(cfg, a2a.store, item.engagementId, r.turn);
  }
}
/**
 * An answer that states an amount ("200rs", "my budget is ₹200", or any price in a chat with no listed price) is also
 * that person's offer: it goes into the negotiation, where the other side's agent counters or accepts within its
 * limit — not to the other side as text to read.
 */
async function offerFromAnswer(item: InboxItem, text: string) {
  if (item.kind !== "answer" || !text) return;
  const cur = await load(db, item.engagementId);
  const named = offeredMoney(text, cur.offer.currency ?? policy().money.defaultCurrency);
  if (!named || !policy().money.currencies.includes(named.currency) || (cur.offer.currency && cur.offer.currency !== named.currency)) return;
  if (!["asking", "negotiating", "deal"].includes(cur.phase) || (cur.offer.price != null && !explicitOffer(text))) return;
  cur.offer.currency = named.currency;
  const count = offeredQuantity(text, cur.offer.unit);
  try { await offerDeal(db, cur, item.side, named.amount, null, text, count, amountIsTotal(text, cur.offer.unit, named.amount, count ?? unitsOf(cur), cur.negotiation.deal?.price ?? cur.offer.price ?? null)); }
  catch (err) { if (err instanceof ShortStock || err instanceof Refused) return; throw err; }
  await respondToOffer(db, model, await load(db, cur.id));
}

// Cloud Scheduler runs the due watches every 15 minutes. Outside /api (no App Check — it's not the web app);
// it must carry the cron token derived from the agent secret.
// A connected POS posts signed stock events here (outside /api: it isn't the web app; the signature is its auth).
app.post("/connectors/:id/events", express.raw({ type: "*/*", limit: "16kb" }), async (req, res) => {
  if (!(await take(db, `connector:${String(req.params.id).slice(0, 40)}`, 1, 120, 2))) return res.status(429).json({ error: "Too many events — slow down.", code: "RATE_LIMITED" });
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    const r = await ingestInventory(db, cfg.secret, String(req.params.id), raw, req.headers["x-collab-signature"] as string | undefined, now());
    res.json(r);
  } catch (err) {
    if (err instanceof ConnectorError) return res.status(err.status).json({ error: err.message, code: err.code });
    log.error("connector event failed", err); res.status(500).json({ error: "retry" });
  }
});

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
    // Connected calendars refresh every run; a feed that fails leaves its grant degraded and its data going stale.
    const calendars = ((await db.find(GRANTS, [["provider", "==", "ical"]], 100)) as ConnectorGrant[]).filter(g => g.status !== "revoked");
    const linked = gcal ? ((await db.find(GRANTS, [["provider", "==", "google-calendar"]], 100)) as ConnectorGrant[]).filter(g => g.status !== "revoked") : [];
    const synced = (await Promise.all([...calendars.map(g => syncIcal(db, g, url => getSafe(url), now())), ...linked.map(g => syncGcal(db, gcal!, g, now()))])).filter(x => x.synced).length;
    // Listings published before buyer questions were written for them (or while Gemini was away) get theirs.
    const unasked = ((await db.find(FACTS, [["tier", "==", "public"]], 300)) as Fact[]).filter(f => f.offer && !f.offer.questions?.length).slice(0, 10);
    for (const f of unasked) {
      const questions = await buyerQuestions(model, f.offer!, f.text).catch(() => null);
      if (questions) await db.update(FACTS, f.id, (cur: Fact | null) => (cur?.offer && cur.text === f.text ? { ...cur, offer: { ...cur.offer, questions } } : null));
    }
    // Weekly hours keep making bookable times two weeks ahead.
    const schedules = ((await db.find(RESOURCES, [["type", "==", "slots"]], 300)) as Resource[]).filter(x => needsTopUp(x, now()));
    for (const x of schedules) await topUpHours(db, x.id, now()).catch(err => log.warn("hours top-up failed", { resource: x.id, error: String(err).slice(0, 120) }));
    // Planned goals move on when a step's dependency is done (searching only — nothing is committed).
    const planned = ((await db.find(GOALS, [["closed", "==", null]], 100)) as Goal[]).filter(g => g.plan?.some(st => st.state !== "done" && st.state !== "failed")).slice(0, 25);
    for (const g of planned) await advancePlan(db, model, g, ((await db.get(PROFILES, g.owner)) as Profile | null)?.area ?? null, now()).catch(err => log.warn("plan advance failed", { goal: g.id, error: String(err).slice(0, 120) }));
    // Recurring goals (search, notify — never buy) and all-or-nothing compensation.
    const open_ = (await db.find(GOALS, [["closed", "==", null]], 200)) as Goal[];
    let rounds = 0, compensated = 0;
    for (const g of open_) {
      if (g.recurrence && !g.recurrence.stopped && g.recurrence.nextAt <= now()) {
        const here = ((await db.get(PROFILES, g.owner)) as Profile | null)?.area ?? null;
        // Only worth a notification when it found something.
        if ((await runRecurrence(db, model, g, here, now(), (goal, text) => (/^No one fits/i.test(text) ? Promise.resolve() : pushTo(goal.owner, `New options: ${goal.outcome}`, text, "/?screen=requests").then(() => {})))).ran) rounds++;
      }
      if (g.allOrNothing && !g.compensation && (await compensate(db, g, now()))) compensated++;
    }
    log.info("cron", { ...r, recovered, calendars: { total: calendars.length, synced }, schedules: schedules.length, questioned: unasked.length, plans: planned.length, rounds, compensated });
    res.json({ ...r, recovered, calendars: { total: calendars.length, synced } });
  } catch (e) { next(e); }
});
// Every minute: waiting agent turns that weren't queued (or whose task was lost) are queued again.
app.post("/cron/recover", async (req, res, next) => {
  try {
    const got = Buffer.from(String(req.headers["x-collab-cron"] ?? "")), want = Buffer.from(cronToken(cfg.secret));
    if (got.length !== want.length || !timingSafeEqual(got, want)) return res.status(401).json({ error: "not the scheduler" });
    const recovered = await recoverOutbox(db, now(), queue ? queue.enqueue : null, id => sendTurn(cfg, id, null));
    const decisions = await expireDecisions(db, now(), i => pushTo(i.owner, "Still waiting for you", i.question ?? "A decision is due — tap to decide.", `/?engagement=${i.engagementId}`).then(() => {}));
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
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code, ...(err.extra ?? {}) });
  if (err instanceof Problem) return res.status(400).json({ error: err.message, code: "INVALID_INPUT" });
  if (err instanceof Refused) return res.status(403).json({ error: err.message, code: "AUTHORITY_REQUIRED" });
  if (err instanceof Stale) return res.status(409).json({ error: err.message, code: "VERSION_CONFLICT" });
  log.error("unhandled", err, { path: _req.path });
  res.status(500).json({ error: "something went wrong" });
});

if (env.SEED_DEMO === "1") await seedDemo(db, model, now());
const server = app.listen(port, () => log.info(`collab-market on :${port}`, { store: env.STORE === "memory" ? "memory" : "firestore", model: model?.status().model ?? null, backend: model?.status().backend ?? null, a2a: `${cfg.publicUrl}/a2a` }));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));

/** The buyer's side of a conversation (the requester unless the requester is the one selling). */
function buyerOfSide(e: Engagement): "requester" | "provider" { return (e.seller ?? "provider") === "requester" ? "provider" : "requester"; }
