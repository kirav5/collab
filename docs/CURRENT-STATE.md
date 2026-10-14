# Collab — current application state

Audited 15 October 2026 (Asia/Kolkata). Source commit: `914fc4546861fb1be63d2ac960cdf218c9954125`.

> **Update, 15 October (later the same day):** the technical PRD's stages T0–T4 were implemented, tested (101/101)
> and deployed (`./deploy.sh production`, build on `/health`). What changed against the audit below:
> - **T0:** build id on `/health` + `version.txt`; `/pay` claims atomically (one tap wins, same key returns the same
>   payment); payment, fulfilment (delivered / accepted / disputed) and the track record are separate; outbox
>   recovery (per-save flag, named Cloud Tasks, minute scan); replay protection fails closed (503, degraded state on
>   `/health`); anonymous A2A tokens own their tasks; offerings chosen explicitly or asked about; webhooks checked at
>   connect time (no private/rebinding targets, no redirects); Model Armor outage policy; exact AP2 claim on cards.
> - **T1:** validated operational policy (`server/src/config/policy.ts`, `POLICY_JSON`), hash on `/health` and on
>   each conversation, `/api/policy` for the app's labels; currencies (INR, USD; refused clearly otherwise) through
>   carts, checkouts, sealed terms, verifier and UI; checkout line items from the proposal; goals and tasks with
>   derived states (information goals complete with no price) and a one-time backfill; versioned capability
>   discovery (`/public/capabilities`, on cards; `UNSUPPORTED_CAPABILITY` as a rejected task); decisions bound to the
>   exact proposal, deduplicated, with deadlines (unconfirmed deals lapse; questions get one reminder); per-environment
>   deploy manifests (`deploy/*.env`).
> - **T2:** resource ledger (`core/resources.ts`): quantity stock and time slots, atomic holds, expiry, commit/release,
>   staleness; deals reserve at agreement and commit at payment; out of stock refuses payment with nothing charged;
>   stock questions answered from the ledger; slot picking; seller controls in Context.
> - **T3:** connectors (`core/connectors.ts`): scoped, expiring, revocable grants; signed POS stock events (applied
>   once, never rolled back by older events); iCal busy times (titles not stored); outages degrade the grant and make
>   availability unknown.
> - **T4:** goal budgets (allocated in a transaction at every buyer confirmation; released on decline/lapse/
>   fall-through); plans (Gemini proposes, code bounds; ready steps search, never commit); recurring goals (search +
>   notify, stop at budget/end); all-or-nothing compensation.
> - **Not done, by decision:** real payments (Google Pay stays in TEST mode).
> The remaining items in the tables below that these cover should be read as done; see HANDOFF §10 for the live checks.


## Position against the product vision

**Collab is a working two-party agent collaboration prototype with a tested simulated retail transaction path.** It has useful foundations for consumers, shops and service providers. It is not yet a general autonomous execution platform: resource reservation, booking, organisation roles, connector permissions and coordinated multi-task goals remain missing.

There is no defensible single percentage of “finished” for the vision. Representation and conversation are the strongest parts; operational execution and production assurance are the largest gaps. Supporting many listing categories does not mean completing the corresponding domain workflows.

| Capability stage | Position |
|---|---|
| Owner representation, context and permissions | Implemented foundation; limited delegation and server-readable private storage |
| Two-party collaboration | Working matching, questions, negotiation, decisions and agreement |
| Durable execution | Partial: turn queue exists, with gaps in enqueue recovery and live verification |
| Resource commitments | Not built: no authoritative stock, capacity ledger or booking/reservation system |
| Connected execution | Some Google services integrated; no general user-authorised connector framework or real settlement |
| Composed goals | Not built: no persistent goal/dependency planner or compensation across providers |
| Open participation | Signed A2A interface exists; full external business-workflow interoperability is not proven |

## Evidence and limits

- **Checked now:** strict TypeScript and all **65 tests pass** with `cd server && npm run check`. Expected signature-failure logs are emitted by negative tamper tests; the suite passes.
- **Checked now:** public production health responds successfully with Firestore and Vertex AI; Model Armor is enabled and reports activity. Riya’s live agent-card signature verifies using the key fetched from the known Collab `/public/keys` endpoint.
- **Version uncertainty:** served web version is `756452d-1792009875`, which differs from the source commit above. Health does not expose a backend commit. These observations do not establish that all current source changes are deployed.
- **Earlier evidence:** HANDOFF records authenticated retail, Scheduler and other live checks. These are historical evidence, not transactions repeated in this audit.
- **Not checked now:** authenticated purchasing, collection, physical devices, Google Pay sheet, Nano execution, queue recovery, external webhook delivery or a production benchmark.

Machine-readable evidence: [audit/current-state-2026-10-15.json](audit/current-state-2026-10-15.json). UTC timestamps in that record correspond to the next calendar day in India.

## Overall capability inventory

“Source” means code is present; “test” means relevant automated coverage exists; “historical live” means recorded in HANDOFF; “live now” means directly checked during this audit. No label implies production readiness.

