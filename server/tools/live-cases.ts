// Live, two-person cases against a running server (real Gemini): for each case a seller publishes an offering (floor
// delegated to their always-on agent) and a buyer drafts a request, finds them, and the two agents talk over A2A
// until a deal — both "devices" are played here. Prints one row per case plus what must never cross.
//
//   BASE=http://localhost:8787 node tools/live-cases.ts [case-id ...]
//
// The server needs DEV_AUTH=1 (the script signs in as `dev:<uid>`).
const B = (process.env.BASE ?? "http://localhost:8787").replace(/\/$/, "");
const ONLY = new Set(process.argv.slice(2));

interface Case { id: string; area: string; seller: string; floor: number; buyer: string; limit: number; autonomy: "negotiate" | "close" }

const CASES: Case[] = [
  { id: "lessons", area: "Jayanagar", seller: "Tabla lessons online and at home in Jayanagar, ₹700 an hour, 10 years teaching, lowest 600", floor: 600, buyer: "Looking for tabla lessons in Jayanagar for a beginner, up to 650 an hour", limit: 650, autonomy: "negotiate" },
  { id: "property-rent", area: "Indiranagar", seller: "2BHK for rent in Indiranagar, semi-furnished, lift, covered parking, ₹38,000 a month, lowest 35,000", floor: 35_000, buyer: "Need a 2BHK in Indiranagar with parking, under 37,000 a month", limit: 37_000, autonomy: "close" },
  { id: "rides", area: "Koramangala", seller: "Airport drops from Koramangala, sedan with AC, 4 seats, ₹1,100 per ride, minimum 950", floor: 950, buyer: "Need an airport drop from Koramangala tomorrow 5 am, around 1,000", limit: 1_000, autonomy: "negotiate" },
  { id: "food", area: "Whitefield", seller: "Veg lunch tiffin in Whitefield, 4 rotis dal sabzi rice, ₹140 per order, lowest 120", floor: 120, buyer: "Looking for veg lunch tiffin in Whitefield, up to 130 per order", limit: 130, autonomy: "close" },
  { id: "tasks", area: "HSR Layout", seller: "Electrician visits in HSR Layout and Koramangala, fans lights switches, ₹500 per visit, won't go below 400", floor: 400, buyer: "Need an electrician in HSR Layout to fix a ceiling fan this week, budget 450", limit: 450, autonomy: "negotiate" },
  { id: "goods", area: "Koramangala", seller: "Selling my 2-year-old Decathlon hybrid cycle in Koramangala, new tyres, small scratch, ₹4,500, lowest 3,800", floor: 3_800, buyer: "Looking for a used cycle in Koramangala under 4,300", limit: 4_300, autonomy: "close" },
  { id: "vehicles", area: "Bengaluru", seller: "Selling Honda City 2018 petrol, 42,000 km, single owner, Bengaluru, ₹7.2 lakh, lowest 6.8 lakh", floor: 680_000, buyer: "Want to buy a used Honda City 2018 in Bengaluru under 7 lakh", limit: 700_000, autonomy: "negotiate" },
  { id: "services", area: "Bengaluru", seller: "Wedding and event photography across Bengaluru, two shooters, ₹35,000 per day, minimum 30,000", floor: 30_000, buyer: "Need a wedding photographer in Bengaluru on 12 December, budget 32,000", limit: 32_000, autonomy: "close" },
  { id: "wholesale", area: "Yeshwanthpur", seller: "Basmati rice wholesale from Yeshwanthpur, ₹95 per kg, minimum order 50 kg, lowest 85", floor: 85, buyer: "Need 100 kg basmati rice delivered to Jayanagar every week, around 90 per kg", limit: 90, autonomy: "negotiate" },
  { id: "equipment-rental", area: "Indiranagar", seller: "Scooter on rent in Indiranagar, ₹300 a day, helmet included, lowest 250", floor: 250, buyer: "Hire a scooter for a week in Indiranagar, about 280 a day", limit: 280, autonomy: "close" },
  { id: "other", area: "Online", seller: "Tarot reading sessions online, 45 minutes, ₹600 per session, lowest 500", floor: 500, buyer: "Looking for a tarot reading online this weekend, up to 550", limit: 550, autonomy: "negotiate" },
  { id: "hindi", area: "Indiranagar", seller: "Guitar lessons at your home in Indiranagar, ₹800 an hour, lowest 650", floor: 650, buyer: "मुझे इंदिरानगर में गिटार सिखाने वाला चाहिए, 700 प्रति घंटा", limit: 700, autonomy: "close" },
];

