# Collab — 112 retail and commerce journeys, and how to make each simpler

Written 17 October 2026 for the AI Builder Cup theme **Retail & Commerce**. [TEST-SCENARIOS.md](TEST-SCENARIOS.md) proves
that each flow *works* (122 checks). This document asks a different question for each real journey: **how much
does the person have to do, and what should we remove?** Payment stays a demo (test mode); everything else is in scope.

Starting point, from the [17 October review](REVIEW-2026-10-17.md): technical prototype 8/10, visual design 7/10, user
experience 5/10, adoption readiness 4/10, potential value 7/10. Readiness needs real merchants and real payments, so it
isn't the target here. The other four are.

**Status:** ✅ smooth (one or two taps, no avoidable questions) · ⚠️ works, but with avoidable steps, text or decisions ·
❌ missing. **Taps** count deliberate actions from intent to done, excluding typing the first message.

## A. Buying from a shop you're standing in (QR on the counter)

| ID | Journey | Today | Status | Simplify |
|---|---|---|---|---|
| A1 | Scan a shop's QR, ask "is the steel bottle in stock?" | Store card opens with stock shown and tap-to-ask chips; answer from the shop's data | ✅ | — |
| A2 | Buy one item at the listed price and collect now | Card → Order → Pay → pass; 3 taps | ✅ | — |
| A3 | Buy 3 of an item | Quantity stepper on the card; stock checked | ✅ | — |
| A4 | Ask for 200 when the shop has 15 | Refused with "Only 15 left" and a one-tap "take 15" | ✅ | — |
| A5 | Ask for a discount on 5 | Offer price on the card; seller's agent counters inside its floor | ✅ | — |
| A6 | Buy two different items in one go | Each item is its own order and its own pass | ⚠️ | A shop-card basket: several items, one deal, one pass (deal `items` already supports lines) |
| A7 | Shop is paused (closed) | "Isn't taking requests right now"; offerings shown | ✅ | Show opening hours if stated |
| A8 | Item sold out since the QR was printed | "Out of stock right now" on the card | ✅ | Offer "tell me when it's back" (a watch on that listing) |
| A9 | Scan with the phone camera, no app | Opens the web app straight on the card | ✅ | — |
| A10 | Buy again next week | **Buy again** on a paid deal: same item, quantity and seller, at today's price | ✅ | (17 Oct) |
| A11 | Ask about warranty or returns | Answered from the seller's stated terms (with web-sourced suggestions they accepted) | ✅ | — |
| A12 | Pay another way (cash, UPI) and still get a pass | "Paid another way" → pass says who marked it paid | ✅ | — |

## B. Asking for something and letting agents find it

| ID | Journey | Today | Status | Simplify |
|---|---|---|---|---|
| B1 | "Need 2 brass desk lamps in Indiranagar this week" | Brief card → Find people → matches; 2 taps | ✅ | — |
| B2 | Vague request ("need stuff") | Quality check returns tap-to-answer questions before searching | ✅ | — |
| B3 | Set the most I'll pay | Limit field on the brief, or in my own words ("up to ₹3,200") | ✅ | — |
| B4 | Pick from three matches | One main button per match (Book within your limit, else Negotiate); the rest under More | ✅ | (17 Oct) |
| B5 | Book a match outright | Book → joins the request's goal; "✓ Booked — see the deal" | ✅ | (fixed 17 Oct) |
| B6 | Let agents bargain with three sellers at once | Tick 3 → Ask their agents; deals arrive on Deals | ✅ | Show the three side by side with a recommendation (PRD R5) |
| B7 | No one fits | "Watch for me" runs hourly for 14 days and notifies | ✅ | — |
| B8 | Nobody on Collab sells it nearby | Maps-grounded shops listed as leads | ✅ | Say clearly they aren't on Collab; offer to share an invite link |
| B9 | Check whether a price is fair | Search-grounded fair price, private, 5 a day | ✅ | — |
| B10 | Ask in Hindi or Kannada | Gemini reads any language; UI stays English | ⚠️ | Answer in the language asked; later, UI strings |
| B11 | Say the request instead of typing | Mic in the composer (browser speech, Indian English or Hindi) | ✅ | (17 Oct) |
| B12 | Search with a photo of what I want | — | ❌ | Photo → request (Gemini reads the item); next after photo listings |

