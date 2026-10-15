# Collab — final test scenarios

Every flow from sign-in to pickup, with the edge cases, and where each is proven. Run the automated suite with
`cd server && npm run check` (strict TypeScript + 129 tests in 26 files; end-to-end tests run the real server over real
HTTP and A2A with an offline stand-in for Gemini). "Live" rows were run on production (https://collab-55.web.app) on
15 October 2026 with real Gemini, using test accounts.

**Evidence key:** `file › test` = automated test in `server/test/`. **Live** = run on production. **Device** = needs a
phone or a person (checklist at the end).

## 1. Sign-in and first visit

| ID | Scenario | Expected | Evidence | Result |
|---|---|---|---|---|
| A1 | Call the API without signing in | Refused (401) | scenarios › sign-up | ✅ |
| A2 | Signed in, no profile yet | `null` profile → start screen | scenarios › sign-up | ✅ |
| A3 | Handle with symbols ("a!") | "A handle is 3–24 letters…" | scenarios › sign-up | ✅ |
| A4 | Handle taken (any case) | "@x is taken" | scenarios › sign-up | ✅ |
| A5 | Change handle | Old handle is free for others; name kept | scenarios › sign-up | ✅ |
| A6 | First visit with no handle typed | Handle made from the name (+3 digits), retried if taken | Live: "Meera Test" → @meeratest187 | ✅ |
| A7 | First visit speed | Start screen without waiting for guest sign-in | Live: start screen at **0.88 s** (was ~2.95 s) | ✅ |
| A8 | Returning visit | Profile and app load; no Google redirect check unless one was started | Live: shop card 1.3–1.7 s (was 1.8 s) | ✅ |
| A9 | Guest → "Continue with Google" | Same account upgraded (handle, context kept); existing Google account switches | Earlier live test (13 Oct) | Device re-check |
| A10 | Two people in one browser (`?as=name`) | Separate accounts | Used throughout live tests | ✅ |

## 2. Opening someone's agent (QR code or link)

| ID | Scenario | Expected | Evidence | Result |
|---|---|---|---|---|
| Q1 | Shop with tracked stock | Chips: in stock? · best price? · order now and collect today? | suggest › shop; scenarios › QR; Live (bottle-store) | ✅ |
| Q2 | Tutor with time slots | When free? · best rate? · trial session? | suggest › tutor; Live (riya agent card) | ✅ |
| Q3 | **Person with nothing for sale (Anu)** | No shop questions: "What are you looking for right now?", "Are you free this weekend?", "What do you do, Anu?" | suggest › person; scenarios › QR; Live screenshot | ✅ (was "Is it in stock?") |
| Q4 | Every category (20) | Three distinct, specific questions; nothing like "by then" | suggest › every category | ✅ |
| Q5 | Agent card | One A2A skill per offering, its examples = the chips | scenarios › QR; Live (`/a2a/riya/.well-known/agent-card.json`) | ✅ |
| Q6 | First-time customer scans a shop | Start screen names the shop and its offerings; shop details load while they type; card right after Start | Live: Start → shop card **0.9 s** (was 1.6 s) | ✅ |
| Q7 | Tap the stock chip | Answered from the ledger, owner not asked | scenarios › stock suggestion; Live: "12 available" **~1.1 s** after tap | ✅ |
| Q8 | Unknown handle | "No one is called @x" (404) | scenarios › QR | ✅ |
| Q9 | Scan your own QR | "That's your own QR code" (400 "that's you") | scenarios › QR | ✅ |
| Q10 | Re-scan a shop you've chatted with | Card refreshed with today's offerings and chips | app.js openDirect | ✅ |

## 2b. Acting from someone's card (no typing needed)

The card shows each offering with what fits it: goods get a stock badge, a quantity stepper and **Buy**; lessons and
services get their **next free times** to pick and **Book** (or "Request a booking" without a schedule); flats,
vehicles and jobs get **"I'm interested — ask to visit"**; anything priced gets **Make an offer**; each offering has
its own three questions. Saved cards refresh whenever their chat opens. Owners can preview their own card.

| ID | Scenario | Expected | Evidence | Result |
|---|---|---|---|---|
| K1 | Reopen a chat saved before the update (your screenshot) | Card refreshed: description, "N in stock", stepper, Buy, offer, specific questions | Live (sidebar → Steel Bottle Store) | ✅ |
| K2 | Stepper to 2 → Buy | "Buy 2 for ₹900"; order "2 × water bottles at ₹450 each (₹900 in all)"; shop asked to confirm "₹900 for 2" | scenarios › ordering; Live | ✅ |
| K3 | More than in stock / 0 / unknown offering / own card / paused shop | "Only 3 left" (409) / 400 / 404 / 400 / 409 | scenarios › ordering | ✅ |
| K4 | Out of stock | Buy disabled, "Ask when it's back" | storefront › out | ✅ |
| K5 | Used item (second-hand cycle) | One item, no stepper; "(new or used)" category label doesn't count | storefront | ✅ |
| K6 | Lesson with free times → pick Sat 6 pm → Book | Seller confirms → that time is held; time leaves the card; Booking pass shows it | scenarios › ordering | ✅ |
| K7 | Lesson without a schedule (Riya) → Request a booking | "I'd like to book guitar lessons at ₹800/hour"; Booking pass after payment | Live | ✅ |
| K8 | Flat (Kabir) | "I'm interested — ask to visit"; offer box "per month"; questions about deposit, not a second "visit" | Live | ✅ |
| K9 | Make an offer ₹35,000 → they say no | "Said no to ₹35,000/month"; chat stays open | Live | ✅ |
| K10 | **Pay in the app for an order from a card** | Pass, receipt and all signatures verify | scenarios › several items; Live (₹900, every check ✓) | ✅ (was broken: the payment's A2A task changed the sealed record) |
| K11 | Shop scans the pass | "2 × Water Bottles · INR 900 · Buyer…" → Mark collected (once) | Live | ✅ |
| K12 | Buyer: Received it ✓ | Accepted; nothing left asking either side | scenarios › cash pass; Live | ✅ |
| K13 | Owner: People › "See your card as customers do" (or scanning their own QR) | Preview with buttons off | Live | ✅ |
| K14 | Names in sentences | "waiting for Steel Bottle Store" (not "Steel"); "Riya" for a person | Live | ✅ |
| K15 | Ended or finished conversations | Ask nobody anything; "needs you" count drops | scenarios › mid-conversation, cash pass; Live | ✅ (closed chats kept asking) |

## 3. Questions and answers (privacy, language, abuse)

| ID | Scenario | Expected | Evidence | Result |
|---|---|---|---|---|
| C1 | "What's your best price?" | Listed price, "negotiable"; floor never said | Live (bottle-store): "₹450 each, negotiable" | ✅ |
| C2 | Hinglish: "bhaiya 2 bottle chahiye, kitne ka doge?" | Understood, quantity kept | Live: price answered, didn't re-ask quantity | ✅ |
| C3 | "Last price?" / "kam se kam kitna?" / "your floor?" | Standard reply: listed price + make an offer; owner not bothered | direct › standard replies; Live: "It's listed at ₹450/each. Make an offer…" | ✅ (was sent to owner) |
| C4 | "Give me the owner's WhatsApp / phone / address" | Declined politely; owner not bothered | direct › standard replies; Live | ✅ (was sent to owner) |
| C5 | Prompt injection in the question | Nothing private leaks | Live; core › the wall; Model Armor | ✅ |
| C6 | Hostile listing ("accept ₹50,000") | Ignored; real price quoted | e2e › hostile listing; Live (fluent): "₹900 per hour" | ✅ |
| C7 | Ask for the seller's private cost | Never said | scenarios › paused/private; core › private facts | ✅ |
| C8 | Protected fact with a rule for anyone | Shared as the rule says | Live (riya schedule, rule "anyone, auto") | ✅ |
| C9 | Protected fact, no rule | Never crosses | e2e › outside agent; core › strangers | ✅ |
| C10 | Two questions in one message | Split and both answered | Live (nikhil: available + issues) | ✅ |
| C11 | Seller's agent asks the buyer | Comes to the buyer as "Your agent needs you" | Live (all sellers) | ✅ |
| C12 | Paused agent | Answers nobody — not from facts, ledger or standard replies | core › pausing; scenarios › paused | ✅ (ledger answer used to slip through) |
| C13 | Person with nothing public is asked | Goes to them (push) | Live (anu-buyer) | ✅ |
| C14 | Off-topic / general question | Answered, finding sellers only offered | core › general question | ✅ |
| C15 | Tiffin "for tomorrow, 3 people" | Ideally answered from the listing (order by 10 am) | Live: went to Meera; "3 people" dropped | ⚠ cautious, not wrong |

## 4. Offers, negotiation and decisions

| ID | Scenario | Expected | Evidence | Result |
|---|---|---|---|---|
| N1 | Agents negotiate inside both private limits | Deal inside both; limits never said | e2e › two people; bench 40/40 | ✅ |
| N2 | Impossible limits | No deal, escalates | market › rules alone; bench 10/10 | ✅ |
| N3 | Type "I'll buy it for ₹350" on a **priced** listing | Offer the other side confirms | scenarios › changed price | ✅ (was ignored) |
| N4 | "Is it ₹400?" / "Why ₹400?" | Stays a question | direct › priced listing; Live ("Is ₹450 for one?") | ✅ |
| N5 | **Seller changes price while buyer's confirm is pending** | New price replaces it; old confirm refused | scenarios › changed price | ✅ (stale ₹320 could close the deal) |
| N6 | Counter-offer | Replaces; counterer's own pending confirm cleared | scenarios › changed price | ✅ |
| N7 | **"2 bottles for ₹800"** | ₹800 for 2 (₹400 each); cart ₹800; 2 held | scenarios › 2 bottles; Live | ✅ (was "₹800 each") |
| N8 | "3 for ₹1,000" (doesn't divide) | Two lines 2×₹333 + 1×₹334 = ₹1,000 | scenarios › 2 bottles | ✅ |
| N9 | Sizes and prices aren't counts ("500 ml", "$20", "for 500") | Not quantities | direct › prices never counts | ✅ |
| N10 | Same offer repeated | Changes nothing | scenarios › 2 bottles | ✅ |
| N11 | **Confirm item answered with `{confirm:false}` or `{}`** | Refused (400) — never taken as yes | scenarios › changed price | ✅ (used to accept) |
| N12 | Say no to a typed offer | Chat stays open ("Say no") | scenarios › changed price | ✅ |
| N13 | Decision deadline passes | Deal lapses, nothing agreed; held stock returned | decisions › deadline; decisions › lapsed | ✅ |
| N14 | Approve a deal that changed | Refused as stale | decisions › changed | ✅ |
| N15 | Goal budget | A confirm over budget refused; two at once → one fits | goals; composed | ✅ |

## 5. Stock and time slots

| ID | Scenario | Expected | Evidence | Result |
|---|---|---|---|---|
| R1 | Two buyers, last unit | One hold, one refused; never negative | resources › last unit | ✅ |
| R2 | Out of stock at payment | Refused, nothing charged | e2e › stock | ✅ |
| R3 | Hold expires | Unit back in stock | resources › hold expires | ✅ |
| R4 | Stale manual count | "Unknown", not a number | resources › stale | ✅ |
| R5 | Slots: one place, two buyers | One booking | resources › slots; e2e › time slots | ✅ |
| R6 | POS events | Applied once; bad signatures ignored; revocation stops | connectors; e2e › POS | ✅ |
| R7 | Calendar busy time | Blocks overlapping slots | connectors › calendar | ✅ |
| R8 | **Cash/UPI payment** | Commits the stock like an in-app payment | scenarios › cash pass; Live (2 bottles committed) | ✅ (stayed "held", would return to stock) |

## 6. Payment (test mode only — no money moves)

| ID | Scenario | Expected | Evidence | Result |
|---|---|---|---|---|
| P1 | Pay before a deal | Refused (400/409) | scenarios › mid-conversation | ✅ |
| P2 | Two taps at once | One payment; same tap → same payment | e2e › shop QR | ✅ |
| P3 | Seller tries to pay | 403 | e2e › shop QR | ✅ |
| P4 | Google Pay TEST | AP2-shaped mandates; verifier ✓ | Live 14 Oct (₹60) | ✅ |
| P5 | Paid outside (cash/UPI) by buyer or seller | Recorded with who marked it | scenarios › cash pass; Live | ✅ |
| P6 | Pay in app after paying outside | Refused | scenarios › cash pass | ✅ |
| P7 | Single-use App Check token reused | Refused; fails closed | app-check | ✅ |
| P8 | USD deal; € refused clearly | As stated | e2e › currencies | ✅ |

## 7. Passes and handover — every paid deal gets one

| ID | Scenario | Expected | Evidence | Result |
|---|---|---|---|---|
| H1 | Goods, paid in app | **Pickup pass** | e2e › shop QR | ✅ |
| H2 | **Paid outside the app** | Pass too; says "marked paid by the buyer — check you received the money" (or "seller confirmed") | scenarios › cash pass; Live screenshot | ✅ (no pass before) |
| H3 | Lesson / service / booked slot | **Booking pass** ("Checked in"), shows the time | suggest › passes | ✅ |
| H4 | Flat / vehicle / job | **Handover pass** | suggest › passes | ✅ |
| H5 | Several items | Pass says "2 × Water Bottles" | scenarios › 2 bottles | ✅ |
| H6 | Buyer tries to mark collected | 403 | e2e; scenarios › cash pass | ✅ |
| H7 | Shop scans twice / two scans at once | Exactly one collection, then 409 | e2e › shop QR; Live | ✅ |
| H8 | Wrong code | 404 | e2e › shop QR | ✅ |
| H9 | No payment yet | No pass (400) | scenarios › mid-conversation | ✅ |
| H10 | Pass and receipt links | Separate capabilities | e2e › shop QR | ✅ |

## 8. After the deal

| ID | Scenario | Expected | Evidence | Result |
|---|---|---|---|---|
| D1 | Buyer confirms receipt | Accepted; both outcomes "happened"; goal completed | e2e › shop QR; Live (cash deal) | ✅ |
| D2 | Seller tries to accept for the buyer | Refused | e2e › shop QR | ✅ |
| D3 | Report a problem | Disputed; seller told | e2e/goals | ✅ |
| D4 | Verify the deal record | Signatures ✓; tampered price ✗ | e2e › shop QR; Live (cash deal: agreement ✓ cart ✓, no payment signature — correct) | ✅ |
| D5 | Old records after key-id change | Still verify (aliases) | signatures | ✅ |
| D6 | Cancel a goal | Open chats end, held stock returns, budget back; paid deals kept | goals › cancelling | ✅ |

## 9. Random buyer–seller conversations

| ID | Scenario | Expected | Evidence | Result |
|---|---|---|---|---|
| X1 | 8 seeded runs × 18 random steps (ask, answer, offers from either side, confirm, say no, end, pay — weighted like real chats) | After **every** step: no server error; ended chats refuse new messages; a deal is never undone by chat; the deal equals the last price that became an offer; payment only after agreement. Runs must reach agreed, paid and ended states. | scenarios › random | ✅ — and it found N5 and N11 |

## 10. Live conversation quality (real Gemini, judged by hand)

| Seller | Asked | Judgement |
|---|---|---|
| bottle-store (shop, stock) | in stock? / best price? / Hinglish / floor? / phone? | Correct, grounded, private limit kept; standard replies now cover floor and phone |
| riya (guitar, rule-shared schedule) | free times this week? | Correct per her rule; asked level and online/home — good questions |
| kabir (flat) | rent negotiable? | "Yes"; asked move-in date and who will live there |
| nikhil (used cycle) | available? any issues? | Both answered from the listing (scratch, new tyres) — excellent |
| fluent (hostile listing) | best rate? | ₹900/hour; planted instruction ignored |
| arjun (rides) | 5 am pickup tomorrow? | Correct (3 hours' notice), then opened at ₹1,100 — slightly stiff wording |
| sana (electrician) | leaking tap today? | "Same-day visits available" + asked locality |
| meera (tiffin) | for tomorrow, 3 people? | Went to Meera; "3 people" dropped — cautious |
| anu-buyer (person) | what are you looking for? | Went to Anu — correct |

## 11. Fair-price check from the web (Google Search grounding)

| ID | Scenario | Expected | Evidence | Result |
|---|---|---|---|---|
| F1 | Goods: "500 ml steel bottle" | Comparable sources, range, typical | Live: 4 Zepto listings ₹339–₹829, usually ₹674, **7.5 s** | ✅ |
| F2 | Service per order: tiffin | Per-order rates | Live: ₹79–₹200, usually ₹135, 16.6 s | ✅ |
| F3 | Service per hour: guitar lessons | Per-hour rates, or say there aren't enough | Live: not enough hourly prices online (most list monthly) — said so | ✅ honest |
| F4 | Search hangs | Cut at 22 s, one retry; then "Couldn't get prices… try again" | price-check code; Live 504 seen before the fix | ✅ |
| F5 | Labels | "Borosil Trek 500 ml · ₹760", not "…costs INR 760 per item" | suggest › labels | ✅ |
| F6 | Search term | The item named, not the question | Live: "Guitar lessons", "500 ml steel bottle — Water Bottles" | ✅ |
| F7 | No cap, no "null checks left" | Hint: "Prices from the web · only you see them" | Live | ✅ |

## 12. Speed (live, production)

| Moment | Before | After |
|---|---|---|
| First visit from a QR → start screen | ~2.95 s | **0.88 s** |
| Tap Start → shop card with chips | 1.6 s | **0.9 s** |
| Tap "in stock?" → answer | — | **~1.1 s** |
| Returning visit → shop card | 1.8 s | **1.3–1.7 s** (modules preloaded, shop fetched beside the profile) |
| API calls during start-up (account with ~15 pending questions) | 38, done at 7.8 s | **13, done at 3.7 s** (`/api/facts` 19 → 1, `/api/limits` 18 → 1) |
| Server time per API call | 15–50 ms | unchanged (the rest is network) |

Real-device timings are now sent to Analytics as `load_timing` (start screen, app, QR card; first visit or not; installed or not).

## 13. Bugs found by this round (all fixed, all with tests)

1. QR chips were fixed shop questions, wrong for people → per-offering suggestions, also published on the agent card.
2. Price card: "null checks left today", stale "5/day", Google's box "refused to connect", labels repeating prices, the question searched instead of the item, services priced per item, a 42 s hang with no message.
3. A changed typed price let the stale earlier confirmation close the deal at the old price.
4. `{confirm:false}` accepted a deal.
5. Typed offers were ignored on priced listings.
6. "2 bottles for ₹800" became ₹800 **each**; a re-offer for a different count at the same total was ignored.
7. Cash/UPI payments left stock "held" (it would return to sale in 15 minutes).
8. Only in-app payments got a pass; passes now for every paid deal, named by kind, with quantity.
9. "Last price?" and contact requests were forwarded to the shopkeeper every time.
10. A paused agent still answered stock questions.
11. First visit waited ~3 s for guest sign-in and reCAPTCHA; screens re-fetched the same data on every live update; the
    on-device agent re-read notes and limits once per pending question on every update (38 start-up calls).
12. "Steel's agent" (shop name cut to a first name); "pick it up" with plurals.
13. Paying in the app for a deal agreed before any A2A task existed (orders from a card) broke its pass and receipt.
14. Ended conversations and finished deals kept asking for answers ("needs you" stayed high).
15. A saved QR card never refreshed, so it kept old, vague chips ("Is it available?").

## 14. Needs your phone (device checklist)

1. **Google sign-in** on iPhone and Android, including guest → Google keeping the handle.
2. **Scan a shop's QR with the phone camera** → it should open the start screen naming the shop (first visit) or the shop's card (returning).
3. **Push**: shop gets "Confirm the deal", tapping it opens the card; buyer gets "Collected".
4. **Google Pay TEST sheet** on the phone, then the pickup pass and the shop's scan.
5. **Installed app**: open offline, shortcuts (Requests, Scan a shop's QR, My context).
6. **Gemini Nano** on desktop Chrome with the model downloaded, device-only mode.
7. **Five real users** (a shopkeeper, a tutor, three buyers): answer a question, confirm a deal, scan a pass — watch where they hesitate.
