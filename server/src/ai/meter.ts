// What Gemini costs. Every call records its model, latency and token usage; prices are per million tokens from
// GEMINI_PRICES ("<substring>=<in>/<out>,..." — the first model-name substring match wins).
export interface Usage { input: number; output: number; thinking: number; cached: number }

const zero = (): Usage => ({ input: 0, output: 0, thinking: 0, cached: 0 });

/** [input, output] USD per million tokens; output covers thinking too. */
export function priceFor(model: string, prices?: string): [number, number] {
  for (const part of (prices ?? "").split(",")) {
    const m = part.match(/^\s*([^=]+?)\s*=\s*([\d.]+)\s*\/\s*([\d.]+)\s*$/);
    if (m && model.includes(m[1])) return [Number(m[2]), Number(m[3])];
  }
  return model.includes("lite") ? [0.10, 0.40] : [0.30, 2.50];
}

export class Meter {
  private calls = 0; private failures = 0; private totalMs = 0;
  private slowest: { ms: number; task: string } | null = null;
  private tokens = zero(); private costUSD = 0;
  private byTask: Record<string, { calls: number; ms: number; tokens: Usage; costUSD: number }> = {};
  private byModel: Record<string, number> = {};
  private prices?: string;
  constructor(prices?: string) { this.prices = prices; }

  record(e: { task: string; model: string; ms: number; usage: Partial<Usage> | null; ok: boolean }) {
    this.calls++; this.totalMs += e.ms;
    if (!e.ok) this.failures++;
    if (!this.slowest || e.ms > this.slowest.ms) this.slowest = { ms: e.ms, task: e.task };
    this.byModel[e.model] = (this.byModel[e.model] ?? 0) + 1;
    const [pin, pout] = priceFor(e.model, this.prices);
    const u = { ...zero(), ...(e.usage ?? {}) };
    const cost = (u.input * pin + (u.output + u.thinking) * pout) / 1e6;
    for (const k of ["input", "output", "thinking", "cached"] as const) this.tokens[k] += u[k];
    this.costUSD += cost;
    const t = (this.byTask[e.task] ??= { calls: 0, ms: 0, tokens: zero(), costUSD: 0 });
    t.calls++; t.ms += e.ms; t.costUSD += cost;
    for (const k of ["input", "output", "thinking", "cached"] as const) t.tokens[k] += u[k];
  }

  status() {
    return { calls: this.calls, failures: this.failures, avgMs: this.calls ? Math.round(this.totalMs / this.calls) : 0,
      slowest: this.slowest, tokens: { ...this.tokens }, costUSD: this.costUSD, byTask: this.byTask, byModel: this.byModel };
  }
}
