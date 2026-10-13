// Every person's always-on agent is an A2A agent (Agent2Agent protocol v1.0, official SDK): an Agent Card at
// /a2a/<handle>/.well-known/agent-card.json and JSON-RPC at /a2a/<handle>. One engagement is one A2A task; each turn
// is one message with a text part (for any A2A client) and a data part (`collab.turn/v1`) with the structured turn.
//
// The provider side is an AgentExecutor (providerTurn). The requester side is an A2A client (requesterTurn): our
// users' agents talk to each other over real A2A calls, and any other A2A agent can talk to ours — an agent that
// doesn't sign in is a stranger and gets Public facts only.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import express, { type Router } from "express";
import { AgentCard, Message, Task, TaskState } from "@a2a-js/sdk";
import { AgentEvent, DefaultRequestHandler, type AgentExecutor, type ServerCallContext, type TaskStore } from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler } from "@a2a-js/sdk/server/express";
import { ClientFactory, JsonRpcTransportFactory, type Client } from "@a2a-js/sdk/client";
import type { Model } from "../ai/gemini.ts";
import type { Docs } from "../docs.ts";
import { moneyText } from "../market/types.ts";
import type { Engagement, Fact, Profile } from "../core/model.ts";
import { FACTS, PROFILES } from "../core/policy.ts";
import { byHandle } from "../core/directory.ts";
import { type Turn, fresh, load, providerTurn, requesterTurn, save } from "../core/engage.ts";
import { take, withLease } from "../core/limits.ts";

const TASKS = "a2a_tasks";
export const TURN = "collab.turn/v1";

export interface A2AConfig { db: Docs; model: Model | null; publicUrl: string; secret: string; verifyIdToken: (t: string) => Promise<string> }

// MARK: - Who is calling

/** Our users' agents sign their calls with the server's secret; people's browsers or other apps use a Firebase ID
 *  token; anything else is an unnamed outside agent. */
export const agentToken = (secret: string, uid: string) => `agent:${uid}.${createHmac("sha256", secret).update(uid).digest("base64url")}`;

/** An owner's signature over a deal receipt's hash. */
export const signReceipt = (secret: string, uid: string, hash: string) => createHmac("sha256", secret).update(`${uid}:${hash}`).digest("base64url");

function agentUid(secret: string, token: string): string | null {
  const m = token.match(/^agent:([^.]+)\.(.+)$/);
  if (!m) return null;
  const want = Buffer.from(agentToken(secret, m[1]).split(".").pop()!), got = Buffer.from(m[2]);
  return want.length === got.length && timingSafeEqual(want, got) ? m[1] : null;
}

class Caller {
  uid: string | null;
  ip: string;
  constructor(uid: string | null, ip = "") { this.uid = uid; this.ip = ip; }
  get isAuthenticated() { return this.uid !== null; }
  get userName() { return this.uid ?? ""; }
}
const callerOf = (c: ServerCallContext) => ((c.user as Caller | undefined)?.uid ?? null);
const ipOf = (c: ServerCallContext) => ((c.user as Caller | undefined)?.ip ?? "");
const clientIp = (req: express.Request) => String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim();

// MARK: - Tasks in Firestore

class FirestoreTaskStore implements TaskStore {
  db: Docs;
  constructor(db: Docs) { this.db = db; }
  async save(task: Task, context: ServerCallContext) {
    const prev = await this.db.get(TASKS, task.id);
    await this.db.set(TASKS, task.id, { id: task.id, caller: prev?.caller ?? callerOf(context), json: JSON.stringify(Task.toJSON(task)), updatedAt: Date.now() });
  }
  async load(taskId: string, context: ServerCallContext) {
    const d = await this.db.get(TASKS, taskId);
    // A task is the caller's: one agent can't read another's conversation by guessing an id.
    if (!d || (d.caller && d.caller !== callerOf(context))) return undefined;
    return Task.fromJSON(JSON.parse(d.json));
  }
  async list() { return { tasks: [], nextPageToken: "", pageSize: 0, totalSize: 0 } as any; }
}

// MARK: - Agent cards

