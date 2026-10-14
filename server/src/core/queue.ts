// Cloud Tasks for agent turns: when a conversation's next turn has to wait (a request ran out of time, or another
// instance holds the conversation), a task re-runs it on the server — durable, retried, and not dependent on anyone's
// app being open. The task calls Cloud Run directly with an OIDC token for this service's own account, which the
// handler checks. Without TASKS_QUEUE (tests, local) turns wait for the next run as before.
import { GoogleAuth, OAuth2Client } from "google-auth-library";
import { log } from "../log.ts";

export interface TurnQueue { enqueue(engagementId: string, delaySeconds?: number): Promise<void>; verify(authorization: string | undefined): Promise<boolean> }

export function turnQueue(queue: string | undefined, runUrl: string | undefined, serviceAccount: string | undefined): TurnQueue | null {
  if (!queue || !runUrl || !serviceAccount) return null;
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const oidc = new OAuth2Client();
  const url = `${runUrl.replace(/\/$/, "")}/tasks/turns`;
  return {
    async enqueue(engagementId, delaySeconds = 2) {
      try {
        const token = await auth.getAccessToken();
        const r = await fetch(`https://cloudtasks.googleapis.com/v2/${queue}/tasks`, { method: "POST", signal: AbortSignal.timeout(5000),
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ task: { scheduleTime: new Date(Date.now() + delaySeconds * 1000).toISOString(),
            httpRequest: { url, httpMethod: "POST", headers: { "content-type": "application/json" },
              body: Buffer.from(JSON.stringify({ engagementId })).toString("base64"),
              oidcToken: { serviceAccountEmail: serviceAccount, audience: url } } } }) });
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
      } catch (e) { log.warn("turn not queued (the next run will send it)", { engagementId, error: String(e).slice(0, 200) }); }
    },
    async verify(authorization) {
      const t = authorization?.match(/^Bearer (.+)$/)?.[1];
      if (!t) return false;
      try {
        const p = (await oidc.verifyIdToken({ idToken: t, audience: url })).getPayload();
        return p?.email === serviceAccount && p.email_verified === true;
      } catch { return false; }
    },
  };
}
