# Claude SDLC — Framework Config (Kesef Street)

The `.claude/` configuration for this repo. Skills migrated from `claude-stream` (see
`../claude-skills.lock`). **Project stack, conventions, safety rules and model tiering live in
the root `../CLAUDE.md`** — this file only covers the SDLC entry points.

## Primary entry point

```
use sdlc: <feature or bug description>
```

Runs the pipeline: **PO → Team Lead → Architect → Developer → Security → Review → Tests → PR →
Retro.**

Optional keep-going with a done-check:

```
/goal SDLC run for "<desc>" is DONE when: acceptance criteria met, code review APPROVED,
gate green (ruff check + ruff format --check + mypy + pytest), PR opened. STOP on any HITL blocker.
use sdlc: <desc>
```

`/goal` never overrides a safety stop — a `command-guard` block, an exhausted repair budget, a
blocked backlog item (MON-503), or anything in §6 of `../docs/FABLE_KICKOFF.md`.

## Individual skills

```
/architect            → design + ADR only
/product-owner        → turn a request into backlog items with acceptance criteria
/code-reviewer        → code review
/test-reviewer        → catch tests that pass but assert nothing
/debugger             → root-cause a failure
/security-researcher  → security sign-off
/diagram-generator    → draw.io architecture diagram
/flow-reviewer        → retrospective on the last run
/checkpoint           → save session state + emit a resume prompt
/audit                → pre-PR audit against project conventions
```

## Guardrails (active)

- **PreToolUse / Bash** → `hooks/command-guard.sh`: hard-blocks force-push, `git reset --hard`,
  `git clean -fdx`, history rewriting, npm/PyPI publishing, repo deletion or visibility
  changes, and catastrophic `rm -rf`. Irreversible and outward-facing actions are a human's
  keystroke.
- **PostToolUse / Edit·Write·MultiEdit** → `hooks/edit-guardrail.sh`: blocks hardcoded keys and
  secrets, warns on ownerless TODOs. Use `TODO(MON-###)` so a TODO has an owning backlog item.
- `settings.json` mirrors these as `permissions.deny` and pre-allows the safe verbs (`uv run`,
  `npm run`, read-only git, `gh pr`/`gh issue`).

## Project-specific review checklist

Beyond the generic checklists, a reviewer here must check:

1. No rule logic outside `packages/engine`.
2. No user-facing English string inside `packages/engine` — keys only.
3. No physical CSS properties in `packages/web` (`ml-*`, `pr-*`, `left`, `right`).
4. No global randomness, clock access, or I/O in the engine.
5. Every new rule has a unit test, a golden-game touch, and an invariant where one applies.
6. No invented game data.
