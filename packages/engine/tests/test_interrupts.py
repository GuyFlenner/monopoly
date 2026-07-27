"""Interrupt frames — ADR-007.

The point of the stack is that an interrupt records where to return to, so a game saved
three interrupts deep resumes exactly. These tests pin the push/pop semantics and the
validator that keeps ``phase`` and the live frame from disagreeing.
"""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from helpers import make_maximal_state, make_player, make_state
from kesef_engine.commands import TradeOffer, TradeSide
from kesef_engine.phases import INTERRUPT_PHASES, PORTFOLIO_PHASES, RAISING_PHASES, Phase
from kesef_engine.primitives import AuctionReason, BuildingLot, CashReason, Deck, TileLot
from kesef_engine.state import (
    PHASE_OF_FRAME,
    AuctionFrame,
    CardFrame,
    DebtFrame,
    GameState,
    Obligation,
    TradeFrame,
)


def _card_frame(resume: Phase = Phase.RESOLVING_TILE) -> CardFrame:
    return CardFrame(resume=resume, card_id="card.chance.pay_each_player", deck=Deck.CHANCE)


def _debt_frame(resume: Phase = Phase.CARD_RESOLUTION, debtor: int = 0) -> DebtFrame:
    return DebtFrame(
        resume=resume,
        debtor=debtor,
        obligations=(Obligation(creditor=1, amount=50),),
        reason=CashReason.CARD,
    )


def _trade_frame(resume: Phase = Phase.DEBT_SETTLEMENT) -> TradeFrame:
    return TradeFrame(resume=resume, offer=TradeOffer(proposer=0, recipient=1, give=TradeSide(), receive=TradeSide()))


def _auction_frame(resume: Phase = Phase.AWAITING_PURCHASE_DECISION, **changes: Any) -> AuctionFrame:
    fields: dict[str, Any] = {
        "resume": resume,
        "lot": TileLot(tile=1),
        "reason": AuctionReason.DECLINED_PURCHASE,
        "eligible": (0, 1),
        "active": (0, 1),
        "turn": 0,
    }
    return AuctionFrame(**(fields | changes))


# --- Push and pop -----------------------------------------------------------


def test_pushing_a_frame_suspends_the_current_phase() -> None:
    state = make_state()
    pushed = state.push_interrupt(_auction_frame())
    assert pushed.phase is Phase.AUCTION
    assert len(pushed.interrupts) == 1
    assert pushed.interrupts[-1].resume is Phase.AWAITING_ROLL


def test_popping_a_frame_restores_the_phase_it_suspended() -> None:
    state = make_state().model_copy(update={"phase": Phase.AWAITING_PURCHASE_DECISION})
    restored = state.push_interrupt(_auction_frame()).pop_interrupt()
    assert restored.phase is Phase.AWAITING_PURCHASE_DECISION
    assert restored.interrupts == ()


def test_interrupts_nest_three_deep_and_unwind_in_order() -> None:
    """ADR-007's worked example: card -> unpayable rent -> trade to raise the cash."""
    state = make_state().model_copy(update={"phase": Phase.RESOLVING_TILE})
    state = state.push_interrupt(_card_frame())
    assert state.phase is Phase.CARD_RESOLUTION
    state = state.push_interrupt(_debt_frame())
    assert state.phase is Phase.DEBT_SETTLEMENT
    state = state.push_interrupt(_trade_frame())
    assert state.phase is Phase.TRADE_REVIEW
    assert len(state.interrupts) == 3

    state = state.pop_interrupt()
    assert state.phase is Phase.DEBT_SETTLEMENT
    state = state.pop_interrupt()
    assert state.phase is Phase.CARD_RESOLUTION
    state = state.pop_interrupt()
    assert state.phase is Phase.RESOLVING_TILE
    assert state.interrupts == ()


