# Submission — brief description

**Theme:** Retail & Commerce — Intelligent Customer and Business Experiences

**Collab** gives everyone a personal agent that can ask anyone's agent for anything — a flat, a tutor, a ride, a
repair — and negotiate for them, while their private context never leaves their device. You say what you need;
Gemini shapes it into a request with you (asking what's missing, with tap-to-answer options); your agent finds the
people whose public offerings fit and talks to their agents over Google's A2A protocol. Their agents answer from what
their owners chose to share, ask what they need to know, and negotiate inside each owner's private limit. Owners are
notified only when needed — a question only they can answer, a deal to confirm — through live, interactive cards.

Information has three levels: **Private** (stored only on the device), **Protected** (shared with the people a rule
names, on its topics), and **Public** (discoverable). The always-on agent holds only Protected and Public facts, and a
deterministic policy decides what each asker may see before anything reaches the model — so private context cannot be
drawn out by any question. Limits stay on the device: the agent uses them one move at a time and never states them.

**How we use Google Cloud:**

- **Gemini (Vertex AI):** reads requests and offerings in any language (category, fields, the request's own filters),
  writes the brief providers see (no money, no limit), asks clarifying questions, ranks matches with reasons, answers
  only from allowed facts with quoted evidence, judges answers, gathers requirements for providers, and chooses
  negotiation moves from numbers only. Every output is checked by code before use. **Gemini embeddings** power search
  by meaning; **Gemini Nano** answers from private notes on the device in Chrome.
- **Cloud Run:** the server — one A2A agent per person (Agent Card + JSON-RPC, official A2A SDK), the web API, the
  directory and the engagement engine.
- **Firestore:** profiles, Protected and Public facts with a **vector index**, sharing rules, conversations between
  agents (streamed live to both people), device inboxes, A2A tasks and the audit log of what each agent shared.
- **Firebase:** Hosting for the web app (with rewrites to Cloud Run) and Authentication (anonymous guests or Google).
