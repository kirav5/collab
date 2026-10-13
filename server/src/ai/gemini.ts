// Gemini, the market's model. On Cloud Run it's reached through Vertex AI with the service's own identity (no key in
// the container); locally (or anywhere) a Gemini API key from Google AI Studio works too. The model only proposes:
// every answer is a JSON object that a task checks before anything uses it (see decide.ts).
//
// GEMINI_MODELS is an ordered list: when a model is overloaded (503), rate-limited (429) or gone (404), the next one
// answers, and the failing one is skipped for a minute. Thinking is kept low (GEMINI_THINKING): every task here is a
// short structured decision, and latency is what the owner feels. Cheap tasks (classification, judging, ranking)
// try GEMINI_MODELS_CHEAP first with GEMINI_THINKING_CHEAP.
import { GoogleGenAI } from "@google/genai";
import { Meter, type Usage } from "./meter.ts";
import { log } from "../log.ts";

export interface CompleteRequest {
  instructions: string;
  prompt: string;
  /** JSON Schema for the response (Gemini's structured output). */
  schema?: object;
  maxTokens?: number;
  /** Which task is asking (for metering); cheap tasks try the lite model first. */
  task?: string;
  tier?: "cheap" | "standard";
}

export interface Model {
  readonly name: string;
  /** The model's JSON text, or null if it couldn't answer (error, timeout, refusal). */
  complete(req: CompleteRequest): Promise<string | null>;
  /** One embedding per text (for search by meaning), or null on failure. */
  embed?(texts: string[], kind: "query" | "document"): Promise<number[][] | null>;
}

export const EMBEDDING_DIMENSIONS = 768;

export interface ModelStatus extends ReturnType<Meter["status"]> {
  model: string; models: string[]; backend: string; lastError: string | null; lastModel: string | null;
}

const RETRYABLE = /\b(429|500|503|504|404)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|DEADLINE_EXCEEDED|NOT_FOUND/;

const list = (v: string | undefined, d: string) => (v || d).split(",").map(s => s.trim()).filter(Boolean);

/** Cheap tasks try the cheap models first, then the standard ones as a safety net. */
export const modelsFor = (tier: "cheap" | "standard" | undefined, standard: string[], cheap: string[]): string[] =>
  tier === "cheap" ? [...new Set([...cheap, ...standard])] : standard;

export function geminiFromEnv(env = process.env): (Model & { status(): ModelStatus }) | null {
  const models = list(env.GEMINI_MODELS || env.GEMINI_MODEL, "gemini-3.6-flash,gemini-3.8-flash,gemini-3.5-flash-lite");
  const cheap = list(env.GEMINI_MODELS_CHEAP, "gemini-3.6-flash,gemini-3.5-flash-lite");
  const thinking = env.GEMINI_THINKING || "low";
  const thinkingCheap = env.GEMINI_THINKING_CHEAP || "minimal";
  const apiKey = env.GEMINI_API_KEY;
  const project = env.GOOGLE_CLOUD_PROJECT;
  if (!apiKey && !project) return null;
  const backend = apiKey ? "gemini-api" : "vertex-ai";
  const ai = apiKey
    ? new GoogleGenAI({ apiKey, httpOptions: { timeout: 15_000 } })
    : new GoogleGenAI({ vertexai: true, project, location: env.GOOGLE_CLOUD_LOCATION || "global", httpOptions: { timeout: 15_000 } });
  const resting = new Map<string, number>();
  // A model that doesn't take a thinking level answers without one — remembered per model and level.
  const noThinking = new Set<string>();
  const meter = new Meter(env.GEMINI_PRICES);
  let lastError: string | null = null, lastModel: string | null = null;

  async function once(model: string, req: CompleteRequest, level: string): Promise<{ text: string | null; usage: Usage }> {
    const res = await ai.models.generateContent({
      model,
      contents: req.prompt,
      config: {
        systemInstruction: req.instructions,
        responseMimeType: "application/json",
        ...(req.schema ? { responseJsonSchema: req.schema } : {}),
        ...(level !== "default" && !noThinking.has(`${model}:${level}`) ? { thinkingConfig: { thinkingLevel: level as any } } : {}),
        temperature: 0.2,
        maxOutputTokens: Math.max(req.maxTokens ?? 512, 1024),
      },
    });
    const u = res.usageMetadata;
    return { text: res.text ?? null, usage: { input: u?.promptTokenCount ?? 0, output: u?.candidatesTokenCount ?? 0,
      thinking: u?.thoughtsTokenCount ?? 0, cached: u?.cachedContentTokenCount ?? 0 } };
  }

  const embeddingModel = env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
  // Gemini models are served from the global endpoint; embeddings also run in the region next to Cloud Run, which
  // answers in well under a second (the global endpoint's first call took ~12 s).
  const embedder = apiKey ? ai : new GoogleGenAI({ vertexai: true, project, location: env.GEMINI_EMBEDDING_LOCATION || "asia-south1", httpOptions: { timeout: 15_000 } });
  return {
    name: models[0],
    status: () => ({ ...meter.status(), model: models[0], models, backend, lastError, lastModel }),
    async embed(texts, kind) {
      try {
        const res = await embedder.models.embedContent({ model: embeddingModel, contents: texts,
          config: { outputDimensionality: EMBEDDING_DIMENSIONS, taskType: kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT" } });
        const out = res.embeddings?.map(e => e.values ?? []) ?? [];
        return out.length === texts.length && out.every(v => v.length === EMBEDDING_DIMENSIONS) ? out : null;
      } catch (e) {
        lastError = `${embeddingModel}: ${String(e).slice(0, 240)}`;
        log.warn("embedding failed", { error: lastError });
        return null;
      }
    },
    async complete(req) {
      const started = Date.now();
      const r = await attempt(req);
      const ms = Date.now() - started;
      meter.record({ task: req.task ?? req.instructions.slice(0, 40), model: r !== null ? lastModel! : modelsFor(req.tier, models, cheap)[0], ms, usage: r?.usage ?? null, ok: r !== null });
      if (r) log.info("gemini", { task: req.task ?? req.instructions.slice(0, 40), model: lastModel, ms, tokens: r.usage });
      return r?.text ?? null;
    },
  };

  async function attempt(req: CompleteRequest): Promise<{ text: string | null; usage: Usage } | null> {
    const choices = modelsFor(req.tier, models, cheap);
    const level = req.tier === "cheap" ? thinkingCheap : thinking;
    const ready = choices.filter(m => (resting.get(m) ?? 0) < Date.now());
    for (const model of ready.length ? ready : choices) {
      try {
        const r = await once(model, req, level);
        lastModel = model;
        if (r.text) return r;
        lastError = `${model}: empty response`;
      } catch (e) {
        const msg = String(e);
        // A model that doesn't take a thinking level answers without one.
        if (/thinking/i.test(msg) && !noThinking.has(`${model}:${level}`)) {
          noThinking.add(`${model}:${level}`);
          try { const r = await once(model, req, level); lastModel = model; if (r.text) return r; } catch { /* next model */ }
        }
        lastError = `${model}: ${msg.slice(0, 240)}`;
        if (!RETRYABLE.test(msg)) break;
        resting.set(model, Date.now() + 60_000);
      }
    }
    log.warn("gemini failed", { error: lastError });
    return null;
  }
}
