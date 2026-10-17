# Collab (web) — Product Requirements Document

Product direction: [Collab — everyone’s agent for getting things done together](PRODUCT-VISION.md). That document defines the full consumer, business and service-provider vision; this PRD describes the current web implementation and its delivery scope.

For forward engineering requirements use [TECHNICAL-PRD.md](TECHNICAL-PRD.md); for the audited implementation and verification status use [CURRENT-STATE.md](CURRENT-STATE.md). The dated requirements and status statements below are a historical baseline and may lag subsequent code changes.

Status: v1 retail completion deployed (15 Oct 2026); remaining live device and seller collection checks are in [HANDOFF.md](HANDOFF.md) · Hackathon: AI Builder Cup 2026, theme **Retail & Commerce** · Submission
deadline **18 Oct 2026** · Live: https://collab-55.web.app · Work log and engineering handoff: [HANDOFF.md](HANDOFF.md)

This is the web/Google Cloud edition of **Collab** (the native iOS/macOS app in `~/Projects/Collab`). It shares
Collab's ideas, sharing model and look, and reuses ported logic, but it is a **separate product with its own data**:
it does not read the Collab app's AT Protocol records or Nostr listings.

---

## 1. Problem

Most everyday commerce in India — renting a flat, finding a tutor, booking a ride, ordering home food, hiring an
electrician, buying wholesale — is found by word of mouth and negotiated by hand over WhatsApp and calls. It is slow,
it doesn't scale beyond who you already know, and the person who negotiates less (or shares too much) loses.

Generic AI assistants don't fix this: they can search the web, but they can't talk to *the other person's* side, they
don't know what you're willing to share, and handing them your private context (budget, address, schedule) means it
lives on someone's server.

## 2. Solution (one line)

**Your agent asks anyone's agent for anything — and a deterministic policy wall decides what it may say.**

Each person has an agent. You say what you need; Gemini helps you shape it into a request; your agent finds the people
whose **public** offerings fit and talks to *their* agents over Google's **A2A (Agent2Agent) protocol**. Their agents
answer only from what their owners chose to share, ask what they need to know, and negotiate inside each owner's
**private** limit. People are interrupted only when it matters: a question only they can answer, a deal to confirm.

## 3. Users

| Persona | Wants | Collab gives them |
|---|---|---|
| Requester (Alice, moving to Bengaluru) | A 2BHK that allows her dog, under ₹36k, without 20 calls | One message → a brief → matched flats → her agent asks the questions and haggles → she confirms |
| Small provider (Riya, guitar teacher) | Students without answering the same questions all day | A public offering; her agent answers from it, shares her availability only under her rule, quotes, negotiates to her floor |
| Landlord (Kabir) | Serious tenants, maintenance details shared only after he checks | Protected fact under a "check with me first" rule |
| Any other AI agent (A2A client) | To discover and talk to people's agents programmatically | A public Agent Card per person; a stranger gets Public facts only |

## 4. Principles (non-negotiable)

1. **Asked once, answered for you.** Everything a person tells their agent — notes, earlier answers, listings —
   answers other people's agents by default, so nobody is asked the same thing twice (decided 18 Oct 2026). Private
   means *not listed*: never in the directory or on the card.
2. **The user decides what never leaves**, per note ("never use"), per person and topic (rules), per answer
   (approval). Every answer given for them is listed in Privacy › What your agent shared.
3. **Hard limits before the model.** Code picks the notes *before* Gemini sees anything: never one the owner set to
   "never use", one with contact details, or a private note that mentions money (a budget, floor, cost or supplier
   rate); signed-out outside agents get Public facts only; an answer naming the owner's limit goes to the owner.
4. **Gemini proposes, code checks.** Every model output is validated (grounded in the user's words/facts, numbers
   must be written, no contact details, no limit leaks); a deterministic fallback decides otherwise.
5. **Limits are never stated.** Negotiation prompts carry numbers only; messages revealing a limit are replaced.
6. **Open, not a walled garden.** Agents speak A2A; any A2A agent can talk to ours.
7. **Nothing final without the owner.** A deal is tentative until both owners confirm — on their device, or in
   advance through a *close* mandate they explicitly gave (a limit, an autonomy level and an expiry); the receipt
   records which.
8. **Market data is shared, limits are not.** What the market learns from agreed deals (prices, discounts, rounds)
   is anonymised and shown to both sides; nobody's limit, name or notes is ever part of it.

## 5. Information model — three levels