## C. Quantity, stock and bulk

| ID | Journey | Today | Status | Simplify |
|---|---|---|---|---|
| C1 | Order more than one per buyer allows | "Sells at most N per buyer" | ✅ | — |
| C2 | Two buyers race for the last unit | Atomic hold; one wins, the other is told | ✅ | — |
| C3 | Untracked stock | Shown as "ask"; no invented count | ✅ | — |
| C4 | Stale stock count | Marked unconfirmed, seller asked | ✅ | — |
| C5 | Wholesale: 50 units at a bulk price | Negotiation per unit and quantity | ✅ | Seller-stated price breaks ("₹380 each for 20+") read from words |
| C6 | Seller restocks | Update on hand on My info › stock, or POS sync | ⚠️ | Edit stock from the listing card itself; low-stock alert |
| C7 | Low stock warning for the seller | Push once when stock runs low; again after a restock | ✅ | (17 Oct) |
| C8 | Variants (size, colour) | One listing per variant | ⚠️ | Variant chips on one listing (later) |
| C9 | Pre-order when out of stock | Not offered | ❌ | "Notify me" (watch) instead of pre-order for now |
| C10 | POS keeps stock in sync | POS key + webhook updates stock | ✅ | — |

## D. Services and bookings (salon, tutor, repair)

| ID | Journey | Today | Status | Simplify |
|---|---|---|---|---|
| D1 | Book a haircut at the next free time | Slot chips (next eight + More) → Book → booking pass | ✅ | — |
| D2 | Instant-book seller | Agreed at once at the listed price | ✅ | — |
| D3 | Slot taken while choosing | "That time was just taken — pick another" | ✅ | — |
| D4 | Tutor: weekly lessons | Goal repeats every N days | ⚠️ | "Every week" chip on the booking |
| D5 | Ask about add-ons (beard trim) | "Ask about add-ons" → agent lists them with prices | ✅ | — |
| D6 | Reschedule | "Change time" on the booking pass picks another free slot | ✅ | (17 Oct) |
| D7 | Cancel a booking | "Cancel booking" on the pass; frees the slot | ✅ | (17 Oct) |
| D8 | Electrician: price after inspection | Ask, then negotiate; no inspection step | ⚠️ | Quote-after-visit as a deal term |
| D9 | Seller's calendar decides free times | iCal feed connector | ✅ | — |
| D10 | Check-in at the salon | Booking pass, seller marks checked in | ✅ | — |

## E. Becoming a seller

| ID | Journey | Today | Status | Simplify |
|---|---|---|---|---|
| E1 | "I teach tabla, ₹700 an hour, lowest 600" | Offer card; floor kept private; Publish | ✅ | — |
| E2 | Vague offer ("selling stuff") | Quality check asks what exactly, before publishing | ✅ | — |
| E3 | What will buyers ask? | Gemini's likely questions, answered once on the card | ✅ | Fewer at once (top 2, rest folded) |
| E4 | Warranty/returns terms | Suggested from what sellers of that item state on the web, with sources; seller edits | ✅ | — |
| E5 | Rules in my words ("close on its own at ₹3,300+") | Read, confirmed, applied | ✅ | — |
| E6 | Snap a photo to list an item | Photo → listing: Gemini reads the item and its condition; the seller sets the price | ✅ | (17 Oct) |
| E7 | Say the listing aloud | Mic in the composer (same as B11) | ✅ | (17 Oct) |
| E8 | Set stock while listing | Stock count on the offer card | ✅ | (17 Oct) |
| E9 | Get my shop QR to print | People › Your QR › Download | ⚠️ | Name it **My shop** in the menu; QR first |
| E10 | See my card as customers do | Preview opens fresh each time | ✅ | — |
| E11 | Offer card has many sections | Publish first; questions, terms and rules as "Improve your listing" chips after | ✅ | (17 Oct) |
| E12 | List ten products | One chat message each | ⚠️ | Paste a list (one per line) → several listings to review |

