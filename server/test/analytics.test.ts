// BigQuery export and forecast (core/analytics): off and harmless without BQ_DATASET (the insights card says so);
// rows carry no account ids, handles or names (only keyed hashes); the forecast query takes the category as a
// parameter, never as SQL; and a seller's forecast runs once a day.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { NOT_SET_UP, analytics, dealRow, forecastQuery, hashId, missRow, next7From, requestRow } from "../src/core/analytics.ts";
import { memoryDocs } from "../src/docs.ts";

const T = Date.UTC(2026, 9, 17) / 1000;
const brief: any = { id: "b1", owner: "user-anu-123", createdAt: T, goalId: null,
  shared: { title: "Steel water bottles · 1 L", summary: "Anu Sharma needs bottles", category: "goods", mode: null, area: "Indiranagar", requirements: [], budget: "up to ₹500", questions: [] },
  need: { id: "n1", category: "goods", text: "Anu Sharma wants 20 steel bottles, up to 450", place: { name: "Indiranagar", lat: 12.97, lon: 77.64, isCity: false }, radiusKm: 5, attributes: { item: "Steel water bottles" }, mustAsk: [], filters: [] } };
const deal: any = { id: "e1", seller: "provider", phase: "agreed", brief: brief.shared,
  requester: { uid: "user-anu-123", handle: "anu-b", name: "Anu Sharma" }, provider: { uid: "shop-ravi-456", handle: "ravi-steel", name: "Ravi Steel" },
  offer: { factId: "f1", title: "Steel water bottles · 1 L", price: 400, unit: null, category: "goods", currency: "INR" },
  negotiation: { requester: [], provider: [], dealBy: "provider", deal: { id: "p1", price: 380, terms: { quantity: 3 }, round: 2 } } };
const miss = { seller: "shop-ravi-456", factId: "f1", item: "Steel water bottles", wanted: 20, available: 3, buyer: "user-anu-123", at: T };
const PRIVATE = ["user-anu-123", "shop-ravi-456", "anu-b", "ravi-steel", "Anu Sharma", "Ravi Steel", "450", "₹500"];

test("without BQ_DATASET every call is a no-op and the forecast says BigQuery isn't set up", async () => {
  let calls = 0;
  const call = async () => { calls++; return {}; };
  for (const a of [analytics(undefined, undefined, "s", call), analytics("collab-55", "", "s", call), analytics("collab-55", "  ", "s", call)]) {
    assert.equal(a.enabled, false);
    a.request(brief, 20, T); a.deal(deal, T); a.miss(miss, "goods", "Indiranagar");
    assert.equal(await a.forecastNext7("goods", null), null);
    const db = memoryDocs();
    assert.deepEqual(await a.forecastFor(db, "shop-ravi-456", "Indiranagar", T), { available: false, reason: NOT_SET_UP, items: [] });
    assert.equal((await db.find("forecasts", [])).length, 0, "nothing kept");
  }
  assert.equal(calls, 0, "BigQuery is never called");
});

test("rows carry categories, areas, items and numbers — people only as keyed hashes", async () => {
  const r = requestRow(brief, 20, T), d = dealRow("secret", deal, T)!, m = missRow("secret", miss, "goods", "Indiranagar");
  assert.deepEqual(r, { at: "2026-10-17T00:00:00.000Z", category: "goods", area: "Indiranagar", item: "Steel water bottles", units: 20 });
  assert.equal(d.units, 3); assert.equal(d.unit_price, 380); assert.equal(d.listed, 400); assert.equal(d.currency, "INR");
  assert.equal(d.seller_hash, hashId("secret", "shop-ravi-456")); assert.equal(d.buyer_hash, hashId("secret", "user-anu-123"));
  assert.equal(m.seller_hash, d.seller_hash, "one seller's rows group together");
  assert.match(d.seller_hash, /^[0-9a-f]{32}$/); assert.notEqual(hashId("other-secret", "shop-ravi-456"), d.seller_hash, "keyed by the server's secret");
  assert.equal(Object.hasOwn(m, "buyer_hash"), false, "a miss doesn't say who asked");
  // What actually leaves, through an enabled client.
  const sent: string[] = [];
  const a = analytics("collab-55", "collab_analytics", "secret", async (path, body) => { sent.push(path + JSON.stringify(body)); return {}; });
  a.request(brief, 20, T); a.deal(deal, T); a.miss(miss, "goods", "Indiranagar");
  await new Promise(r => setImmediate(r));
  assert.equal(sent.length, 3);
  assert.ok(sent[0].includes("tables/requests/insertAll") && sent[1].includes("tables/deals/insertAll") && sent[2].includes("tables/demand_misses/insertAll"));
  for (const s of sent) for (const x of PRIVATE) assert.ok(!s.includes(x), `${x} must not leave`);
  // A failing BigQuery is a warning, never an error for the caller.
  const failing = analytics("collab-55", "collab_analytics", "secret", async () => { throw new Error("403"); });
  assert.doesNotThrow(() => failing.request(brief, 1, T));
});

