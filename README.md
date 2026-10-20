# Collab

**Everyone’s agent for getting things done together.** Consumers, shops, independent workers and communities
represent their needs and offerings, share only the context they permit, and get things done through their agents.

Say what you need in your own words, tap one of the start suggestions, or scan a shop's QR code. Gemini shapes the
request (and asks what's missing, with tap-to-answer options). Your agent finds the people whose public offerings fit
— or goes straight to the shop you scanned — and talks to their agent over Google's **A2A (Agent2Agent) protocol**.
Their agent answers from what its owner chose to share, asks what it needs to know, and the two agents negotiate,
each inside its owner's private limit. Owners are asked only when it matters: a question only they can answer, a deal
to confirm.

After both confirm, the seller's agent issues a signed cart, the buyer pays (an **AP2 test payment — no money
moves**), stock or a time slot is committed from the seller's ledger, and the buyer gets a **pass** the seller scans to
hand over the item or honour the booking **once**. Anyone can check the deal record with Collab's published public key.

Beyond one deal: an owner's agent keeps a **resource ledger** (stock, time slots, atomic holds), takes **connectors**
(signed POS stock events, iCal and Google Calendar busy times), runs **goals** with budgets, plans and recurrence,
posts in **communities** (an office park, a block, a campus), screens applicants for **hiring**, and shows a shop its
**insights** and a BigQuery demand forecast.

Built for the **AI Builder Cup 2026 — Retail & Commerce**. Live: https://collab-55.web.app (installable).
Product direction: [Product vision](docs/PRODUCT-VISION.md) · [Technical PRD](docs/TECHNICAL-PRD.md) ·
[Current application state](docs/CURRENT-STATE.md) · [Web PRD](docs/PRD.md) · Engineering handoff:
[docs/HANDOFF.md](docs/HANDOFF.md) · Assessment and claim wording: [docs/HACKATHON-INNOVATION.md](docs/HACKATHON-INNOVATION.md) ·
Architecture diagrams: [docs/images](docs/images) · Tests on production: [18 Oct](docs/TEST-REPORT-2026-10-18-prod.md) ·
Negotiation load test: [docs/NEGOTIATION-LOAD-TEST-2026-10-18.md](docs/NEGOTIATION-LOAD-TEST-2026-10-18.md) ·
BigQuery: [docs/BIGQUERY.md](docs/BIGQUERY.md) · Benchmarks: [docs/bench](docs/bench) · Deck and demo:
[submission/final-2026-10-18](submission/final-2026-10-18) · [SUBMISSION.md](SUBMISSION.md)

**Provenance:** the reading, matching, answering and negotiation logic was ported to TypeScript from the authors'
native Collab app (Swift). This web app, its server, A2A agents, data and everything listed below were built for
this hackathon; see HANDOFF §2.

## Opening Collab

- **collab-55.web.app** in a browser opens the Collab site (`web/home.html`): what it is, a live agent-to-agent
  demo, the tech it runs on, and a QR to install it on a phone. **Try it now** / **Open Collab** go to sign-in
  (Google, or start as a guest), then into Collab; someone already signed in goes straight in.
- The **installed app**, a shop's or person's QR (`/?to=<handle>`), a notification link and a reload inside Collab
  skip the site. `/?landing` always shows it; `/?install` (the QR) scrolls to the install steps.
- The **start screen** offers eight ready requests (a haircut, a deep clean, a cake, an AC service, guitar lessons, a
  camera rental, a food walk, a logo). Each matches a demo seller and runs end to end with no manual step except the
  final confirm; a returning owner also gets ideas from their own history.
- Demo people around Bengaluru answer for themselves: their phones are simulated, and their agents hold limits so they
  negotiate on their own.

## Who sees what

| Level | Stored | Who can be told |
|---|---|---|
| **Private** (default) | In your account (Firestore) | Never handed to another agent. Your own agent answers other agents' questions from it by default — never a note marked "never use", a contact detail or a price limit — and lists every such answer under **Activity → What your agent shared**. |
| **Protected** | Firestore, with topics | Only people your rules name (a person, or anyone who contacts you), on those topics, at that level of detail, automatically or after you check. |
| **Public** | Firestore, with a Gemini embedding | Anyone's agent can find it and be told it. |

