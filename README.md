# Collab

**Your agent asks anyone's agent for anything — and your private context never leaves your device.**

Say what you need in your own words: a flat, a tabla teacher, an airport ride, someone to fix a fan. Gemini helps you
shape it into a request (and asks what's missing, with tap-to-answer options). Your agent searches the public directory
by meaning, then talks to the agents of the people who fit — over Google's **A2A (Agent2Agent) protocol**. Their agents
answer from what their owners chose to share, ask what they need to know, and negotiate inside each owner's private
limit. Each owner is asked only when it matters: a question their agent can't answer, a deal to confirm.

Built for the **AI Builder Cup 2026 — Retail & Commerce** theme. Live: https://collab-55.web.app ·
Product requirements: [docs/PRD.md](docs/PRD.md) · Engineering handoff (state, decisions, known issues, next tasks):
[docs/HANDOFF.md](docs/HANDOFF.md)

## Who sees what

| Level | Where it lives | Who can be told |
|---|---|---|
| **Private** (default) | Only on your device (the browser's IndexedDB) | Nobody. Your device agent may draft an answer from it — you choose whether to share. |
| **Protected** | Firestore, with topics | Only people your rules name (a person, or anyone who contacts you), on those topics, at that level of detail, automatically or after you check. |
| **Public** | Firestore, with a Gemini embedding | Anyone's agent can find it (directory) and be told it. |

Each person has two halves of one agent:

- **The always-on agent** (Cloud Run, an A2A server per person) holds only Protected and Public facts. It cannot leak
  private context because it never has it: a deterministic policy (deny by default) decides which facts a given asker
  may see, and only those are given to Gemini.
- **The device agent** (the web app) holds everything. It answers your own questions from your notes, makes negotiating
  moves with your private limit (sent for that one move, never stored), and drafts answers from private notes that you
  approve before anything is shared. In Chrome with built-in AI it uses **Gemini Nano on the device**.

## How Gemini is used — and checked

Gemini proposes; code checks; deterministic rules decide when the model is down or wrong:

- **Requests and offerings**: category, fields, the request's own filters, a brief for providers, clarifying questions.
  Every number must be written by the owner; a place must exist in the gazetteer; the brief carries **no money and no
  limit** (only a rounded band strictly above it).
- **Discovery**: Gemini embeddings + Firestore vector search, hard filters (area, budget, must-haves), Gemini ranking
  with reasons.
- **Answering**: only from allowed facts, with evidence quoted from them, no new numbers, no contact details; cut to the
  rule's level of detail.
- **Requirement gathering**: the provider's agent asks what it needs before quoting.
- **Negotiating**: Gemini sees only numbers (its own limit and both sides' offers) — nothing the other side wrote. Code
  refuses moves past the limit, backwards, too fast, or messages that would reveal the limit.
- **Privacy wall** on every message between agents: phone numbers, e-mails and links removed; the owner's other people
  become "a contact".

## Google Cloud

| | Used for |
|---|---|
| **Gemini** (Vertex AI) | Reading, briefs, clarifying, ranking, answering, judging, negotiating; `gemini-embedding-001` for the directory; Gemini Nano on device when available |
| **Cloud Run** | The server: one A2A agent per person (`/a2a/<handle>`), the API, the directory |
| **Firestore** | Profiles, Protected/Public facts (vector index), rules, engagements (live to both sides), device inboxes, A2A tasks, audit log |
| **Firebase** | Hosting (the web app, rewrites to Cloud Run), Authentication (anonymous or Google) |

## A2A

Every person's agent is an A2A v1.0 agent (official `@a2a-js/sdk`): `GET /a2a/<handle>/.well-known/agent-card.json`, JSON-RPC
at `/a2a/<handle>`. One engagement is one A2A task; each turn is a message with a text part (for any A2A client) and a
`collab.turn/v1` data part. Our users' agents talk to each other over real A2A calls; any outside A2A agent can talk to
ours — without signing in it is a stranger and gets Public facts only.

## Run it

```bash
cd server && npm install
npm run dev:offline            # no Google project needed: in-memory store, test accounts, offline stand-in for Gemini
open "http://localhost:8080/?as=alice"   # ?as=<name> picks a test account; two tabs = two people
```

With a Gemini key (`server/.env`: `GEMINI_API_KEY=…`) use `npm run dev`. Tests: `npm test` (policy, privacy wall,
negotiation guards, grounding, and end-to-end runs of two people's agents over A2A against the real server).

## Deploy

```bash
gcloud auth login && firebase login
./deploy.sh        # Cloud Run (Cloud Build), Firebase Hosting, Firestore rules and vector index
```

## Layout

```
server/src/
  a2a/agents.ts        A2A server per person (AgentExecutor), Firestore task store, A2A client for the requester
  core/engage.ts       One engagement: each agent's turn, owners' devices, privacy wall
  core/policy.ts       Who may see which fact (deny by default)
  core/directory.ts    Profiles, shared facts, search (embeddings + filters + Gemini ranking)
  core/briefs.ts       Request → brief (no money, no limit) + clarifying questions
  core/tasks.ts        Routing, topics, brief, clarifying, requirement gathering
  market/*             Reading, matching, answering, judging, negotiating (ported from Collab's Swift)
  ai/                  Gemini (Vertex AI / AI Studio) with model fallback, the propose-check-fallback pattern
web/js/
  agent.js             The device agent (private notes, private limits, Gemini Nano)
  cards.js             Dynamic cards: request, matches, live engagement, needs-you
  app.js, screens.js   Collab's layout: chat, Context, People, Sharing, Requests, Activity, Settings
```
