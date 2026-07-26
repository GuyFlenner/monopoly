# ADR-006 — Local hotseat for v1; networked play deferred but not designed out

- **Status**: Accepted
- **Date**: 2026-07-25
- **Deciders**: Guy Flenner

## Context

The brief needs 2–6 players, human against human, human against machine, or any mix. That
requirement is fully satisfied by everyone sharing one screen and taking turns — which is
also how a family actually plays a board game at a table.

Networked play (each player on their own device, joining by room code) is a different
product: it needs a lobby, room lifecycle, reconnection, per-seat views so a player cannot
see another's hand, and server-authoritative anti-cheat. Realistically it doubles v1.

## Decision

**v1 is local hotseat.** One client holds one game; all seats are on that client; any seat
can be a bot. No accounts, no lobby, no rooms, no auth.

Sessions live in a process-local dictionary (`SessionStore`), capped, with no database.

**Networked play is deferred, not designed out.** Three v1 choices keep it additive:

- The engine is already "commands in, events out" (ADR-002), which is a wire protocol.
- The server is already the only place state changes, so it is already authoritative.
- Every session keeps an append-only event log, which is what a late joiner or a
  reconnecting client needs to catch up.

## Alternatives considered

**Networked one-device-per-player in v1.** Closer to how a family spread across rooms would
play. Rejected on scope: it defers the actual game — the rules and the board — behind
infrastructure, and this project's value is in the rules and the presentation.

**Peer-to-peer with no server.** Rejected: with no authoritative state, cheating is trivial
and desync is inevitable.

## Consequences

- Restarting the server loses in-flight games. Accepted, and partly mitigated for free:
  `GameState` serializes losslessly, so "save to a file and load it back" is a small feature
  rather than a subsystem (MON-704).
- `SessionStore` is deliberately a narrow interface, so swapping in Redis touches nothing
  else.
- Hotseat has one UX problem networked play does not: **secret information**. Under the
  universal rules there is very little — no hidden hand — but a player's deliberation is
  visible. We accept this; it is how the physical game works.
- The WebSocket endpoint exists in v1 for event streaming to a single client. That is not
  premature: it is what drives the animation queue, and it happens to be the seam networked
  play would grow from.
