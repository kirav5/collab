# Collab: AI Builder Cup innovation assessment

Reviewed 15 October 2026 against the official public pages and the signed-in Hack2skill dashboard; technology audit added the same day against each Google product's current documentation. The dashboard's Retail & Commerce brief suggests hyper-personalization, conversational commerce, product discovery, demand forecasting, basket analysis, customer segmentation, and inventory intelligence. Collab fits the conversational and physical-commerce portion; it does not implement forecasting or inventory intelligence.

## Recommendation

Position Collab as **personal agents for neighbourhood commerce: scan a shop, agree within private limits, and collect once**. Focus the demonstration on one physical retail purchase. The reusable technology can serve other categories, but listing every category weakens the retail story.

The differentiation to demonstrate is the combination of bilateral negotiation, selective disclosure, owner control, and physical handover. Do not claim that agent shopping, QR pickup, public-key signatures, or search grounding are individually new. Google and Shopify already offer agentic commerce infrastructure ([Google announcement](https://blog.google/products/ads-commerce/agentic-commerce-ai-tools-protocol-retailers-platforms/), [Shopify Agentic Storefronts](https://www.shopify.com/news/ai-commerce-at-scale)). This is a positioning recommendation, not evidence of a world-first invention.

## Fit with the challenge

Retail & Commerce explicitly includes discovery, conversational shopping, and improvements across physical and digital commerce. The published scoring is technical merit and Gen AI implementation 40%, problem alignment and impact 25%, innovation 25%, and UX 10%. Gemini and deployment on Cloud Run/Firebase fit the technology requirements. Source: [official challenges and requirements](https://aibuildercup.com/themes.html).

The public timeline gives 18 October 2026 for submission and 14 October for team formation. Source: [official timeline](https://aibuildercup.com/).

**Eligibility (owner's decision, 15 Oct).** Collab is the team's own product and this web app was built within the project timeline; the ported logic stays disclosed in README and HANDOFF. The FAQ also requires 2–4 eligible team members, a deployed prototype, public repository, a video under three minutes, and a deck. The public theme page contains unrelated category wording in its submission section, so confirm the actual dashboard category and template before submitting.

## What to finish and how to prove it

| Priority | Innovation to demonstrate | Repo evidence today | Proof for judges |
|---|---|---|---|
| 1 | Two agents negotiate while each owner's exact limit remains unavailable to the other agent | A2A engine, policy filter, numeric negotiation guards exist | Two accounts with different private limits; include a hostile request; show the final amount and information actually disclosed |
| 2 | A digital agreement leads to a single physical handover | Paid pickup QR, public status page, and atomic seller-only collection are deployed; one-time behavior passed the retail E2E test. The live listing-origin ₹410 pass is uncollected because the seller was not signed in for this check | Seller collects once; simultaneous/repeated redemption cannot create a second collection; buyer/stranger cannot collect |
| 3 | A receipt another developer can check | Ed25519 signatures, public key in agent cards, logged-out verifier, offline CLI and tamper tests are implemented; the live ₹410 receipt verified in a logged-out browser. Its original cart and payment are legacy HMAC | Download a newly issued receipt and verify using a pinned public key only; change amount or party and show rejection |
| 4 | Private evidence helps an owner decide whether to accept | Search-grounded price hint, citations/abstention and five-per-day cap are deployed. The live vague bottle listing correctly returned insufficient comparable evidence | Use a specific SKU for a sourced range; show that the result is absent from peer-agent payload |
| 5 | Measured reliability of the agent workflow | Full real-Gemini local benchmark is in [bench/REPORT.md](bench/REPORT.md): 100/100 canary privacy runs, 38/50 negotiation runs agreed (38/39 feasible), 120/120 repeated intent routes and 50/50 load conversations. Its failure and cost limits are documented | Present denominators, scope, p50/p95 latency and cost estimate with limitations |

The first four complete the proposed product path. The fifth gives evidence for the largest judging category. Model Armor can add a second injection screen, but it should not replace deterministic access control or delay the end-to-end proof.

## One additional feature worth considering

**Negotiate tradeoffs, not only the rupee amount.** For example: a buyer can collect tomorrow and accepts an alternative colour; a shop can offer a lower price for that combination. Each owner chooses allowed tradeoffs. Gemini converts the language to a structured proposal; code validates every allowed option, price and expiry; both owners see and approve the exact final terms.

This makes the Gen AI contribution visible and gives a local shop a reason to use Collab. It is not implemented merely because the model has a `terms` field. For a hackathon, constrain it to one extra dimension (pickup window) and add it only after the existing flow passes. Quantity would also require stock reservation and concurrent-order handling; avoid claiming inventory guarantees without those.

Other ideas to defer: collective buying, demand forecasting, dynamic stock allocation and cross-store baskets. They need data or coordination beyond the current path. UCP interoperability is a credible roadmap item; advertising a protocol on a card is not proof of interoperability.

## Claims that need precise wording

- **Privacy:** Private facts and limits are stored server-side today. The policy excludes Private facts from answers to counterparties. Say “not shared with the other party,” not “never leaves your device,” “zero knowledge,” or “the server cannot see it.” A visible budget band or accepted offer can still reveal information about willingness to pay.
- **Signatures:** Ed25519 enables public verification of Collab-issued signatures. Server-held keys do not establish an independent human signature or remove trust in Collab. Bind signer identity, payload format/version and key ID; document how a verifier trusts the published key. Preserve legacy receipts and plan key rotation.
- **Record immutability:** The receipt registry is write-once by application convention. It is not an external immutable ledger and does not prevent an administrator rewriting the database.
- **Pickup:** A static QR with atomic seller redemption prevents repeat redemption. It does not prove the presenter is the buyer; a copied pass could be presented first. Show the buyer's name to the seller and describe this limitation. Public links should be unguessable bearer links exposing only the necessary receipt details, never conversations, limits or notes.
- **Payments:** Label the current flow “AP2-inspired test payment; no money moves” until conformance is verified. The current [AP2 specification](https://ap2-protocol.org/ap2/specification/) (v0.2) defines Checkout and Payment Mandates as SD-JWT verifiable credentials and **requires the merchant's Checkout JWT to use a non-deterministic signature scheme such as ECDSA — it names Ed25519 as not permitted** (rainbow-table binding). This code advertises a v0.1 extension, uses custom JSON objects, and signs with Ed25519. So: our carts are verifiable *Collab* receipts, not AP2 mandates; conformance would need ES256 keys, SD-JWT, and a credential provider. Say exactly that.
- **Fair price:** Google Search grounding supplies evidence, not a certified fair valuation. Do not turn unrelated products or asking prices into claims about actual sale prices. A number appearing in generated prose does not establish that a source supports it. Require comparable evidence and allow “not enough information.” Source links and required Search suggestions must follow [Google's grounding guidance](https://cloud.google.com/vertex-ai/generative-ai/docs/grounding/grounding-with-google-search).

## Technology audit — what we use, how deeply, and what we leave on the table

Checked 15 October 2026 against each product's current documentation. "Depth" is an honest grade of how much of the capability that matters *for this product* is in use — not how many features exist.

### Google technologies in the build

| Technology | In use (verified in code) | Not used, and whether it matters here | Depth |
|---|---|---|---|
| **Gemini on Vertex AI** (`gemini-3.6-flash` → `3.8-flash` → `3.5-flash-lite`) | `systemInstruction`; structured output via `responseJsonSchema`; `thinkingLevel` low / minimal per tier; `temperature 0.2`; ordered model fallback with per-model resting on 429/503/404; per-call token+cost meter; a cheap tier for 6 of ~19 tasks per journey | **Context caching — not applicable**: our instructions are 60–140 tokens; implicit caching needs ≥4,096 tokens on 3.6/3.8 Flash and explicit caching ≥1,024, so there is nothing to cache ([docs](https://ai.google.dev/gemini-api/docs/caching)). **Interactions API**: GA June 2026 and now Google's default; `generateContent` is "legacy, fully supported" — a migration note, not a missing feature. **Function calling**: deliberately not used — structured output + code validation is the safer pattern for us. **Multimodal input** (photo listings), **Batch**, **Live API**: roadmap R4. | High for this shape of problem |
| **`gemini-embedding-001`** (768-d, `RETRIEVAL_QUERY/DOCUMENT` task types, regional `asia-south1`) | Yes | **`gemini-embedding-2`** went GA on 22 April 2026: natively multimodal (text, image, PDF, audio) and 100+ languages, same recommended 768 dims, MRL-normalised truncation ([docs](https://ai.google.dev/gemini-api/docs/models/gemini-embedding-2)). Directly relevant to our Hindi/Hinglish requests and to photo listings. Caveat: available in `global`/`us`/`eu` only — we moved embeddings to `asia-south1` for latency (12 s cold on `global`), so measure before switching. | Medium — one model id behind |
| **Grounding with Google Search** | Fair-price check: every number must trace to a grounding support, else "not enough evidence"; `searchEntryPoint` rendered in a sandboxed iframe as Google requires; 5/day cap | **Grounding with Google Maps** (`googleMaps` tool, `places` + `routing`, 250 M places, reviews, opening hours): would let a request find *shops* not just Collab users, and would retire the GeoNames TSV that lacked Bengaluru localities. Billing is separate; not for the last 72 hours. | Good |
| **Firestore** | Vector search with the recommended **composite pre-filter index** (`tier` + `embedding[768]`); transactions for leases, rate buckets and one-time pickup; TTL on `rate`/`leases`; `onSnapshot` listeners; security rules scoping engagements/inbox to participants | Distance measure is `COSINE`; Google now recommends `DOT_PRODUCT` for normalised embeddings (identical ranking, marginally faster) — cosmetic. PITR and export (R8). | High |
| **Cloud Run** | Source deploy via Cloud Build; concurrency 40, min 1 / max 2, CPU boost, 60 s timeout; service identity for Vertex/Firestore (no keys in container) | **Cloud Tasks** for agent turns (R7): turns still run inside the user's request with an outbox; Google's guidance is exactly our case ("delegate slow operations… at-least-once, idempotent handlers"). | Good |
| **Firebase** | Hosting with rewrites; Auth (anonymous + Google link); **App Check enforced** (reCAPTCHA Enterprise) on `/api`; **FCM web push** (`sendEachForMulticast`); installable PWA with versioned shell | **Firebase AI Logic hybrid SDK** does, as a product, what `web/js/agent.js` does by hand: Gemini Nano on device, cloud fallback, App Check built in. Not worth a rewrite now; note it as the supported path if the device agent grows. | High |
| **Cloud Scheduler · Secret Manager · Cloud Monitoring/Error Reporting** | 15-minute watch job with a header token; agent + receipt keys in Secret Manager; uptime check → alert; structured JSON logs | **Cloud Trace**: no span per agent turn, so a slow conversation can only be read from logs. | Good |
| **Gemini Nano (Chrome Prompt API)** | `LanguageModel.availability()` + `responseConstraint` JSON schema for the private-notes answer | The Prompt API shipped to **web stable in Chrome 148** (was extensions-only) — our path is real now but still untested in a real Chrome (HANDOFF §9 #5). **Language Detector + Translator APIs** (Chrome 138, desktop only) could detect Hindi input and translate on device. | Medium — built, unverified |
| **A2A v1.0** (`@a2a-js/sdk` 1.3) | Agent Card per person; JSON-RPC binding; `protocolVersion 1.0`; one task per conversation; text + `collab.turn/v1` data parts; multi-tenant handler per handle; caller classes (signed agent / Firebase user / stranger) | **Signed Agent Cards** (spec §8.4; `generateAgentCardSignature` in the SDK, JWS over JCS via `jose`) — we already publish an Ed25519 key at `/public/keys`, so this is a few lines and directly supports the "trust before interaction" claim. **Push-notification configs** and **streaming**: `capabilities` declares both `false`; we poll `GetTask`. Fine for a demo; push is the v1.0 way to stop polling. | Good — one cheap gap |
| **AP2** | Extension declared on the card (roles merchant/shopper, `required:false`); cart + payment mandate objects signed Ed25519 | See *Claims* above: v0.2 requires SD-JWT VCs and a **non-Ed25519** Checkout JWT. Ours is "inspired", correctly labelled. | Declared, not conformant |
| **Model Armor** | Not used | Inline screening of `generateContent` prompts/responses via **project floor settings** (no code) or per-request templates; prompt-injection + jailbreak + sensitive-data filters; **free to 2 M tokens/month** ([pricing](https://cloud.google.com/security/products/model-armor)). A second screen on hostile listing text, behind — never instead of — the deterministic policy wall. | Not used — cheap to add |
| **UCP** (Universal Commerce Protocol) | Not used | Google's Jan-2026 standard for agentic checkout on AI Mode / Gemini; Merchant Center feed, US/CA/AU only, approved merchants. Roadmap wording only; advertising it would be hollow. | N/A |
| **Vertex Gen AI evaluation** · **Genkit** · **ADK (TypeScript)** / Agent Runtime | Not used — `bench.ts` is a custom harness; `decide.ts` is a custom propose→validate→fallback loop; the engine is hand-built | Judges accept Cloud Run + Gemini without an agent framework (theme page). ADK-JS has `RemoteA2AAgent` and `adk deploy cloud_run`; Gen AI eval has rubric metrics (`FINAL_RESPONSE_QUALITY`, `HALLUCINATION`) that could score our bench traces. None justify a rewrite before submission; mention as the managed path. | Deliberate |

### Non-Google pieces worth knowing about

Node 24 · Express 5 · strict TypeScript · `node:crypto` Ed25519 · GeoNames gazetteer (CC BY) · **`qrcode` loaded from `esm.sh` at runtime** — a CDN dependency in an installable, offline-capable app is a supply-chain and offline risk; vendor it (one file) before the video.

### Verdict

The Gen AI usage is deep where it should be — structured output everywhere, a cheap tier, deterministic validation and fallback, grounding with source tracing, embeddings with pre-filtered vector search, on-device Nano path — and deliberately shallow where the "feature" would be theatre (function calling, agent frameworks, caching on 100-token prompts). The real gaps are not Gemini features; they are **four protocol/platform items that moved in 2026** (A2A signed cards, AP2 v0.2 signature rules, `gemini-embedding-2`, Interactions API default) and **two Google security/quality services we don't touch** (Model Armor, Cloud Trace).

## What to add before 18 October, ranked by proof-per-hour

| # | Add | Effort | Why it scores | Risk |
|---|---|---|---|---|
| 1 | **Sign the Agent Cards** (A2A §8.4) with the existing receipt key (`alg: EdDSA`, `kid`, `jku: /public/keys`) using the SDK's `generateAgentCardSignature`; show a verifier fetching card + key | 1–2 h | A2A v1.0 headline feature; ties the identity story (card → receipts → pickup) to one published key | Low — SDK supports it; keep unsigned fallback |
| 2 | **Model Armor floor setting** on project `collab-55` for prompt-injection/jailbreak; log the sanitisation result on the hostile `@fluent` listing | ~1 h, no code | A named Google security product on the 40 % technical-merit axis, with a live demonstration we already have | Adds latency per call; measure; free tier covers us |
| 3 | **Vendor `qrcode`** (drop `esm.sh`) | 30 min | Removes a runtime CDN dependency from the demo path and the PWA | None |
| 4 | **Verify the Gemini Nano path in Chrome 148** and record it (private-note answer on device, no network call) | 1 h | Turns an untested claim into a shown one; the privacy story's strongest beat | Model download on first use |
| 5 | **Trial `gemini-embedding-2`** on `global`: re-embed Public facts, compare precision@3 and Hindi recall against the bench | 2 h | Latest model, multilingual; one-line change if latency holds | Latency on `global`; keep `-001` if p95 > 1.5 s |
| 6 | **Cloud Trace span per agent turn** (OpenTelemetry → Cloud Trace) | 2 h | Observability evidence for scalability; pairs with the benchmark | Low |

Defer past submission (documented as roadmap, not claimed): Maps grounding for shop discovery; Live API voice (Hindi is in its 70 languages); Google Wallet generic pass for the pickup QR (signed-JWT "Add to Wallet" link — straightforward later); Cloud Tasks for turns; Firebase AI Logic hybrid SDK; AP2 v0.2 conformance (ES256 + SD-JWT); UCP.

## Demonstration: aim for 2 minutes 45 seconds

1. 0:00–0:20: show a shop QR and a specific shopper need.
2. 0:20–1:00: Gemini clarifies the request; agents answer and negotiate. Show the owner's private limit and the smaller set of information shared with the counterparty.
3. 1:00–1:25: optional private price evidence; both confirm the exact item and amount; clearly labelled simulated payment.
4. 1:25–1:55: buyer shows pickup pass; seller collects; replay displays the original collection time.
5. 1:55–2:20: public verification succeeds; a modified receipt fails. Explain server-issued signatures in one sentence.
6. 2:20–2:45: show measured test results and the Google Cloud architecture. Keep unbuilt features on the roadmap.

## Measurements to collect

Use dedicated test accounts and synthetic secrets. Record attempted cases, successful executions, failures and skips separately. Privacy tests should inspect data visible to the attacking counterparty and also try encoded/multilingual extraction. Count negotiation limits separately from privacy leaks: accepting a limit-valued offer is not automatically a leak. Include infeasible pairs that should walk away. Report agreement rate, limit adherence, rounds and seller/buyer surplus where meaningful; routing accuracy on labelled requests; step latency p50/p95; and cost per completed request/deal.

Production `/health` counters are per process and may reset or come from different Cloud Run instances. Their difference is not reliable per-run billing. Include search charges separately from token estimates and label unknown costs. A load run is separate from functional validation and should use a bounded, explicit concurrency setting.

Compare the guarded agent to an appropriate baseline using the same scenarios; a small deterministic or manual-flow baseline can establish whether Gemini reduces owner interventions or improves successful completion. Do not fabricate lift, throughput or privacy percentages before measuring them.

## Current handoff

The seven must-do implementation areas are in the repo and deployed. Automated tests cover the full retail flow, chat sync/version changes, receipt tampering and one-time collection. The live Scheduler fired a synthetic watch and wrote one alert; the listing-origin ₹410 deal was paid in test mode and produced a public pickup pass. Cross-device chat rendering on both physical devices and seller redemption of that live pass still need the owners' signed-in sessions. The source tree passed 58 tests and the secrets pattern scan. Keep git push subject to the user's approval. Real UPI, passkeys, voice, Wallet passes and calendar remain out of scope.
