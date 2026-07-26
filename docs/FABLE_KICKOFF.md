# Kickoff brief for the orchestrating model (Fable)

**You are taking over a bootstrapped repository and driving it to a finished game.** This file
is the whole handoff: mission, current state, the rules you must not break, how to fan out
agents, and the two review gates that bracket the work.

Read in this order before doing anything:

1. `docs/superpowers/specs/2026-07-25-kesef-street-design.md` — the design
2. `docs/adr/001` … `006` — the decisions and the alternatives already rejected
3. `docs/BACKLOG.md` — every work item, sized, tiered, with acceptance criteria
4. `CLAUDE.md` — conventions and guardrails
5. `docs/PROJECT_BRIEF.md` — the requirements as the owner stated them

---

## 1. Mission

Ship **Kesef Street**: a bilingual (English / Hebrew) property-trading board game for 2–6
players — any mix of people and bots on one screen — playing the classic universal rules,
with an optional Kids Mode. It must be genuinely pleasant for a six-year-old and correct
enough for an adult who knows the rules. The repository is public and doubles as a
teaching-grade example of a clean domain core.

**Owner**: Guy Flenner. He wants to *learn from* this codebase, so clarity of design and of
commit history is part of the deliverable, not a nicety.

---

## 2. Current state (verified 2026-07-25)

M0 is complete and the gate is green: `ruff check` · `ruff format --check` · `mypy --strict` ·
**89 tests** · `pip-audit`.

**Implemented and tested**

- uv workspace, three packages (`engine`, `server`, `web`), CI, agent guardrails, MIT licence
- Both board JSON files, generated from a single table, with 13 economic-invariant tests
- `Rng` — counter-based splitmix64, 12 tests including distribution and O(1) seek
- `GameState`, `Ruleset`, `Phase`, 17 commands, 21 events — typed, validated, round-tripping
- API contract: schemas final; engine-backed routes declared and returning **501 on purpose**
  so the frontend can generate types and be built in parallel
- i18n scaffolding, English + Hebrew `common` catalogues, classic-board catalogues in both
  languages, locale-parity tests

**Deliberately not implemented** — `apply()`, `legal_commands()`, every rule module, the bots,
every React component. These are M1–M6 and they are itemised in the backlog.

**Unverified** — everything under `packages/web`. There is no lockfile and no `node_modules`,
so **no TypeScript in this repo has ever been compiled**. MON-401 is where that changes; treat
existing web files as reviewed-by-eye only, and expect to fix them.

---

## 3. Phase 0 — critique before you build (mandatory)

Do **not** start MON-101 first. Start by trying to break the design.

Fan out independent explorations, each answering one question, each reading the code rather
than trusting this document:

1. **Rule completeness.** Take the universal rules and the ten traps in §3.6 of the spec.
   What rule has no home in any planned module? What edge case does the phase machine make
   unreachable or ambiguous? (Specific things to interrogate: a bankruptcy cascade during an
   auction; a card that moves a player into a debt they cannot pay; the last house being
   contested; a trade that would leave a group unevenly built.)
2. **State model adequacy.** Can `GameState` as it stands express every situation the rules
   permit? Name any field that is missing, and any field that is redundant.
3. **Contract adequacy.** Does `GameView` carry enough for the UI to render every phase —
   including auctions and trades — without computing anything?
4. **i18n and RTL completeness.** Is any user-visible string reachable without a key? Does
   any planned component need a physical CSS property to work?
5. **Test strategy honesty.** Which planned tests would still pass if the implementation were
   deleted? Which invariant is claimed but not actually checkable as specified?
6. **Accessibility and child-usability.** Where does the design assume reading ability, fine
   motor control, or colour discrimination?

Write the findings to **`docs/GAP_ANALYSIS.md`**: each gap with severity, the file or spec
section it affects, and a proposed fix. Then **amend the spec, the ADRs and the backlog**
before writing code. Open one PR for the design amendments so the reasoning is reviewable on
its own, separately from implementation.

If an exploration finds nothing, say so explicitly. "No gaps found in area 4" is a useful
result; silence is not.

---

## 4. Execution

### Order

M1 → M2 → M3 → M4 → M5 → M6 → M7 → M8, with one exception that matters: **M4's foundation
(MON-401, MON-402) depends only on the contract, not the rules**, so run the web track in
parallel with E1/E2 from the start. Fixing the API schemas at M0 was done specifically to buy
this parallelism — use it.

### Fan-out shape

- **Within a milestone**, one agent per backlog item, respecting the dependency spine at the
  end of `BACKLOG.md`. Rule modules that share no state (`jail`, `cards`, `development`) run
  concurrently; anything downstream of `rent` does not.
- **Use worktree isolation** when agents edit files in parallel, which they will inside
  `rules/` and `panels/`.
- **Verify adversarially.** For each rule module, spawn a reviewer whose brief is to *break*
  it — construct a state where the rule is wrong — not to confirm it works. A rule module is
  done when a hostile reviewer failed to break it, not when its author says it is finished.
