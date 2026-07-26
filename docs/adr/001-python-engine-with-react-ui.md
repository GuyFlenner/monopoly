# ADR-001 — A pure Python rules engine behind a React web UI

- **Status**: Accepted
- **Date**: 2026-07-25
- **Deciders**: Guy Flenner

## Context

We need a board game that is genuinely pleasant for children to look at, that supports
Hebrew right-to-left properly, that can show two players' property portfolios side by side,
and that doubles as a codebase worth reading and learning from.

Three candidate shapes were considered.

## Decision

A uv-workspace monorepo with three packages:

| Package | Responsibility |
|---|---|
| `packages/engine` | the rules. Pure Python, one dependency, no I/O, deterministic |
| `packages/server` | FastAPI + WebSocket. Sessions, serialization, fan-out. No rules |
| `packages/web` | React 19 + Vite + TypeScript + Tailwind. Presentation. No rules |

## Alternatives considered

**Pure Python with Pygame.** One language, one toolchain, no build step, and the simplest
thing to grasp end to end. Rejected on two counts. First, right-to-left Hebrew has to be
hand-rolled (bidi handling, manual mirroring of the board and every panel), where a browser
gives it to us for the price of one `dir` attribute and a discipline of logical CSS
properties. Second, every panel, layout and animation is manual rectangle arithmetic, which
is exactly the work we would rather spend on the rules — and the result looks dated to a
child who uses a tablet.

**Textual / terminal UI.** Cheap and fast, and we keep a text driver for precisely this
reason (see below) — but it is not a game a six-year-old wants to play.

**Both a Pygame and a web front end.** Maximum proof that the engine is UI-agnostic, at
roughly 1.6× the UI work plus a permanent feature-parity tax. The text driver already proves
the same point at a fraction of the cost.

## Consequences

- Two languages and two toolchains. Mitigated by generating the TypeScript API types from
  the server's OpenAPI document, so the contract cannot silently drift (ADR-005, MON-302).
- The engine ships a **text-mode driver** (`uv run kesef play`). This is not a toy: it means
  the rules are demonstrably correct and winnable before any pixel exists, and it keeps the
  engine honest about being UI-agnostic without maintaining a second real UI.
- The engine could later run in the browser via Pyodide, or be reimplemented in TypeScript,
  and neither would require the UI to change. We are not planning either.
- The web package can be built by a different agent, in parallel with the engine, against
  the generated contract.
