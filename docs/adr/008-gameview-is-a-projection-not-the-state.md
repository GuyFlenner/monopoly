# ADR-008 — GameView is a projection, not the raw GameState

- **Status**: Proposed (Phase 0 gap analysis; awaiting owner review)
- **Date**: 2026-07-26
- **Deciders**: Guy Flenner
- **Informs**: `GAP_ANALYSIS.md` G-30..G-36

## Context

`GameView` currently embeds the engine's `GameState` verbatim. Phase 0 found this fails in
both directions at once:

- **Too little reaches the wire.** Everything the UI actually needs is a `@property` or
  method that pydantic silently drops from `model_dump` and therefore from the OpenAPI
  document and `generated.ts`: the **board itself** (tiles, names, groups, prices — no
  endpoint returns them at all), `net_worth`, group completion, dice totals. Rendering the
  dossier would mean re-implementing the valuation rule in TypeScript — the exact
  `if cash < rent` defect this architecture exists to prevent, one layer up.
- **Too much reaches the wire.** The full deck order and the RNG seed ship with every view —
  a devtools cheat channel in hotseat and a real one the day networked play lands.

Separately, the event log is *history*: a log line rendered by looking up current state shows
turn-20 numbers on a turn-3 entry. Events must be self-contained.

## Decision

1. `GameView` becomes an explicit **projection**: `{ board, state: GameStateView,
   legal_commands, events, event_cursor }`.
   - `board: Board` ships whole (frozen, serializable, ~4 KB, static per game).
   - `GameStateView` carries what the state carries **minus** `rng` and deck contents
     (`deck_counts` replace the ordered lists), **plus** promoted derived fields:
     `net_worth` per player, `group_holdings` per player (`owned/total/complete/houses/
     mortgaged_count` per colour group), dice `total`.
2. The full `GameState` remains reachable only via the save-file path
   (`GET /games/{id}/save`) — the reducer's "the JSON is the save file" property is kept,
   just no longer conflated with what a client may see.
3. **Every event is self-contained**: it carries every parameter its catalogue sentence needs
   in either language (`RentCharged` gains base rent, houses, multiplier, dice total, group,
   `note_keys` + `note_params`). Events gain a session-assigned `seq`, and
   `GET /games/{id}?since=` replays from a cursor.
4. Errors are structured: `{reason_key, params}` — the engine's `IllegalCommandError` context
   survives to the client, so `error.insufficient_funds` can say how much short.
5. `POST /games/{id}/validate` exposes `is_legal` non-mutatingly — the trade builder's live
   validation path (ADR-005 explicitly delegates trades to `is_legal`; without a route that
   delegation dead-ends at the HTTP boundary).

## Alternatives considered

**Promote everything to `computed_field` and keep shipping `GameState`.** Fixes "too little",
not "too much" — the rng/decks stay on the wire. Also couples the engine's internal shape to
the wire contract forever. Rejected.

**A `GET /boards/{id}` endpoint instead of `board` in the view.** Workable, saves ~4 KB per
poll; but the view's docstring — "everything a client needs to render one frame" — becomes a
lie, and reconnect needs two round-trips. The 4 KB is static and HTTP-cacheable anyway.
Rejected for v1; revisit if view size ever matters.

**Trusting the hotseat client (ship rng/decks, nobody cheats their own family).** Tempting,
but ADR-006 deliberately kept the wire protocol networked-play-ready, and this would quietly
un-keep it. Rejected.

## Consequences

- The server grows a small mapping layer (state → view). It owns **no rules** — every field
  it adds is either a copy or a call into an engine-derived property.
- `generated.ts` gains real types for the board and the dossier; MON-403..410 need zero
  client-side arithmetic.
- The 501-route schemas change before MON-301 implements them — which is exactly why this is
  decided at Phase 0, while the change is free.
- The golden-game format asserts events with `seq`, killing the duplicate-event ambiguity in
  the animation queue (MON-701) for free.