| Level | Stored | Who can be told | Notes |
|---|---|---|---|
| **Private** (default) | Firestore, under the owner's uid | Nobody — the policy gate never returns the tier (no rule can name it, no engagement draws on it, no embedding or listing is built from it). The device agent may draft an answer from it; it's shared only if the owner taps *Share* | Includes private limits (most you'll pay / least you'll take) |
| **Protected** | Firestore, with topics | People a **rule** names (a person, or "anyone who contacts my agent"), on the rule's topics, cut to its level of detail (yes/no · one line · summary · full), automatically or after the owner approves | Rules expire (day/week/month/never) and can be revoked; "Pause everything" stops all sharing |
| **Public** | Firestore, with a Gemini embedding | Anyone; discoverable in the directory | What you offer lives here; offerings are read by Gemini into structured listings (category, price, area, attributes) |

(Collab's separate "World" level is merged into Public here.) Location: only a public **area** (neighbourhood centre
from the GeoNames gazetteer) is ever used; exact location is Private (see roadmap R3).

## 6. Agent model

- **Always-on cloud agent** (Cloud Run): one A2A agent per person at `/a2a/<handle>`. Answers and negotiates only
  from what policy allows for that caller — Public for strangers, Protected under rules, Private for nobody.
  Negotiates while the owner is away inside limits they delegated.
- **Device agent** (the web app): the owner's own surface. Routes the owner's chat, answers from their notes,
  drafts requests/offerings, makes negotiation moves with the private limit, drafts answers from private notes for
  approval. Uses Gemini Nano on device when Chrome provides it; otherwise Gemini via the server. (Roadmap R1:
  Gemma on device, fully offline.)

## 7. Core flows

### F1 Request anything
1. Owner types a need in chat (any language). Device agent routes it (`request`).
2. Gemini drafts: category (from `domains.json`), fields, **this request's own filters** (must/nice, stated/implied,
   each quoting the request), a **shared brief** (no money, no limit), and up to 2 **clarifying questions with
   tap-to-answer options**. The owner edits title/summary, toggles must/nice, removes filters/questions, taps answers
   (re-drafted), and sets the **most they'll pay (private)**, optionally delegating it.
3. *Find people*: directory search (embedding → vector search over Public facts → hard filters for same-category
   offerings: area/mode/budget band/must-haves → Gemini ranking with reasons). Nothing is sent yet.
4. Owner picks people → one **engagement** (A2A task) per provider.

### F2 Agents talk (one engagement)
1. Requester's cloud agent sends the brief (A2A message, `collab.turn/v1`).
2. Provider's cloud agent: **requirement gathering** (up to 2 questions it needs answered) + answers the requester's
   must-asks from allowed facts (Public / Protected-by-rule), cut to the rule's detail; `review` rules → owner approves;
   unanswerable → owner's device.
3. Requester's cloud agent judges answers (met / unmet / unclear; a failed must-have ends it politely), answers the
   provider's questions from the brief and its shared facts, else asks its owner's device.
4. When questions settle, the provider quotes; turns alternate; each move uses the side's stored limit (delegated
   for autonomy, or "ask"-stored and sent by the owner's device for that move). Gemini picks moves from numbers
   only; guards enforce limits, pacing, no backtracking, no leaks. Rounds run out → widen the limit or walk away.
5. Accept → tentative deal → both owners confirm → agreed.

### F3 Offer something
Owner types an offering → Gemini reads it into a listing; a stated floor ("lowest 600") is **removed from the public
text** and kept private (stored with the owner's limits, never revealed; optionally delegated with an autonomy
level) → owner reviews → *Publish* (Public, embedded, discoverable).

### F4 Incoming
Someone's agent contacts yours → live notification + a card in Requests. Your cloud agent works on its own; the card
shows progress and asks you exactly when needed (answer / approve / limit / confirm).

