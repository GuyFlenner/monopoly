# Kesef Street — Project Instructions

## What this is

A bilingual (English / Hebrew) property-trading board game for 2–6 players playing by the
classic universal rules, built as a **teaching-grade codebase**: a pure rules core, a thin
transport, and a UI that knows no rules. Human vs human, human vs bots, or any mix of six
seats, all on one screen.

Read **`docs/superpowers/specs/2026-07-25-kesef-street-design.md`** before implementing
anything. The decisions behind it are in `docs/PROJECT_BRIEF.md` and `docs/adr/`. The work
items are in `docs/BACKLOG.md`.

## The architecture, in one screen

```
packages/engine   kesef-engine   apply(state, command) -> (state, events)
                                 pure Python, one dependency, no I/O, deterministic
packages/server   kesef-server   FastAPI + WebSocket. Sessions and serialization only.
packages/web      @kesef-street/web   React 19 + Vite + TS + Tailwind. Presentation only.
```

## Four rules that are not negotiable

1. **Rules live in the engine. Only in the engine.**
   If the server or the UI contains `if player.cash < rent`, that is a bug regardless of
   whether it works. The UI renders `GameView.legal_commands` as buttons; it never decides
   what is legal.

2. **The engine never returns prose — only i18n keys.**
   `tile.classic.boardwalk`, `error.not_your_turn`, `rent.note.full_group_doubled`. This is
   what makes the Hebrew build a catalogue rather than a code change. A string literal
   destined for a human's eyes inside `packages/engine` is a defect.

3. **The engine is deterministic and pure.**
   No clocks, no globals, no I/O, no mutation. Randomness comes from `state.rng`, which is
   part of the serialized state. `apply()` returns a new state.

4. **Logical CSS properties only, everywhere in the web package.**
   `ms-*` / `me-*` / `ps-*` / `pe-*` / `start` / `end`. Never `ml-*`, `pr-*`, `left`,
   `right`. A physical property is a bug that is invisible in English and obvious in Hebrew.

## Tech stack

- **Python 3.13** (`.python-version`), managed with **uv**. `uv sync`, `uv add <pkg>`,
  `uv run <cmd>`. Never `pip install`. `uv.lock` is authoritative — always commit it.
- **Engine**: pydantic v2 only. Adding a second dependency to `kesef-engine` needs an ADR.
- **Server**: FastAPI + pydantic-settings + structlog.
- **Web**: React 19, Vite 6, TypeScript strict, Tailwind v4, i18next, TanStack Query,
  Zustand for UI-local state only (never for game state — that lives in the engine).
- **Lint/format**: ruff (line-length 120) for Python, eslint + prettier for TS.
- **Types**: mypy `strict` with the pydantic plugin; `tsc --noEmit` with
  `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- **Tests**: pytest (+ hypothesis for engine invariants), vitest + Testing Library,
  Playwright for one e2e smoke in each locale.

## Build & verify

```bash
uv sync                      # runtime + dev tools into .venv
uv run pre-commit install    # one-time: commit hook = the fast subset of this gate
uv run ruff check .          # lint
uv run ruff format --check . # format gate — DISTINCT from the line above
uv run mypy                  # types, strict
uv run pytest                # tests
uv run kesef boards          # sanity: the engine loads its board data
```

```bash
cd packages/web && npm run typecheck && npm run lint && npm run test -- --run
```

CI (`.github/workflows/ci.yml`) runs the same set plus `pip-audit` and an API-contract
drift check. **A passing `ruff check` is not a passing `ruff format --check`.** Run both.

## Testing expectations

- **Engine rules get three kinds of test.** A unit test for the rule, a **golden recorded
  game** (fixed seed plus a command list, asserting the final state) for regression, and a
  **hypothesis invariant** where one applies. The invariants that must always hold:
  money is conserved, houses never exceed 32 and hotels 12, even-build is never violated,
  and no player holds negative cash outside `DEBT_SETTLEMENT`.
- **`legal_commands` and `apply` must agree.** Every command the former returns is accepted
  by the latter; every command it omits is rejected. This is a property test, not a
  spot-check.
- **A test that cannot fail is not a test.** If deleting the implementation still leaves it
  green, it is documentation with a misleading name.

## Product and UX standards

These are gates, not aspirations. The audience includes six-year-olds and colourblind
adults, and those two needs overlap more than they conflict.

- Colour groups always carry a **pattern or icon** as well as a colour.
- Every rent figure can be **explained**, not merely charged (`rent.note.*` keys exist for
  this reason).
- Full keyboard reachability, visible focus, `aria-live` narration of dice, movement and
  money, contrast ≥ 4.5:1 for text, hit targets ≥ 44 × 44 px.
- Nothing blocks on an animation. A player can always act, and skip the flourish.

## How agents work in this repo

1. **Diffs, not deployments.** `.claude/hooks/command-guard.sh` hard-blocks force-push,
   hard reset, `git clean -fdx`, registry publishes and repo deletion. A human runs those.
2. **Every change flows through PR → CI → review.** Green CI is the floor, not the goal.
3. **No secrets in source.** `.claude/hooks/edit-guardrail.sh` blocks literal keys.
4. **Ask before inventing game data.** The Israeli board's city names must come from a
   verified source (MON-503). A plausible-looking fabricated board is worse than a missing
   one, because nobody will re-check it.

## Model tiering

| Tier | Model | Owns |
|------|-------|------|
| Architect / reviewer | **Fable** | Spec, ADRs, rule correctness, the reducer's phase machine, auction and bankruptcy edge cases, review of everything below |
| Mainstream build | **Opus 4.8** | Rule modules, bots, the board and dossier components, the animation queue |
| Mechanical | **Sonnet 5** | Locale catalogues, test scaffolding, story-level components, docs, config |

Pattern: **Fable plans and reviews; Opus implements; Sonnet fills.** Pick the tier by how
expensive it would be to get the thing subtly wrong. Rent maths is expensive. A button
label is not.

## Skills

Entry point: **`use sdlc: <task>`** runs PO → Team Lead → Architect → Developer → Security →
Review → Tests → PR → Retro. Also present: `/architect`, `/code-reviewer`, `/test-reviewer`,
`/debugger`, `/product-owner`, `/team-lead`, `/flow-reviewer`, `/checkpoint`,
`/diagram-generator`, `/skill-lint`, `/audit`, `/discovery`.

## Trademark discipline

The project is deliberately named, branded and worded so that it is an original
implementation of a widely played *ruleset*, not a copy of a branded product. Do not add the
trademarked product name, its logo, its mascot, its card artwork, or its specific
trade-dress to this repo, in code, docs, assets or commit messages.

**Owner**: Guy Flenner · **Created**: 2026-07-25
