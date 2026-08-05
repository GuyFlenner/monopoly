# Kesef Street — memory index

One line per memory. No content here; the files hold it.

## Project status

- [Session Checkpoint 2026-08-04 12:09](_checkpoint_20260804_120935.md) — **development signed off**; every backlog item done bar the MON-90x rows
- [Session Checkpoint 2026-08-03 10:12](_checkpoint_20260803_101226.md) — signed off; MON-713 reload fix in PR #39, three candidates ranked
- [Session Checkpoint 2026-07-28 15:09](_checkpoint_20260728_150952.md) — M0–M4 complete (PRs #1–#8 merged), handing off to M5 Hebrew/RTL
- [Run metrics — MON-100](run-2026-07-26-mon-100.json) — the state-model rework's SDLC run, machine-readable

## Open action items

*Refreshed 2026-08-04, at development sign-off. Three of the five items this list carried are closed and
verified rather than assumed: **D1** by MON-714 (a load now asks whether to replace the live game),
**the event log** by MON-715 (it travels in the save file), and **the currency** by MON-720 (`$50` /
`50 ₪`). What is left is two owner-side settings and two deliberate positions.*

- 🟡 **Branch protection excludes administrators** — a docs commit once reached `main` bypassing the
  required check. Owner-side; cannot be changed from a session.
- 🟡 **`.claude/worktrees/` holds ~590 MB** of gitignored junk; `rm -rf` is hook-blocked.
- 🟡 **MON-722's legality-predicate cluster** — 37 surviving mutants across `_build_house`,
  `_trade_side`, `_sell_house`, `_unmortgage`. Filed and deliberately not run to zero: a mutant killed
  by an assertion nobody would otherwise have written is a test that exists to satisfy a tool.
- 🟡 **ADR-011's WebSocket limitation is accepted, not deferred.** A watcher of a *replaced* game goes
  quiet, and a close code alone makes it worse — the watcher reconnects at its own cursor while the
  replaced log restarts at `seq 1`, so it receives silence. A correct fix needs a cursor-reset protocol
  through the animation queue. Revisit trigger: **MON-901**.

## Where the durable briefs live

- `docs/M5_KICKOFF.md` — the next milestone, written as a handoff
- `docs/FABLE_KICKOFF.md` — the original mission, the non-negotiables, the two review gates
- `docs/GAP_ANALYSIS.md` — Phase 0's findings and §7's binding owner decisions
- `docs/BACKLOG.md` — every item; E4b holds the gaps M4 surfaced
