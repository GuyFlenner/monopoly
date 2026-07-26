# Plan: MON-100 — state-model rework (interrupt frames, lots, projection fields)

**Tier**: 3 (TDD mode) · **Design**: ADR-007, ADR-008 (engine half), GAP_ANALYSIS §1/§7 (owner
decisions binding) · **Branch**: `feature/mon-100-state-rework`

## Files changing
- `packages/engine/src/kesef_engine/state.py` — InterruptFrame union (Auction/Debt/Trade/Card),
  lots, obligations; new PlayerState fields (gender, deck-identified jail cards); GameState
  fields (interrupts, doubles_streak, elimination_order, elapsed_seconds, deck model unchanged);
  SCHEMA_VERSION=2 enforced; cross-validation vs board; bounds everywhere; is_bot → property.
- `packages/engine/src/kesef_engine/phases.py` — PORTFOLIO_PHASES + RAISING_PHASES.
- `packages/engine/src/kesef_engine/commands.py` — EndTurn.elapsed_seconds; TradeSide.jail_cards
  → tuple[Deck, ...].
- `packages/engine/src/kesef_engine/events.py` — CashChanged counterparty bank|pot; DiceRolled
  purpose; TradeProposed/TradeCancelled/DebtSettled; GameEnded winner optional + final_standings
  + no_survivors; RentCharged self-contained params; AuctionStarted reason/lot.
- `packages/engine/src/kesef_engine/ruleset.py` — building_shortage_auction flag;
  free_parking_pot → free_parking_pot_enabled; BotLevel import direction.
- `packages/engine/src/kesef_engine/bots/base.py` — BotLevel moves to state.py or levels.py.
- `packages/engine/tests/` — helpers gain make_maximal_state + non-contiguous player ids;
  new test_interrupts.py, test round-trips over every union member; existing tests updated
  deliberately where shapes changed (each with a reason).
- Server `schemas.py`/`sessions.py`/`api.py` compile-compat only (still 501) — no view work
  (that is MON-301/ADR-008 server half).

## Design decisions (already made — do not relitigate)
Owner decisions GAP §7: shortage auction skipped in v1 (flag False, BuildingLot exists);
official dual mortgage-fee model; flat tax; no niqqud; grammatical_gender ships; kids trading
stays on with setup toggle. Shortfall-as-data (cash ge=0). snake_case keys.

## Constraints
- Engine purity: no clock/global/I-O; keys not prose; pydantic v2 only.
- Full gate green: ruff check + ruff format --check + mypy strict + pytest.
- Existing 89 tests pass or are deliberately updated with a stated reason per change.
- mypy strict on tests too. Line length 120.

## Test surface (TDD — write first, watch fail)
- Round-trip: maximal state (live AuctionFrame w/ BuildingLot + queue, DebtFrame w/ 3
  obligations, TradeFrame, CardFrame, populated decks, dice purpose=rent) == restored.
- Round-trip: every Event union member (21+new) and every Command member via TypeAdapter.
- Validators: schema_version≠2 rejected; hotel-on-GO rejected; owner=99 rejected;
  mortgaged+houses rejected; stock inconsistent with ruleset rejected; phase⇔top-frame
  mismatch rejected; winner⇔GAME_OVER tied; duplicate tokens/names rejected; dice bounds.
- Frames: push/pop semantics helpers; depth invariant expressible.
- PlayerKind: bot_level typed (BotLevel), "banana" rejected; is_bot property.
- jail_cards: deck-identified; multiset conservation assertable.

## Open questions (HITL candidates)
None — the six owner decisions closed them.
