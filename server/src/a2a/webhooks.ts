// Push notifications to outside agents' webhooks, sent safely: https only, no redirects, a 5-second limit, and the
// address the connection actually uses must be public — checked at connect time, so a DNS answer can't swap a public
// name for a private address after the check (rebinding).
import { lookup as dnsLookup } from "node:dns";
import { request } from "node:https";
import { isIP } from "node:net";
import { V1PushNotificationSerializer, type PushNotificationSender, type PushNotificationStore, type ServerCallContext } from "@a2a-js/sdk/server";
import type { Task } from "@a2a-js/sdk";
import { log } from "../log.ts";

/** Private, loopback, link-local, carrier-grade NAT, multicast, documentation and other non-public ranges. */
export function publicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && ip.startsWith("192.0.0.")) || ip.startsWith("192.0.2."))) return false;
    if (a === 198 && (b === 18 || b === 19 || ip.startsWith("198.51.100."))) return false;
    if (ip.startsWith("203.0.113.")) return false;
    return true;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === "::" || x === "::1") return false;
    if (/^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith("ff") || x.startsWith("2001:db8")) return false;
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return publicAddress(mapped[1]);
    return true;
  }
  return false;
}

/** DNS lookup that refuses any non-public answer (used by the connection itself). */
function safeLookup(hostname: string, options: any, cb: (err: Error | null, address?: any, family?: number) => void) {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses: any) => {
    if (err) return cb(err);
    const list = (Array.isArray(addresses) ? addresses : [{ address: addresses, family: 4 }]) as { address: string; family: number }[];
    const bad = list.find(a => !publicAddress(a.address));
    if (!list.length || bad) return cb(new Error(`webhook host resolves to a non-public address`));
    if (options?.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

export function postWebhook(url: string, headers: Record<string, string>, body: string, timeoutMs = 5000): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== "https:") return reject(new Error("https only"));
    const req = request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: "POST", lookup: safeLookup as any,
      headers: { ...headers, "content-length": Buffer.byteLength(body) }, timeout: timeoutMs }, res => {
      // No redirects are followed: a 3xx is a failed delivery. The response body is read up to 4 KB and discarded.
      let size = 0;
      res.on("data", (c: Buffer) => { size += c.length; if (size > 4096) res.destroy(); });
      res.on("end", () => resolve(res.statusCode ?? 0));
      res.on("error", () => resolve(res.statusCode ?? 0));
    });
    req.on("timeout", () => req.destroy(new Error("webhook timed out")));
    req.on("error", reject);
    req.end(body);
  });
}

export class SafePushSender implements PushNotificationSender {
  store: PushNotificationStore;
  serializer = new V1PushNotificationSerializer();
  constructor(store: PushNotificationStore) { this.store = store; }
  async send(event: any, context: ServerCallContext, task?: Task) {
    const v = event?.payload?.value;
    const taskId = v?.taskId ?? v?.id ?? task?.id;
    if (!taskId) return;
    const { body, contentType } = this.serializer.serialize(event, task);
    for (const c of await this.store.load(taskId, context)) {
      const headers: Record<string, string> = { "content-type": contentType };
      if (c.authentication?.scheme && c.authentication.credentials) headers.authorization = `${c.authentication.scheme} ${c.authentication.credentials}`;
      else if (c.token) headers["x-a2a-notification-token"] = c.token;
      try {
        const status = await postWebhook(c.url, headers, body);
        if (status < 200 || status >= 300) log.warn("a2a webhook not accepted", { status, host: new URL(c.url).hostname });
      } catch (e) { log.warn("a2a webhook failed", { host: (() => { try { return new URL(c.url).hostname; } catch { return "?"; } })(), error: String(e).slice(0, 120) }); }
    }
  }
}
