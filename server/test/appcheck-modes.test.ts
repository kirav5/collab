// App Check modes, end to end and as rules. "enforce" is verified-or-limited: a person whose browser can't get a
// token (a content blocker, a private window, the SDK throttling itself) can still use Collab, under a tighter limit;
// payments, pickups and price checks always need a fresh single-use token. "strict" refuses anything unverified.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { appCheckDecision, appCheckMode, appCheckOutcome, freeUnverified, instanceBucket } from "../src/core/app-check.ts";
// @ts-ignore browser module, pure functions
import { appCheckCode, usableToken } from "../../web/js/appcheck.js";

test("the decision table: verified passes; unverified is allowed in enforce, refused in strict and for payments", async () => {
  assert.equal(appCheckMode("enforce"), "enforce"); assert.equal(appCheckMode("strict"), "strict"); assert.equal(appCheckMode(undefined), "off"); assert.equal(appCheckMode("bogus"), "off");
  assert.equal(appCheckOutcome("enforce", "ok", false), "verified");
  for (const d of ["invalid", "expired", "replay"] as const) {
    assert.equal(appCheckOutcome("enforce", d, false), "unverified", `enforce · ${d}`);
    assert.equal(appCheckOutcome("monitor", d, false), "unverified", `monitor · ${d}`);
    assert.equal(appCheckOutcome("strict", d, false), "refuse", `strict · ${d}`);
    assert.equal(appCheckOutcome("enforce", d, true), "refuse", `a payment with ${d} is refused`);
  }
  const expired = async () => { throw new Error("The provided App Check token has expired."); };
  const garbage = async () => { throw new Error("Decoding App Check token failed."); };
  assert.equal(await appCheckDecision("t", false, expired), "expired");
  assert.equal(await appCheckDecision("t", false, garbage), "invalid");
  assert.equal(freeUnverified("GET", "/api/inbox"), true); assert.equal(freeUnverified("POST", "/api/chats"), true);
  assert.equal(freeUnverified("POST", "/api/route"), false); assert.equal(freeUnverified("POST", "/api/chatsx"), false);
  let t = 0; const take = instanceBucket(2, 1, () => t);
  assert.deepEqual([take(), take(), take()], [true, true, false]);
  t = 1000; assert.equal(take(), true, "refills over time");
});

test("a stale App Check token is never sent; a fresh one is", () => {
  const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;
  const now = 1_800_000_000_000;
  assert.equal(usableToken(jwt(now / 1000 + 3600), now), jwt(now / 1000 + 3600));
  assert.equal(usableToken(jwt(now / 1000 - 1), now), null, "expired");
  assert.equal(usableToken(jwt(now / 1000 + 10), now), null, "expires within 30 s");
  assert.equal(usableToken("not-a-jwt", now), null); assert.equal(usableToken(null, now), null); assert.equal(usableToken(`h.${Buffer.from("{}").toString("base64url")}.s`, now), null, "no exp");
  assert.equal(appCheckCode({ code: "appCheck/recaptcha-error" }), "appCheck/recaptcha-error");
});

const servers: ChildProcess[] = [];
async function start(mode: string) {
  const port = 9400 + Math.floor(Math.random() * 400), B = `http://localhost:${port}`;
  const s = spawn(process.execPath, ["src/server.ts"], { cwd: new URL("..", import.meta.url).pathname, stdio: "pipe",
    env: { ...process.env, PORT: String(port), STORE: "memory", DEV_AUTH: "1", GEMINI_FAKE: "1", GEMINI_API_KEY: "", PUBLIC_URL: B, APPCHECK: mode } });
  servers.push(s);
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch { /* starting */ } await new Promise(r => setTimeout(r, 200)); }
  return (uid: string, path: string, body?: unknown, token?: string) => fetch(B + path, { method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", authorization: `Bearer dev:${uid}`, ...(token ? { "x-firebase-appcheck": token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
}
after(() => { for (const s of servers) s.kill(); });

test("enforce: a browser without a token can sign up and write (limited); a bad token on a read isn't refused; payments and price checks are", async () => {
  const call = await start("enforce");
  assert.equal((await call("nt", "/api/me", { handle: "no-token", name: "No Token", areaName: "Indiranagar" })).status, 200, "no token: still works");
  assert.equal((await call("nt", "/api/me", undefined, "garbage.token.here")).status, 200, "an invalid token on a read is not refused");
  const price = await call("nt", "/api/price-check", { item: "steel bottle", area: "Indiranagar" });
  assert.equal(price.status, 401); assert.equal(price.body.code, "APP_CHECK"); assert.match(price.body.error, /reCAPTCHA/);
  assert.doesNotMatch(price.body.error, /Please use the Collab app/);
  // The unverified write budget: 20 at once, then refused with its own code.
  const results = [];
  for (let i = 0; i < 22; i++) results.push((await call("burst", "/api/me", { handle: "burst-acct", name: `B${i}` })).status);
  assert.ok(results.slice(0, 19).every(s => s === 200), JSON.stringify(results));
  assert.equal(results.at(-1), 429);
});

test("strict: anything unverified is refused, with a message that says why", async () => {
  const call = await start("strict");
  const r = await call("st", "/api/me", { handle: "strict-1", name: "Strict" });
  assert.equal(r.status, 401); assert.equal(r.body.code, "APP_CHECK"); assert.match(r.body.error, /couldn't be verified/);
  assert.equal((await call("st", "/api/me")).status, 200, "a plain read with no token still loads (nothing to protect)");
});
