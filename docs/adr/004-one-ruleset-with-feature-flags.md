# ADR-004 — One rules implementation, with Kids Mode as feature flags

- **Status**: Accepted
- **Date**: 2026-07-25
- **Deciders**: Guy Flenner

## Context

The brief asks for two things that pull against each other: the **universal rules** (the
real game — auctions, mortgages, even-build, bankruptcy chains) and a game **for children**.
Auctions and mortgages are genuinely hard for a six-year-old, and a full game runs long
enough to lose them.

## Decision

The default ruleset is the complete universal rules. **Kids Mode is the same engine with
features switched off**, expressed as a `Ruleset` value that is part of the game state:

| Flag | Universal | Kids |
|---|---|---|
| `auctions_enabled` | on | **off** — declining simply leaves it with the bank |
| `mortgages_enabled` | on | **off** |
| `simplified_trades` | off | **on** — one item per side |
| `even_build_enforced` | on | **on** |
| `hints_enabled` | off | **on** |
| `max_jail_turns` | 3 | 1 |
| `starting_cash` | 1500 | 2000 |
| `target_duration_minutes` | none | 45, then richest player wins |

Even-build stays **on** in Kids Mode deliberately: removing it would unbalance the game
rather than simplify it, and the rule is easy to explain visually ("houses have to stay
level").

House rules that people play but the official rules do not sanction — money on Free Parking,
double salary for landing exactly on GO — exist as flags defaulting to **off**. Naming them
documents them as house rules instead of leaving them to be re-argued.

## Alternatives considered

**Universal rules only.** Leanest engine, fewest tests. Rejected: it makes the game
inaccessible to half its intended audience, and an auction UI is a poor first experience for
a child.

**A simplified kids ruleset only.** Fastest route to a fun game. Rejected: it is not the
ruleset that was asked for, and retrofitting auctions, mortgages and bankruptcy chains later
would touch most of the engine.

**Two engine implementations.** Rejected outright — two implementations of the same rules
diverge, and the divergence is discovered by a player mid-game.

## Consequences

- Any rule that differs between modes **must** read its flag from `Ruleset`. A variant may
  never fork a code path silently; if a rule needs a conditional, the condition is a named
  flag.
- Every rule test is parameterized over both rulesets where the rule differs, so Kids Mode
  cannot rot while the universal path stays green.
- The `/rulesets` endpoint returns both rulesets fully expanded, so the new-game screen can
  show a child's parent exactly what Kids Mode changes rather than describing it vaguely.
- The flags are serialized with the game, so a saved game replays under the rules it was
  played with even if the defaults change later.
