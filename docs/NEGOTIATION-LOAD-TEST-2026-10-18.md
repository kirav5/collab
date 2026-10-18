# Collab — 126+ negotiations on production: sync and correctness report, 18 Oct 2026

**What ran:** 126 complete negotiations on production (https://collab-55.web.app), from the test account
`@sellertest816` against 28 live demo agents across every category, real Gemini, real A2A turns. Each request went out
with a private limit and "close on its own":

- 112 with a limit at or above the seller's private floor (a deal is possible);
- 14 with a limit below the seller's floor (no deal should happen).

Questions only a person can answer were answered by the test harness, as a person would. The test account's request
allowance was raised for the run only (`QUOTA_BOOST_UIDS`, set on that deploy and removed after).

**What was checked, for every conversation:** the conversation's state against its agent log and its signed receipt
(server data), then what the screens show (Activity counts, deal stage, deal price) against that state, at Mac size
(1440 × 900) and iPhone size (390 × 844), plus real iOS Safari rendering in the iPhone 17 Pro simulator.

## 1. Results

| Measure | Result |
|---|---|
| Deals possible → closed | **106 of 112 (95%)** — the other 6 were found and fixed (section 3) |
| Below-floor cases → deals | **0 of 14** (correct: neither agent goes past its owner's limit) |
| Deals outside a limit | **0** — every price was within the buyer's limit and at or above the seller's floor |
| Time to an agreed deal | median **22 s**, 90% within **48 s**, slowest 222 s (a demo owner had to answer first) |
| Deals with no person answering anything | **56** of 106 |
| Search found the intended seller | 122 of 126 |
| Server errors | 0 |
| State = agent log = receipt, fully | **105 of 126** before the fixes (failures below) |
| Every agreed deal's signed receipt verifies | yes (all) |
| Activity counts on screen = server | yes (Mac and iPhone) — the one agreed deal still awaiting payment is counted under "Awaiting you" by design |
| Deal stage and price on the card = server | 10 of 10 sampled, on Mac and on iPhone |
| Sideways scroll at iPhone width | none |

## 2. Is everything in sync?

| Check (per conversation) | Before fixes | Notes |
|---|---|---|
| Agreed ⇔ a deal confirmed by both sides | ✅ all | |
| Agreed ⇔ "Deal agreed by both owners" in the log, after "Tentative deal" | ✅ all | |
| Every offer in the state appears in the log, same amount | ✅ (10 flagged were the checker misreading "₹1.11 Cr") | |
| No amount in the log that was never offered | ✅ (23 flagged were crore/lakh formats the checker misread) | |
| Log in time order | ✅ all | |
| Nothing left waiting / open after a conversation ends | ✅ | |
| **No question left "asked" in an agreed deal** | ❌ **10** | Fixed |
| **No offer repeated by the same side while there's room** | ❌ **3** (seller held a price two rounds) | Fixed. (In the re-check, 3 more "repeats" were a seller holding at its own limit — no room left, correct.) |
| Receipt verifies (signature + registered) | ✅ all agreed | |

## 3. Problems found and fixed (deployed, build 10a64d2)

1. **Newer conversations invisible past 100–200 (stalls).** Conversations were read without an order, and Firestore
   returns them oldest first; past the limit the ones going on *now* were left out. The inbox then missed a demo
   owner's question in newer conversations (4 logo-design conversations stalled), and Activity could miss them too.
   → Read newest-first with a new Firestore index (participants + updatedAt). Verified: the 4 stalled questions
   appeared at once.
2. **Questions left "asked you" after a deal closed (10).** → When a deal is agreed, open questions are marked "not
   needed — the deal was agreed" and their inbox items closed.
3. **"4 of 4 questions answered" when all were declined.** → The card counts real answers and says "N not shared".
4. **A deal possible at the seller's floor missed (2).** The seller's agent used its 5 offers before the buyer's 5th
   (the one reaching its limit). → Both sides reach their limit by their 4th offer.
5. **Same price twice in a row (3).** The no-repeat rule covered only the rules' offers, not Gemini's. → An agent's
   offer can't repeat its last price while there's room to its limit.
6. **Odd first offers (₹1,06,96,900, ₹1,784).** → The first offer is rounded to three significant figures in the
   owner's favour, never past the limit.

7. **A seller's agent crawling toward its limit.** Gemini's offers could move far slower than the schedule
   (₹1,720 → ₹1,650 → ₹1,610 …) and run out of offers above the buyer's limit. → An agent offer much slower than the
   schedule is replaced by the scheduled one (#32).
8. **A stalled conversation the watchdog never looked at.** The minute watchdog read the 100 *oldest* conversations
   per phase; newer stalls were outside that window. → It reads the newest 200 (new index on phase + updatedAt) (#32).
9. **A question pending with nobody asked.** One logo conversation sat in "asking": the buyer's question to the seller
   was pending, but the record of who it waited on had been dropped (a save from an older copy), so it showed in no
   inbox. → The watchdog asks such a question again — the same inbox item, never twice (#33). Verified on production:
   the stuck conversation's question reappeared within a minute of deploy, was answered, and closed at ₹4,800.

## 4. Re-check after the fixes (production, builds 064023a and 85fe1c1)

24 negotiations on the first fixed build, then 8 targeted ones (portrait and logo, the two that hadn't closed),
with the test account on its **normal** request allowance (the load-test boost was removed with this deploy).

| Measure | Result |
|---|---|
| Deals outside a limit | **0** |
| Below-floor cases → deals | **0** |
| Agreed deals with a question still "asked" | **0** |
| First offers | all round numbers (₹1,800, ₹5,100, ₹1,06,00,000 …) |
| Stalled conversations | the one found (logo, "asking") freed by the watchdog and closed |
| Portrait cases at ₹1,500–1,545 that didn't close | **correct** — see below |

**The portrait "misses" were the test's assumption, not the agents.** The demo seller's stored limit on production is
₹1,600 over 8 rounds (changed from the seeded ₹1,500 at some point), so its agent rightly stopped at ₹1,600 and held
there; buyers capped at ₹1,500 or ₹1,545 can't get a deal, and both agents handed the decision to their owners. With a
₹1,800 limit, both re-runs closed at ₹1,615 in 48 s and 74 s.

Targeted re-check (normal allowance, so times include waiting out "Slow down a little"):

| Seller | Buyer's limit | Seller's limit | Result | Offers (seller / buyer) |
|---|---|---|---|---|
| Portrait | ₹1,500 | ₹1,600 | no deal (correct), handed to owners | 1,800 → 1,600 / 1,270 → 1,480 |
| Portrait | ₹1,545 | ₹1,600 | no deal (correct), handed to owners | 1,800 → 1,600, held / 1,310 → 1,540 |
| Portrait ×4 | ₹1,800 | ₹1,600 | **₹1,615** each, 48–226 s | 1,800, 1,700 / 1,530, 1,615 |
| Logo ×2 | ₹4,800 (= floor) | ₹4,800 | **₹4,800** each | 6,000, 5,400, 4,920, 4,800 / 4,080, 4,440, 4,680 |
| Logo | ₹4,944 | ₹4,800 | **₹4,800** | 6,000, 5,400, 5,000 / 4,200, 4,500, 4,800 |
| Logo | ₹6,000 | ₹4,800 | **₹5,250** | 6,000, 5,400 / 5,100, 5,250 |
| Logo (the stalled one) | ₹4,944 | ₹4,800 | **₹4,800** after the watchdog re-asked its question | 6,000, 5,400, 5,000 |

**All 9 deals possible closed; 0 outside a limit; 0 repeats while there was room; 0 questions left open.** Across
the whole run (126 + 24 + 9), every conversation's state, agent log and receipt agree, and the screens match the
server on Mac and iPhone sizes.

## 5. Follow-ups — all fixed (#34, #35)

| Was | Now |
|---|---|
| The demo portrait seller's limit had drifted to ₹1,600 / 8 rounds (someone acting for it chose that, and it was stored for everyone) | A limit chosen while acting for a demo person applies to that conversation only; drifted demo limits are reset on start. Production is back to ₹1,500 / 5. |
| A person running 2 negotiations while answering questions hit "Slow down a little" within minutes (60, then 4 a minute) | 120, then 10 a minute; answering your own agent's question costs 1 instead of 2. |
| Below-floor conversations stayed "negotiating" until someone acted | After a day with neither limit changed, the conversation closes politely ("Closed without a deal… either side can start again"), both inbox items close and the owner is told. Also fixed: a reminded question stayed "due" for ever, so past 50 of them newer deadlines weren't processed — it now leaves the due list. |
| "₹1.11 Cr" on cards and "₹1,16,00,000" in the log | One style, exact: ₹1,16,00,000 everywhere; Gemini's "₹1.16 Cr" / "₹6.8 lakh" are converted. |
| Role words in Gemini's lines ("your client", "lower her offer") | A line naming a client, customer, buyer or seller, or saying he/she, is replaced by the plain line ("Could you do ₹1,600?"); the prompt says the same. |
| "ACTIVITY" twice at the top of side-panel screens | The repeated label is removed. |
| The test answered questions with canned words | The re-check below answers each question as a person would. |

### Re-check with the follow-ups live, answering as a person would

Six negotiations on production after #35, each question answered with a specific, human answer ("I have a clear
front-facing photo of my parents from their anniversary", "Warm and hand-made: earthy colours…"), normal allowance:

| Seller | Buyer's limit | Seller's limit | Deal | Time |
|---|---|---|---|---|
| Portrait | ₹1,500 | ₹1,500 (reset) | **₹1,500** | 29 s |
| Portrait | ₹1,545 | ₹1,500 | **₹1,520** | 27 s |
| 3BHK flat | ₹1,29,00,000 | ₹1,28,00,000 | **₹1,28,50,000** | 25 s |
| 3BHK flat | ₹1,32,00,000 | ₹1,28,00,000 | **₹1,28,50,000** | 16 s |
| Logo | ₹5,000 | ₹4,800 | **₹5,000** | 21 s |
| 2BHK rent | ₹35,000 | ₹34,500 | **₹35,000** | 20 s |

6 of 6 closed, all inside both limits, no "Slow down" waits, no "₹… Cr" anywhere, no role words in the agents'
offers. Two things it surfaced, also handled:

- **Role words in the request's summary** ("A client requires a custom logo…", "A buyer is looking to purchase…") —
  the first line the other agent reads. The summary now speaks as the request ("Needs a custom logo…", "Looking to
  purchase…"), and Gemini is told to write it that way (#36).
- **Old canned answers come back.** The flat's agent answered "Own funds, no loan" and "This Saturday, any time after
  10 am" for the test account — remembered answers from earlier harness runs, reused as designed ("answered once,
  never asked again"). The feature works; the test account's remembered answers are test leftovers and should be
  cleared in About me → remembered answers before any further testing on it.
