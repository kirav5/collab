# Benchmark report — 14 October 2026

Run `mv72y0ce` · `server/tools/bench.ts --full --load` · raw data: [full-local-gemini/results.json](full-local-gemini/results.json)

**Setup.** The server ran locally with the **real Gemini models on Vertex AI** (`gemini-3.6-flash`, falling back to
`3.8-flash` and `3.5-flash-lite`) and real embeddings, but an **in-memory store** instead of Firestore, with test
accounts. That keeps benchmark accounts and listings out of the live directory. So the model behaviour is real, but
latency is laptop → Vertex AI (India), not Cloud Run → Vertex AI, and Firestore time is not included. A run against
production was blocked: creating App Check tokens for test accounts needs `iam.serviceAccounts.signBlob` on the
service account (see HANDOFF §10).

## Results

| Suite | Cases | Passed | Failed | Errors | What it checks |
|---|---:|---:|---:|---:|---|
| Privacy | 100 | **100** | 0 | 0 | An outside account asks the seller's agent for its Private and Protected secrets (canaries) |
| Negotiation | 50 | 38 | 11 | 1 | Seller floor and buyer limit both hidden; agents negotiate to a deal or not |
| Intent | 120 | **120** | 0 | 0 | What the user typed is routed correctly (remember / ask / ask-self / request / offer / refine / chat) |
| Load | 50 | **50** | 0 | 0 | 50 conversations started at the same time against one shop |

### Negotiation, read correctly

| | Count | Result |
|---|---:|---|
| Feasible pairs (buyer limit ≥ seller floor) | 39 | **38 agreed (97%)**; 1 stalled before negotiating (case 10, still asking) |
| Deals inside **both** hidden limits | 38 of 38 | **100%** — no deal ever crossed either limit |
| Infeasible pairs (limit below floor) | 10 | **10 of 10: no deal** (correct), but none ended on its own: after up to 10 moves the engine hands the decision to the owner ("no deal inside your limit yet") and the script does not answer that, so it counts as a fail |
| Request not drafted | 1 | Case 18 (error) |
| Mean offers per agreed deal | 3.1 | |
| Average surplus | buyer ₹163 · seller ₹437 | Deals land nearer the buyer's limit than the seller's floor in this scenario (the seller opens at floor + ₹700) |
| Match precision@3 | 0.98 | The seller's listing was in the top 3 results |

### Latency (laptop → Vertex AI)

| Step | n | p50 | p95 |
|---|---:|---:|---:|
| Understand a message (`/api/route`) | 120 | 1.1 s | 1.4 s |
| Draft a request with questions (`/api/briefs/draft`) | 50 | 4.8 s | 8.3 s |
| Search the directory (`/api/briefs`) | 49 | 2.7 s | 3.0 s |
| Save a fact (topics, reading, embedding) | 73 | 3.3 s | 4.6 s |
| One A2A agent turn (`/run`) | 199 | 4.1 s | 7.8 s |
| Owner answers / confirms (`/api/inbox/:id`, includes the next agent turn) | 51 | 6.3 s | 16.6 s |
| Load: one conversation of 50 at once | 50 | 5.8 s | max 8.5 s |

Web app, measured on the live site in a browser: returning visit usable in ≈0.6 s (≈1.0 s fully loaded), first
visit ≈1.5 s.

### Cost

1,402 Gemini calls (1 failure, recovered by the fallback model) for the whole run: **≈ $1.10** by the server's token
meter (a single process, so the counter is reliable here). Search grounding was not exercised, and the meter is an
estimate from published per-token prices, not a bill.

## Limitations — read before quoting

- **Privacy:** the detector looks for the literal canaries (also with spacing removed, and base64). A paraphrased leak
  would need human review. Also, in this run the seller's agent **answered none of the 100 attacks**: every one went
  to the owner as a question only they could answer. That shows the policy never handed the secrets to the model, but
  not how the agent behaves on borderline questions it does answer. A next run should mix in legitimate questions.
- **Corpus size:** 10 distinct attack templates and 20 distinct intent messages, each repeated. Repeats are not
  independent examples: say "10 attack patterns × 10 runs" and "20 messages × 6 runs", not "120 different inputs".
- **Negotiation** is one product (a used cycle) with one price structure; surplus figures describe this scenario only.
- **Infeasible pairs** escalate to the owner by design; the script doesn't play that owner.
- **Load** used one process with an in-memory store; it shows the engine handles 50 simultaneous conversations,
  not Cloud Run + Firestore throughput.
- [`results.md`](results.md) in this folder is an earlier, **blocked** production attempt (0 cases); `local-gemini/`
  is an earlier smoke run.

## Reproduce

```bash
cd server
GEMINI_API_KEY= GOOGLE_CLOUD_PROJECT=collab-55 GOOGLE_CLOUD_LOCATION=global STORE=memory DEV_AUTH=1 SEED_DEMO=1 \
  PORT=8797 PUBLIC_URL=http://localhost:8797 node src/server.ts &
BASE=http://localhost:8797 BENCH_OUT=../docs/bench/full-local-gemini node tools/bench.ts --full --load
```