def test_push_records_the_resume_phase_even_if_the_frame_carried_a_stale_one() -> None:
    state = make_state().model_copy(update={"phase": Phase.AWAITING_END_TURN})
    pushed = state.push_interrupt(_trade_frame(resume=Phase.MOVING))
    assert pushed.interrupts[-1].resume is Phase.AWAITING_END_TURN


def test_popping_an_empty_stack_is_a_programming_error() -> None:
    with pytest.raises(ValueError, match="no interrupt"):
        make_state().pop_interrupt()


def test_the_pushed_state_is_a_valid_state() -> None:
    """The helpers must not be able to build something a save file could not restore."""
    pushed = make_state().push_interrupt(_auction_frame())
    assert GameState.model_validate_json(pushed.model_dump_json()) == pushed


# --- phase <-> live frame ---------------------------------------------------


def test_every_frame_kind_maps_to_exactly_one_phase() -> None:
    assert set(PHASE_OF_FRAME) == {"auction", "debt", "trade", "card"}
    assert set(PHASE_OF_FRAME.values()) >= INTERRUPT_PHASES


def test_an_interrupt_phase_without_a_frame_is_rejected() -> None:
    with pytest.raises(ValidationError, match="phase"):
        GameState.model_validate(make_state().model_dump() | {"phase": Phase.AUCTION})


def test_a_frame_whose_kind_contradicts_the_phase_is_rejected() -> None:
    payload = make_state().model_dump() | {
        "phase": Phase.AUCTION,
        "interrupts": [_debt_frame(resume=Phase.AWAITING_ROLL).model_dump()],
    }
    with pytest.raises(ValidationError, match="phase"):
        GameState.model_validate(payload)


def test_a_live_frame_with_an_ordinary_phase_is_rejected() -> None:
    payload = make_state().model_dump() | {
        "phase": Phase.AWAITING_ROLL,
        "interrupts": [_auction_frame().model_dump()],
    }
    with pytest.raises(ValidationError, match="phase"):
        GameState.model_validate(payload)


def test_game_over_cannot_hold_a_live_interrupt() -> None:
    """G-8: the two-player bankruptcy-to-bank deadlock is unrepresentable."""
    payload = make_state().model_dump() | {
        "phase": Phase.GAME_OVER,
        "winner": 0,
        "interrupts": [_auction_frame().model_dump()],
    }
    with pytest.raises(ValidationError, match="phase"):
        GameState.model_validate(payload)


def test_frames_may_only_name_seated_players() -> None:
    payload = make_state().model_dump() | {
        "phase": Phase.DEBT_SETTLEMENT,
        "interrupts": [_debt_frame(resume=Phase.AWAITING_ROLL, debtor=99).model_dump()],
    }
    with pytest.raises(ValidationError, match="unknown player"):
        GameState.model_validate(payload)


def test_a_standing_high_bid_the_bidder_cannot_afford_is_rejected() -> None:
    """The invariant needs the bidder's cash, so it lives at GameState level: a bid is
    capped by cash at placement and an auction only lets its bidders raise cash, so an
    unaffordable standing bid could never be awarded — the ledger's ge=0 backstop would
    break instead. It used to be asserted only in a generator comment."""
    seats = (make_player(0, cash=40), make_player(1))
    payload = make_state(seats=seats).model_dump() | {
        "phase": Phase.AUCTION,
        "interrupts": [_auction_frame(high_bid=50, high_bidder=0, min_bid=51).model_dump()],
    }
    with pytest.raises(ValidationError, match="high_bid"):
        GameState.model_validate(payload)

    affordable = make_state(seats=seats).model_dump() | {
        "phase": Phase.AUCTION,
        "interrupts": [_auction_frame(high_bid=40, high_bidder=0, min_bid=41).model_dump()],
    }
    assert GameState.model_validate(affordable).phase is Phase.AUCTION


