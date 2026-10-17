// The pattern every model decision follows (Collab's `DecisionTask`): the model proposes JSON, the task's own rules
// check it against what was actually written, and a deterministic version decides when the model is missing, fails,
// or proposes something the rules reject. The model can make an agent smarter, never less safe.
import type { Model } from "./gemini.ts";

export interface Task<I, O> {
  name: string;
  instructions: string;
  schema?: object;
  maxTokens?: number;
  prompt(input: I): string;
  /** The model's JSON object → a candidate output, or null if it doesn't fit the shape. */
  parse(json: any, input: I): O | null;
  /** Grounded and safe, or null. */
  validate(output: O, input: I): O | null;
  fallback(input: I): O;
  /** Cheap tasks run on the lite model with minimal thinking (default standard). */
  tier?: "cheap" | "standard";
  /** A deterministic answer that needs no model. */
  settled?(input: I): O | null;
  /** A photo the model reads along with the prompt. */
  image?(input: I): { mimeType: string; data: string } | null;
}

export interface Decision<O> { output: O; byModel: boolean; /** True when the task's `settled` hook answered (vs. the fallback). */ settled?: boolean }

/** The first JSON object in a model's text (models sometimes wrap it in prose or a code fence). */
export function firstJSON(text: string | null): any {
  if (!text) return null;
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}

export async function decide<I, O>(model: Model | null, task: Task<I, O>, input: I): Promise<Decision<O>> {
  const s = task.settled?.(input);
  if (s != null) return { output: s, byModel: false, settled: true };
  if (model) {
    const raw = await model.complete({ instructions: task.instructions, prompt: task.prompt(input), schema: task.schema, maxTokens: task.maxTokens, task: task.name, tier: task.tier, image: task.image?.(input) ?? null });
    const parsed = firstJSON(raw);
    const candidate = parsed === null ? null : task.parse(parsed, input);
    const checked = candidate === null ? null : task.validate(candidate, input);
    if (process.env.DEBUG_TASKS === "1") console.log(`[${task.name}]`, raw, "→", checked === null ? "rejected" : "kept");
    if (checked !== null) return { output: checked, byModel: true };
  }
  return { output: task.fallback(input), byModel: false };
}

/** A string field, trimmed; null for missing, empty or "null". */
export function str(o: any, k: string): string | null {
  const v = o?.[k];
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && t.toLowerCase() !== "null" ? t : null;
}

export function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") { const n = Number(v.replace(/,/g, "")); return Number.isFinite(n) && v.trim() !== "" ? n : null; }
  return null;
}
