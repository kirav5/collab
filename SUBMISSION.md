# Submission — brief description

**Theme:** Retail & Commerce — Intelligent Customer and Business Experiences

**Collab: personal agents for neighbourhood commerce — scan a shop, agree within private limits, collect once.**

Everyone gets a personal agent. A shopper scans a shop's QR code (or describes what they need) and their agent talks
to the shop's agent over Google's **A2A protocol**: it asks questions, the shop's agent answers from what the owner
chose to share, and the two agents negotiate — each inside its owner's private limit, which the other side never
sees. Owners are asked only when it matters (a question only they can answer, a deal to confirm), through live
interactive cards and push notifications. When both confirm, the shop's agent issues a signed cart, the shopper pays
(an AP2-inspired **test** payment — no money moves), and gets a **pickup pass** the shop scans to hand over the item
exactly once. Anyone can check the deal record against Collab's published Ed25519 public key.

Information has three levels: **Private** (stored in the owner's account, never shared with the other party),
**Protected** (shared only with people a rule names, on its topics) and **Public** (discoverable). A deterministic
policy decides what each asker may see before anything reaches the model.

**Google Cloud:**

- **Gemini (Vertex AI):** routes what the user types, drafts requests and asks clarifying questions, ranks matches,
  answers only from allowed facts with quoted evidence, judges answers, gathers a seller's questions, chooses
  negotiation moves from numbers only, and checks fair prices with **Google Search grounding** (every price must
  trace to a search source). Code validates every output. **Gemini embeddings** + Firestore vector search power the
  directory.
- **Cloud Run:** the server — one A2A agent per person (Agent Card + JSON-RPC, official A2A SDK), the API and the
  negotiation engine.
- **Firestore:** profiles, facts with a vector index, sharing rules, live conversations, inboxes, A2A tasks, deal
  receipts, pickups and an audit log.
- **Firebase:** Hosting (an installable web app), Authentication (Google or guest), App Check (reCAPTCHA
  Enterprise) and **Cloud Messaging** for push. Also **Cloud Scheduler** (agents that keep watching a request),
  **Secret Manager** and **Cloud Monitoring**.

Test payments only; signatures are issued by Collab's server on behalf of its agents.