| Area | Current capability and evidence | Remaining work |
|---|---|---|
| Access and identity | Google/guest sign-in, handles, profiles; source and integration tests | Organisation membership, staff roles, delegated helpers, account lifecycle/export |
| Context | Private/Protected/Public facts and owner rules; policy tests | Purpose/action-scoped grants, provenance/freshness, processing controls, encryption/key ownership options |
| Privacy | Counterparty filtering and output checks; private facts remain in Firestore | Do not claim device-only storage or server blindness; improve semantic leak evaluation and local-cache lifecycle |
| User interface | Chat, Context, People, Sharing, Requests, Activity, Settings and installable web shell | Generic goal dashboard, domain-aware action cards, accessibility and representative user research |
| Requests/offerings | Language interpretation, structured briefs, category fields, clarifications and listing publication | Non-priced collaboration as a first-class workflow, explicit schema versions, fewer category-specific assumptions |
| Discovery | Embeddings, public vector search, deterministic filters and model ranking | Scale tests, availability-aware matching, pagination, freshness and configurable search policy |
| Nearby shops | Maps-grounded nearby leads; source and historical live result | A map result is not an onboarded provider or proof of stock/consent |
| Agent questions | Bidirectional questions, permitted answers and owner inbox | Robust outside-agent intent/offer selection; richer task negotiation |
| Negotiation | Guarded proposals, terms structures, private limits and bounded rounds; tests | Productised stock/time/quality tradeoffs and generic commitment types |
| Delegation | Ask, negotiate and close modes with expiry | Per-action authority, cumulative budgets, connectors, recipient constraints and version-bound approvals |
| Human intervention | Inbox, FCM notifications, progress and owner decisions | Deadline-aware proactive escalation, delivery/acknowledgement states, quiet hours and notification deduplication |
| Agreements | Both sides confirm; sealed records and server-issued signatures; tests | Independent fulfilment/acceptance states, organisation authority and revised-term approval binding |
| Payments | Simulated payment; legacy carts plus new custom checkout/SD-JWT-shaped bundle; tests | Real provider settlement, refunds, reconciliation, atomic idempotency and protocol conformance review |
| Google Pay | TEST sheet integration and token digest in record; source | Live sheet exercise remains unproven in available evidence; no real money moves |
| Pickup | Bearer QR, public status, seller-only atomic one-time collection; retail tests and historical live pass | Live seller redemption evidence still outstanding in HANDOFF; copied-first-pass risk remains |
| Public verification | Published keys, logged-out browser verifier and CLI; tamper tests | Key rotation/history and consistent protocol/version claims; signature validity does not prove physical completion |
| Fair-price evidence | Search-grounded hint, source support checks, private storage and quota; tests | Configurable limits/currency/unit handling, broader comparability evaluation |
| Inventory | Listings and prices only | SKU/variant quantities, stock source, atomic holds, reconciliation, return-to-stock |
| Availability/bookings | Availability can be represented as shared facts | Calendar connectors, working capacity, slot holds, time zones, recurrence and double-book prevention |
| Services/projects | Can discover, ask, quote and agree | Milestones, deliverables, acceptance, revisions, recurring work and disputes |
| Multiple parties | Several bilateral engagements can exist | Shared goal, dependency graph, total budget allocation and partial-failure recovery |
| A2A identity | Cards and task endpoints; live signature verified now | Reliable external identity/authorisation, capability compatibility and independent-client lifecycle test |
| A2A updates | Streaming and webhook code; live card advertises both; historical SSE check | External webhook exercise, DNS/redirect SSRF protection, restart/reconnect and task ownership review |
| Model execution | Shared Gemini service, task tiers, fallbacks, embeddings and metering | Versioned model routing/processing policies and quality/cost gates |
| Device inference | Nano controls/download UI, note cache and local inference path in current source | Verify on supported devices; current online fallback can send notes to server, so not strict local-only mode |
| Sync/offline | Chat sync tests, shell caching, private-note cache and Firestore persistence | Physical-device/account-isolation tests; offline does not permit remote commitments |
| Background turns | Cloud Tasks enqueue and OIDC-checked handler; historical unauthenticated rejection | Trigger/retry/restart test, durable enqueue recovery, stable operation IDs and dead-letter handling |
| Scheduled watches | Periodic search/alerts; automated test and historical synthetic Scheduler evidence | Real notification delivery for a watch; generic goal deadlines and recurring mandates |
| Security services | Auth, rules, App Check, quotas, leases, Model Armor; source and tests for parts | Replay downgrade behaviour, Armor coverage/outage policy, webhook hardening and adversarial tests |
| Operations | Deploy script, secrets, structured logs, monitoring, CI/test scripts | Build identity, staging/rollback evidence, restore drills, end-to-end traces and SLOs |
| Evaluation | Local real-model benchmark and evaluation-service integration | Complete current full run, independent cases, semantic review and attributable cost |

## Current constraints and risks to address

These are code observations, not claims that an exploit was attempted.

