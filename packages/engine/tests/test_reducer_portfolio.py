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
from kesef_engine.events import BuildingChanged, CashChanged, DebtSettled, MortgageChanged, TradeExecuted
from kesef_engine.phases import Phase
from kesef_engine.primitives import CashReason, Deck
from kesef_engine.reducer import apply
from kesef_engine.ruleset import Ruleset
from kesef_engine.state import DebtFrame, GameState, Obligation, PropertyState

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


def test_selling_a_hotel_with_an_empty_house_bank_takes_the_group_to_zero() -> None:
    # 32 houses standing elsewhere leave the bank empty (GAP G-B3b). Updated by MON-201:
    # the drop is now the explicit ``demolish_hotel`` whole-group sale, because a lone
    # hotel falling to zero would leave its sibling five levels above it. The full surface
    # lives in test_reducer_development.py.
    full_groups = {
        index: PropertyState(owner=1, houses=4)
        for index in (6, 8, 9, 11, 13, 14, 16, 18)  # 8 tiles x 4 houses = 32
    }
    state = make_state(
        properties={1: PropertyState(owner=0, houses=5), 3: PropertyState(owner=0, houses=5), **full_groups}
    )
    assert state.houses_remaining == 0
    new_state, events = apply(state, SellHouse(player=0, tile=1, demolish_hotel=True))
    assert (new_state.properties[1].houses, new_state.properties[3].houses) == (0, 0)
    refund = next(e for e in events if isinstance(e, CashChanged))
    assert refund.delta == 10 * 25, "ten levels at half price"
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


def test_a_debtor_trades_their_way_out_and_the_debt_settles_itself() -> None:
    """The nested-interrupt path nothing else covered: DEBT_SETTLEMENT is suspended by a
    TradeFrame pushed on top of the DebtFrame, and when the accepted trade pops, the cash it
    delivered settles the debt automatically (no PayDebt command) and the *second* frame pops
    too — two levels of ADR-007 stack unwinding inside one ``apply``."""
    seats = (make_player(0, cash=100), make_player(1), make_player(2))
    debt = DebtFrame(
        resume=Phase.AWAITING_END_TURN,
        debtor=0,
        obligations=(Obligation(creditor=1, amount=600),),
        reason=CashReason.RENT,
        source_tile=19,
    )
    state = make_state(
        seats=seats,
        phase=Phase.DEBT_SETTLEMENT,
        interrupts=(debt,),
        properties={1: PropertyState(owner=0)},
    )
    offer = TradeOffer(proposer=0, recipient=2, give=TradeSide(tiles=(1,)), receive=TradeSide(cash=500))

    proposed, _ = apply(state, ProposeTrade(player=0, offer=offer))
    assert proposed.phase is Phase.TRADE_REVIEW
    assert [frame.kind for frame in proposed.interrupts] == ["debt", "trade"], "the debt is suspended, not replaced"
    assert proposed.pending_debt is debt

    settled, events = apply(proposed, RespondToTrade(player=2, accept=True))
    assert settled.interrupts == (), "both frames popped"
    assert settled.phase is Phase.AWAITING_END_TURN, "play resumes where the debt suspended it"
    assert settled.properties[1].owner == 2
    assert (settled.player(0).cash, settled.player(1).cash, settled.player(2).cash) == (0, 2100, 1000)
    assert [e for e in events if isinstance(e, TradeExecuted)]
    assert [e for e in events if isinstance(e, DebtSettled)] == [DebtSettled(debtor=0, creditor=1, amount=600)]


def test_a_debtor_whose_trade_falls_short_stays_in_debt_settlement() -> None:
    """The negative half: an accepted trade that does not cover the debt pops only its own
    frame. Without it the test above would pass on a reducer that always drained the stack."""
    seats = (make_player(0, cash=100), make_player(1), make_player(2))
    debt = DebtFrame(
        resume=Phase.AWAITING_END_TURN,
        debtor=0,
        obligations=(Obligation(creditor=1, amount=600),),
        reason=CashReason.RENT,
    )
    state = make_state(seats=seats, phase=Phase.DEBT_SETTLEMENT, interrupts=(debt,))
    offer = TradeOffer(proposer=0, recipient=2, give=TradeSide(), receive=TradeSide(cash=100))
    state, _ = apply(state, ProposeTrade(player=0, offer=offer))
    short, events = apply(state, RespondToTrade(player=2, accept=True))
    assert short.phase is Phase.DEBT_SETTLEMENT
    assert [frame.kind for frame in short.interrupts] == ["debt"]
    assert short.player(0).cash == 200
    assert not [e for e in events if isinstance(e, DebtSettled)]


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
