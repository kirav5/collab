# Collab (web) — handoff · 14 October 2026

Read [PRD.md](PRD.md) first for what and why. This file is what exists, how it works, how to run/test/deploy it, what
is known to be wrong, and what to do next.

Repo: `git@github.com:kirav5/collab.git` (branch `main`). CI is `.github/workflows/ci.yml` (`npm run check`).

---

## 1. State at a glance

| | |
|---|---|
| Live web app | https://collab-55.web.app (Firebase Hosting → Cloud Run rewrites for `/api/**`, `/a2a/**`, `/health`) |
| Cloud Run | service `collab-market`, region `asia-south1`, **min 1 / max 2 instances** (one kept warm: no ~3 s cold start; `MIN_INSTANCES=0 ./deploy.sh` turns it off), startup CPU boost, request-based billing, 1 GiB, timeout 60 s · https://collab-market-mj7d6nwxxq-el.a.run.app |
| GCP project | `collab-55` (number 611701997508), free trial ₹28,797 until 12 Jan 2027 |
| Service account | `collab-market@collab-55.iam.gserviceaccount.com` — `aiplatform.user`, `datastore.user`, `firebaseauth.viewer`, `firebasecloudmessaging.admin`, secret accessor on `agent-secret` |
| Scheduler | Cloud Scheduler job `collab-watches`, `*/15 * * * *` → `POST $RUN_URL/cron/run` with header `x-collab-cron` = HMAC-SHA256(agent secret, "collab-cron") base64url (created/updated by `deploy.sh`) |
| Push | Firebase Cloud Messaging web push (default VAPID key); tokens in `push_tokens`; verified on iPhone (installed app) and Mac Chrome |
| Firestore | `(default)`, Native, `asia-south1`; vector index on `facts(tier, embedding[768])`; TTL on `rate.expireAt`, `leases.expireAt` |
| Firebase | web app `1:611701997508:web:149a27edf4e20d9dbd6e91`; Auth: Anonymous + Google enabled; App Check: reCAPTCHA Enterprise key `6LcWVO0tAAAAAGE87CLYa8anCDcS9mnidBl2geJN` (domains: collab-55.web.app, collab-55.firebaseapp.com, localhost) — **enforced** on `/api` |
| Secret | Secret Manager `agent-secret` (HMAC key our agents sign A2A calls with); local copy `.deploy/agent-secret` (git-ignored) |
| Monitoring | uptime check "collab health" (`/health`, 5 min) → alert policy "Collab is down" → e-mail atishay.srivastava.10@gmail.com |
| Model | Vertex AI `global`: `gemini-3.6-flash,gemini-3.8-flash,gemini-3.5-flash-lite` (low thinking); embeddings `gemini-embedding-001` in `asia-south1` |
| Tests | 49/49 pass (`npm run check` = `tsc --strict` + `node --test`); live 12-case run 12/12 (§8) |
| Size | ~5.8k lines: server ~4.0k TS, web ~1.8k JS/CSS |
| Live accounts used for testing | @atishaysrivastava10 (uid `NlVWMHzyk1MqGNrO0jWZQTa9hEC2`, Google), @anu-buyer (uid `GrqThVDukkVtN6yK2DkGvT5usvK2`), @bottle-store (`?as=seller` guest tab in a browser) |

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

