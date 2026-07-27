"""MON-102 — the portfolio commands' M1 handlers (MON-201/202/204 own the full rules)."""

from __future__ import annotations

from helpers import make_player, make_state
from kesef_engine.commands import (
    BuildHouse,
    CancelTrade,
    MortgageProperty,
    ProposeTrade,
    RespondToTrade,
    SellHouse,
    TradeOffer,
    TradeSide,
    UnmortgageProperty,
)
from kesef_engine.events import BuildingChanged, CashChanged, MortgageChanged, TradeExecuted
from kesef_engine.phases import Phase
from kesef_engine.primitives import CashReason, Deck
from kesef_engine.reducer import apply
from kesef_engine.ruleset import Ruleset
from kesef_engine.state import GameState, PropertyState

BROWNS = {1: PropertyState(owner=0), 3: PropertyState(owner=0)}  # house_cost 50 each


def test_building_a_house_charges_the_cost_and_raises_the_tile() -> None:
    state = make_state(properties=BROWNS)
    new_state, events = apply(state, BuildHouse(player=0, tile=1))
    assert new_state.properties[1].houses == 1
    paid = next(e for e in events if isinstance(e, CashChanged))
    assert (paid.delta, paid.reason, paid.counterparty) == (-50, CashReason.BUILD, "bank")
    built = next(e for e in events if isinstance(e, BuildingChanged))
    assert (built.tile, built.houses, built.delta) == (1, 1, 1)


def test_selling_a_house_refunds_half_the_build_cost() -> None:
    state = make_state(properties={1: PropertyState(owner=0, houses=1), 3: PropertyState(owner=0, houses=1)})
    new_state, events = apply(state, SellHouse(player=0, tile=1))
    assert new_state.properties[1].houses == 0
    refund = next(e for e in events if isinstance(e, CashChanged))
    assert (refund.delta, refund.reason) == (25, CashReason.SELL_BUILDING)


def test_selling_a_hotel_with_stock_drops_to_four_houses() -> None:
    state = make_state(properties={1: PropertyState(owner=0, houses=5), 3: PropertyState(owner=0, houses=5)})
    new_state, events = apply(state, SellHouse(player=0, tile=1))
    assert new_state.properties[1].houses == 4
    assert next(e for e in events if isinstance(e, CashChanged)).delta == 25


def test_selling_a_hotel_with_an_empty_house_bank_drops_to_zero_at_half_price_for_all_levels() -> None:
    # 32 houses standing elsewhere leave the bank empty (GAP G-B3b).
    full_groups = {
        index: PropertyState(owner=1, houses=4)
        for index in (6, 8, 9, 11, 13, 14, 16, 18)  # 8 tiles x 4 houses = 32
    }
    state = make_state(
        properties={1: PropertyState(owner=0, houses=5), 3: PropertyState(owner=0, houses=5), **full_groups}
    )
    assert state.houses_remaining == 0
    new_state, events = apply(state, SellHouse(player=0, tile=1))
    assert new_state.properties[1].houses == 0
    refund = next(e for e in events if isinstance(e, CashChanged))
    assert refund.delta == 5 * 25, "all five levels at half price"
    changed = next(e for e in events if isinstance(e, BuildingChanged))
    assert (changed.houses, changed.delta) == (0, -5)


def test_mortgaging_pays_out_half_the_printed_price() -> None:
    state = make_state(properties={1: PropertyState(owner=0)})
    new_state, events = apply(state, MortgageProperty(player=0, tile=1))
    assert new_state.properties[1].mortgaged
    paid = next(e for e in events if isinstance(e, CashChanged))
    assert (paid.delta, paid.reason) == (30, CashReason.MORTGAGE)
    assert next(e for e in events if isinstance(e, MortgageChanged)).mortgaged is True


def test_unmortgaging_charges_the_value_plus_ten_percent() -> None:
    state = make_state(properties={1: PropertyState(owner=0, mortgaged=True)})
    new_state, events = apply(state, UnmortgageProperty(player=0, tile=1))
    assert not new_state.properties[1].mortgaged
    paid = next(e for e in events if isinstance(e, CashChanged))
    assert (paid.delta, paid.reason) == (-33, CashReason.UNMORTGAGE)


def test_any_solvent_player_may_act_on_their_portfolio_off_turn() -> None:
    state = make_state(properties={1: PropertyState(owner=1)})  # player 0's turn
    new_state, _ = apply(state, MortgageProperty(player=1, tile=1))
    assert new_state.properties[1].mortgaged
    assert new_state.current_player_id == 0, "the turn did not move"


def _trade_offer() -> TradeOffer:
    return TradeOffer(
        proposer=0,
        recipient=1,
        give=TradeSide(cash=100, tiles=(1,)),
        receive=TradeSide(tiles=(5,), jail_cards=(Deck.CHANCE,)),
    )


def _trade_state() -> GameState:
    seats = (make_player(0), make_player(1, jail_cards=(Deck.CHANCE,)))
    return make_state(seats=seats, properties={1: PropertyState(owner=0), 5: PropertyState(owner=1)})


def test_a_proposed_trade_suspends_into_trade_review() -> None:
    state = _trade_state()
    new_state, _ = apply(state, ProposeTrade(player=0, offer=_trade_offer()))
    assert new_state.phase is Phase.TRADE_REVIEW


def test_an_accepted_trade_executes_atomically_and_resumes_play() -> None:
    state = _trade_state()
    state, _ = apply(state, ProposeTrade(player=0, offer=_trade_offer()))
    new_state, events = apply(state, RespondToTrade(player=1, accept=True))
    assert new_state.phase is Phase.AWAITING_ROLL
    assert new_state.properties[1].owner == 1
    assert new_state.properties[5].owner == 0
    assert new_state.player(0).cash == 1400
    assert new_state.player(1).cash == 1600
    assert new_state.player(0).jail_cards == (Deck.CHANCE,)
    assert new_state.player(1).jail_cards == ()
    assert [e for e in events if isinstance(e, TradeExecuted)]
    cash_moves = [e for e in events if isinstance(e, CashChanged)]
    assert sum(e.delta for e in cash_moves) == 0, "player-to-player money conserves"


def test_a_declined_trade_changes_nothing() -> None:
    state = _trade_state()
    state, _ = apply(state, ProposeTrade(player=0, offer=_trade_offer()))
    new_state, _ = apply(state, RespondToTrade(player=1, accept=False))
    assert new_state.phase is Phase.AWAITING_ROLL
    assert new_state.properties[1].owner == 0
    assert new_state.player(0).cash == 1500


def test_the_proposer_may_cancel_a_pending_trade() -> None:
    state = _trade_state()
    state, _ = apply(state, ProposeTrade(player=0, offer=_trade_offer()))
    new_state, _ = apply(state, CancelTrade(player=0))
    assert new_state.phase is Phase.AWAITING_ROLL
    assert new_state.properties[1].owner == 0


def test_kids_mode_rejects_a_multi_item_trade_side() -> None:
    import pytest

    from kesef_engine.errors import IllegalCommandError

    seats = (make_player(0), make_player(1, jail_cards=(Deck.CHANCE,)))
    state = make_state(
        seats=seats,
        properties={1: PropertyState(owner=0), 5: PropertyState(owner=1)},
        ruleset=Ruleset.kids(),
    )
    with pytest.raises(IllegalCommandError) as excinfo:
        apply(state, ProposeTrade(player=0, offer=_trade_offer()))
    assert excinfo.value.reason_key == "error.trade_too_complex"