async function cardFor(cfg: A2AConfig, p: Profile): Promise<AgentCard> {
  const offers = ((await cfg.db.find(FACTS, [["owner", "==", p.uid]], 100)) as Fact[]).filter(f => f.tier === "public");
  return AgentCard.fromJSON({
    name: `${p.name}'s agent (@${p.handle})`,
    description: `${p.bio ? p.bio + " " : ""}Ask about what ${p.name} offers or send a request. This agent answers only from what ${p.name} chose to share; anything else goes to ${p.name}.`,
    version: "1.0.0",
    supportedInterfaces: [{ url: `${cfg.publicUrl}/a2a/${p.handle}`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    provider: { organization: "Collab Market", url: cfg.publicUrl },
    capabilities: { streaming: false, pushNotifications: false,
      extensions: [{ uri: "https://github.com/google-agentic-commerce/AP2/tree/v0.1",
        description: "Agentic Payments Protocol roles: merchant (this agent's Public offerings) and shopper (requests it sends). Mandates are negotiated here; payment happens between the owners for now.",
        required: false, params: { roles: ["merchant", "shopper"] } }] },
    securitySchemes: { firebase: { httpAuthSecurityScheme: { scheme: "bearer", bearerFormat: "Firebase ID token", description: "Optional. Without it you're a stranger: Public facts only." } } },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: [{
      id: "engage", name: "Requests and questions",
      description: `Send a request (a brief) or a question. The agent answers from ${p.name}'s shared facts, asks what it needs to know, and negotiates within ${p.name}'s limits.`,
      tags: [...new Set(offers.map(f => f.offer?.category).filter(Boolean) as string[])].slice(0, 8),
      examples: offers.slice(0, 4).map(f => f.offer ? `I'm interested in: ${f.offer.title}` : `Question about: ${f.text.slice(0, 60)}`),
      inputModes: ["text/plain", "application/json"], outputModes: ["text/plain", "application/json"],
    }],
  });
}

// MARK: - Messages

const textOf = (t: Turn): string => {
  const parts: string[] = [];
  if (t.brief) parts.push(`Request: ${t.brief.title}. ${t.brief.summary}${t.brief.budget ? ` Budget ${t.brief.budget}.` : ""}`);
  for (const q of t.questions ?? []) parts.push(`Question: ${q.question}`);
  for (const a of t.answers ?? []) parts.push(`${a.question} — ${a.answer}`);
  for (const p of t.pending ?? []) parts.push(`(checking with the owner: ${p})`);
  if (t.proposal) parts.push(`Offer: ${moneyText({ amount: t.proposal.price, currency: "INR" })}${t.note ? ` — ${t.note}` : ""}`);
  if (t.accept) parts.push(t.note ?? "Accepted.");
  if (t.confirm) parts.push("Confirmed by the owner.");
  if (t.decline) parts.push(t.decline);
  return parts.join("\n") || "…";
};

const message = (role: "ROLE_USER" | "ROLE_AGENT", t: Turn, ids: { taskId?: string; contextId?: string } = {}) =>
  Message.fromJSON({ messageId: randomUUID(), role, ...(ids.taskId ? { taskId: ids.taskId } : {}), ...(ids.contextId ? { contextId: ids.contextId } : {}),
    parts: [{ text: textOf(t) }, { data: t }] });

/** The turn in an A2A message (or, from an outside agent that only sends text, a brief made of that text). */
export function turnOf(m: Message | undefined): Turn | null {
  if (!m) return null;
  const json = Message.toJSON(m) as any;
  const data = (json.parts ?? []).find((p: any) => p.data?.kind === TURN)?.data;
  if (data) return data as Turn;
  const text = (json.parts ?? []).map((p: any) => p.text).filter(Boolean).join("\n").trim();
  // Plain text from another A2A agent: its questions are the questions to answer.
  const questions = (text.match(/[^.?!\n]*\?/g) ?? []).map((q: string) => q.trim()).filter((q: string) => q.length >= 6).slice(0, 4);
  return text ? { kind: TURN, from: "requester", engagementId: "", brief: { title: text.slice(0, 80), summary: text.slice(0, 600), category: "", mode: null, area: null, requirements: [], budget: null, questions } } : null;
}

function stateOf(e: Engagement): TaskState {
  if (e.phase === "agreed") return TaskState.TASK_STATE_COMPLETED;
  if (e.phase === "declined") return TaskState.TASK_STATE_REJECTED;
  if (e.phase === "closed") return TaskState.TASK_STATE_CANCELED;
  return e.waiting.provider ? TaskState.TASK_STATE_WORKING : TaskState.TASK_STATE_INPUT_REQUIRED;
}

// MARK: - The provider side (server)

function executorFor(cfg: A2AConfig, provider: Profile): AgentExecutor {
  return {
    async execute(ctx, bus) {
      const t = turnOf(ctx.userMessage);
      const caller = callerOf(ctx.context);
      let e: Engagement | null = null;
      if (t?.engagementId) {
        try { e = await load(cfg.db, t.engagementId); } catch { e = null; }
        // An engagement is between its two parties: a caller can't continue someone else's.
        if (e && (e.provider.uid !== provider.uid || e.requester.uid !== caller)) e = null;
      }
      if (!e) {
        if (!t?.brief) throw new Error("Start with a request (a brief).");
        // New conversations cost the provider's agent (and Gemini) the most: 20 an hour per caller.
        if (!(await take(cfg.db, `a2a-new:${caller ?? "ip:" + ipOf(ctx.context)}`, 1, 20, 20 / 3600))) throw new Error("Too many new requests — try again later.");
        const who = caller ? ((await cfg.db.get(PROFILES, caller)) as Profile | null) : null;
        // Which of the provider's offerings this is about: the one named, else their (first) offering.
        const offerFact = t.offerFactId ? ((await cfg.db.get(FACTS, t.offerFactId)) as Fact | null)
          : ((await cfg.db.find(FACTS, [["owner", "==", provider.uid]], 100)) as Fact[]).find(f => f.tier === "public" && f.offer) ?? null;
        e = fresh({ briefId: null, brief: t.brief, requester: { uid: caller, handle: who?.handle ?? "outside-agent", name: who?.name ?? "An outside agent" },
          provider: { uid: provider.uid, handle: provider.handle, name: provider.name },
          offer: offerFact?.owner === provider.uid && offerFact.offer
            ? { factId: offerFact.id, title: offerFact.offer.title, price: offerFact.offer.price.amount, unit: offerFact.offer.price.period ?? null, category: offerFact.offer.category }
            : { factId: offerFact?.owner === provider.uid ? offerFact.id : null, title: t.brief.title, price: null, unit: null, category: t.brief.category || null } });
        e.events.push({ at: Math.floor(Date.now() / 1000), who: "system", text: `${e.requester.name}'s agent sent a request over A2A.` });
      }
      e.taskId = ctx.taskId;
      e.contextId = ctx.contextId;
      // One provider turn at a time per conversation, across every instance.
      const current = e;
      const reply = await withLease(cfg.db, `eng:${e.id}:provider`, 50_000, async () => {
        const r = await providerTurn(cfg.db, cfg.model, current, { ...(t as Turn), engagementId: current.id });
        await save(cfg.db, current);
        return r;
      });
      if (!reply) throw new Error("This conversation is busy — try again in a moment.");
      if (!ctx.task) bus.publish(AgentEvent.task({ id: ctx.taskId, contextId: ctx.contextId, status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: new Date().toISOString() }, artifacts: [], history: [ctx.userMessage], metadata: { engagementId: e.id } }));
      bus.publish(AgentEvent.statusUpdate({ taskId: ctx.taskId, contextId: ctx.contextId,
        status: { state: stateOf(e), message: message("ROLE_AGENT", reply, { taskId: ctx.taskId, contextId: ctx.contextId }), timestamp: new Date().toISOString() }, metadata: { engagementId: e.id } } as any));
      bus.finished();
    },
    async cancelTask(taskId, bus) {
      bus.publish(AgentEvent.statusUpdate({ taskId, contextId: "", status: { state: TaskState.TASK_STATE_CANCELED, message: undefined, timestamp: new Date().toISOString() }, metadata: undefined } as any));
      bus.finished();
    },
  };
}

export function a2aRouter(cfg: A2AConfig): { router: Router; store: TaskStore } {
  const store = new FirestoreTaskStore(cfg.db);
  const handlers = new Map<string, DefaultRequestHandler>();
  const router = express.Router({ mergeParams: true });
  const userBuilder = async (req: express.Request) => {
    const ip = clientIp(req);
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!token) return new Caller(null, ip);
    const agent = agentUid(cfg.secret, token);
    if (agent) return new Caller(agent, ip);
    try { return new Caller(await cfg.verifyIdToken(token), ip); } catch { return new Caller(null, ip); }
  };
  router.use("/:handle", async (req, res, next) => {
    // Outside callers are limited per IP (our own agents sign their calls and are limited per account upstream).
    const own = agentUid(cfg.secret, req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? "");
    if (req.method === "POST" && !own && !(await take(cfg.db, `a2a-ip:${clientIp(req)}`, 1, 60, 1))) {
      res.status(429).json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Too many requests — slow down." } });
      return;
    }
    const p = await byHandle(cfg.db, req.params.handle).catch(() => null);
    if (!p) { res.status(404).json({ error: "no such agent" }); return; }
    let h = handlers.get(p.uid);
    if (!h) handlers.set(p.uid, h = new DefaultRequestHandler(await cardFor(cfg, p), store, executorFor(cfg, p)));
    const inner = express.Router();
    // The handler sends what the provider returns as is: the card in its wire (ProtoJSON) form.
    inner.use("/.well-known/agent-card.json", agentCardHandler({ agentCardProvider: async () => AgentCard.toJSON(await cardFor(cfg, p)) as any, cache: { maxAge: 60 } }));
    inner.use("/", jsonRpcHandler({ requestHandler: h, userBuilder }));
    inner(req, res, next);
  });
  return { router, store };
}

