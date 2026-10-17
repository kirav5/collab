// The web app from this checkout, against a deployed backend: files from web/ (fresh on every request, no service
// worker), everything else (/api, /a2a, /public, /config, /health…) passed to the backend. For testing UI changes
// without a deploy.  node scripts/serve-web.mjs [port] [backend]   (default 5055, https://collab-55.web.app)
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const PORT = Number(process.argv[2] ?? 5055), BACKEND = (process.argv[3] ?? "https://collab-55.web.app").replace(/\/$/, "");
const ROOT = new URL("../web/", import.meta.url).pathname;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".wasm": "application/wasm" };
// A service worker would keep serving old files: this one removes itself.
const NO_SW = `self.addEventListener("install", () => self.skipWaiting()); self.addEventListener("activate", e => e.waitUntil(self.registration.unregister().then(() => self.clients.matchAll()).then(cs => cs.forEach(c => c.navigate(c.url)))));`;

async function file(path) {
  const p = normalize(join(ROOT, decodeURIComponent(path)));
  if (!p.startsWith(ROOT)) return null;
  try { const s = await stat(p); return s.isFile() ? p : s.isDirectory() ? (await stat(join(p, "index.html")).then(() => join(p, "index.html")).catch(() => null)) : null; } catch { return null; }
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/sw.js") { res.writeHead(200, { "content-type": TYPES[".js"], "cache-control": "no-store" }); return res.end(NO_SW); }
  const local = !url.pathname.startsWith("/api/") && !url.pathname.startsWith("/a2a") && !url.pathname.startsWith("/public/") ? await file(url.pathname === "/" ? "/index.html" : url.pathname) : null;
  if (local) {
    res.writeHead(200, { "content-type": TYPES[extname(local)] ?? "application/octet-stream", "cache-control": "no-store" });
    return res.end(await readFile(local));
  }
  // Anything else is the backend's: same method, headers and body.
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await new Promise(r => { const c = []; req.on("data", d => c.push(d)); req.on("end", () => r(Buffer.concat(c))); });
  const headers = { ...req.headers }; delete headers.host; delete headers["accept-encoding"]; delete headers.origin; delete headers.referer;
  try {
    const r = await fetch(BACKEND + req.url, { method: req.method, headers, body, redirect: "manual" });
    const out = {}; r.headers.forEach((v, k) => { if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) out[k] = v; });
    res.writeHead(r.status, out);
    if (r.body && !/event-stream/.test(r.headers.get("content-type") ?? "")) return res.end(Buffer.from(await r.arrayBuffer()));
    for await (const chunk of r.body ?? []) res.write(chunk);
    res.end();
  } catch (e) { res.writeHead(502, { "content-type": "text/plain" }); res.end(`backend unreachable: ${e.message}`); }
}).listen(PORT, () => console.log(`web/ on http://localhost:${PORT} → API ${BACKEND}`));
