# Collab — work checklist, 18 Oct 2026

Status: [x] done · [~] in progress · [ ] to do

## Earlier asks
- [x] Panel resizer (drag, keys, double-click reset, remembered) — deployed da408c7
- [x] Pull latest main (PR #10, #11 merged) before changes
- [x] "Where AI runs" defaults to Gemini; Gemma on the device is an opt-in feature (Settings › Privacy & AI › Advanced)

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
- [x] 7 fixers applied them (css 48, app 29, cards 14, screens 13, shell 9, agent 6, server 6)
- [x] Cross-file handoffs and the integration review's 11 problems fixed (container-query layout left for a visual pass)
- [x] Burger menu: 44px, centred with the title, drawn icon; drawer takes focus, Esc closes
- [x] Delete a chat (menu, confirm, all devices; old copies can't bring it back) — tested on production
- [x] Privacy → Add rule works (type a topic when you have no Protected facts; errors shown; no stuck spinner)
- [x] Close (×) buttons: 44px targets, drawn icon, every screen
- [x] Agent card sideways scroll fixed (developer JSON was 3,188px wide)
- [x] Every screen at 375px on production: no sideways scroll (sections expanded)
- [x] Agent card "JSON for developers": wraps inside its box, relabelled "machine-readable card" with a plain explanation

## Performance / prefetch
- [x] Drafting a request: one Gemini round fewer; start ideas carry their category
- [x] Prefetch screens and start-idea drafts; service worker cache-first; modulepreload — first paint 576 → 40 ms

## Ship
- [x] Server checks pass (248 tests)
- [x] Deployed to production (4d4a6ef for testing, then 4cb1721 from main)
- [x] Production test run: 27 drafts, 6 negotiations (all deals, no limit leaks), demo customers on a listing, every new feature — docs/TEST-REPORT-2026-10-18-prod.md
- [x] PR #12 merged to main; production deployed from main (4cb1721) and smoke-tested
