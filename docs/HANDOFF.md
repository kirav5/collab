# Collab (web) — handoff · 13 October 2026

Read [PRD.md](PRD.md) first for what and why. This file is what exists, how it works, how to run/test/deploy it, what
is known to be wrong, and what to do next.

Repo: `git@github.com:kirav5/collab.git` (branch `main`). CI is `.github/workflows/ci.yml` (`npm run check`).

---

## 1. State at a glance

| | |
|---|---|
| Live web app | https://collab-55.web.app (Firebase Hosting → Cloud Run rewrites for `/api/**`, `/a2a/**`, `/health`) |
| Cloud Run | service `collab-market`, region `asia-south1`, revision `collab-market-00005-sfj`, max 2 instances, request-based billing, 1 GiB, timeout 60 s · https://collab-market-mj7d6nwxxq-el.a.run.app |
| GCP project | `collab-55` (number 611701997508), free trial ₹28,797 until 12 Jan 2027 |
| Service account | `collab-market@collab-55.iam.gserviceaccount.com` — `aiplatform.user`, `datastore.user`, `firebaseauth.viewer`, secret accessor on `agent-secret` |
| Firestore | `(default)`, Native, `asia-south1`; vector index on `facts(tier, embedding[768])`; TTL on `rate.expireAt`, `leases.expireAt` |
| Firebase | web app `1:611701997508:web:149a27edf4e20d9dbd6e91`; Auth: Anonymous + Google enabled; App Check: reCAPTCHA Enterprise key `6LcWVO0tAAAAAGE87CLYa8anCDcS9mnidBl2geJN` (domains: collab-55.web.app, collab-55.firebaseapp.com, localhost) — **enforced** on `/api` |
| Secret | Secret Manager `agent-secret` (HMAC key our agents sign A2A calls with); local copy `.deploy/agent-secret` (git-ignored) |
| Monitoring | uptime check "collab health" (`/health`, 5 min) → alert policy "Collab is down" → e-mail atishay.srivastava.10@gmail.com |
| Model | Vertex AI `global`: `gemini-3.6-flash,gemini-3.8-flash,gemini-3.5-flash-lite` (low thinking); embeddings `gemini-embedding-001` in `asia-south1` |
| Tests | 30/30 pass (`npm run check` = `tsc --strict` + `node --test`) |
| Size | ~5.7k lines: server ~3.3k TS, web ~1.2k JS/CSS |

## 2. What was done (chronologically)

1. **Assessed eligibility** of the native Collab app for AI Builder Cup 2026 (Hack2skill × Google Cloud): needs Google
   Cloud (Cloud Run/Firebase), Gemini/Gemma, a deployed link, a public repo, a deck (their template), a < 3 min video.
   Theme chosen: Retail & Commerce. No hackathon credits found; using the GCP free trial.
2. **First cut (market only)**: ported Collab's Cloudflare index + Swift market logic to TypeScript on Cloud Run +
   Firestore with Gemini. **Replaced** after the user's direction: separate app, no Collab/AT Protocol data, three
   tiers, any kind of request, A2A between agents, Collab's UI, private data local.
3. **Rebuild** (current):
   - Ported from Collab Swift: listing reader (`ClassifyTask`, `ListingFieldsTask`, `DemandFiltersTask`), matcher,
     `AnswerTask`, `JudgeTask`, negotiation (`Negotiator`, `MoveGuard`, `NegotiateTask`), domains/gazetteer/geohash,
     the policy engine idea (grants → rules), the privacy wall, engagements.
   - New: per-person A2A agents (official `@a2a-js/sdk` v1.3, protocol 1.0), Firestore task store, the engagement turn
     engine, device inbox, briefs (no money), clarifying questions, requirement gathering, directory with embeddings
     and Firestore vector search, demo people, web app copying Collab's look and layout with dynamic cards.
4. **Verified** (see §8) with an offline stand-in model, then on real Vertex Gemini + Firestore locally, then live.
5. **Privacy bugs found by tests and fixed**: a written floor ("lowest 600") would have been published → removed
   deterministically from the public text; a round limit (₹650) produced a band equal to the limit → band is now
   strictly above the limit.
6. **Performance**: 3.8 Flash had 2–14 s variance → 3.6 Flash first (~1.2 s); embeddings moved from `global`
   (12 s cold) to `asia-south1` (0.4–1 s); profile reads parallelised.
7. **Production hardening**: Firestore token-bucket rate limits and leases (cross-instance); atomic inbox claim;
   strict TypeScript + CI; Secret Manager; structured logs + Error Reporting; uptime alert; App Check (enforced) and
   A2A per-IP / new-conversation limits.