## F. A seller's day

| ID | Journey | Today | Status | Simplify |
|---|---|---|---|---|
| F1 | A buyer's agent arrives | Push "New buyer: X"; agent answers from the listing | ✅ | — |
| F2 | Agent can't answer a question | Asked once with Yes/No chips | ✅ | — |
| F3 | Confirm a deal | One tap, or automatic under a close rule | ✅ | — |
| F4 | Hand over with the pass | Pass modal → Mark collected | ✅ | (17 Oct) |
| F5 | See today's orders to hand over | Requests › Agreed | ⚠️ | Name it **Deals**; "To hand over today" first for sellers |
| F6 | See what I sold | Your deals with totals and stage | ✅ | (17 Oct) |
| F7 | Find a past deal | Filter chips: To do · Sold · Bought · Done | ✅ | (17 Oct) |
| F8 | Many buyers at once | Each a card; agents work in parallel | ✅ | — |
| F9 | Pause everything for a day | Privacy › Pause | ✅ | — |
| F10 | Reply to a buyer's message after agreeing | Chat line on the deal | ✅ | — |

## G. Negotiation and delegation

| ID | Journey | Today | Status | Simplify |
|---|---|---|---|---|
| G1 | Buyer offers ₹200 for a ₹450 item | Seller's agent counters inside its floor | ✅ | — |
| G2 | Both sides delegate | Agents agree without either owner | ✅ | — |
| G3 | Limit never revealed | Policy wall + tests (100/100 privacy runs) | ✅ | — |
| G4 | Rounds run out | Widen the limit or walk away, one decision | ✅ | — |
| G5 | Counter-offer reaches me | Accept ₹X / Let my agent handle it | ✅ | — |
| G6 | Negotiate pickup time, not only price | — | ❌ | One extra dimension (pickup window) as a term |
| G7 | Hostile buyer tries to extract the floor | Refused; Model Armor screens injection | ✅ | — |
| G8 | Accept the seller's price straight away | "Take their price" | ✅ | — |
| G9 | Set autonomy once for all deals | Per request or listing | ⚠️ | Default in Settings ("Let my agent close within my rules") |
| G10 | Understand why the agent did something | One colour-coded stage tag per deal; A2A log and events for detail | ✅ | (17 Oct) |

## H. After the deal

| ID | Journey | Today | Status | Simplify |
|---|---|---|---|---|
| H1 | Show the pass and collect | Pass modal with QR | ✅ | — |
| H2 | Seller scans the pass | In-app scanner opens the same modal | ✅ | — |
| H3 | Confirm it's as agreed | "Received it ✓ / Report a problem" | ✅ | (kept visible, 17 Oct) |
| H4 | Report a problem | Seller sees it; part of the record | ✅ | — |
| H5 | Receipt anyone can verify | Logged-out verify page; Ed25519 | ✅ | — |
| H6 | Show a changed receipt failing | "Try changing the price" on the verify page; the signature check refuses it | ✅ | (17 Oct) |
| H7 | Seller's record grows | Verified sales on the public card | ✅ | — |
| H8 | Return or refund | — | ❌ | Return request as a deal event; refund stays out of scope with payments |
| H9 | Buy again | Same as A10 | ✅ | (17 Oct) |
| H10 | Share the receipt | Link on the receipt | ✅ | — |

## I. Trust, privacy and safety

| ID | Journey | Today | Status | Simplify |
|---|---|---|---|---|
| I1 | Know where my notes live | Stored / Read by / Shared, everywhere | ✅ | (17 Oct) |
| I2 | See exactly what a seller's agent receives | Fold-out on the request | ✅ | (17 Oct) |
| I3 | Share my address only after the deal | — | ❌ | One-time share to that deal (PRD R3) |
| I4 | Block a pushy buyer | — | ❌ | Block from the deal; their agent gets nothing more |
| I5 | Delete or export my data | — | ❌ | Settings › Your data (PRD R8) |
| I6 | Protected topic for some people only | Rules in Privacy | ✅ | — |
| I7 | See what my agent shared | Activity | ✅ | Fold into Privacy |
| I8 | Demo payment can't be mistaken for money | Quiet "Demo payment" tag on pass and Pay | ✅ | (17 Oct) |
| I9 | A copied pass shown first | Seller checks the buyer's name | ⚠️ | Stated on the pass; inherent to static QR |
| I10 | Outside agent asks for private data | Gets Public only | ✅ | — |