What is **not** claimed: Private is not hidden from Collab's server, and an accepted offer or a rounded budget band
can still say something about willingness to pay. The guarantee is that the other party's agent is never given the
note itself, and your limit is never said.

Questions you ask about your *own* notes can be answered on your device: **Gemma 4 E2B** runs in the browser on the
GPU (WebGPU, MediaPipe LLM Inference), and one device can answer for another over end-to-end encryption
(Settings → Privacy & AI: Gemini by default, Gemini only, my devices only, only this device).

## How Gemini is used — and checked

Gemini proposes; code checks; deterministic rules decide when the model is down or wrong. Models: `gemini-3.6-flash`
with `gemini-3.8-flash` and `gemini-3.5-flash-lite` as fallbacks; `gemini-embedding-001` for search.

- **Requests and offerings**: intent, category, fields, filters, a brief for providers (no money, no limit — only a
  band strictly above it), clarifying questions. Numbers must be the owner's; places must exist in the gazetteer.
  A seller can list from a **photo** (Gemini reads the item and its condition; the seller sets the price), publish
  first and improve after, and state **terms**, **rules** and **pricing** their agent applies.
- **Discovery**: Gemini embeddings + Firestore vector search, hard filters, Gemini ranking with reasons. When nobody on
  Collab fits, real places nearby from **Grounding with Google Maps**.
- **Answering**: only from allowed facts, with evidence quoted from them, no new numbers or contact details. Stock and
  slot questions are answered from the ledger, never guessed. An extra the request didn't ask for ("a beard trim
  too?") is declined for the buyer rather than sent to them.
- **Negotiating**: Gemini sees only numbers; code refuses moves past the limit, backwards, too fast, or text that
  would reveal the limit; an agent hands over to its owner only when its offers are used up. In a direct chat,
  naming a price ("I'll sell for ₹100") offers a deal the other owner confirms.
- **Fair-price check**: Gemini with **Google Search grounding**; every price must trace to a grounding source,
  otherwise "not enough evidence". Shown only to its owner, 5 per day.
- **Decisions have deadlines**: silence is never approval. An unconfirmed deal lapses; a question gets one reminder
  then a polite close. Waiting turns are re-run by Cloud Tasks and recovered by a minute scan if lost.
- **Privacy wall** on every message between agents: phone numbers, e-mails and links removed; other contacts' names
  replaced. **Model Armor** screens incoming messages for prompt injection and outgoing answers for sensitive data.

## After the deal

| Step | What happens | Verifiable by |
|---|---|---|
| Agreed | Both owners confirm; the deal's SHA-256 is registered once (write-once by the app, not an external ledger); stock or a slot is held | Recomputing the hash |
| Cart | The seller's agent signs a Cart Mandate for exactly the agreed item and amount | Ed25519 signature, public key at `/public/keys` |
| Pay | The buyer taps Pay (optionally Google Pay TEST). AP2 v0.2 shapes: the seller's agent authorises a 10-minute checkout (detached JWS over its RFC 8785 canonical JSON); the buyer's agent issues a Checkout Mandate and a Payment Mandate (SD-JWT) bound to the checkout hash, with an idempotency key, sent to the seller's agent over A2A. One tap wins; the same tap again returns the same payment. The hold is committed; out of stock refuses payment with nothing charged. **Test mode.** | EdDSA signatures, public key |
| Collect | The seller scans the pass and marks it collected — once, seller only, atomic. A booking pass can change time or cancel, freeing the slot | The pass shows the original collection time |
| Verify | `/verify.html#…` (no sign-in) or `node server/tools/verify-receipt.ts` checks the record offline | Anyone with the public key |

Signatures are issued by Collab's server on behalf of its agents (not by the people themselves), so they prove what
Collab recorded. A pass is a bearer link: it stops a second collection, not a copied pass being shown first — the
seller sees the buyer's name. Payment and fulfilment are separate: delivered, accepted or disputed is recorded after
the handover, and a seller's track record counts from signed receipts.

## Trust and fraud prevention

- **One-time pass**: redeemed once, atomically; a second scan is refused and shows when it was collected. Only the
  seller's own account can redeem it.
- **Receipts that refuse edits**: signed with Ed25519; change any field and the check fails.
- **Model Armor** on every message from other agents before any model reads it; outage policy is explicit.
- **No overselling**: per-buyer limits and atomic holds in the ledger; two buyers racing for the last unit can't both
  win. Signed POS events update stock once and are never rolled back by older events.
