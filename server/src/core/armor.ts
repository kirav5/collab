// Model Armor: a second, model-based screen next to the deterministic policy (which stays the guarantee). Text from
// other agents is checked for prompt injection and jailbreaks before any model reads it; answers our agents are
// about to share are checked for sensitive data (cards, credentials, account numbers) and go to the owner for review
// when something is found. If Model Armor is unreachable the text passes (the policy and the privacy wall still
// apply) and the miss is logged.
import { GoogleAuth } from "google-auth-library";
import { log } from "../log.ts";

export interface Screen { flagged: boolean; reason?: string }
export interface Armor { incoming(text: string): Promise<Screen>; outgoing(text: string): Promise<Screen>; stats: { checked: number; flagged: number; errors: number } }

export function modelArmor(project: string | undefined, location: string, incoming?: string, outgoing?: string): Armor | null {
  if (!project || (!incoming && !outgoing)) return null;
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const stats = { checked: 0, flagged: 0, errors: 0 };
  const base = `https://modelarmor.${location}.rep.googleapis.com/v1/projects/${project}/locations/${location}/templates`;
  async function call(template: string | undefined, method: "sanitizeUserPrompt" | "sanitizeModelResponse", text: string): Promise<Screen> {
    if (!template || !text.trim()) return { flagged: false };
    stats.checked++;
    try {
      const token = await auth.getAccessToken();
      const body = method === "sanitizeUserPrompt" ? { userPromptData: { text: text.slice(0, 8000) } } : { modelResponseData: { text: text.slice(0, 8000) } };
      const r = await fetch(`${base}/${template}:${method}`, { method: "POST", signal: AbortSignal.timeout(4000),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json() as any;
      if (!r.ok) throw new Error(j?.error?.message ?? `HTTP ${r.status}`);
      const s = j.sanitizationResult ?? {};
      if (s.filterMatchState !== "MATCH_FOUND") return { flagged: false };
      const f = s.filterResults ?? {};
      const reason = f.pi_and_jailbreak?.piAndJailbreakFilterResult?.matchState === "MATCH_FOUND" ? "prompt injection"
        : f.sdp?.sdpFilterResult?.inspectResult?.matchState === "MATCH_FOUND" ? `sensitive data (${(f.sdp.sdpFilterResult.inspectResult.findings ?? []).map((x: any) => x.infoType).join(", ")})`
        : "policy";
      stats.flagged++;
      log.info("model armor flagged", { method, reason });
      return { flagged: true, reason };
    } catch (e) {
      stats.errors++;
      log.warn("model armor unavailable", { method, error: String(e).slice(0, 160) });
      return { flagged: false };
    }
  }
  return { stats, incoming: t => call(incoming, "sanitizeUserPrompt", t), outgoing: t => call(outgoing, "sanitizeModelResponse", t) };
}
