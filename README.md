# Kesef Street · רחוב הכסף

A bilingual (English / Hebrew) property-trading board game for 2–6 players, playing by the
classic universal rules. Play human against human, human against bots, or any mix up to six
seats — all on one screen.

> **Status: M0 — bootstrapped.** The board data, the state and command model, the RNG and the
> API contract are in place and tested. The rules engine and the UI are being built next; see
> [`docs/BACKLOG.md`](docs/BACKLOG.md).

## Why this repo might interest you

It is a small game, deliberately built the way a larger system should be:

- **A pure rules core.** `kesef-engine` is `apply(state, command) -> (state, events)`. No I/O,
  no framework, one dependency. Save/load, undo, replay, regression tests and bot search all
  fall out of that one decision rather than being features anyone had to build.
- **Bilingual by construction, not by sweep.** The engine never returns a human-readable
  string — only i18n keys. It is structurally impossible for English to leak into the rules.
- **The UI does not know the rules.** It renders the buttons the engine hands it
  (`legal_commands`), so the classic "the button was enabled but the move was illegal" bug
  family cannot occur.
- **Two boards, two languages, independently.** Play the Israeli city board in English or the
  Atlantic City board in Hebrew. The boards are data with identical economics, so one ruleset
  stays valid for both.

## Quick start

```bash
uv sync                       # Python 3.13 toolchain + both packages
uv run kesef boards           # the bundled boards
uv run kesef show classic     # full layout and economics
uv run uvicorn kesef_server.api:app --reload    # API at :8000/docs
```

## The gate

Everything below must be green before a PR merges. Note that a passing `ruff check` is
**not** a passing `ruff format --check` — run both.

```bash
uv run ruff check .
uv run ruff format --check .
uv run mypy
uv run pytest
```

## Layout

```
packages/engine/   kesef-engine — the rules. Pure Python, no I/O, deterministic.
packages/server/   kesef-server — FastAPI + WebSocket. Thin. Owns no rules.
packages/web/      React 19 + Vite + TypeScript + Tailwind. Owns no rules either.
docs/              design spec, ADRs, backlog, and the orchestration brief
```

## Documentation

| Document | What it is for |
|---|---|
| [`docs/superpowers/specs/2026-07-25-kesef-street-design.md`](docs/superpowers/specs/2026-07-25-kesef-street-design.md) | the design spec — read this first |
| [`docs/PROJECT_BRIEF.md`](docs/PROJECT_BRIEF.md) | what we decided and why |
| [`docs/BACKLOG.md`](docs/BACKLOG.md) | every work item, with acceptance criteria |
| [`docs/FABLE_KICKOFF.md`](docs/FABLE_KICKOFF.md) | the brief handed to the orchestrating model |
| [`docs/adr/`](docs/adr/) | the decisions, with the alternatives we rejected |
| [`CLAUDE.md`](CLAUDE.md) | conventions and guardrails for agents working here |

## Accessibility and children

The two are the same problem often enough that we treat them as one:

- Colour groups always carry a **pattern or icon**, never colour alone.
- Every rent calculation can be **explained** in-game, not just applied.
- Full keyboard navigation, visible focus, and `aria-live` narration of dice and payments.
- Kids Mode: no auctions or mortgages, simplified trades, hints on, and a target game
  length so the game ends while it is still fun.

## Licence and trademarks

MIT — see [`LICENSE`](LICENSE).

This is an independent, original implementation of the widely played rules of a
property-trading board game. It is **not** affiliated with, endorsed by, or derived from the
assets of Hasbro or any other rights holder, and it deliberately uses its own name, artwork
and board naming. The Atlantic City street names in the `classic` board are real place names
in Atlantic City, New Jersey.