8. **Cost**: token metering, a cheap model tier, cached listing answers and settled moves that skip the model — §7.
9. **Market data + marketplace practices** (after a landscape review of Facebook Marketplace AI, OLX, Faktorist,
   Arcoa/Chowdr/Haggle, Google AP2): anonymised deal records → "what similar deals closed at" for both sides (no
   model call); mandates with an autonomy level (negotiate / negotiate-and-close) and expiry; signed deal receipts;
   outcomes → a public track record; AP2 roles declared on the agent card. Meter prices corrected to the published
   Gemini rates.

## 3. Architecture

```
Browser (device agent)                     Cloud Run: collab-market (Node 24, Express 5)            Firestore
  IndexedDB: private facts, chats,   /api   ├─ API (auth: Firebase ID token + App Check)            profiles, handles, facts(+vector)
  private limits                     ─────▶ ├─ directory: embeddings + vector search + ranking  ──▶ rules, contacts, briefs
  Gemini Nano (if Chrome has it)            ├─ engagement engine (core/engage.ts)                    engagements (live), inbox
  Firebase Auth / App Check / FS            ├─ A2A per person /a2a/<handle> (SDK)  ◀── other agents  a2a_tasks, limits, audit
  listeners (engagements, inbox)            └─ Gemini (Vertex AI) via ai/gemini.ts                   rate, leases (TTL), meta
```

Requester's agent → provider's agent is a **real A2A HTTP call** (the server calls `PUBLIC_URL/a2a/<handle>` with an
HMAC agent token). When the provider's owner resolves something on their device, the provider's turn is written into
the A2A task (`deliverProviderTurn`) and the requester's agent reads it with `GetTask` and continues.

## 4. Code map

```
server/src/
  server.ts            Express app: middleware (request logs, App Check), all /api routes, static files, error handler
  a2a/agents.ts        Agent cards; FirestoreTaskStore; provider AgentExecutor (providerTurn under a lease);
                       per-handle DefaultRequestHandler; A2A client side: sendTurn/runTurns (lease, outbox, 35 s
                       budget), onProviderTask, deliverProviderTurn; caller auth (HMAC agent token / Firebase / stranger)
  core/engage.ts       THE ENGINE. Turn type; providerTurn / requesterTurn; answerOpen (policy → AnswerTask → shape →
                       wall → audit, else inbox); GatherTask once; judge; moveOrAsk/move (NegotiateTask); confirm/settle;
                       resolve() for device inbox items; fresh() builds an engagement
  core/deals.ts        Deal records (anonymised, written once on "agreed"), insights() medians per category/area,
                       forRequester/forProvider lines, receipt() (sha256 + per-owner HMAC), stats() track record
  core/policy.ts       allowedFor(owner, asker): Public + Protected via active rules (deny by default); shapeAnswer
  core/directory.ts    saveProfile/handles, saveFact (topics, offer reading, embedding), search()
  core/briefs.ts       draft() (read + SharedBriefTask + ClarifyTask), share(), saveBrief() (band only, no raw text)
  core/tasks.ts        RouteTask, TopicsTask, SharedBriefTask (no money/limit), GatherTask, ClarifyTask
  core/limits.ts       take() token bucket and withLease() — Firestore transactions
  core/wall.ts         clean(): strip e-mail/phone/links, replace other contacts' names
  core/model.ts        All server-side types (Profile, Fact, Rule, Brief, Engagement, InboxItem, …)
  market/read.ts       Classify → fields ∥ filters → draft (offer/need); sameQuestion() de-dupe
  market/match.ts      check(), modeServes, rank(), RankTask, budgetUpper/budgetBand (strictly above limit)
  market/negotiate.ts  Negotiator, guards (limits, pacing, no backtracking, leak detection), NegotiateTask (₹ only)
  market/answer.ts     offerFacts, AnswerTask (evidence-quoted, no new numbers/contacts), JudgeTask
  market/{domains,places,geo,text,types}.ts + data/{domains.json, places.tsv (GeoNames CC BY)}
  ai/gemini.ts         Vertex/AI-Studio client, model fallback + resting, thinking level, embeddings (regional), stats
  ai/meter.ts          per-call token/latency/cost metering (GEMINI_PRICES)
  ai/decide.ts         propose → parse → validate → fallback
  ai/fake.ts           GEMINI_FAKE=1 offline stand-in (keyword answers, word-hash embeddings) — tests/dev only
  docs.ts              Docs interface: memoryDocs() and firestoreDocs() (vector fields encoded as Firestore vectors)
  demo.ts              7 demo people (riya, kabir, arjun, meera, dev, sana, fluent=hostile text); seeded once (meta/demo)
  log.ts               JSON logs (severity), Error Reporting shape
server/test/           core.test.ts (policy, wall, brief), market.test.ts (guards, grounding, matching),
                       cost.test.ts (meter, tiers, settled moves, answer cache, fact reuse),
                       deals.test.ts (insights thresholds, deal record has no uid/name/limit, receipt hash stable,
                       expired mandate, close mandate confirms), e2e.test.ts (spawns the server: two people over A2A,
                       outside stranger agent, hostile listing, AP2 card + receipt + insights + outcome)
web/
  index.html, styles.css   Collab theme (near-black, hairlines, mono labels, square controls, #2D5BFF, periwinkle = on device)
  js/app.js            Boot (sign-in → setup → layout), sidebar, chat sessions, paint loop (diff-skips), card actions,
                       tier changes, inbox actions, requester driving (/run while outbox)
  js/cards.js          Dynamic cards: brief (clarify chips, filters, private limit), matches, offer, saved fact,
                       sources, live engagement (Q&A, sources, verdicts, offers chart, timeline, needs-you blocks)
  js/screens.js        Context, People, Sharing, Requests, Activity, Settings
  js/agent.js          Device agent: chat routing, think() (Nano or /api/think), auto moves with local limits,
                       private-note drafts for answer items
  js/live.js           Engagements/inbox state, Firestore listeners or polling, notifications, poke()
  js/local.js          IndexedDB (per-uid keys), relevant() note retrieval
  js/api.js            Firebase Auth (anonymous, Google link), App Check token, Firestore listeners, api()
deploy.sh              SA + IAM (retried), Secret Manager, TTL, Cloud Run deploy (--source), Firebase deploy
monitoring.sh          One-time uptime check + alert (ALERT_EMAIL=…)
firebase.json, firestore.rules, firestore.indexes.json, Dockerfile, .github/workflows/ci.yml
```

