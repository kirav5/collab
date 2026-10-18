# Collab — work checklist, 18 Oct 2026

Status: [x] done · [~] in progress · [ ] to do

## Earlier asks
- [x] Panel resizer (drag, keys, double-click reset, remembered) — deployed da408c7
- [x] Pull latest main (PR #10, #11 merged) before changes
- [ ] Hackathon: "Where AI runs" default → "My devices, else Gemini" (waiting on your yes)

## Request card context ("2–3 years" asked again)
- [x] Gemini's questions come back answered from the request's own words (evidence-checked)
- [x] Job seeker profile filled from what they wrote
- [x] Ranges and units kept ("2–3 years")
- [x] Quality check knows the area; doesn't repeat Gemini's questions
- [x] Providers' agents get the request's area
- [x] Request sentence no longer sent back as a must-ask; a "yes…" answer never ends a conversation
- [x] Listing "What buyers usually ask" prefilled from all your context (incl. private notes, earlier answers; never money/contacts) — words/notes fill in, only guesses wait for a tap

## Live agents, both sides, minimal interaction
- [x] Demo data v8: a live agent in every category
- [x] "Try with demo customers" on any listing
- [x] Demo agents carry private context (availability, logistics) so they answer on their own (demo v9)
- [x] Saying "needs 2–3 years" with a request open updates that request (refine adds details, answers pending questions)
- [x] Daily agent: summarises your activity each day into your private context (scheduler + "Summarise my last day now" in About me)

## UI/UX (ui-ux-pro-max audit: 143 findings, 129 verified to fix)
- [~] 7 fixers applying them — 6 done (css 48, cards 14, screens 13, shell 9, agent 6, server 6); app.js running
- [x] 45 of 56 cross-file handoffs applied (rest are app.js)
- [~] Burger menu: 44px, centred, drawn icon (CSS + icon done; app.js markup pending)
- [~] Delete a chat: server done (tombstone, syncs to all devices); sidebar button pending
- [x] Privacy → Add rule works (type a topic when you have no Protected facts; errors shown; no stuck spinner)
- [~] Close (×) buttons: 44px targets and larger glyph (CSS done; app.js icon pending)
- [x] Agent card sideways scroll fixed (developer JSON was 3,188px wide)
- [ ] Re-check every screen at 375px on production
- [~] Agent card "JSON for developers" contained (wraps, scrolls inside its box) — label wording pending

## Performance / prefetch
- [x] Drafting a request: one Gemini round fewer; start ideas carry their category
- [~] Prefetch screens and start-idea drafts; service worker cache-first; modulepreload

## Ship
- [ ] Server checks pass
- [ ] Deployed to production
- [ ] Full production test run (27 journeys + provider side) and report
- [ ] PR opened and merged to main
