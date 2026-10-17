# Collab

**Everyone’s agent for getting things done together.** Consumers, shops and service providers can represent their needs and offerings, share permitted context, and collaborate through their agents.

The current working demonstration covers discovery, two-party collaboration, agreement, simulated payment and one-time retail pickup. The broader product adds reliable resource commitments, connected services and multi-task goals.

Product direction: [Product vision](docs/PRODUCT-VISION.md) · [Technical PRD](docs/TECHNICAL-PRD.md) · [Current application state](docs/CURRENT-STATE.md).

Say what you need in your own words — or scan a shop's QR code. Gemini helps shape the request (and asks what's
missing, with tap-to-answer options). Your agent finds the people whose public offerings fit, or goes straight to the
shop you scanned, and talks to their agent over Google's **A2A (Agent2Agent) protocol**. Their agent answers from
what its owner chose to share, asks what it needs to know, and the two agents negotiate — each inside its owner's
private limit. Owners are asked only when it matters: a question only they can answer, a deal to confirm.

After both confirm, the seller's agent issues a signed cart, the buyer pays (an **AP2-inspired test payment — no money
moves**), and the buyer gets a **pickup pass** the seller scans to hand over the item **once**. Anyone can check the
deal record with Collab's published public key.

Built for the **AI Builder Cup 2026 — Retail & Commerce**. Live: https://collab-55.web.app (installable) ·
Product requirements: [docs/PRD.md](docs/PRD.md) · Engineering handoff: [docs/HANDOFF.md](docs/HANDOFF.md) ·
Assessment and claim wording: [docs/HACKATHON-INNOVATION.md](docs/HACKATHON-INNOVATION.md) · Benchmarks: [docs/bench](docs/bench) ·
Full review (coverage, tests, UI, market): [docs/REPORT-2026-10-15.md](docs/REPORT-2026-10-15.md) · Deck: [submission/](submission/)

**Provenance:** the reading, matching, answering and negotiation logic was ported to TypeScript from the authors'
native Collab app (Swift). This web app, its server, A2A agents, data and everything listed below were built for
this hackathon; see HANDOFF §2.

## Who sees what

| Level | Stored | Who can be told |
|---|---|---|
| **Private** (default) | In your account (Firestore) | Nobody else. The policy never gives it to an agent talking to someone; your device can draft an answer from it that you choose to share. |
| **Protected** | Firestore, with topics | Only people your rules name (a person, or anyone who contacts you), on those topics, at that level of detail, automatically or after you check. |
| **Public** | Firestore, with a Gemini embedding | Anyone's agent can find it and be told it. |

What is **not** claimed: Private is not hidden from Collab's server, and an accepted offer or a rounded budget band
can still say something about willingness to pay. The guarantee is that the other party's agent is never given it.

## How Gemini is used — and checked

Gemini proposes; code checks; deterministic rules decide when the model is down or wrong.

- **Requests and offerings**: intent, category, fields, filters, a brief for providers (no money, no limit — only a
  band strictly above it), clarifying questions. Numbers must be the owner's; places must exist in the gazetteer.
- **Discovery**: Gemini embeddings + Firestore vector search, hard filters, Gemini ranking with reasons.
- **Answering**: only from allowed facts, with evidence quoted from them, no new numbers or contact details.
- **Negotiating**: Gemini sees only numbers; code refuses moves past the limit, backwards, too fast, or text that
  would reveal the limit. In a direct chat, naming a price ("I'll sell for ₹100") offers a deal the other owner confirms.
- **Fair-price check**: Gemini with **Google Search grounding**; every price must trace to a grounding source,
  otherwise "not enough evidence". Shown only to its owner, 5 per day.
- **Privacy wall** on every message between agents: phone numbers, e-mails and links removed; other contacts' names replaced.

## After the deal

| Step | What happens | Verifiable by |
|---|---|---|
| Agreed | Both owners confirm; the deal's SHA-256 is registered once (write-once by the app, not an external ledger) | Recomputing the hash |
| Cart | The seller's agent signs a Cart Mandate for exactly the agreed item and amount | Ed25519 signature, public key at `/public/keys` |
| Pay | The buyer taps Pay (optionally Google Pay TEST). AP2 v0.2 shapes: the seller's agent authorises a 10-minute checkout (detached JWS over its RFC 8785 canonical JSON); the buyer's agent issues a Checkout Mandate and a Payment Mandate (SD-JWT) bound to the checkout hash, with an idempotency key, sent to the seller's agent over A2A. **Test mode.** | EdDSA signatures, public key |
| Collect | The seller scans the pickup pass and marks it collected — once, seller only, atomic | The pass shows the original collection time |
| Verify | `/verify.html#…` (no sign-in) or `node server/tools/verify-receipt.ts` checks the record offline | Anyone with the public key |

Signatures are issued by Collab's server on behalf of its agents (not by the people themselves), so they prove what
Collab recorded. A pickup pass is a bearer link: it stops a second collection, not a copied pass being shown first —
the seller sees the buyer's name.

## Trust and fraud prevention

- **One-time pass**: a pickup or booking pass is redeemed once, atomically; a second scan is refused and shows when it
  was collected. Only the seller's own account can redeem it.