10. **14 Oct session** (all deployed and live-tested unless noted):
    - **Load time 3.5–4 s → ~0.6 s** for a returning visit (≈1 s fully loaded; first visit ≈1.5 s). Causes found by
      resource timing: module waterfall, config fetched before sign-in, Auth waiting on the App Check token
      (reCAPTCHA ≈1.5 s), duplicate first refresh, `/api/facts` fetched on every repaint, Cloud Run cold start.
      Fixes: `modulepreload` + preconnect, config cached in localStorage and fetched in parallel, App Check on its own
      Firebase app instance (`check-<as|main>`) so Auth doesn't wait, Firestore listeners attached after first paint,
      one repaint per poll, saved-note facts cached 20 s, one warm instance.
    - **Google sign-in on the first screen** ("Continue with Google" or guest): a guest upgrades in place
      (`linkWithPopup`, same uid); a Google account that already has Collab signs back in (`credential-already-in-use`
      → `signInWithCredential`); redirect fallback where pop-ups are blocked; prefilled name/handle; QR invite text
      ("You're opening @x's agent"); guarded guest sign-out.
    - **Push actually works**: devices were never registered (0 tokens). Now a tap registers, each visit
      re-registers quietly, Settings › App & notifications has Install app (`beforeinstallprompt`; iPhone steps) and
      **Send a test notification** (`POST /api/push/test`); pushes while open show in-app.
    - **Direct chats (QR) don't stall**: a conversation with no listed price rests when every question is answered;
      the card says who answered and offers a reply box + Done; **either side** can send follow-ups
      (`POST /api/engagements/:id/ask` now accepts the provider — sent with `deliverProviderTurn`).
    - **Direct chats can reach a deal**: a message or answer naming a price ("I'll sell for 100rs", "₹450", "2.5 lakh")
      offers a deal (`core/direct.ts offeredPrice`, `engage.ts offerDeal`); the other owner gets Confirm/Walk away;
      saying no reopens the chat. Seller = whoever said "sell" (`pay.ts sellerFrom`).
    - **AP2 (test mode)** replaces "did it go ahead?": on agreement the seller's agent issues a signed **Cart
      Mandate**; the buyer taps **Pay** → their agent signs a **Payment Mandate** for that cart, sent to the seller's
      agent over A2A (`Turn.payment`), seller is notified; paying marks the deal as gone ahead for both. "Paid another
      way" and a small "It fell through" remain. The receipt view verifies both signatures. Live: ₹100 deal paid,
      `cartOk:true, paymentOk:true`.
    - **Chat history follows the account** (`chats` collection, owner-only): synced on open, on resume and on save;
      older on-device chats upload. "Delete chat history" clears everywhere.
    - **Updates reach installed apps**: the service worker is network-first (3 s fallback to the device copy);
      `deploy.sh` writes `web/version.txt`; an app coming back to the front reloads into a new version (unless typing).
    - Sidebar: unexplained "Web"/"Gemini" tags → a "✦ Powered by Gemini" chip that opens Settings › AI engine.

## 3. Architecture