## J. Access and first use

| ID | Journey | Today | Status | Simplify |
|---|---|---|---|---|
| J1 | First visit | Name → handle made → chat, under a second | ✅ | — |
| J2 | Understand what to do | Three short steps and four tiles | ✅ | (17 Oct) |
| J3 | Menu on a phone | Opens; closes on a tap outside | ✅ | (17 Oct) |
| J4 | Too many menu items with jargon | Deals · My shop · About me · Privacy · Settings (Activity inside Privacy) | ✅ | (17 Oct) |
| J5 | Ask about my notes without a 2 GB download | Matching notes shown at once; AI optional | ✅ | (17 Oct) |
| J6 | Slow network | Offline shell, send queue | ✅ | — |
| J7 | Light or dark | Auto/Light/Dark | ✅ | — |
| J8 | QR code library unavailable | Bundled with the app | ✅ | (17 Oct) |

## K. Notifications, devices and other agents

| ID | Journey | Today | Status | Simplify |
|---|---|---|---|---|
| K1 | Told only when needed | Push for decisions and new buyers | ✅ | — |
| K2 | Quiet hours / daily summary | — | ❌ | Later |
| K3 | Same account on laptop and phone | Google sign-in on both | ✅ | — |
| K4 | Another company's A2A agent buys | Card + JSON-RPC; Public only | ✅ | — |
| K5 | Verify an agent card's signature | Signed with the published key | ✅ | — |
| K6 | Tap a notification | Opens the right deal | ✅ | — |
| K7 | Notification while app open | In-app toast, no duplicate | ✅ | — |
| K8 | Install as an app | Install button / iOS steps | ✅ | — |

## Tally

| Status | Count |
|---|---|
| ✅ smooth | 93 |
| ⚠️ avoidable effort | 11 |
| ❌ missing | 8 |

## What to change, ranked by value for the theme and effort

**Workflow**
1. **Buy again** from a past deal (A10, H9) — retail's most repeated action. S.
2. **One primary action per match** (B4) — Book within your limit, else Negotiate; the rest under More. S.
3. **Filter chips on Deals** (F7) and "To hand over" first for sellers (F5). S.
4. **Photo → listing** (E6), then photo → request (B12) — Gemini multimodal, the strongest retail demo. M.
5. Stock on the offer card (E8) and low-stock push (C7). S–M.
6. Shop-card basket (A6). M.

**Visual design**
7. **Menu: Deals · My shop · About me · Privacy · Settings** (J4, E9, I7) — fewer items, no jargon. S.
8. One stage tag per deal, colour-coded like Your deals (G10). S.
9. Offer card: publish first, improvements as chips after (E11). M.

**User experience**
10. **Voice input** (B11, E7) — inclusion and a strong demo. S.
11. **Bundle the QR library** (J8). S.
12. **"Try changing the price"** on the verify page (H6) — makes the receipt proof visible. S.
13. Cancel / change time on a booking pass (D6, D7). M.

**Potential value (roadmap, not claimed)**
Address after the deal (I3), block (I4), your data (I5), negotiating the pickup window (G6), price breaks (C5),
compare three offers (B6), quiet hours (K2), returns (H8).

**Business insights** (for the seller only; other people's data only as counts by item, from two or more people):
shop insights show missed demand ("wanted 200, had 15"), what buyers ask most, prices actually agreed, buyer groups
(new / repeat, at your price / bargained down) and what is often bought together. Next, once BigQuery access is
granted: export the same counts to BigQuery and forecast demand per item with `AI.FORECAST`.

Built 17 Oct: everything ranked above except the shop-card basket (A6), photo → request (B12) and "To hand over"
first for sellers (F5).