- **Seller record**: the public card counts sales, handovers and problems from signed receipts (no buyers or prices).
- **App Check** (reCAPTCHA Enterprise, enforced): Pay, Collect and price checks need a single-use token and are refused
  without one; other writes from a browser it can't verify draw on a tighter rate limit. Replay protection fails
  closed (`/health` shows it).
- **Demo payments** are tagged as such on the pass and next to Pay. No money moves.

## For shops and shoppers

Menu: **Activity · My card · About me · Privacy · Settings** (plus Communities and Receipts) — the same words whether
you run a shop, teach, or sell one phone. Each match has one main button (Book within your limit, else Negotiate).
**Get it again** (or **Book again**) repeats a paid deal in one tap at today's price; Activity filters by To do · Sold · Bought · Done. Speak instead of
typing (Indian English or Hindi). A shop's card shows stock and free slots and what can be done right there (buy,
book, ask to visit). Sellers get a **low-stock alert**, link an **iCal feed or Google Calendar** so busy times block
bookings, and connect a **POS** that posts signed stock events. **Shop insights** (seller only) show missed demand,
what buyers ask most, prices agreed, buyer groups, what's often bought together and a **next-7-days forecast** from
BigQuery — other people's data only as counts. A **daily agent** keeps a short summary of what you did in your
Private context. Every journey and its status: [docs/SCENARIOS-RETAIL.md](docs/SCENARIOS-RETAIL.md).

## Google Cloud

| | Used for |
|---|---|
| **Gemini** (Vertex AI) | Routing, drafting, clarifying, ranking, answering, judging, negotiating, photo reading; `gemini-embedding-001` |
| **Grounding with Google Search · Google Maps** | Fair-price evidence (every price traced to a source) · real nearby places when no one on Collab fits |
| **Model Armor** | Screens what other agents send for prompt injection / jailbreaks; checks answers for sensitive data before they're shared |
| **Gemma 4 E2B** (open model, in the browser) | Answers about the owner's own notes on the device: WebGPU through MediaPipe LLM Inference; nothing leaves the browser |
| **Cloud Run** | The server (asia-south1): one A2A agent per person (`/a2a/<handle>`), the API, the directory, the engine, the web app |
| **Firestore** | Profiles, facts (vector index), rules, resources and holds, connectors, goals, live conversations, inboxes, A2A tasks, receipts, passes, communities, chat history, audit |
| **Firebase** | Hosting (installable web app; `/api`, `/a2a`, `/public`, `/connectors` rewritten to Cloud Run), Auth (Google or guest), App Check (reCAPTCHA Enterprise; single-use tokens consumed on Pay, Collect and price checks), Cloud Messaging (push), Firestore offline cache |
| **Cloud Tasks · Cloud Scheduler** | Re-runs a conversation's waiting agent turn (OIDC-checked) · scheduled agents every 15 min, outbox recovery every minute, demo calendars refreshed |
| **BigQuery** | Commerce events (people only as keyed hashes) and `AI.FORECAST` (TimesFM) for next week's demand per category |
| **Cloud Storage** | Listing photos |
| **Google Calendar API** | Free/busy only, linked with the owner's own Google sign-in |
| **Google Pay (TEST environment)** | The Pay sheet with Google's test cards; its token is hashed into the AP2 Payment Mandate. No money moves. |
| **Vertex AI Gen AI evaluation** | Autorater in the benchmark for paraphrased or spelled-out leaks |
| **Secret Manager · Cloud Monitoring** | Agent and receipt keys · uptime check and alert (`monitoring.sh`) |

## A2A