- **Receipts that refuse edits**: signed with Ed25519; change any field and the check fails. On the receipt page,
  "Try changing the price" shows it.
- **Model Armor** screens every message from other agents for prompt injection before any model reads it.
- **No overselling**: per-buyer limits and atomic stock holds; two buyers racing for the last unit can't both win.
- **Seller record**: the public card counts sales, handovers and problems from signed receipts (no buyers or prices).
- **App Check** on every write; writes from a browser it can't verify are rate-limited.
- **Demo payments** are tagged as such on the pass and next to Pay. No money moves.

## For shops and shoppers

Menu: **Deals · My shop · About me · Privacy · Settings**. Each match has one main button (Book within your limit,
else Negotiate). **Buy again** repeats a paid deal in one tap; Deals filters by To do · Sold · Bought · Done. Speak
instead of typing (Indian English or Hindi). Sellers list from a **photo** (Gemini reads the item; the seller sets
the price), publish first and improve the listing after, see stock on the card and get a **low-stock alert**. A
booking pass can **change time** or **cancel**, freeing the slot. **Shop insights** (seller only) show missed demand, what
buyers ask most, prices agreed, buyer groups and what's often bought together — other people's data only as counts.
Every journey and its status: [docs/SCENARIOS-RETAIL.md](docs/SCENARIOS-RETAIL.md).

## Google Cloud

| | Used for |
|---|---|
| **Gemini** (Vertex AI) | Routing, drafting, clarifying, ranking, answering, judging, negotiating; `gemini-embedding-001` |
| **Grounding with Google Search · Google Maps** | Fair-price evidence (every price traced to a source) · real nearby shops when no one on Collab fits |
| **Model Armor** | Screens what other agents send for prompt injection / jailbreaks; checks answers for sensitive data before they're shared |
| **Firebase AI Logic** | Gemini Nano on the device (`only_on_device`) for answers from private notes in Chrome |
| **Cloud Run** | The server: one A2A agent per person (`/a2a/<handle>`), the API, the directory, the engine |
| **Firestore** | Profiles, facts (vector index), rules, live conversations, inboxes, A2A tasks, receipts, pickups, chat history, audit |
| **Firebase** | Hosting (installable web app), Auth (Google or guest), App Check (reCAPTCHA Enterprise; single-use tokens consumed on Pay, Collect and price checks), Cloud Messaging (push), Firestore offline cache |
| **Cloud Tasks** | Re-runs a conversation's waiting agent turn on the server (OIDC-checked) |
| **Google Pay (TEST environment)** | The Pay sheet with Google's test cards; its token is hashed into the AP2 Payment Mandate. No money moves. |
| **Vertex AI Gen AI evaluation** | Autorater in the benchmark for paraphrased or spelled-out leaks |
| **Cloud Scheduler** | Scheduled agents re-run watched requests every 15 minutes |
| **Secret Manager · Cloud Monitoring** | Agent and receipt keys · uptime check and alert |

## A2A

Every person's agent is an A2A v1.0 agent (official `@a2a-js/sdk`): `GET /a2a/<handle>/.well-known/agent-card.json`,
JSON-RPC at `/a2a/<handle>`. Agent cards are **signed** (JWS over the JCS-canonical card, `jku` → `/public/keys`) and
advertise **streaming** (Cloud Run's URL first — Firebase Hosting buffers server-sent events) and **push
notifications** (public https webhooks only). One conversation is one A2A task; each turn carries a text part (for any A2A client)
and a `collab.turn/v1` data part (questions, answers, offers, confirmations, payment mandates). Any outside A2A
agent can talk to ours — without signing in it is a stranger and gets Public facts only.

## Run it

```bash
cd server && npm install
npm run dev:offline            # no Google project needed: in-memory store, test accounts, offline stand-in for Gemini
open "http://localhost:8080/?as=alice"   # ?as=<name> picks a test account; two tabs = two people
npm run check                  # tsc --strict + all tests
```

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
APPCHECK=enforce ./deploy.sh   # service account, secrets, Cloud Run, Hosting, Firestore rules/indexes, Scheduler
```

## Layout

```
server/src/
  a2a/agents.ts        A2A server per person, Firestore task store, A2A client for the requester's agent
  core/engage.ts       The conversation engine: each agent's turn, owners' inboxes, deals, offers in chats
  core/pay.ts          AP2-inspired cart and payment mandates (test mode)
  core/pickup.ts       Pickup passes, one-time collection
  core/signatures.ts   Ed25519 signing and verification
  core/price-check.ts  Grounded fair-price evidence
  core/policy.ts       Who may see which fact (deny by default)
  core/directory.ts    Profiles, facts, search (embeddings + filters + Gemini ranking)
  core/watch.ts        Scheduled agents · core/push.ts web push · core/deals.ts receipts, insights, track record
  market/*             Reading, matching, answering, judging, negotiating
  ai/                  Gemini (Vertex AI) with model fallback, grounding, metering; propose-check-fallback
server/tools/          bench.ts, verify-receipt.ts, verify-watch.ts, secrets-check.ts, live-cases.ts
web/                   Installable web app: chat, Context, People (QR), Sharing, Requests, Activity, Settings;
                       verify.html and pickup.html (no sign-in)
```