1. **Payment state is not an authoritative settlement record.** `/pay` loads, mutates and saves an engagement. Same-key retries are recognised after a successful save, but the operation is not an atomic claim across simultaneous requests. Test payment also marks both outcomes as “happened.” Separate agreement, simulated payment, fulfilment and acceptance.
2. **Webhook URL validation is lexical.** `safeWebhook()` rejects obvious private names/IP literals but does not establish that DNS resolves only to permitted public addresses or prevent redirect-based bypass. Treat external webhook enablement as requiring further hardening.
3. **Replay protection can downgrade.** `server.ts` catches permission-related token-consumption errors, disables consumption for that process and falls back to ordinary token validation. Enforced single-use protection is therefore conditional. Require an explicit operational policy and visible degraded status; sensitive execution must not silently weaken.
4. **Queue persistence is incomplete.** `queue.ts` logs enqueue failure and returns; work can await another run. A successful request is not proof that every pending turn is durably scheduled.
5. **Model Armor is supplementary and fail-open on errors.** It does not replace policy checks, and its counters do not prove all paths were screened.
6. **Outside-agent conversations need stronger isolation and selection review.** Anonymous callers can lack a durable caller identity; task loading conditionally checks recorded callers. The provider defaults to the first public offering when an offer is omitted. Review capability ownership and do not infer a product choice from storage order.
7. **Private facts are server-readable.** Local-note execution and caching do not change that storage fact. Browser persistence requires clear device and sign-out controls.
8. **Protocol claims differ.** New source and README describe v0.2-shaped payment bundles; the live card advertises an AP2-inspired custom v0.1 flow. Code uses custom claims and a Collab-controlled signer. Neither self-verification nor a version label establishes AP2 conformance or third-party acceptance.
9. **Documentation has drifted.** Old PRD/HANDOFF passages predate Cloud Tasks and newer device controls; the Firestore rules comment says private context is not stored server-side, contrary to the implementation. Use this audit for the dated status, the technical PRD for target requirements, and historical entries as history.

## Where hardcoding limits the product

Some foundations are already data-driven: `data/domains.json` defines categories, terms and questions, and model choices have environment overrides. The remaining work is to separate deployment settings, versioned product policy, domain definitions and owner mandates.

| Present assumption | Evidence | Target |
|---|---|---|
| INR and rupee parsing in core/UI | `core/pay.ts`, `core/ap2.ts`, `core/deals.ts`, `core/price-check.ts`, `core/direct.ts`, verifier/UI | Currency-aware money representation and locale adapters; unsupported currencies rejected explicitly |
| One item with quantity one at checkout | `core/ap2.ts` constructs `item_1`, `quantity: 1` | Line items, variant/resource references and quantities from the agreed proposal |
| Price-bound bilateral agreement | `Engagement`, `Mandate` and current handlers | General goals/tasks with typed commitments, optional payment and multiple participants |
| First offer if none selected | `a2a/agents.ts` | Resolve by explicit capability/offer ID or clarify ambiguity |
| Fixed quotas and duplicated text | `price-check.ts`, `nearby.ts`, `web/js/cards.js` | Server-resolved quota policy and remaining/reset metadata for the UI |
| Fixed round, timeout, lease and length values | Engine, A2A and route files | Validated operational policy with safe bounds, preserving security caps |
| Seven-day cart and ten-minute checkout | `core/pay.ts`, `core/ap2.ts` | Distinguish offer validity, reservation expiry and payment authorisation expiry by policy/protocol |
| Online represented by a place named Online at zero coordinates | `market/types.ts` | Explicit fulfilment/service mode, with location optional |
| Question/price parsing relies on specific wording | `a2a/agents.ts`, `core/direct.ts` | Structured inputs plus validated language adapters and clarification |
| Cloud deployment and demo defaults mixed | `deploy.sh`, demo seeding | Environment manifest, explicit demo mode and isolated demo records |
| Frontend formats domain states directly | `web/js/cards.js`, `screens.js` | Typed view models and capability-driven components, retaining specialised UI where useful |

Avoiding hardcoding does not mean making authorisation, cryptographic verification or accounting rules editable by a model. Those remain enforced code invariants. Details: [TECHNICAL-PRD.md](TECHNICAL-PRD.md).

## Evaluation snapshot

The completed older local real-Gemini report records privacy 100/100, negotiation 38 passes / 11 failures / 1 error from 50 attempts, intent 120/120 and load 50/50. These are synthetic/local results with repeated templates, not production guarantees. See [full-local-gemini/results.md](bench/full-local-gemini/results.md).

The newer `full-armor-autorater` file currently records privacy 100/100, legitimate questions 29/30, negotiation 36/44, and **zero intent/load attempts**. Treat it as a partial snapshot, not a completed full benchmark. Its files were untracked at audit time. Do not merge its denominators with the older run. See [full-armor-autorater/results.md](bench/full-armor-autorater/results.md).

## Next delivery position

First stabilise the existing collaboration loop and configuration boundaries. Then prove one resource interface with both stock reservations and time-slot bookings, followed by connected execution and composed goals. This sequence advances the broad consumer/shop/worker vision while keeping each increment demonstrable. Release gates and acceptance criteria are in the [technical PRD](TECHNICAL-PRD.md).