// MARK: - The requester side (client)

async function clientFor(cfg: A2AConfig, handle: string, asUid: string): Promise<Client> {
  const token = agentToken(cfg.secret, asUid);
  const fetchImpl: typeof fetch = (url, init) => fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string> ?? {}), authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(55_000) });
  return new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl })] }).createFromUrl(`${cfg.publicUrl}/a2a/${handle}/`);
}

/** The requester's agent sends its turn over A2A and keeps going while it can answer on its own. */
export async function sendTurn(cfg: A2AConfig, engagementId: string, first: Turn | null) {
  const ran = await withLease(cfg.db, `eng:${engagementId}:requester`, 55_000, () => runTurns(cfg, engagementId, first));
  // Another instance is sending for this conversation: the turn waits in the outbox, and the next run sends it.
  if (ran === null && first) {
    const e = await load(cfg.db, engagementId);
    if (!e.outbox) { e.outbox = first; await save(cfg.db, e); }
  }
}

async function runTurns(cfg: A2AConfig, engagementId: string, first: Turn | null) {
  const started = Date.now();
  {
    let turn: Turn | null = first ?? ((await load(cfg.db, engagementId)).outbox as Turn | undefined) ?? null;
    for (let i = 0; i < 12 && turn; i++) {
      const e = await load(cfg.db, engagementId);
      if (!e.requester.uid) return;
      // A request behind Firebase Hosting has 60 s: past ~35 s the next turn waits in the outbox for the next run.
      if (Date.now() - started > 35_000) { e.outbox = turn; await save(cfg.db, e); return; }
      if (e.outbox) { e.outbox = null; await save(cfg.db, e); }
      const client = await clientFor(cfg, e.provider.handle, e.requester.uid);
      const task = (await client.sendMessage({ message: message("ROLE_USER", turn, { taskId: e.taskId ?? undefined, contextId: e.contextId ?? undefined }) } as any)) as Task;
      turn = await onProviderTask(cfg, engagementId, task);
    }
  }
  return true;
}