def test_a_bankrupt_creditor_is_rejected() -> None:
    """MON-207 settles or voids a leaving player's claims, so a creditor is always a solvent
    player or the bank. Also previously a generator comment rather than a rule."""
    seats = (make_player(0), make_player(1, cash=0, bankrupt=True))
    payload = make_state(seats=seats).model_dump() | {
        "phase": Phase.DEBT_SETTLEMENT,
        "interrupts": [_debt_frame(resume=Phase.AWAITING_ROLL).model_dump()],
        "elimination_order": [1],
    }
    with pytest.raises(ValidationError, match="bankrupt creditor"):
        GameState.model_validate(payload)


# --- Read-convenience accessors --------------------------------------------


def test_derived_accessors_find_frames_anywhere_in_the_stack() -> None:
    """G-9: the UI keeps the card face-up while the debt dialog is open."""
    state = make_maximal_state()
    assert state.top_interrupt is state.interrupts[-1]
    assert state.auction is not None
    assert state.pending_debt is not None
    assert state.pending_trade is not None
    assert state.pending_card is not None
    assert state.pending_card.card_id == "card.chance.advance_to_boardwalk"


def test_derived_accessors_are_none_without_interrupts() -> None:
    state = make_state()
    assert state.top_interrupt is None
    assert state.auction is None
    assert state.pending_debt is None
    assert state.pending_trade is None
    assert state.pending_card is None


# --- AuctionFrame -----------------------------------------------------------


def test_an_auction_lot_may_be_a_tile_or_a_building() -> None:
    """G-3: the building-shortage auction sells a house, not a tile."""
    assert _auction_frame().lot == TileLot(tile=1)
    shortage = _auction_frame(lot=BuildingLot(building="hotel"), reason=AuctionReason.BUILDING_SHORTAGE)
    assert shortage.lot == BuildingLot(building="hotel")


def test_withdrawn_bidders_are_derived_not_stored() -> None:
    frame = _auction_frame(active=(1,), turn=1)
    assert frame.withdrawn == (0,)
    assert "withdrawn" not in AuctionFrame.model_fields


def test_an_active_bidder_must_be_eligible() -> None:
    with pytest.raises(ValidationError, match="eligible"):
        _auction_frame(active=(0, 1, 2))


def test_the_bidding_turn_must_belong_to_an_active_bidder() -> None:
    with pytest.raises(ValidationError, match="turn"):
        _auction_frame(active=(0,), turn=1)


def test_a_high_bid_needs_a_high_bidder() -> None:
    with pytest.raises(ValidationError, match="high_bid"):
        _auction_frame(high_bid=50)
    with pytest.raises(ValidationError, match="high_bid"):
        _auction_frame(high_bid=0, high_bidder=0)


def test_the_bid_ceiling_cannot_sit_below_the_floor() -> None:
    with pytest.raises(ValidationError, match="max_bid"):
        _auction_frame(min_bid=100, max_bid=99)


def test_an_auction_carries_a_queue_of_remaining_lots() -> None:
    """G-3: bankruptcy to the bank auctions an ordered estate, not one tile."""
    frame = _auction_frame(reason=AuctionReason.BANKRUPTCY_TO_BANK, queue=(TileLot(tile=3), TileLot(tile=5)))
    assert frame.queue == (TileLot(tile=3), TileLot(tile=5))


def test_eligible_bidders_are_a_stored_order_without_duplicates() -> None:
    with pytest.raises(ValidationError, match="duplicate"):
        _auction_frame(eligible=(0, 0), active=(0,))


# --- DebtFrame --------------------------------------------------------------


def test_a_debt_can_owe_several_creditors_at_once() -> None:
    """G-7: "pay each player" creates one debt with up to five creditors."""
    frame = DebtFrame(
        resume=Phase.CARD_RESOLUTION,
        debtor=0,
        obligations=(
            Obligation(creditor=1, amount=50),
            Obligation(creditor=2, amount=50),
            Obligation(creditor="bank", amount=100),
        ),
        reason=CashReason.CARD,
    )
    assert frame.total == 200
    assert frame.creditors == (1, 2, "bank")