## 5. Data (Firestore collections)

| Collection | Doc | Who reads |
|---|---|---|
| `profiles/{uid}` | handle, name, bio, area, demo?, paused? | server |
| `handles/{handle}` | uid | server |
| `facts/{id}` | owner, text, tier (protected/public), topics, offer?, embedding? (public) | server |
| `rules/{id}` | owner, audience (uid/"anyone"), topics, shape, approval, expires, revoked? | server |
| `contacts/{owner}_{uid}` | | server |
| `briefs/{id}` | owner, shared brief, banded need (no raw text, no exact limit) | server |
| `engagements/{id}` | both parties, brief, offer, phase, waiting{requester,provider}, qa, negotiation, events, outbox | **participants (rules)** |
| `inbox/{id}` | owner, engagementId, side, kind, question/draft, status open/working/done | **owner (rules)** |
| `limits/{fact:<id> \| brief:<id>}` | delegated mandates only, with `autonomy` (negotiate/close) and `expires` | server |
| `deals/{deal-<engagementId>}` | anonymised agreed deal: category, area, unit, list/deal price, discount %, rounds, hours, questions, demo? — no uid, name or limit | server |
| `a2a_tasks/{taskId}` | caller, task JSON | server |
| `audit/{id}` | what the cloud agent shared, to whom, tier | server |
| `answers/{factId:question}` | answers a provider's agent gave from an offering, reused for the same question | server |
| `rate/*`, `leases/*` | TTL `expireAt` | server |
| `meta/demo` | `{version:"demo-v2"}` — bump `SEEDED` in demo.ts to re-seed (v2 adds 18 labelled demo deals) | server |

Private facts and non-delegated limits exist **only** in the browser (IndexedDB `collab` → stores `facts`, `sessions`,
`limits`, keyed `<uid>:<id>`).

## 6. Run · test · deploy

```bash
cd server && npm install
npm run dev:offline                         # memory store, test accounts, offline model → http://localhost:8080/?as=alice
npm run dev                                 # memory store, real Gemini via server/.env GEMINI_API_KEY (AI Studio)
# real Vertex + real Firestore locally (needs `gcloud auth application-default login`):
GEMINI_API_KEY= GOOGLE_CLOUD_PROJECT=collab-55 GOOGLE_CLOUD_LOCATION=global DEV_AUTH=1 SEED_DEMO=1 PORT=8787 node src/server.ts
npm run check                               # tsc --strict + all tests (~10 s)
cd .. && APPCHECK=enforce ./deploy.sh       # from the collab-market folder; ~4–6 min
```