```
Browser (device agent)                     Cloud Run: collab-market (Node 24, Express 5)            Firestore
  IndexedDB: chat cache (synced)     /api   ├─ API (auth: Firebase ID token + App Check)            profiles, handles, facts(+vector)
  Gemini Nano (if Chrome has it)     ─────▶ ├─ directory: embeddings + vector search + ranking  ──▶ rules, contacts, briefs
  Firebase Auth / App Check / FS            ├─ engagement engine (core/engage.ts)                    engagements (live), inbox
  listeners (engagements, inbox)            ├─ A2A per person /a2a/<handle> (SDK)  ◀── other agents  a2a_tasks, limits, audit
                                          └─ Gemini (Vertex AI) via ai/gemini.ts                   rate, leases (TTL), meta

All fact tiers — Private included — live in Firestore under the owner's uid. "Private" now means *never shared*:
allowedFor() never returns the tier (no rule can name it), Private facts get no topics/offer/embedding, so they
can't leak through rules, listings, search, or engagements. Limits/mandates are stored too (LIMITS; autonomy "ask"
= kept for the owner's devices, agent still asks each move).
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
  core/direct.ts       offeredPrice(): the rupee amount a chat message offers ("100rs", "₹450", "2.5 lakh"), ignoring
                       counts/sizes ("2 bottles", "200 ml")
  core/pay.ts          AP2 test mode: sellerOf/buyerOf/sellerFrom, cartFor (seller agent signs), pay (buyer agent signs,
                       marks outcome), checkPayment (hashes + signatures + cart matches the sealed deal)
  core/push.ts         FCM web push: saveToken, pushTo → {devices, sent}; dead tokens removed
  core/watch.ts        Scheduled agents: startWatch, runDue (search again, alert on new matches) — run by /cron/run
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
  market/{domains,places,geo,text,types}.ts + data/{domains.json (19 domains: goods, vehicles, stays, jobs, events,
                       pets, other …; FB Marketplace has ~19 top categories, OLX ~15),
                       places.tsv (GeoNames CC BY), places.extra.tsv (local supplement: Bengaluru localities)}
  ai/gemini.ts         Vertex/AI-Studio client, model fallback + resting, thinking level, embeddings (regional), stats
  ai/meter.ts          per-call token/latency/cost metering (GEMINI_PRICES)
  ai/decide.ts         propose → parse → validate → fallback
  ai/fake.ts           GEMINI_FAKE=1 offline stand-in (keyword answers, word-hash embeddings) — tests/dev only
  docs.ts              Docs interface: memoryDocs() and firestoreDocs() (vector fields encoded as Firestore vectors)
  demo.ts              8 demo people (riya, kabir, arjun, meera, dev, sana, nikhil=used cycle, fluent=hostile text) +
                       25 demo deals; seeded once (meta/demo)
server/tools/          live-cases.ts (two-person cases against a running server, real Gemini; BASE=… node tools/live-cases.ts [ids]),
                       read-probe.ts (what the reader decided for a message, step by step)
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
  js/local.js          IndexedDB chat cache (per-uid keys; the account copy is in `chats`), relevant() note retrieval
  js/api.js            Config (cached), Firebase Auth (guest / Google link-or-switch / redirect fallback), App Check on a
                       separate app instance, push registration, install prompt, Firestore listeners (lazy), api()
  sw.js                Service worker: network-first shell (3 s fallback), FCM background messages, notification clicks
  manifest.webmanifest, icon*.png/svg   Installable app (PWA); version.txt is written by deploy.sh (git-ignored)
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
| `receipts/{engagementId}` | sha256 of the sealed deal, registered once at agreement (append-only) | server |
| `push_tokens/{sha256(token)[:40]}` | uid, token, at | server |
| `watches/{id}`, `alerts/{id}` | scheduled re-searches of a request; new matches for the owner | server |
| `chats/{uid}_{chatId}` | owner, updatedAt, json (the chat; last 200 messages, ≤600 KB) | server (owner only) |
| `meta/demo` | `{version:"demo-v3"}` — bump `SEEDED` in demo.ts to re-seed (v2 added labelled demo deals, v3 @nikhil + goods/vehicles deals) | server |

Chat sessions are cached in the browser (IndexedDB `collab` → store `sessions`, keyed `<uid>:<id>`) and kept in the
account (`chats`), newest copy wins. Engagements also carry `seller` (side) and `payment` (AP2 cart/mandate/status). Facts of every
tier and all limits live server-side; `autonomy: "ask"` on a LIMITS row stores a non-delegated limit for the owner's
devices without letting the agent act on it.

## 6. Run · test · deploy

```bash
cd server && npm install
npm run dev:offline                         # memory store, test accounts, offline model → http://localhost:8080/?as=alice
npm run dev                                 # memory store, real Gemini via server/.env GEMINI_API_KEY (AI Studio)
# real Vertex + real Firestore locally (needs `gcloud auth application-default login`):
GEMINI_API_KEY= GOOGLE_CLOUD_PROJECT=collab-55 GOOGLE_CLOUD_LOCATION=global DEV_AUTH=1 SEED_DEMO=1 PORT=8787 node src/server.ts
npm run check                               # tsc --strict + all tests (~10 s)
BASE=http://localhost:8787 node tools/live-cases.ts [goods hindi …]   # 12 two-person cases on real Gemini (~8 min, ≈ $0.20)
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
- **Private facts are stored server-side** (user's call — simpler demo, works across devices) but the guarantee is
  enforced by the same deterministic policy wall: `allowedFor` never yields the tier, so no answer, listing or
  brief can contain it. Device-side storage remains an option (PRD R1) if the threat model needs it back.
- **A2A with the official SDK**, multi-tenant via one `DefaultRequestHandler` per handle; agent card served in wire
  JSON (`AgentCard.toJSON`) because `agentCardHandler` stringifies what the provider returns.
- **Turns are bounded requests** (Hosting rewrites cut at 60 s): `runTurns` stops at 35 s and leaves the next turn in
  `engagement.outbox`; the device calls `/api/engagements/:id/run` while an outbox exists.
- **Demo people's devices are simulated**: their inbox items are shown to the requester talking to them (labelled).
- **Gemini 3.6 Flash first** for latency; 3.8 as fallback. `gemini-flash-latest` does not exist on Vertex.
- **Budget band strictly above the limit**, coarse (₹1,000 → "up to ₹1,500"); business categories send no band.
- **Generality**: the only category-specific code is `domains.json` (terms, units, default questions) plus two
  family checks (property needs a named area; b2b gets a 40 km radius and no budget band). `other` is a catch-all
  so any priced request/offering can flow; `goods`/`vehicles` cover second-hand items. Non-property offerings fall
  back to the owner's area (or online) when no place is named. A seller whose floor is below the ask (stated or
  delegated) is marked `negotiable`, so near-budget requests (≤1.15×) still match.
