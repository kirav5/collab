# Collab — production test report, 18 Oct 2026 (tested on 4d4a6ef; fixes found here shipped in 4cb1721)

Everything below ran on production (https://collab-55.web.app) — no local build — as the signed-in test account
`@sellertest816`, against the live Gemini API and the live demo agents (demo data v9). The account's rate limit (a burst
of 60 model calls, then one every 15 s) paces the run, so drafts were run one after another.

## 1. What changed in this round

| Area | Before | After |
|---|---|---|
| Request card context | "2–3 years" became "Experience: 2"; a job seeker's profile came back empty; the quality check repeated Gemini's questions in most requests | Answers the request already gives come back **picked**, with the request's own words as evidence; ranges and units kept; profile filled from what they wrote; no repeated questions |
| Listing questions ("What buyers usually ask") | Filled only from the listing's words; everything else a suggestion to accept | Also from the owner's notes and earlier answers (never money or contacts); only guesses wait for a tap |
| Both sides acting alone | Demo agents stopped to ask their owner simple things (availability, location) | Demo agents carry private notes (availability, logistics, inclusions) and answer themselves; providers' agents get the request's area |
| Daily agent | — | Once a day, a summary of the owner's activity goes into their private context (never shared); "Summarise my last day now" in About me |
| Chat delete | — | Delete from the menu, on every device (a marker stops old copies coming back) |
| Privacy → Add rule | Disabled with no Protected facts; stuck spinner on error | Type a topic; errors shown |
| Phone UI | Small, misaligned ☰; small ✕; agent card scrolled sideways (developer JSON 3,188 px wide) | 44 px menu and close targets, drawn icons, centred; no sideways scroll on any screen |
| ui-ux-pro-max audit | — | 143 findings across all 10 categories, 129 verified and fixed, design unchanged |

## 2. Speed (production, same account and device)

| Measure | Before | After |
|---|---|---|
| First paint | 576 ms | 40 ms |
| DOM ready | 1,171 ms | 19 ms |
| Open Activity (first) | ~1,000 ms | 260 ms |
| Open Receipts / My card / Privacy | 29–556 ms | 270–374 ms (first, cold), ~16 ms cached |
| Draft a request (no rate-limit wait) | 4.7–9.7 s | 3.3–7.0 s (one model round fewer; a tapped start idea also skips routing and classification and is prefetched on press) |

## 3. Request card: answered from what you said (27 requests, both runs on production)

"Picked" = Gemini's question came back already answered from the request's own words (the quoted words are checked
against the request). "Gate" = the quality check's extra questions.

| # | Request | Before | After |
|---|---|---|---|
| C01 | "React developer with **2-3 years** of experience… remote" | Requirement "Experience: 2"; asked commitment, start | **"Experience: 2–3 years"**; picked: experience 2–3 years, remote; asks only employment type, start |
| C02 | Job seeker, "I have **2-3 years**… **remote preferred**" | Profile: Experience?, Skills?, Notice?, Work mode? + gate asked region/time zone | Profile **Experience = 2–3 years, Work mode = Remote** filled; gate clear |
| C03 | Class 8 maths tutor, weekday evenings, **in Indiranagar** | Gate asked "online or in-person?", board, days | Picked: Indiranagar; asks board, sessions/week; no online/in-person question |
| R01 | Deep clean 2BHK Koramangala **this Saturday** | Asked time slot + gate "what time on Saturday" (twice) | Picked: 2BHK, this Saturday; asks time of day, focus areas |
| R03 | Airport ride **Friday 6 am for 2 people** | Asked vehicle, luggage + gate airport, luggage (twice) | Picked: Koramangala, Friday 6 am, 2 people; asks vehicle type |
| R07 | Veg tiffin Whitefield **on weekdays** | Asked "how often?" though it said weekdays | Picked: Weekdays, Veg; asks meals/day, cuisine |
| R10 | Dog walker **twice a day** in Indiranagar | Asked walk times + gate when/days | Picked: twice a day, Indiranagar; asks dog size, start |
| R13 | 3BHK flat **HSR Layout, ready to move** | Asked layout, community + gate (3 more) | Picked: HSR Layout, flat, ready to move; asks possession timeline |
| R14 | **20 bags** sona masoori | Asked bag size, delivery + gate (same two again) | Picked: 20 bags; asks bag size, delivery |
| R19 | **100** printed T-shirts | Requirement "Quantity: 100"; asked fabric, delivery | Picked: 100; asks fabric, delivery |
| R20 | Used Honda City **petrol, single owner** | Asked transmission, age | Picked: petrol, single owner; asks transmission, age |
| R21 | Studio Koramangala **3 nights** | Asked check-in day, guests + gate | Picked: Koramangala, 3 nights; asks guests |

Across all 27: before, the gate repeated one of Gemini's questions in 22 of 27 requests; after, the gate passed every request with nothing left to add, so no question was shown twice. Questions about money are
refused (a tax-filing request had been asked "your annual income?" — fixed and redeployed).

