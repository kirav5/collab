# Collab

**Personal agents for neighbourhood commerce: scan a shop, agree within private limits, collect once.**

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
Assessment and claim wording: [docs/HACKATHON-INNOVATION.md](docs/HACKATHON-INNOVATION.md) · Benchmarks: [docs/bench](docs/bench)

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
| Pay | The buyer taps Pay; their agent signs a Payment Mandate for that cart and sends it to the seller's agent over A2A. **Test mode.** | Ed25519 signature |
| Collect | The seller scans the pickup pass and marks it collected — once, seller only, atomic | The pass shows the original collection time |
| Verify | `/verify.html#…` (no sign-in) or `node server/tools/verify-receipt.ts` checks the record offline | Anyone with the public key |

Signatures are issued by Collab's server on behalf of its agents (not by the people themselves), so they prove what
Collab recorded. A pickup pass is a bearer link: it stops a second collection, not a copied pass being shown first —
the seller sees the buyer's name.

## Google Cloud

| | Used for |
|---|---|
| **Gemini** (Vertex AI) | Routing, drafting, clarifying, ranking, answering, judging, negotiating, grounded price checks; `gemini-embedding-001` |
| **Cloud Run** | The server: one A2A agent per person (`/a2a/<handle>`), the API, the directory, the engine |
| **Firestore** | Profiles, facts (vector index), rules, live conversations, inboxes, A2A tasks, receipts, pickups, chat history, audit |
| **Firebase** | Hosting (installable web app), Auth (Google or guest), App Check (reCAPTCHA Enterprise), Cloud Messaging (push) |
| **Cloud Scheduler** | Scheduled agents re-run watched requests every 15 minutes |
| **Secret Manager · Cloud Monitoring** | Agent and receipt keys · uptime check and alert |

## A2A

Every person's agent is an A2A v1.0 agent (official `@a2a-js/sdk`): `GET /a2a/<handle>/.well-known/agent-card.json`,
JSON-RPC at `/a2a/<handle>`. One conversation is one A2A task; each turn carries a text part (for any A2A client)
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
server/tools/          bench.ts, verify-receipt.ts, secrets-check.ts, live-cases.ts
web/                   Installable web app: chat, Context, People (QR), Sharing, Requests, Activity, Settings;
                       verify.html and pickup.html (no sign-in)
```