- **Judging answers**: a bare "Yes."/"No." is settled without the model; only a *yes/no check* question judged
  unmet ends a conversation — information questions never do (the owner sees "not met" and decides).
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
- **Track record**: a completed AP2 payment marks the deal "went ahead" for both; otherwise either side can mark
  "paid another way" or "fell through"; `stats()` counts what the *other* side said; shown on matches and profiles.
- **AP2 in test mode only** (user's call: no real UPI for the hackathon — without a payment provider we can't
  confirm a UPI payment happened, which breaks "payment proves the deal"). Cart Mandate signed by the seller's agent
  at agreement (`engage.ts save()` → `pay.ts cartFor`), Payment Mandate signed by the buyer's agent on Pay and sent
  over A2A. Signatures are still server HMACs (see next tasks: Ed25519).
- **Direct chats**: no listing → no agent negotiation; owners talk through their agents, and a named price is an
  offer (regex, not Gemini — deterministic and free). Deals agreed before `seller` existed infer it from the message
  that offered the deal (`sellerInChat`).
- **Service worker network-first** (not stale-while-revalidate): SWR left installed apps on old code for days.

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
- **Two-person live cases on real Vertex** (`server/tools/live-cases.ts`, 12 cases: lessons, property-rent, rides,
  food, tasks, goods, vehicles, services, wholesale, equipment-rental, a catch-all "tarot online", and a Hindi
  request): each case publishes an offering with a delegated floor, drafts a request, finds the seller, and plays
  both devices to a deal. Final run: **12/12 found, 12/12 agreed, 0 leaks** (floor never in public text or
  conversation, exact budget never in the brief, every deal inside both limits), ~22 Gemini calls and ~$0.016 per
  case (≈ ₹1.4), 30–55 s per case with scripted devices; Flash-Lite answering classify/rank/judge/brief. Three
  runs before that found and fixed: b2b/online offerings requiring a named gazetteer place, missing Bengaluru
  localities, negotiable sellers hidden by the budget filter, JudgeTask closing on a bare "Yes.", mixed units in
  insights.

- **14 Oct live (two real phones/Macs + a guest tab):** FCM delivery to both devices (direct send and app path);
  "New request" and "Your agent needs you" on real A2A questions; follow-up both ways; ₹100 deal offered by text,
  confirmed on the phone, paid via AP2 (both signatures valid, receipt verified); carts back-filled for older deals
  (₹410 Anu ↔ bottle-store awaiting payment); seller's 3 chats uploaded to the account. **Not yet confirmed:** the
  two real accounts' chats syncing (their apps were still on cached old code — reopen twice).

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
10. Private facts and chat history sit in Firestore (plaintext at rest — GCP encrypted, but readable by anyone with
    DB access); no per-user encryption.
15. `offeredPrice` is a regex: "can you do 350?" is a question, not an offer (no selling word); unusual phrasings may
    be missed — the owner can always restate with ₹.
16. The pickup proof doesn't exist yet: a paid receipt can be shown twice (see next tasks).
17. `SUBMISSION.md` is out of date (says Private stays on the device; misses AP2, QR chats, push, watches, PWA,
    Google sign-in).
18. Cloud Scheduler watches are deployed and the job is ENABLED, but a real alert end-to-end hasn't been observed.
11. The deployed site's old tabs (pre-App-Check JS) get 401s until reloaded.
12. `firebase deploy` used to prompt about TTL field overrides; now declared in `firestore.indexes.json`.