test("the forecast query takes the category and area as parameters, never as SQL", () => {
  const evil = "goods' OR 1=1; DROP TABLE requests --";
  const q = forecastQuery("collab-55", "collab_analytics", evil, "Indiranagar'--");
  assert.ok(!q.query.includes(evil) && !q.query.includes("Indiranagar"), "no user text in the SQL");
  assert.match(q.query, /AI\.FORECAST\(/); assert.match(q.query, /r\.category = @category/); assert.match(q.query, /horizon => 7/);
  assert.match(q.query, /`collab-55\.collab_analytics\.requests`/);
  assert.equal(q.parameterMode, "NAMED"); assert.equal(q.useLegacySql, false);
  assert.deepEqual(q.queryParameters, [{ name: "category", parameterType: { type: "STRING" }, parameterValue: { value: evil } },
    { name: "area", parameterType: { type: "STRING" }, parameterValue: { value: "Indiranagar'--" } }]);
  assert.equal(forecastQuery("collab-55", "d", "goods", null).queryParameters[1].parameterValue.value, "", "no area: every area");
  assert.throws(() => forecastQuery("collab-55`; --", "d", "goods", null)); assert.throws(() => forecastQuery("collab-55", "a.b", "goods", null));
});

test("a seller's forecast: one query per category a day, summed over 7 days; a failed model answer says so", async () => {
  const rows = (vals: number[], status = "") => ({ jobComplete: true, schema: { fields: [{ name: "forecast_timestamp" }, { name: "forecast_value" }, { name: "ai_forecast_status" }] },
    rows: vals.map((v, i) => ({ f: [{ v: String(T + i * 86400) }, { v: String(v) }, { v: status }] })) });
  assert.equal(next7From(rows([1.4, 2, 0.6, -1, 3, 0, 1])), 8, "below zero counts as none");
  assert.equal(next7From(rows([1, 2], "not enough data")), null);
  assert.equal(next7From({ jobComplete: false }), null);
  const db = memoryDocs();
  await db.set("facts", "f1", { id: "f1", owner: "shop", tier: "public", offer: { category: "goods", title: "Steel bottle" } });
  await db.set("facts", "f2", { id: "f2", owner: "shop", tier: "private", offer: { category: "food", title: "secret" } });
  const queries: any[] = [];
  const a = analytics("collab-55", "collab_analytics", "s", async (path, body: any) => { queries.push({ path, body }); return rows([1, 1, 1, 1, 1, 1, 1]); });
  const f = await a.forecastFor(db, "shop", "Indiranagar", T);
  assert.equal(f.available, true); assert.equal(f.items.length, 1, "only what the seller lists publicly");
  assert.equal(f.items[0].next7, 7); assert.ok(f.items[0].label.length > 2 && f.items[0].label !== "goods", "the category in plain words");
  assert.equal(queries[0].path, "projects/collab-55/queries");
  await a.forecastFor(db, "shop", "Indiranagar", T + 600);
  assert.equal(queries.length, 1, "kept for the day");
  await a.forecastFor(db, "shop", "Indiranagar", T + 86400);
  assert.equal(queries.length, 2, "a new day runs it again");
  // BigQuery refusing (no permission yet): no forecast, no error, and it's tried again after an hour, not every view.
  let tries = 0;
  const denied = analytics("collab-55", "collab_analytics", "s", async () => { tries++; throw new Error("Access Denied"); });
  const g = await denied.forecastFor(db, "shop", null, T);
  assert.equal(g.available, false); assert.equal(g.items.length, 0); assert.ok(g.reason);
  await denied.forecastFor(db, "shop", null, T + 60); assert.equal(tries, 1);
  await denied.forecastFor(db, "shop", null, T + 3700); assert.equal(tries, 2);
  assert.deepEqual(await denied.forecastFor(memoryDocs(), "nobody", null, T), { available: false, reason: "List something to see a forecast", items: [] });
});

test("GET /api/shop/insights carries forecast.available=false when BigQuery isn't set up, existing fields untouched", async () => {
  const PORT = 9100 + Math.floor(Math.random() * 100), B = `http://localhost:${PORT}`;
  const server = spawn(process.execPath, ["src/server.ts"], { cwd: new URL("..", import.meta.url).pathname, stdio: "pipe",
    env: { ...process.env, PORT: String(PORT), STORE: "memory", DEV_AUTH: "1", GEMINI_FAKE: "1", GEMINI_API_KEY: "", PUBLIC_URL: B, BQ_DATASET: "" } });
  try {
    for (let i = 0; ; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch { /* starting */ } if (i > 50) throw new Error("server didn't start"); await new Promise(r => setTimeout(r, 200)); }
    const as = async (path: string, body?: unknown) => (await fetch(B + path, { method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", authorization: "Bearer dev:bq-shop" }, body: body === undefined ? undefined : JSON.stringify(body) })).json();
    await as("/api/me", { handle: "bq-shop", name: "BQ Shop", areaName: "Indiranagar" });
    await as("/api/facts", { tier: "public", text: "Steel water bottles 500 ml for sale in Indiranagar, ₹400 each" });
    const i = await as("/api/shop/insights");
    assert.deepEqual(i.forecast, { available: false, reason: NOT_SET_UP, items: [] });
    for (const k of ["days", "missed", "unmet", "asked", "prices", "buyers", "together", "summary", "byModel"]) assert.ok(k in i, k);
  } finally { server.kill(); }
});
