# ADR-007 — Interrupts are a stack of frames, not a scalar phase

- **Status**: Accepted. Proposed 2026-07-26 · Accepted in implementation by MON-100 (PR #2, 2026-07-26)
- **Date**: 2026-07-26
- **Deciders**: Guy Flenner
- **Informs**: `GAP_ANALYSIS.md` G-1..G-9; supersedes the "at most one interrupt is live at a
  time" sentence in the design spec §3.1

## Context

The M0 state model holds one `phase` scalar and three independent nullable slots (`auction`,
`pending_trade`, `pending_debt`). Phase 0's adversarial review found that the rules this
project has committed to require **nested and queued** interrupts, reachable without any
exotic play:

- a card moves a player into rent they cannot pay: `CARD_RESOLUTION → DEBT_SETTLEMENT`, and
  the card's unfinished effect (pay double, roll for utility rent) must survive;
- a debtor may trade to raise cash (MON-207): `DEBT_SETTLEMENT → TRADE_REVIEW → DEBT_SETTLEMENT`;
- bankruptcy to the bank auctions the whole estate: an ordered **queue** of tile auctions,
  during which a further debt (the 10% mortgage fee) can open on the recipient;
- the "pay each player" card creates up to five simultaneous obligations — one debt, many
  creditors.

None of these is expressible today, and a scalar phase records nowhere to *return to* — a
saved game mid-interrupt cannot resume. Meanwhile `AuctionState.tile: TileIndex` assumes every
auction sells a tile; the building-shortage rule auctions a *house*.

## Decision

1. `GameState.phase` stays (it is the UI's single "what is happening" signal), but the three
   nullable slots are replaced by **`interrupts: tuple[InterruptFrame, ...]`** — a stack whose
   top frame is the live interrupt. Each frame is a tagged union member
   (`AuctionFrame | DebtFrame | TradeFrame | CardFrame`) and carries its own **resume phase**.
   A validator ties `phase` to the top frame's kind (or to no frame, for ordinary phases).
2. `AuctionFrame` carries a **lot** (`TileLot | BuildingLot`), a **reason**
   (`declined_purchase | bankruptcy_to_bank | building_shortage`), the stored `eligible`
   bidding order, the withdrawn set, `min_bid`/`max_bid`, and a queue of remaining lots for
   estate liquidation.
3. `DebtFrame` carries `obligations: tuple[Obligation, ...]` (one debtor, N creditors, each
   `PlayerId | "bank"`), the triggering `CashReason` and source tile. Semantics are
   **shortfall-as-data**: cash never goes negative; the frame holds the outstanding amounts.
4. `CardFrame` carries `(card_id, deck, step)` so a multi-step card suspended by a debt
   resumes where it stopped.
5. Derived read-convenience properties (`.auction`, `.pending_debt`, `.pending_trade`) remain
   so call sites stay readable.

## Alternatives considered

**A single `resume_phase` field.** Cheapest, but it caps nesting at depth 1 and the specced
rules reach depth 3. Rejected for being one bug away from the current design.

**Inferring the continuation from which slots are non-None.** This is the status quo's implicit
plan, and it is exactly the "scatter of booleans" the explicit `Phase` enum was introduced to
kill. Rejected.

**Modelling interrupts as re-entrant `apply` calls (a continuation in code, not data).** Breaks
the reducer contract — the state would no longer be the whole truth, and save/load mid-interrupt
would be impossible. Rejected without much grief.

## Consequences

- MON-101/102 build against frames from day one — this ADR must land **before** E1 starts,
  which is why Phase 0 exists.
- New invariants become statable and cheap: interrupt depth is bounded and decreases on every
  non-escalating command; `GAME_OVER ⇒ no live frames`; `legal_commands` is non-empty unless
  `GAME_OVER` (the deadlock catcher).
- The building-shortage auction gets a *representation* (a `BuildingLot`) even though v1 ships
  first-come-first-served behind `Ruleset.building_shortage_auction = False` pending the owner
  decision recorded in `GAP_ANALYSIS.md` §7.
- The save schema changes shape: `schema_version` bumps to 2, and the version check becomes
  real (G-19).
