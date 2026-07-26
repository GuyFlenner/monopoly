# ADR-002 — The engine is a reducer, and the RNG lives inside the state

- **Status**: Accepted
- **Date**: 2026-07-25
- **Deciders**: Guy Flenner

## Context

The obvious way to model a board game is a graph of mutable objects: a `Game` holding
`Player` objects with a `move()` method that changes `self.position` and calls
`self.pay_rent(owner)`. It is the shape most tutorials use, and it works — until you want to
save a game, undo a move, reproduce a bug report, or let a bot look three turns ahead.

## Decision

The engine is a reducer over an immutable state:

```python
apply(state: GameState, command: Command) -> tuple[GameState, tuple[Event, ...]]
```

`GameState` is a frozen pydantic model with **no hidden state anywhere** — no module
globals, no clocks, no `random` module. Randomness comes from `Rng(seed, counter, stream)`,
which is a field of the state.

Commands and events are closed discriminated unions. Events are returned alongside the new
state because the state says what to *draw* and the events say what to *animate*: a client
diffing two states would know the token is on Boardwalk but not that it passed GO to get
there.

## Alternatives considered

**Mutable object graph.** Simpler to write for the first ten rules. Rejected: every feature
in the table below would have to be built deliberately, and several (reproducibility, bot
rollouts) would be impractical to retrofit.

**`random.Random` held outside the state.** Its Mersenne Twister state is ~2.5 KB, awkward
to round-trip through JSON, and restoring a position means replaying every draw. We use
counter-based **splitmix64** instead: the whole generator is two integers, and any position
in the stream is reachable in O(1). Separate `stream` values keep deck shuffles from
shifting the dice sequence.

**Frozen dataclasses instead of pydantic.** Slightly faster and dependency-free. Rejected:
pydantic gives us validated construction, JSON round-tripping and the server's schema from
one declaration, and at 40 tiles and 6 players the performance difference is not measurable.
One dependency in the engine is the budget; a second needs its own ADR.

## Consequences

| We get | Because |
|---|---|
| Save / load | `model_dump_json()` **is** the save file. No extra code was written for this. |
| Replay and regression tests | a seed plus a command list reproduces a game exactly |
| Undo | keep the previous state; there is nothing else to roll back |
| Bot lookahead | clone the state, play hypotheticals, discard them |
| Networked play later | "commands in, events out" is already a wire protocol (ADR-006) |
| A reproducible bug report | a seed and a command list, not "it happened after a while" |

The costs are real and accepted: every mutation allocates a new state, the code is written
in a functional style that is less familiar than mutation, and `apply` must be careful to
resolve transient phases fully before returning so callers never observe a half-finished
turn.