def test_a_debt_needs_at_least_one_obligation() -> None:
    with pytest.raises(ValidationError):
        DebtFrame(resume=Phase.RESOLVING_TILE, debtor=0, obligations=(), reason=CashReason.RENT)


def test_an_obligation_of_nothing_is_not_a_debt() -> None:
    with pytest.raises(ValidationError):
        Obligation(creditor="bank", amount=0)


def test_a_debtor_cannot_owe_themselves() -> None:
    with pytest.raises(ValidationError, match="debtor"):
        DebtFrame(
            resume=Phase.RESOLVING_TILE,
            debtor=0,
            obligations=(Obligation(creditor=0, amount=10),),
            reason=CashReason.RENT,
        )


def test_the_bank_is_a_named_creditor_not_a_none_sentinel() -> None:
    """GAP §1 minor: ``None``-as-bank forced every call site to guess."""
    assert Obligation(creditor="bank", amount=10).creditor == "bank"
    with pytest.raises(ValidationError):
        Obligation(creditor=None, amount=10)


def test_a_debt_records_where_it_came_from() -> None:
    # Constructed directly, not via model_copy(update=): the copy path skips
    # validation, so it cannot prove the field exists or that its bounds bite.
    frame = DebtFrame(
        resume=Phase.RESOLVING_TILE,
        debtor=0,
        obligations=(Obligation(creditor=1, amount=10),),
        reason=CashReason.RENT,
        source_tile=39,
    )
    assert frame.source_tile == 39
    assert frame.reason is CashReason.RENT


def test_a_debt_source_tile_must_be_on_the_board() -> None:
    with pytest.raises(ValidationError):
        DebtFrame(
            resume=Phase.RESOLVING_TILE,
            debtor=0,
            obligations=(Obligation(creditor=1, amount=10),),
            reason=CashReason.RENT,
            source_tile=40,
        )


# --- CardFrame --------------------------------------------------------------


def test_a_card_frame_remembers_which_step_it_reached() -> None:
    """G-9: a two-step card suspended by a debt must resume at the second step."""
    frame = _card_frame()
    assert frame.step == 0
    assert CardFrame(resume=Phase.RESOLVING_TILE, card_id="c", deck=Deck.CHANCE, step=2).step == 2
    with pytest.raises(ValidationError):
        CardFrame(resume=Phase.RESOLVING_TILE, card_id="c", deck=Deck.CHANCE, step=-1)


def test_a_card_frame_needs_a_card_id() -> None:
    with pytest.raises(ValidationError):
        CardFrame(resume=Phase.RESOLVING_TILE, card_id="", deck=Deck.CHANCE)


# --- TradeFrame -------------------------------------------------------------


def test_a_trade_frame_wraps_the_offer() -> None:
    frame = _trade_frame()
    assert frame.offer.proposer == 0
    assert frame.offer.recipient == 1


def test_a_player_cannot_trade_with_themselves() -> None:
    with pytest.raises(ValidationError, match="recipient"):
        TradeOffer(proposer=0, recipient=0, give=TradeSide(), receive=TradeSide())


# --- Phase sets -------------------------------------------------------------


def test_portfolio_phases_include_jail() -> None:
    """G-5: trap #8 says a jailed player may build and trade."""
    assert Phase.JAIL_DECISION in PORTFOLIO_PHASES
    assert Phase.AWAITING_ROLL in PORTFOLIO_PHASES
    assert Phase.AWAITING_END_TURN in PORTFOLIO_PHASES


def test_raising_phases_cover_debt_and_bidding() -> None:
    """G-5: MON-207 lets a debtor sell, mortgage and trade to raise the cash."""
    assert Phase.DEBT_SETTLEMENT in RAISING_PHASES
    assert Phase.AUCTION in RAISING_PHASES
    assert len(RAISING_PHASES) == 2
    # Raising cash is not the same permission as spending it: no overlap by construction.
    assert not RAISING_PHASES & PORTFOLIO_PHASES
