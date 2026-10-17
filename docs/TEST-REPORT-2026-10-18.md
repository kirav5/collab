# Collab — end-to-end test report, 18 Oct 2026

Tested in a real browser against production APIs (Gemini; no on-device model), as two accounts: the signed-in
`@sellertest816` (prod site) and a fresh guest `@localtest691` (local web build, `node scripts/serve-web.mjs`, APIs
proxied to https://collab-55.web.app). Server suite: 189 tests pass.

## Flows run

| # | Flow | Result |
|---|------|--------|
| 1 | New chat → suggested starts (step 1 of 2) | ✅ ideas personal to the account; now instant from the device's last copy |
| 2 | Request → request card → clarifying questions (step 2) | ✅ after fixes (B2, B4, speed) |
| 3 | No match → Google Maps nearby → Keep watching | ✅ after fix (B3) |
| 4 | Request → match (guitar teacher) → agents ask → limit → deal → confirm | ✅ |
| 5 | Request → Meera (tiffin) → typed lower offer → negotiation | ❌ stalled → ✅ fixed (B18, B19) |
| 6 | Request → electrician → agents talk to several at once (discovery) | ✅ new |
| 7 | Deal → Checkout → pay in app → pass → receipt | ✅ new checkout panel |
| 8 | Receipt → Verify (public page) → tamper test | ✅ signature verified; changed price refused |
| 9 | Receipts view → Verify all | ✅ new |
| 10 | Listing from text → common questions → publish | ✅ after fixes (B9–B11) |
| 11 | My card → QR, share, agent card | ✅ redesigned |
| 12 | About me, Privacy, Settings | ✅ remembered answers section; Animations setting removed |
| 13 | Phone width (375 px): chat, discovery, panel | ✅ no sideways scroll |

## Context: answered once, never asked again

- Every answer the owner gives — to another agent's question, to a request's or a listing's questions — is kept
  (`server/src/core/memory.ts`), matched by the question's words (the same question in other words counts).
- Asked again: the agent answers itself with the owner's exact words (no model), recorded in "What your agent
  shared". Contact details are never reused. Each answer can be set to "Asks me" or deleted in About me.
- New requests and listings fill in from earlier answers ("From what you said before: Lunch only").
- Verified live: an earlier "Lunch only" answer filled a new tiffin request automatically.

## Bugs found and fixed

| # | Bug | Fix |
|---|-----|-----|
| B1 | Start ideas: blank while loading | Skeleton chips; cached on device |
| B2 | Every tapped answer brought two new questions (endless) | Answers apply at once; at most two questions |
| B3 | Google Maps results vanished after Keep watching | Kept with the card |
| B4 | "📍 Online · Online" | Duplicates dropped |
| B5 | "Adjust it, then send" stayed above the matches | Line follows the step |
| B6 | "under Requests" (screen is Activity); "Your agent needs you" on the other side's demo question | Wording |
| B7 | Yes/No buttons on either/or questions ("acoustic or electric?") | Only for real yes/no questions |
| B9 | Listing details ran into the text ("…Koramangala Condition: …") | Sentence break |
| B10 | "Lowest you'll accept" prefilled with the asking price | Empty, with a hint |
| B11 | Raw keys on listings ("age years 1", "mode in_person") | "Age: 1 year" |
| B12 | "IPhone 13" | Brand casing (iPhone, iPad…) |
| B13 | Receipt: agreed price without its unit | "₹740/hour" |
| B14 | Agent card: name repeated, raw URL, every offering as a paragraph | Rebuilt: record, what it does, prices, never-shares |
| B15 | Hardcoded category questions asked of everyone ("How many revisions are included?" to an electrician) | Removed; only Gemini's questions for that request and listing |
| B16 | Requests took ~25 s (a second full re-read to apply an answer) | ~8 s first time, ~2 s cached; taps instant |
| B17 | Listing questions' suggested answers arrived seconds after the card | Returned with the listing draft |
| B18 | **Negotiation deadlock**: two buyer offers in a row → neither agent moved | Turns follow who offered last; stalled conversations are woken |
| B19 | Agent message invented terms ("extend the credit period to 30 days") | Messages with numbers or terms not in the offer are replaced |
| B20 | "Fits you" quoted the remembered question, not the answer | Quotes the answer |

Speed: model answers are cached for an hour (identical requests share one call); negotiation, requirement questions
and clarifying questions use the fast model tier.

## New

- **Checkout** (side panel): order, what your agent saved, fee, total; Google Pay (test environment) or pay in the
  app; then the pass and the receipt.
- **Receipts** (sidebar): every signed deal, filters, Verify all, and what receipts do for the network (the record
  other agents read; anonymised prices people see when setting a limit).
- **My card**: profile, QR and Share first; the agent card reads as a summary.
- **Discovery**: Find people contacts the best matches (up to 3) at once — only the shared request goes out — and one
  live list shows each conversation, what needs you on top.

## Still open

- Google Pay sheet not completed in testing (needs a Google account); the in-app demo payment was.
- A request's time ("tomorrow evening") still isn't carried into the booking.
- Listing "common questions" are still steered by per-category hints in `domains.json` (Gemini writes them per
  listing; the hints only guide it).
- Recording of Index's discovery flow couldn't be opened (macOS temporary folder); built from the description.
