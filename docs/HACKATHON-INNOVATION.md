# Collab: AI Builder Cup innovation assessment

Reviewed 14 October 2026 against the official public pages. The supplied dashboard link requires login; dashboard-only instructions have not been verified.

## Recommendation

Position Collab as **personal agents for neighbourhood commerce: scan a shop, agree within private limits, and collect once**. Focus the demonstration on one physical retail purchase. The reusable technology can serve other categories, but listing every category weakens the retail story.

The differentiation to demonstrate is the combination of bilateral negotiation, selective disclosure, owner control, and physical handover. Do not claim that agent shopping, QR pickup, public-key signatures, or search grounding are individually new. Google and Shopify already offer agentic commerce infrastructure ([Google announcement](https://blog.google/products/ads-commerce/agentic-commerce-ai-tools-protocol-retailers-platforms/), [Shopify Agentic Storefronts](https://www.shopify.com/news/ai-commerce-at-scale)). This is a positioning recommendation, not evidence of a world-first invention.

## Fit with the challenge

Retail & Commerce explicitly includes discovery, conversational shopping, and improvements across physical and digital commerce. The published scoring is technical merit and Gen AI implementation 40%, problem alignment and impact 25%, innovation 25%, and UX 10%. Gemini and deployment on Cloud Run/Firebase fit the technology requirements. Source: [official challenges and requirements](https://aibuildercup.com/themes.html).

The public timeline gives 18 October 2026 for submission and 14 October for team formation. Source: [official timeline](https://aibuildercup.com/).

**Eligibility needs clarification.** The [official FAQ](https://aibuildercup.com/Faqs.html) says only fresh projects built during the hackathon timeline qualify and excludes submissions based on pre-existing projects. PRD and HANDOFF disclose ported logic from native Collab. The first web-repo commit is 13 October; that alone does not establish eligibility of reused work. Ask the organizers whether the disclosed reuse is permitted; do not remove provenance or describe it as all-new. The FAQ also requires 2–4 eligible team members, a deployed prototype, public repository, a video under three minutes, and a deck. The public theme page contains unrelated category wording in its submission section, so confirm the actual dashboard category and template before submitting.

## What to finish and how to prove it

| Priority | Innovation to demonstrate | Repo evidence today | Proof for judges |
|---|---|---|---|
| 1 | Two agents negotiate while each owner's exact limit remains unavailable to the other agent | A2A engine, policy filter, numeric negotiation guards exist | Two accounts with different private limits; include a hostile request; show the final amount and information actually disclosed |
| 2 | A digital agreement leads to a single physical handover | Test payment exists; pickup pass remains planned | Seller collects once; simultaneous/repeated redemption cannot create a second collection; buyer/stranger cannot collect |
| 3 | A receipt another developer can check | SHA-256 registry and HMAC exist; public-key verification remains planned | Download the receipt and verify using public key only; change amount or party and show rejection |
| 4 | Private evidence helps an owner decide whether to accept | Similar-deal aggregates exist; Google Search price check remains planned | Comparable items, currency, condition, unit and dated sources; abstain when evidence is weak; result absent from peer-agent payload |
| 5 | Measured reliability of the agent workflow | Unit/API tests and live-case script exist; full benchmark remains planned | Actual attack pass/fail denominators, limit adherence, completion rate, p50/p95 latency and cost estimate with limitations |

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
- **Payments:** Label the current flow “AP2-inspired test payment; no money moves” until conformance is verified. The current [AP2 documentation](https://ap2-protocol.org/) describes v0.2 checkout and payment mandates and verifiable credentials; this code advertises a v0.1 extension and uses custom JSON objects. Ed25519 alone does not establish AP2 conformance or external payment settlement.
- **Fair price:** Google Search grounding supplies evidence, not a certified fair valuation. Do not turn unrelated products or asking prices into claims about actual sale prices. A number appearing in generated prose does not establish that a source supports it. Require comparable evidence and allow “not enough information.” Source links and required Search suggestions must follow [Google's grounding guidance](https://cloud.google.com/vertex-ai/generative-ai/docs/grounding/grounding-with-google-search).

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

## Build order

Finish pickup, signed export/public verification and private grounded checks; run full retail and regression tests; add the reproducible benchmark; verify device sync, scheduler delivery and a listing-origin payment; reconcile docs and scan tracked files for secrets. Keep git push subject to the user's approval. Real UPI, passkeys, voice, Wallet passes and calendar remain out of scope.