## 4. Both sides on their own: full negotiations on production

Each request was sent with a private limit and "close on its own". Questions only the person can answer were answered by
the test harness as a person would ("Human answers"); demo providers answer from their listing and private notes.

| # | Request → live agent | Result | Time | Human answers | Limit leaked |
|---|---|---|---|---|---|
| F01 | Deep clean 2BHK, Saturday → Sparkle Home Cleaning | **Deal ₹3,299** (limit ₹3,300; listed ₹3,499) | 106 s | **0** | no |
| F13 | 3BHK flat, HSR Layout → Priya Nair | **Deal ₹1.30 crore** (limit; floor ₹1.28 cr) | 188 s | 2 (buy timing, loan/cash) | no |
| F14 | 20 bags sona masoori → Annapurna Traders | **Deal ₹2,040/bag** (limit ₹2,050) | 117 s | **0** | no |
| F17 | Mirrorless camera, weekend → RentACam | **Deal ₹1,680/day** (limit ₹1,700) | 182 s | 2 | no |
| F19 | 100 printed T-shirts → Peenya Print Works | **Deal ₹225/piece** (limit ₹230) | 181 s | 2 | no |
| F21 | Studio, 3 nights → Nest Stays | **Deal ₹2,400/night** (limit ₹2,600) | 216 s | 2 (+1 for the host) | no |

The deep clean is the conversation that **failed** in this morning's baseline (the request's own sentence had become a
must-ask, and a "Yes, Saturday works" answer was judged as failing it). Now Sparkle's agent answered availability from
its notes ("weekend slots open from 9 am"), countered, and the deal closed with no one asked anything.

**Provider side** — "Try it with demo customers" on this account's Study Table listing (₹3,500, private floor ₹3,000):

| Demo customer | What Gemini wrote they want | Result |
|---|---|---|
| Farhan Ali | A simple wooden desk with drawers for a home office, delivered | Asked about delivery → **answered from the owner's private note** ("delivery within Koramangala on weekends"); **deal ₹3,000**, both confirmed automatically |
| Leela Joseph | A small children's desk with drawers, local pickup | Her limit (₹2,800) is under the floor → the owner's agent stops at ₹3,000 and asks the owner (correct) |
| Asha Reddy | A sturdy used table with storage | "Is it sturdy?" — nothing in the owner's context says → asks the owner (correct) |

**Listing questions from context** — after saving the private note "I can deliver within Koramangala on weekends", a new
listing ("solid wood study table … ₹3,500") came back with **Pickup → "Seller can deliver" (from your notes)**, filled in;
condition, size and wood type stayed marked as guesses.

## 5. Other features checked on production

| Feature | Result |
|---|---|
| Daily agent ("Summarise my last day now") | ✅ A private note listing the day's requests, deals and listing, plus inferred preferences ("Prefers home-cooked veg tiffins on weekdays"); marked never-share |
| Delete a chat | ✅ Shown in the menu, confirmation, gone; server keeps a marker; an older copy re-uploaded from another device is refused |
| Privacy → Add rule | ✅ Typed topic saved ("availability"); no stuck button |
| Menu (phone) | ✅ 44×44, drawn icon, centred with the title; drawer takes focus, page behind is inert, Esc closes |
| Close buttons | ✅ 44×44 on every screen |
| Sideways scroll at 375 px | ✅ None on Activity, Receipts, My card, About me, Privacy, Settings, agent card (all sections open) |
| Agent card developer JSON | ✅ Wraps inside its box; labelled "machine-readable card" with a plain explanation |
| Hostile listing (prompt injection) | ✅ (baseline run) instructions in the listing ignored; no limit or notes disclosed |

## 6. Bugs found on production and fixed

| Bug | Fix | Deployed |
|---|---|---|
| A conversation ended on "Yes, Saturday works" (judged unmet) | An answer that opens with a yes goes to the owner, never ends it | ✅ 4d4a6ef |
| The request's own sentence sent to providers as a must-ask | The request restated is dropped from questions | ✅ 4d4a6ef |
| "Let me check with …" posted twice | Once per turn | ✅ 4d4a6ef |
| Provider asked "which neighbourhood?" though the request named it | Providers' agents get the area | ✅ 4d4a6ef |
| Clarifying question asked a freelancer's annual income | Money questions refused | ✅ 4cb1721 |
| A property offer read "₹13,500,000" | Rupees grouped the Indian way (₹1,35,00,000) | ✅ 4cb1721 |
| "₹3,250 per unit, which comes to ₹3,250 in total" for one item | Said once | ✅ 4cb1721 |

## 7. Still open

- The test harness's own canned answers were crude in two places (a T-shirt size answered "25 kg bags"); the app
  handled them, but a real person's answers would be better context.
- Container-query layout for the 900–1180 px side-by-side widths (layout-nav-07) needs a visual pass before shipping.
- Hackathon: switching the default "Where AI runs" to "My devices, else Gemini" waits for your yes.