## 10. Next tasks — code scope to completion (in order)

Deadline 18 Oct 2026. Deck/video are out of this list. Keep `npm run check` green and deploy with
`APPCHECK=enforce ./deploy.sh` (from the `collab-market` folder).

**Must**

1. **Pickup pass (skip the queue).** A paid deal shows the buyer a QR (`/?pickup=<engagementId>.<code>`; code = short
   HMAC of the id so ids alone can't be guessed into passes). The seller scans (People › Scan a QR already uses
   `BarcodeDetector`) or opens the link → a card with item, amount, buyer, "✓ Paid · not collected" and **Mark
   collected** (seller only, one-time, transaction on the engagement: `payment.collectedAt`); a second scan shows
   "Already collected at …". Server: `GET /api/pickup/:id?code=` (participants + seller), `POST /api/pickup/:id/collect`.
   Push the buyer "Collected". Files: `server.ts`, `core/pay.ts`, `web/js/cards.js dealBlock`, `app.js` deep links.
2. **Public-key signatures (make "verifiable" true).** Replace the HMAC receipt/mandate signatures with Ed25519
   (`node:crypto` `generateKeyPairSync("ed25519")`, private key in Secret Manager `receipt-key`, loaded like
   `AGENT_SECRET`). Publish the public key in every agent card (AP2 extension `params.publicKey` or a
   `/.well-known/collab-keys.json`) and sign `{uid, hash}`. Add a **public verify page** (no login) at
   `/verify/<engagementId>` showing yes/no, terms and both mandates, checkable offline with the published key.
   Keep the append-only `receipts` hash. Files: `a2a/agents.ts signReceipt`, `core/pay.ts`, `core/deals.ts`,
   `server.ts`, a small static page.
3. **Fair-price check (Google Search grounding).** `POST /api/price-check {item, area}` → Gemini with
   `tools: [{ googleSearch: {} }]` on Vertex (`ai/gemini.ts`: add a `grounded` option), JSON out
   `{low, high, typical, sources:[{title,url}]}` validated (numbers must appear in the grounded text; drop otherwise).
   Button "Check fair price" on the brief card and the deal-offer prompt; shown only to its owner, never sent to the
   other agent. Cap 5/day per uid via `limits.ts take()`; meter it (`ai/meter.ts`).
4. **End-to-end test of the retail path** in `test/e2e.test.ts`: shop QR (`/api/people/:handle/ask`) → follow-up both
   ways → price offer → confirm → `/pay` → pickup → collect (and double-collect refused). Unit tests for chat sync
   endpoints and `offeredPrice` edge cases you hit.
5. **Benchmark script** `server/tools/bench.ts` (BASE=… against the live service, real Gemini), writing
   `docs/bench/results.json` + a markdown table: privacy red-team (~100 attempts at Private notes/limits incl.
   prompt injection and Hinglish → leaks, target 0), negotiation (~50 seeded pairs → deal rate, % inside both limits =
   100%, rounds, surplus split), routing accuracy (~120 labelled messages), match precision@3, latency p50/p95 per
   step, ₹ per request/deal (from `/health model.costUSD`), and a 50-concurrent-conversation load run.
   `tools/live-cases.ts` is the starting point.
6. **Verify live**: the real accounts' chat sync (reopen apps twice, then check `chats` for both uids); a watch alert
   via Cloud Scheduler (create a watch, add a matching Public offering from another account, wait ≤15 min, expect the
   alert + push); pay the ₹410 listing deal from @anu-buyer.
7. **Docs**: update `SUBMISSION.md` (issue 17), README (features, run, deploy), PRD status.

**Should (if time)**

8. **Model Armor** on text from other agents and on outgoing answers (API already enabled): sanitize before
   `AnswerTask`/`JudgeTask`, log verdicts, refuse on high-confidence injection.
9. **Shop counter screen**: today's paid, not-collected orders for a seller, built on the pickup pass.

**Out of scope for the hackathon**: real UPI / payment provider, passkey-signed mandates, voice, Wallet passes,
calendar, on-device Gemma (PRD R1), Cloud Tasks (R7).