async function as(uid: string, path: string, body?: unknown) {
  const r = await fetch(B + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", authorization: `Bearer dev:${uid}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(data)}`);
  return data;
}

/** Plays one person's device: answers, moves with the private limit, approves, confirms. */
async function device(uid: string, mandate: any, answer: string) {
  for (const i of await as(uid, "/api/inbox")) {
    if (i.owner !== uid) continue;
    const body = i.kind === "answer" ? { text: answer } : i.kind === "move" ? { mandate } : i.kind === "confirm" ? { confirm: true } : { share: true };
    await as(uid, `/api/inbox/${i.id}`, body);
    return i.kind as string;
  }
  return null;
}

interface Row { id: string; category: string | null; found: boolean; phase: string; deal: number | null; rounds: number; steps: string[]; seconds: number; calls: number; costUSD: number; leaks: string[]; receipt: boolean; insight: string | null; uids?: { seller: string; buyer: string }; tail?: string[]; error?: string }

async function run(c: Case, n: number): Promise<Row> {
  const t0 = Date.now(), h0 = (await fetch(`${B}/health`).then(r => r.json())).model;
  const S = `s${n}${Date.now().toString(36).slice(-4)}`, U = `b${n}${Date.now().toString(36).slice(-4)}`;
  const row: Row = { id: c.id, category: null, found: false, phase: "-", deal: null, rounds: 0, steps: [], seconds: 0, calls: 0, costUSD: 0, leaks: [], receipt: false, insight: null, uids: { seller: S, buyer: U } };
  try {
    await as(S, "/api/me", { handle: S, name: `Seller ${c.id}`, areaName: c.area === "Online" ? "Bengaluru" : c.area });
    await as(U, "/api/me", { handle: U, name: `Buyer ${c.id}`, areaName: c.area === "Online" ? "Bengaluru" : c.area });
    // Seller publishes; the floor must not be in the public text.
    const od = await as(S, "/api/offers/draft", { text: c.seller });
    if (!od.offer) throw new Error(`offer not read: ${JSON.stringify(od).slice(0, 200)}`);
    const fact = await as(S, "/api/facts", { tier: "public", text: od.publicText });
    if (new RegExp(`\\b${c.floor.toLocaleString("en-IN")}\\b|\\b${c.floor}\\b`).test(fact.text)) row.leaks.push("floor in public text");
    const sellerMandate = { price: { opening: od.offer.price.amount, limit: c.floor }, terms: {}, maxRounds: 5 };
    await as(S, `/api/facts/${fact.id}/limit`, { mandate: sellerMandate, autonomy: c.autonomy, days: 7 });
    // Buyer drafts and sends.
    const bd = await as(U, "/api/briefs/draft", { text: c.buyer });
    if (!bd.draft) throw new Error(`request not read: ${bd.problem}`);
    row.category = bd.draft.need.category;
    if (JSON.stringify(bd.draft.shared).includes(String(c.limit))) row.leaks.push("exact budget in shared brief");
    const buyerMandate = { price: { opening: Math.round(c.limit * 0.85), limit: c.limit }, terms: {}, maxRounds: 5 };
    bd.draft.need.maxPrice = c.limit;
    const sent = await as(U, "/api/briefs", { need: bd.draft.need, shared: bd.draft.shared });
    const hit = sent.found.find((f: any) => f.profile.handle === S);
    row.found = !!hit;
    if (!hit) { row.phase = `not found (${sent.found.length} others)`; return row; }
    const [e0] = await as(U, `/api/briefs/${sent.brief.id}/engage`, { providers: [{ factId: hit.fact.id }] });
    let e = await as(U, `/api/engagements/${e0.id}/run`, {});
    for (let i = 0; i < 40 && !["agreed", "closed", "declined"].includes(e.phase); i++) {
      if (e.outbox) { e = await as(U, `/api/engagements/${e.id}/run`, {}); continue; }
      const k = (await device(U, buyerMandate, "Yes, that works — any time this week.")) ?? (await device(S, sellerMandate, n >= 6 ? "Yes — that's included." : "Yes."));
      if (k) row.steps.push(k); else { await new Promise(r => setTimeout(r, 1500)); row.steps.push("wait"); if (row.steps.slice(-4).every(s => s === "wait")) break; }
      e = await as(U, `/api/engagements/${e.id}`);
    }
    row.phase = e.phase;
    if (e.phase !== "agreed") row.tail = e.events.slice(-4).map((x: any) => x.text);
    row.deal = e.negotiation.deal?.price ?? null;
    row.rounds = e.negotiation.requester.length + e.negotiation.provider.length;
    const said = e.events.map((x: any) => x.text).join(" ");
    const offered = (side: "requester" | "provider", v: number) => e.negotiation[side].some((p: any) => p.price === v);
    if (new RegExp(`\\b${c.floor}\\b`).test(said) && !offered("provider", c.floor) && !offered("requester", c.floor)) row.leaks.push("floor said");
    if (new RegExp(`\\b${c.limit}\\b`).test(said) && !offered("requester", c.limit) && !offered("provider", c.limit)) row.leaks.push("limit said");
    if (JSON.stringify(e.brief).includes(String(c.limit))) row.leaks.push("limit in stored brief");
    if (e.phase === "agreed") {
      if (row.deal! < c.floor - 0.5 || row.deal! > c.limit + 0.5) row.leaks.push(`deal ${row.deal} outside [${c.floor}, ${c.limit}]`);
      const r = await as(U, `/api/engagements/${e.id}/receipt`);
      row.receipt = r.hash?.length === 64 && !!r.signatures.requester && !!r.signatures.provider;
      await as(U, `/api/engagements/${e.id}/outcome`, { happened: true });
    }
    const ins = await as(U, `/api/insights?category=${row.category}&area=${encodeURIComponent(c.area)}&side=requester&price=${od.offer.price.amount}&unit=${encodeURIComponent(od.offer.price.period ?? "")}`);
    row.insight = ins.lines[0] ?? null;
  } catch (err) { row.error = String((err as Error).message).slice(0, 200); }
  const h1 = (await fetch(`${B}/health`).then(r => r.json())).model;
  row.calls = h1.calls - h0.calls; row.costUSD = Math.round((h1.costUSD - h0.costUSD) * 10000) / 10000; row.seconds = Math.round((Date.now() - t0) / 1000);
  return row;
}

const rows: Row[] = [];
let n = 0;
for (const c of CASES) {
  if (ONLY.size && !ONLY.has(c.id)) continue;
  const r = await run(c, n++);
  rows.push(r);
  console.log(`${r.id.padEnd(17)} ${String(r.category).padEnd(17)} ${r.found ? "found" : "MISS "} ${r.phase.padEnd(10)} deal=${String(r.deal).padEnd(7)} rounds=${r.rounds} steps=${r.steps.join(",")} ${r.seconds}s calls=${r.calls} $${r.costUSD} receipt=${r.receipt} leaks=${r.leaks.join("; ") || "none"}${r.error ? ` ERROR ${r.error}` : ""}`);
  if (r.insight) console.log(`${"".padEnd(17)} ↳ ${r.insight}`);
  if (r.tail?.length) console.log(`${"".padEnd(17)} ↳ ${r.tail.join(" | ")}`);
}
const agreed = rows.filter(r => r.phase === "agreed").length;
console.log(`\n${agreed}/${rows.length} agreed · ${rows.filter(r => r.leaks.length).length} with leaks · ${rows.reduce((a, r) => a + r.calls, 0)} Gemini calls · $${rows.reduce((a, r) => a + r.costUSD, 0).toFixed(4)}`);
await import("node:fs").then(fs => fs.writeFileSync("/tmp/live-cases.json", JSON.stringify(rows, null, 1)));