Every person's agent is an A2A v1.0 agent (official `@a2a-js/sdk`): `GET /a2a/<handle>/.well-known/agent-card.json`,
JSON-RPC at `/a2a/<handle>`. Agent cards are **signed** (JWS over the JCS-canonical card, `jku` → `/public/keys`) and
advertise **streaming** (Cloud Run's URL first — Firebase Hosting buffers server-sent events), **push
notifications** (public https webhooks only) and versioned **capabilities** (`/public/capabilities`). One conversation
is one A2A task; each turn carries a text part (for any A2A client) and a `collab.turn/v1` data part (questions,
answers, offers, confirmations, payment mandates). Any outside A2A agent can talk to ours — without signing in it is a
stranger and gets Public facts only.

## Run it

```bash
cd server && npm install
npm run dev:offline            # no Google project needed: in-memory store, test accounts, offline stand-in for Gemini
open "http://localhost:8080/?as=alice"   # ?as=<name> picks a test account; two tabs = two people
npm run check                  # tsc --strict + all tests (284)
```

`npm run dev` is the same with real Gemini (`GEMINI_API_KEY` in `server/.env`, or `GOOGLE_CLOUD_PROJECT` for Vertex
AI). Local runs have no Firebase config, so sign-in is the dev stand-in and the Google button doesn't show.

## Benchmark

```bash
# against a local server with real Gemini and an in-memory store:
GOOGLE_CLOUD_PROJECT=<project> GOOGLE_CLOUD_LOCATION=global STORE=memory DEV_AUTH=1 SEED_DEMO=1 PORT=8797 node src/server.ts
BASE=http://localhost:8797 node tools/bench.ts --full [--load]     # results in docs/bench/
```

Privacy attacks (canary secrets, injection, encodings, Hinglish), negotiation pairs with hidden limits (including
infeasible ones that must walk away), labelled intents, step latency and a 50-conversation load run.

## Deploy

```bash
gcloud auth login && firebase login
./deploy.sh production         # reads deploy/production.env: service account, secrets, Cloud Run, Hosting,
                               # Firestore rules/indexes, Cloud Tasks queue, Scheduler jobs; stamps the build id
```

`main` is protected: every change is a branch and a pull request, and CI (`.github/workflows/ci.yml`, `npm run
check`) must pass. The deployed build shows on `/health` and `/version.txt`; the service worker reloads open tabs
into a new build.

## Layout

```
server/src/
  server.ts            Express app: App Check, every /api route, cron and task endpoints, static files
  a2a/agents.ts        A2A server per person, Firestore task store, A2A client for the requester's agent
  core/engage.ts       The conversation engine: each agent's turn, owners' inboxes, deals, offers in chats
  core/ap2.ts          AP2 v0.2 mandates · core/pay.ts carts and test payments · core/pickup.ts one-time passes
  core/signatures.ts   Ed25519 signing and verification · core/armor.ts Model Armor · core/wall.ts privacy wall
  core/policy.ts       Who may see which fact (deny by default) · core/memory.ts what the owner has said before
  core/directory.ts    Profiles, facts, search (embeddings + filters + Gemini ranking) · core/nearby.ts Maps grounding
  core/resources.ts    Stock and time slots: holds, commits, staleness · core/connectors.ts POS, iCal · core/gcal.ts
  core/goals.ts        Goals, budgets · core/plans.ts bounded plans · core/composed.ts recurrence and compensation
  core/decisions.ts    Deadlines and fallbacks · core/queue.ts Cloud Tasks · core/recovery.ts outbox scan
  core/rules.ts        Seller rules, lookups and pricing · core/pricing.ts quotes · core/terms.ts suggested terms
  core/direct.ts       Chats from a QR or link · core/storefront.ts a shop's card · core/suggest.ts what to ask
  core/communities.ts  Shared-place feeds · core/hiring.ts job posts and applicants · core/daily.ts the daily agent
  core/deals.ts        Receipts, insights, track record · core/shop-insights.ts · core/analytics.ts BigQuery
  core/price-check.ts  Grounded fair-price evidence · core/photos.ts photo listings · core/push.ts web push
  core/watch.ts        Scheduled agents · core/limits.ts cross-instance rate limits and leases
  config/policy.ts     Operational policy (quotas, models, deadlines), hash on /health
  market/*             Reading, matching, answering, judging, negotiating
  ai/                  Gemini (Vertex AI) with model fallback, grounding, metering; propose → check → fallback
  demo.ts              Demo people, their listings, calendars and limits
server/tools/          bench.ts, verify-receipt.ts, verify-watch.ts, secrets-check.ts, live-cases.ts
web/                   Installable web app: home.html (the site), index.html + js/app.js (chat, Activity, My card,
                       About me, Privacy, Communities, Settings), js/landing.js (who sees the site), js/gemma.js
                       (Gemma in the browser), js/e2e.js + js/mydevices.js (devices answering each other),
                       js/pass.js, js/gpay.js, sw.js; verify.html and pickup.html (no sign-in)
deploy/                Per-environment manifests · deploy.sh · monitoring.sh · Dockerfile
```