- `?as=<name>` picks a local test account (DEV_AUTH only) — two tabs = two people.
- Env: `STORE=memory`, `DEV_AUTH=1` (**never in production**), `SEED_DEMO=1`, `GEMINI_FAKE=1`, `GEMINI_MODELS`,
  `GEMINI_MODELS_CHEAP` (gemini-3.5-flash-lite), `GEMINI_THINKING` (low), `GEMINI_THINKING_CHEAP` (minimal),
  `GEMINI_PRICES` (`<substring>=<in>/<out>` per million tokens), `GEMINI_EMBEDDING_LOCATION` (asia-south1), `PUBLIC_URL`, `AGENT_SECRET`,
  `FIREBASE_WEB_CONFIG`, `RECAPTCHA_SITE_KEY`, `APPCHECK` (off/monitor/enforce), `DEBUG_TASKS=1` (prints raw model output).
- `server/.env` holds an AI Studio key (git-ignored). Its free tier was exhausted during testing; Vertex is used live.

## 7. Key decisions (and why)

- **Separate product, own data** (user's call): no AT Protocol / Nostr ingestion; the directory is this app's Public facts.
- **Public + World merged** into Public (user's call).
- **Private stays on device** (user's call); the cloud agent therefore only holds shareable data — this is what makes
  leaks structurally impossible from the cloud side.
- **A2A with the official SDK**, multi-tenant via one `DefaultRequestHandler` per handle; agent card served in wire
  JSON (`AgentCard.toJSON`) because `agentCardHandler` stringifies what the provider returns.
- **Turns are bounded requests** (Hosting rewrites cut at 60 s): `runTurns` stops at 35 s and leaves the next turn in
  `engagement.outbox`; the device calls `/api/engagements/:id/run` while an outbox exists.
- **Demo people's devices are simulated**: their inbox items are shown to the requester talking to them (labelled).
- **Gemini 3.6 Flash first** for latency; 3.8 as fallback. `gemini-flash-latest` does not exist on Vertex.
- **Budget band strictly above the limit**, coarse (₹1,000 → "up to ₹1,500"); business categories send no band.
- **Gemini cost controls**: token/cost meter per task and model on `/health` (`model.tokens`, `model.costUSD`,
  `model.byTask`) and one `gemini` log line per call; cheap tasks (classify, judge, rank, route, topics, shared
  brief) on the lite model with minimal thinking, flash as fallback; accept/escalate negotiation moves are
  arithmetic and skip the model; listing answers cached per (offering, question) in `answers`, served only while
  the offering is Public and the owner isn't paused, cleared on edit/tier change/delete; re-drafts after a
  clarifying answer pass the category and skip classification; re-saving an unchanged Public fact skips the
  reader and the embedding. Default meter prices follow ai.google.dev/gemini-api/docs/pricing (Flash-Lite 3.5
  $0.30/$2.50, Flash 3.6/3.8 $0.75/$3.75 promo to end-2026); `minimal` thinking errors on 3.8 Flash and is retried
  without it per model.
- **No free server-side model**: Gemma on the Gemini API is evaluation-only (free-tier limits, no paid tier); self-hosted
  Gemma on Cloud Run GPU only beats the token API at steady high volume. The structural saving is device-side
  (Gemini Nano / Gemma in the browser, PRD R1), which is also the privacy story.
- **Market insights are deterministic** (`core/deals.ts`): medians/quartiles over ≥3 anonymised deals, area scope
  when ≥3 in the area, else category; shown while drafting a request (next to the private limit, re-fetched when
  it changes), while drafting an offering (vs. the asking price), on "no deal inside your limit" items (`hint`),
  and on the agreed card. Zero Gemini calls. Demo deals are labelled "(from demo deals)" until real ones exist.
- **Mandate autonomy** (Faktorist-style): `negotiate` = agent moves inside the limit, owner confirms (default);
  `close` = the delegation is the owner's confirmation given in advance — `afterAnswers` confirms when the deal is
  `acceptable()` under the mandate and records `confirmedBy[side]="mandate"`. Mandates expire (1/7/30 days;
  `limitFor` ignores expired ones).
- **Deal receipt**: sha256 over `{engagementId, taskId, terms, parties, at}` + per-owner HMAC (`signReceipt`, same
  secret as agent tokens); computed on request (`GET /api/engagements/:id/receipt`), nothing extra stored. Carries
  handles and the agreed price only — never a limit.
- **Track record**: each side can mark an agreed deal "went ahead" / "fell through"; `stats()` counts what the
  *other* side said; shown on matches and public profiles.
- **AP2**: the agent card declares the AP2 extension (roles merchant/shopper, `required:false`) — no payment flow yet.

## 8. Verification evidence

- Offline model, browser: Alice's flat request → clarify → match → A2A → owner answer → automatic device moves →
  deal ₹34,600 → both confirm. Bob (offering with "lowest 600" → published without it) ↔ Amy: notification on Bob's
  side, both devices negotiated with local limits → ₹626/hour, both confirmed.
- Real Vertex + Firestore (local): flat with Kabir — brief with no money, 2 clarifying questions, vector search +
  reasons, Kabir's Protected maintenance under a **review** rule → approval → negotiation ₹38,000 → ₹36,000, agreed;
  19 calls, 0 failures. Guitar with Riya — Protected availability shared under an **auto** rule, requirement gathering,
  deal ₹700. Ride with Arjun — ₹1,000. Gemini avg ~1.7 s/call.
- Live: outside A2A client (no sign-in) → Riya's agent answered price (Public) and availability (Protected, rule
  "anyone"), sent "home address" to her device, asked two requirement questions; 7.5 s. App Check enforce: `/api`
  without token → 401; web app works; `/a2a` stays open.

## 9. Known issues / rough edges

1. **Offers chart**: when one side has many points and the other one, the x-axis scale makes the lone side look wrong
   (seen on the user's "english teacher" engagement). `web/js/cards.js → offersChart`: scale x by round per side.
2. **JudgeTask** sometimes says "unclear" for information-only questions ("How many years…" → "8 years").
   `market/answer.ts → JudgeTask` instructions; consider the asker's expectation (Collab's ExpectationTask).
3. **Demo rules use audience "anyone"**, so unsigned outside agents see Riya's availability and can trigger Kabir's
   review. Intentional for the demo; decide before launch.
4. **Outside-agent plain text**: questions are split on "?"; a request without questions gets only requirement
   gathering. A provider with several offerings uses the first one (`a2a/agents.ts executorFor`).
5. **Gemini Nano path untested** in a real Chrome with built-in AI. `/api/think` path is tested.
6. **"Share this" (private-note draft) UI path** not clicked end-to-end; `relevant()` is keyword-based.
7. **First vector/embedding call after a cold start** can take several seconds.
8. **Agent turns run inside requests** (bounded, with outbox) — move to Cloud Tasks (PRD R7).
9. **Firestore reads per question**: `allowedFor` loads up to 500 facts of the owner; `inboxFor` scans the user's
   engagements for demo items (N+1); `search()` runs `stats()` per found provider (N+1). Fine for a pilot.
13. **Receipt signatures** are HMACs with the server secret, so they prove "Collab recorded this", not independent
    owner keys; `deals.ts` ↔ `engage.ts` is an ESM import cycle (safe: all uses are inside functions).
14. `GET /api/insights` has no spend charge (no model call) but is unthrottled beyond App Check.
10. Local IndexedDB is unencrypted; a browser = a device (no sync of Private data).
11. The deployed site's old tabs (pre-App-Check JS) get 401s until reloaded.
12. `firebase deploy` used to prompt about TTL field overrides; now declared in `firestore.indexes.json`.

## 10. Next tasks (in order)

1. **Deploy** (`APPCHECK=enforce ./deploy.sh`) — the demo re-seeds (`demo-v2`); check `/health → model.byModel`
   shows Flash-Lite answering the cheap tasks, and that `/api/insights?category=lessons` returns demo lines.
2. **Hackathon deliverables** (deadline 18 Oct): deck on the organisers' template (dashboard), < 3 min video (script:
   setup → request with Gemini questions → matches → live A2A card → needs-you → automatic negotiation → deal; the
   provider's side in a second browser; the hostile listing; the agent card URL), submission text from
   `SUBMISSION.md`, deployed link, repo link. Confirm the team (2–4 members) is registered.
3. **PRD R1 local-first Gemma** (MediaPipe LLM Inference web, WebGPU): port the device-side tasks (route, ask notes,
   draft brief, private drafts) to run in the browser with the same validators (move pure modules from `server/src/market`
   + `core/tasks.ts` into a shared package bundled for the web); PWA service worker + send queue; setting
   "private model: on device only".
4. **R2 FCM web push** for inbox items and new requests (service worker; tokens per uid in Firestore; send from the
   server on `ask()` and new engagements).
5. **R3 exact location after a deal**; fix issues 1–2; R7 Cloud Tasks; R8 delete/export.