- **Tier by consequence** (see the table in `CLAUDE.md`): you own rule correctness, the phase
  machine, auctions, bankruptcy chains and every review. Opus implements load-bearing modules
  and components. Sonnet fills catalogues, scaffolding, docs and config.

### Definition of done, per item

1. Acceptance criteria in the backlog all met.
2. Tests written **first** where the item is a rule, and they fail before the implementation.
3. Full gate green — including `ruff format --check`, which is **not** implied by
   `ruff check`.
4. An adversarial review found no defect.
5. One PR per backlog item, or per tight cluster. The PR body says what changed and why, and
   names the backlog ID.

### Definition of done, per milestone

- M1: **`uv run kesef play` plays a 2-player game to a winner in the terminal.** Not "the code
  looks complete" — actually run it.
- M2: all invariants in MON-209 green; every trap in spec §3.6 has a named passing test.
- M3: the 501 tests have become behavioural tests; generated TypeScript committed and diffed.
- M4: a full game playable in a browser, in English.
- M5: the same game playable in Hebrew, mirrored, with the language switchable mid-game.
- M6: three bot levels, each beating the one below over 100 seeded games; Kids Mode honoured.
- M7: the §5.5 accessibility floor met, verified by keyboard-only play and an axe run.
- M8: public repo, README with a real GIF.

---

## 5. Non-negotiables

Breaking one of these is a defect even when the tests pass.

1. **Rules live in the engine, only in the engine.** A conditional in the server or the UI
   that encodes a rule is wrong even if it works.
2. **The engine emits keys, never prose.** A user-facing English string inside
   `packages/engine` is a defect.
3. **The engine is pure and deterministic.** No I/O, no clock, no globals, no mutation.
   Randomness comes from `state.rng`. If MON-208 needs a clock, the caller passes the time in.
4. **The UI renders `legal_commands`.** It never decides legality.
5. **Logical CSS properties only** in `packages/web`. `ms-*` / `me-*` / `start` / `end`.
6. **Never invent game data.** The Israeli city list (MON-503) is blocked on a verified source.
   A fabricated board looks correct and will never be re-checked — that is exactly why it is
   worse than an empty one.
7. **No trademarked names, logos or artwork** anywhere, including commit messages. The repo is
   public.
8. **Commit hygiene.** One logical change per commit, message explaining why. The owner reads
   this history to learn from it.

---

## 6. Stop and ask the human

Do not guess your way past any of these:

- **MON-503** — the Israeli board's city names. Ask for the list or a citable source.
- **MON-802** — creating the public GitHub repo and pushing. The guard hook blocks agents from
  repo-visibility changes by design.
- **Any ADR reversal.** If Phase 0 concludes an ADR is wrong, propose the reversal with
  reasoning and wait. Do not quietly build the other thing.
- **A rule ambiguity where sources genuinely disagree** (some editions differ on Income Tax
  and Luxury Tax amounts, and on whether the last house is auctioned). Present the options and
  the trade-off; do not pick silently.
- **Scope beyond the spec.** Networked play, accounts, monetisation, extra boards are all
  explicitly deferred (ADR-006, E9).
- **A repair loop that has failed three times.** Stop, write down what you learned, ask.

`/goal`-style keep-going directives never override these stops, nor a `command-guard` block.

---

## 7. Phase N+1 — the second gap pass (mandatory)

**After implementation, before declaring the project done**, run the exploration again — this
time against the *code that exists* rather than the design that was proposed:

1. Re-run the six Phase 0 questions against the implementation. Designs drift while being
   built; find where.
2. **Completeness critic**: what modality was never run, what claim was never verified, what
   rule in spec §3.6 has a test that would pass with the implementation deleted?
3. **Play the game.** In the terminal, and in the browser, in both languages. Note everything
   that felt wrong, not only what was incorrect. A rule can be right and still confusing to a
   child, and that is a finding.
4. Append to `docs/GAP_ANALYSIS.md` under a dated second-pass heading, then fix what you
   found — or file it with a severity and a reason for deferring.
5. Run `/flow-reviewer` for a retrospective on the orchestration itself: which fan-outs were
   wasted, which reviews caught real defects, what the next project should do differently.

Report honestly. If M7 slipped or an invariant is only partly covered, say so plainly with the
evidence. A green summary over an incomplete milestone is worse than an accurate red one,
because the owner will act on it.

---

## 8. Quick reference

```bash
uv sync
uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest
uv run kesef boards          # engine sanity check
uv run kesef show classic    # full board layout and economics
uv run uvicorn kesef_server.api:app --reload

cd packages/web && npm run typecheck && npm run lint && npm run test -- --run
```

| Where | What |
|---|---|
| `docs/superpowers/specs/2026-07-25-kesef-street-design.md` | the design |
| `docs/BACKLOG.md` | the work, with the dependency spine at the end |
| `docs/adr/` | what was decided and what was rejected |
| `docs/GAP_ANALYSIS.md` | **you create this in Phase 0** |
| `CLAUDE.md` | conventions, guardrails, model tiering |
| `packages/engine/src/kesef_engine/rules/__init__.py` | the planned rule modules, with owning backlog IDs |
