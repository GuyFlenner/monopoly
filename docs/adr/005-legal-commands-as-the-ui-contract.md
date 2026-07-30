# ADR-005 — The engine tells the UI what is legal; the UI never decides

- **Status**: Accepted
- **Date**: 2026-07-25
- **Deciders**: Guy Flenner

## Context

There is a bug family every board-game implementation eventually ships: the Build button is
enabled but the move is rejected, or it is greyed out when the move was actually allowed.
It happens because two places encode the same rule — the engine that validates, and the UI
that decides what to render — and they drift.

The same drift shows up between a human's options and a bot's, when the bot is given a
different view of what it may do.

## Decision

`legal_commands(state) -> tuple[Command, ...]` returns every command that is legal right
now, **with concrete parameters** — `BuildHouse(tile=16)`, not "you may build somewhere". It
is bundled into every `GameView` the server returns.

The UI renders the commands it is handed. It contains no rule logic of any kind. Bots receive
the identical tuple, so a bot cannot cheat — it has no path to the state except the one a
human uses.

Three properties, enforced as property tests rather than spot-checks *(amended 2026-07-26 —
the original two-way statement was false against its own exceptions; a test written from it
would fail on a correct implementation and be weakened under pressure)*:

1. **Soundness** — every command `legal_commands` returns is accepted by `apply`.
2. **Completeness over enumerable kinds** — for the 15 command kinds that `legal_commands`
   enumerates exhaustively, every omitted command is rejected by `apply`, and the rejection
   is specifically `IllegalCommandError` with a populated `reason_key` — a crash does not
   count as a rejection.
3. **`is_legal` is the oracle for the rest** — for commands drawn from the full parameter
   space (all bids, all trade drafts), `is_legal(state, command)` agrees with whether
   `apply` accepts. This runs over an *unconstrained* structural state generator, not only
   replayed games: both sides see the same state, so reachability does not matter, and the
   property is not blind to states a buggy `legal_commands` cannot reach.

The two unbounded parameter spaces keep their explicit exception: `PlaceBid` is returned at
the minimum legal bid (with the legal range shipped on the auction view), and `ProposeTrade`
is not enumerated at all — the trade builder validates its draft through `is_legal`, exposed
over HTTP by the `validate` route (ADR-008).

*Amended 2026-07-30 by ADR-009*: the trade builder is no longer the only caller doing that. A
bot may construct a `ProposeTrade` and validate it through `is_legal` the same way, because a
bot that could only return an enumerated command could never open a trade and therefore could
never un-split a colour group. **The enumeration exception itself is unchanged** — nothing about
the offer space or the cost of enumerating it changed — and so is the property that matters here:
the bot has no path into the state that a human does not have.

## Alternatives considered

**The UI derives affordances from the state.** The conventional approach, and the source of
the bug family above. Rejected.

**The UI optimistically enables everything and shows errors.** Honest, and it does keep the
rules in one place — but it teaches a child by punishment, offering moves that turn out to be
illegal. Wrong for this audience.

**A capability bitmask** (`canBuild: true`) rather than concrete commands. Rejected: the UI
still has to construct the command, which means it still has to know which tile is buildable,
which is the rule leaking out again.

## Consequences

- The UI is genuinely simple, and stays simple as rules get more intricate. Adding a rule
  changes the engine and, at most, adds a label.
- Rendering is driven by data, so a new action needs a translation entry and an icon, not a
  new conditional.
- `legal_commands` is on the hot path for every render and must stay cheap. At 40 tiles and
  6 players this is not a real constraint, but it is a reason not to make it do search.
- Hints in Kids Mode are a natural extension: rank the legal commands and highlight one. The
  hint system needs no rule knowledge of its own.