/** Reads the provider's turn from the task and decides the requester's next (null: nothing to send yet). */
async function onProviderTask(cfg: A2AConfig, engagementId: string, task: Task): Promise<Turn | null> {
  const e = await load(cfg.db, engagementId);
  if (!e.taskId) { e.taskId = task.id; e.contextId = task.contextId; }
  const theirs = turnOf(task.status?.message);
  if (!theirs || task.status?.state === TaskState.TASK_STATE_WORKING) { await save(cfg.db, e); return null; }
  const next = await requesterTurn(cfg.db, cfg.model, e, theirs);
  await save(cfg.db, e);
  return next;
}

/** After the provider's owner answered on their device: the provider's turn goes into the A2A task (as the agent's
 *  status message), and the requester's agent picks it up with GetTask, as any A2A client would. */
export async function deliverProviderTurn(cfg: A2AConfig, store: TaskStore, engagementId: string, turn: Turn) {
  const e = await load(cfg.db, engagementId);
  if (!e.taskId) return;
  const ctx = { user: new Caller(e.requester.uid) } as unknown as ServerCallContext;
  const task = await store.load(e.taskId, ctx);
  if (!task) return;
  const msg = message("ROLE_AGENT", turn, { taskId: e.taskId, contextId: e.contextId ?? undefined });
  task.history = [...task.history, ...(task.status?.message ? [task.status.message] : [])];
  task.status = { state: stateOf(e), message: msg, timestamp: new Date().toISOString() };
  await store.save(task, ctx);
  if (!e.requester.uid) return;
  const client = await clientFor(cfg, e.provider.handle, e.requester.uid);
  const fresh = (await client.getTask({ id: e.taskId } as any)) as Task;
  const next = await onProviderTask(cfg, engagementId, fresh);
  if (next) await sendTurn(cfg, engagementId, next);
}
