# Contributing to Kesef Street

Thank you for looking. This is a teaching-grade codebase as much as it is a game, so the
conventions below are the point rather than paperwork around it — most of them exist because a
specific class of bug is impossible once they hold.

Read [`docs/superpowers/specs/2026-07-25-kesef-street-design.md`](docs/superpowers/specs/2026-07-25-kesef-street-design.md)
before implementing anything. [`docs/PROJECT_BRIEF.md`](docs/PROJECT_BRIEF.md) and
[`docs/adr/`](docs/adr/) hold the reasoning; [`docs/BACKLOG.md`](docs/BACKLOG.md) holds the work
items and their acceptance criteria.

## Getting set up

You need [uv](https://docs.astral.sh/uv/) and Node 22. **uv installs Python 3.13 itself** — the
version is pinned in `.python-version`, and you do not need a system Python.

```bash
uv sync                      # runtime + dev tools into .venv
uv run pre-commit install    # one-time: the commit hook is the fast subset of the gate
```

```bash
cd packages/web && npm ci
```

**Never `pip install`.** Use `uv add <pkg>` for a runtime dependency and
`uv add --dev <pkg>` for a tool. `uv.lock` is authoritative and always committed; a PR that
changes dependencies without it will fail CI on `uv sync --frozen`.

Two constraints on dependencies specifically:

- **`kesef-engine` has one dependency, pydantic v2.** Adding a second needs an ADR. The engine
  being almost free-standing is what makes it portable, testable and quick.
- The web package's `src/api/generated.ts` is generated from the server's OpenAPI document by
  `npm run api:generate`. Never hand-edit it — CI regenerates and diffs it byte for byte.

Run the app with the two commands in the [README](README.md#quick-start): uvicorn on `:8000`,
Vite on `:5173`.

## The four rules that are not negotiable

1. **Rules live in the engine. Only in the engine.** If the server or the UI contains
   `if player.cash < rent`, that is a bug regardless of whether it works. The UI renders
   `GameView.legal_commands` as buttons; it never decides what is legal. This is ADR-005, and it
   is what removes the whole family of "the button was enabled but the move was rejected" bugs —
   a command the engine did not offer has no representation in the client at all.
2. **The engine never returns prose — only i18n keys.** `tile.classic.boardwalk`,
   `error.not_your_turn`, `rent.note.full_group_doubled`. A string literal destined for a human's
   eyes inside `packages/engine` is a defect. This is what makes the Hebrew build a catalogue
   rather than a code change.
3. **The engine is deterministic and pure.** No clocks, no globals, no I/O, no mutation.
   Randomness comes from `state.rng`, which is part of the serialized state (ADR-002); a bot
   consulting the state must not advance it, so a bot's presence cannot change the dice a person
   sees. `apply()` returns a new state.
4. **Logical CSS properties only, everywhere in the web package.** `ms-*` / `me-*` / `ps-*` /
   `pe-*` / `start` / `end`. Never `ml-*`, `pr-*`, `left`, `right`. A physical property is a bug
   that is invisible in English and obvious in Hebrew, which is the worst combination of the two.

## The verify gate

Green is the floor, not the goal. Run all of it locally before you open a PR — CI runs exactly
the same set, so "works on my machine" and "CI is green" mean the same thing here.

```bash
uv run ruff check .            # lint
uv run ruff format --check .   # formatting — a DIFFERENT gate from the line above
uv run mypy                    # strict, with the pydantic plugin
uv run pytest                  # tests; the coverage floor is enforced, see below
```

**A passing `ruff check` is not a passing `ruff format --check`.** They are separate steps in
CI so a failure names itself. This trips people up more than anything else in this file.

```bash
cd packages/web
npm run typecheck        # tsc --noEmit, with noUncheckedIndexedAccess + exactOptionalPropertyTypes
npm run lint             # eslint + stylelint
npm run format:check     # prettier
npm run test -- --run    # vitest
npm run build
npm run test:e2e         # Playwright; boots uvicorn and Vite itself
```

Coverage floors, both enforced rather than aspirational:

- **90% total**, set in `[tool.coverage.report]` so a local `--cov` run and the CI step cannot
  disagree about the number.
- **95% on `kesef_server`**, measured against the server package's own tests so the engine's much
  larger surface cannot carry a thin transport over the line.

CI adds three things you cannot easily run yourself: `pip-audit`, a check that the committed
goldens under `packages/engine/tests/goldens/` did not change during the test run (they are
committed artifacts, never a side effect), and an API-contract drift check that regenerates
`generated.ts` from a fresh OpenAPI export and diffs it.

The `pre-commit` hook is the fast mechanical subset — whitespace, JSON/YAML validity, a 500 KB
file-size ceiling, and both ruff gates. mypy and pytest are deliberately not in it; they are too
slow for a commit and CI runs them on every push.

## What a change owes in tests

**Every engine rule gets three kinds of test.**

1. **A unit test for the rule itself**, covering the boundary the rule is about.
2. **A golden recorded game** — a fixed seed plus a command list, asserting the final state.
   This is the regression net: it catches the change that is locally reasonable and globally
   wrong. Goldens are committed artifacts. If your change legitimately moves one, regenerate it
   deliberately and say so in the commit message; if a test run moves one behind your back, that
   is a failure by design.
3. **A hypothesis invariant, where one applies.** These must always hold: money is conserved,
   houses never exceed 32 and hotels 12, even-build is never violated, and no player holds
   negative cash outside `DEBT_SETTLEMENT`.

**`legal_commands` and `apply` must agree.** Every command the former returns is accepted by the
latter, and every command it omits is rejected with a populated `reason_key` rather than a crash.
That is a property test over a state generator, not a spot-check. (`ProposeTrade` is the
documented exception — the offer space is unbounded, so it is validated through `is_legal`
instead of enumerated.)

**A test that cannot fail is not a test.** If deleting the implementation leaves it green, it is
documentation with a misleading name. The most common shape of this here is a jsdom test asserting
something only a layout engine can answer — `scrollHeight` is 0 for every element in jsdom, so a
geometric claim belongs in `packages/web/e2e/` where a browser can measure it.

For the web package: components get Vitest + Testing Library tests, and anything whose truth is
spatial or transport-dependent gets a Playwright spec. Prefer selecting by role and accessible
name; where a spec must work in both languages, select structurally (`data-command-kind`,
`input[id$="-name"]`) so one script drives both.

## Two languages, and no invented game data

- **Both catalogues, in the same PR.** A key added to `common.en.json` and not to
  `common.he.json` leaves a Hebrew player looking at a raw key. `missingKeyHandler` throws under
  dev and test, so the gate will usually catch you, but the habit is the fix.
- **Keys, not sentences, cross the boundary.** If the client is translating an engine enum at the
  render boundary, or diffing two server payloads to produce a label, the projection is missing a
  field — file it rather than working around it. `docs/BACKLOG.md` §E4b is a list of exactly that
  kind of gap, and it exists because each one was found by a component that had to work around it.
- **Ask before inventing game data.** Board names, city names and card text must come from a
  verified source. A plausible-looking fabricated board is worse than a missing one, because it
  looks correct and nobody will ever re-check it.
- **Check the mirror, not just the translation.** Hebrew is a mirrored layout, not English with
  different words. If you touch layout, look at both directions before you push.

## Accessibility and children are one requirement

These are gates, not aspirations. The audience includes six-year-olds and colourblind adults, and
those two needs overlap more than they conflict.

- Colour groups always carry a **pattern or an icon** as well as a colour.
- Every action affordance is an icon **and** words — fifteen text-only labels means a pre-reader
  cannot use the game at all.
- Every rent figure can be **explained**, not merely charged; `rent.note.*` keys exist for this.
- Full keyboard reachability, visible focus, `aria-live` narration of dice, movement and money,
  contrast ≥ 4.5:1 for text, hit targets ≥ 44 × 44 px.
- There is exactly **one live region** in the product and it belongs to `<Announcer>`. A component
  with something to say uses `useAnnounce`; a second live region announces one dice roll twice.
- Nothing blocks on an animation. A player can always act, and can always skip the flourish.

## Opening a pull request

1. **Branch from `main`.** Name it for the work: `feature/mon-802-public-repo`,
   `fix/rent-note-hotel`.
2. **Commit in conventional-commit style**, naming the backlog item:
   `feat(engine): explain every rent, not just the doubled ones (MON-416)`. Say *why* in the body,
   not just what — the diff already says what. Commit messages are where the reasoning for a
   surprising decision survives.
3. **Run the whole gate**, both ruff steps included.
4. **Open the PR against `main`** and describe the behaviour change, the tests that pin it, and
   anything you decided against. If it changes a documented contract, it needs a note in
   `docs/adr/`.
5. **Green CI, then review.** Green CI is the floor. Reviewers here also check, specifically: no
   rule logic outside `packages/engine`; no user-facing English inside `packages/engine`; no
   physical CSS properties in `packages/web`; no global randomness, clock access or I/O in the
   engine; a unit test, a golden touch and an invariant where one applies; and no invented game
   data.

Some things are a human's keystroke and not a contributor's or an agent's: force-pushing,
`git reset --hard`, `git clean -fdx`, rewriting history, publishing to a registry, and changing
the repository's visibility. The hooks in `.claude/hooks/` block them outright.

## Reporting a bug

Please use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md), and please include
**the seed and the command list**. Games here are reproducible from a seed: `state.rng` is part of
the serialized state, so a seed plus the moves played is a complete, exact reproduction of what
you saw. It turns "the rent looked wrong" into a failing test in about a minute. Without it,
diagnosis is guesswork.

## Trademarks

This project is deliberately named, branded and worded so that it is an original implementation of
a widely played *ruleset*, not a copy of a branded product. **Do not add the trademarked product
name, its logo, its mascot, its card artwork, or its specific trade dress to this repository** — in
code, docs, assets, issue titles or commit messages. Describe the game as an implementation of the
classic property-trading ruleset. The project carries its own name, its own artwork and its own
board naming, and that is not an accident to be tidied up later.

---

**Owner**: Guy Flenner · Licensed MIT, see [`LICENSE`](LICENSE).