### F5 Your own context
Remember (saved Private — stored with the account, never shared; suggest Public if it's an offering), ask your
notes (answered by Nano on device or by Gemini, with sources), move facts between tiers (Protected gets topics from
Gemini), rules in Sharing, an audit of everything your agent shared in Activity.

## 8. Functional requirements (v1 — all implemented)

| ID | Requirement |
|---|---|
| FR1 | Sign-in: Firebase anonymous guest; optional Google sign-in links the account. Profile: handle (unique), name, bio, area |
| FR2 | Chat sessions cached on device and synced in the owner’s account; routing to remember / ask_self / request / offer / chat |
| FR3 | Facts with three tiers; tier change; Protected topics (Gemini-suggested, editable) |
| FR4 | Rules: audience (person / anyone), topics, detail level, approval (auto / review), expiry, revoke; pause all |
| FR5 | Request drafting with filters, shared brief, clarifying questions, private limit (+ optional delegation) |
| FR6 | Directory search by meaning with hard filters and Gemini ranking + reasons |
| FR7 | Engagements over A2A v1.0 between per-person agents; outside A2A agents supported (stranger = Public only) |
| FR8 | Provider requirement gathering; answers from allowed facts only; rule detail shaping; review approvals |
| FR9 | Requester judging of answers; must-have failure ends politely |
| FR10 | Negotiation with guarded Gemini moves and deterministic fallback; widen limit / walk away; dual confirmation |
| FR11 | Device inbox: answer (with private-note draft + Share/Don't share), approve, move (automatic with the stored limit), confirm |
| FR12 | Live updates (Firestore listeners + polling fallback) and notifications (toast + browser Notification) |
| FR13 | Offering publishing with floor removed from public text; delegated floor optional |
| FR14 | Audit log of shared answers; privacy wall on every crossing message |
| FR15 | Demo people (8) for solo judging; their devices simulated (the requester can answer for them, labelled "demo") |
| FR15a | Any priced demand: 19 domains (property sale/rent, wholesale, freight, services, equipment rental, commercial lease, manufacturing, rides, food, lessons, tasks, goods, vehicles, stays, jobs, events, pets, other) — comparable to Facebook Marketplace's ~19 and OLX's ~15 top-level categories; `other` is a catch-all, so the reader never refuses something bought, sold, rented or hired; only non-transactions are refused |
| FR16 | Market insights from agreed deals ("similar deals closed at ₹X–₹Y, median ₹Z, ~N% under asking, in R rounds"), deterministic, for the requester (while setting a limit, when the limit runs out) and the provider (vs. the asking price); labelled when from demo deals |
| FR17 | Mandates with an autonomy level — ask me every move / negotiate inside my limit, I confirm / negotiate and close inside my limit — and an expiry (1/7/30 days) |
| FR18 | Signed deal receipt (hash of the agreed terms and parties, signed per owner, who confirmed: owner or mandate) |
| FR19 | Outcomes ("went ahead" / "fell through") per side after a deal → public track record on matches and profiles |
| FR20 | Agent card declares an AP2-inspired test flow; cart and payment mandates are server-signed Ed25519; no money moves |
| FR21 | Paid deal has a buyer pickup pass; only the seller can mark it collected once; replay shows the collection time |
| FR22 | Public receipt verification uses the published key without login; legacy HMAC mandates require Collab |
| FR23 | Google Search grounded fair-price hint is private to the owner and capped at five per account per UTC day |

## 9. Non-functional requirements

| Area | Requirement | v1 state |
|---|---|---|
| Privacy | Private data never shared; minimal disclosure | Met (Private facts are stored server-side but the policy gate returns them to no one — they get no topics, offer or embedding; the brief carries a band strictly above the limit) |
| Security | Verified Firebase ID tokens; server-only Firestore writes; App Check on `/api`; A2A rate limits; least-privilege service account; secret in Secret Manager | Met |
| Scale | Stateless instances; cross-instance locks and rate limits in Firestore; vector index | Met for pilot; agent turns still run in-request (R7) |
| Latency | Draft ≤ 8 s, search ≤ 5 s, agent turn ≤ 10 s | Draft ~6 s; search ~2–4 s on Cloud Run (first embedding call slower); turns 3–15 s |
| Cost | ≈ ₹3 per complete request→deal journey; per-user Gemini allowance | Met (60-call burst, then 1/15 s; token meter on /health; cheap tasks on Flash-Lite; cached listing answers; no model call for settled negotiation moves) |
| Reliability | Model fallback list; uptime check + e-mail alert; structured logs + Error Reporting | Met |
| Quality | Type-checked, tested (unit + end-to-end over A2A), CI | Met (CI runs once the repo is on GitHub) |

## 10. Google Cloud usage (for the submission)

- **Gemini (Vertex AI, `global`)**: `gemini-3.6-flash` → `gemini-3.8-flash` → `gemini-3.5-flash-lite` fallback, low
  thinking. Tasks: classify, fields, request filters, shared brief, clarify, rank, answer, judge, gather requirements,
  negotiate, route, topics. **Embeddings**: `gemini-embedding-001` (768-d) in `asia-south1`. **Gemini Nano** in Chrome.
- **Cloud Run** (`asia-south1`): server, per-person A2A agents, API.
- **Firestore**: profiles, facts (+ vector index), rules, engagements (live), inbox, A2A tasks, audit, rate/leases (TTL).
- **Firebase**: Hosting (+ rewrites to Cloud Run), Authentication (anonymous + Google), App Check (reCAPTCHA Enterprise).
- **Also**: Secret Manager, Cloud Build, Artifact Registry, Cloud Logging / Error Reporting, Cloud Monitoring uptime.

## 11. A2A contract

- Agent Card: `GET /a2a/<handle>/.well-known/agent-card.json` (A2A v1.0; JSON-RPC interface; optional bearer =
  Firebase ID token; skills from the person's public offerings; `capabilities.extensions` declares AP2 v0.1 with
  roles merchant/shopper, not required).
- Endpoint: `POST /a2a/<handle>` JSON-RPC (`SendMessage`, `GetTask`, `CancelTask`).
- One engagement = one task. Each message: a text part (human-readable) + a data part:
  `{ kind: "collab.turn/v1", from: "requester"|"provider", engagementId, brief?, offerFactId?, questions?[{id,question}],
  answers?[{id,question,answer}], pending?[question], declined?[question], proposal?{id,price,terms,round}, accept?,
  confirm?, decline?, note? }`. Plain-text messages from other agents are accepted (their "…?" sentences become questions).
- Task states: `input-required` (requester's turn), `working` (provider's owner is being asked), `completed`
  (agreed), `rejected` (declined), `canceled` (closed).
- Callers: our agents sign with an HMAC token (`agent:<uid>.<sig>`); Firebase ID tokens identify people; anything else
  is a stranger. Per-IP and new-conversation rate limits.

## 12. Out of scope (v1)

Real payments and escrow (test mandates only), identity verification/KYC, free-text reviews
(only went-ahead / fell-through outcomes), native apps (the Collab iOS/macOS app is separate), reading
the Collab app's AT Protocol/Nostr data.

## 13. Success metrics

- A judge completes request → match → agent conversation → deal alone in < 3 minutes (demo people).
- 0 private facts or limits appear in any message, brief, log or Firestore document (tests + audit).
- ≥ 95% of Gemini calls succeed without fallback; median agent turn < 8 s.
- Hackathon: shortlisted; candidates for "Best use of Google Cloud AI tools" and "Most Impactful".

## 14. Roadmap (prioritised)

| ID | Item | Why | Acceptance |
|---|---|---|---|
| R1 | **Local-first device agent with Gemma** (MediaPipe LLM Inference, WebGPU; Gemini Nano where available); offline PWA (service worker, send queue); setting "private model: on device only" | Truly offline; the user alone decides what leaves the device; adds Gemma | Remember/ask-my-notes/draft work with network off; server receives only the approved brief; checks run on device |
| R2 | **Push notifications (Firebase Cloud Messaging)** for "needs you" and new requests | Owners respond while the app is closed | A web push arrives within 10 s of an inbox item; tapping opens the card |
| R3 | **Exact location after a deal** — Private fact shared with one counterparty on tap | Rides/deliveries need a pickup point; still the owner's choice | Only after both confirm; one-time share to that engagement; audited |
| R4 | Multimodal: voice (Hindi etc.) and photo listings (Gemini) | Accessibility, impact | A voice note or photo yields a correct draft |
| R5 | Compare offers across 3 providers; Gemini recommends with reasons | Better decisions | Recommendation cites each provider's answers |
| R6 | Reputation after deals | Trust | Ratings shown in matches |
| R7 | Agent turns on Cloud Tasks (idempotent, retried) | Production robustness | No turn runs inside a user request |
| R8 | Data rights: delete/export my account (server), Firestore PITR | DPDP compliance | One tap deletes all server data |
| R9 | Encrypt Private facts at rest (client-side key or Cloud KMS envelope); optionally move Private storage back on-device | Shared DB access, multi-device | Server holds ciphertext only for the private tier |
| R10 | Load test (k6), staging service | Known limits | Report with p95 at 50 rps |

## 15. Open questions

- Team: the hackathon requires 2–4 members registered by 11 Oct (team changes closed 14 Oct) — confirm.
- Demo rule for Riya/Kabir uses audience "anyone" (strangers included) — keep for the demo, or require sign-in?
- Should delegated limits be the default for providers (so they negotiate while offline)?
