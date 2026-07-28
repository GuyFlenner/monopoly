# Kesef Street — memory index

One line per memory. No content here; the files hold it.

## Project status

- [Session Checkpoint 2026-07-28 15:09](_checkpoint_20260728_150952.md) — M0–M4 complete (PRs #1–#8 merged), handing off to M5 Hebrew/RTL
- [Run metrics — MON-100](run-2026-07-26-mon-100.json) — the state-model rework's SDLC run, machine-readable

## Open action items

- 🔴 **Hebrew translation decision** — ~250 English-only keys behind eight exemption sets; Hebrew needs verb-gender agreement. Three options put to the owner, none chosen. Blocks MON-501's content half.
- 🔴 **MON-506** — 31 Hebrew card texts need a native speaker. English ships; `cards.he.json` absence is tripwired.
- 🟡 **Bring MON-707 (Playwright) forward** — M4's board was broken at every width and 646 tests could not see it; jsdom has no layout engine.
- 🟡 **Epic E4b (MON-413..422)** — ten contract gaps where the UI compensates for the engine; each fix removes a workaround.
- 🟡 **G-40** — catalogue camelCase leaves still resolve against nothing; MON-501's rename deletes `panels/ActionLabels.ts`.
- 🟡 **Branch protection excludes administrators** — a docs commit reached `main` bypassing the required check.

## Where the durable briefs live

- `docs/M5_KICKOFF.md` — the next milestone, written as a handoff
- `docs/FABLE_KICKOFF.md` — the original mission, the non-negotiables, the two review gates
- `docs/GAP_ANALYSIS.md` — Phase 0's findings and §7's binding owner decisions
- `docs/BACKLOG.md` — every item; E4b holds the gaps M4 surfaced
