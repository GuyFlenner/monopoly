"""MON-201 — development: even-build up *and* down, the hotel, and a finite bank.

Spec §3.6 trap 3 lives here: houses within a colour group may never differ by more than
one, on the way up *and* on the way down. Legality decides; these tests pin that the
*effects* agree with it, that stock is conserved, and that the shortage escape hatch
(GAP G-B3b) exists and is explicit.
"""

from __future__ import annotations

import pytest

from helpers import make_player, make_state
from kesef_engine.commands import BuildHouse, SellHouse
from kesef_engine.errors import IllegalCommandError
from kesef_engine.events import BuildingChanged, CashChanged, Event
from kesef_engine.legality import legal_commands
from kesef_engine.phases import Phase
from kesef_engine.primitives import CashReason
from kesef_engine.reducer import apply
from kesef_engine.ruleset import Ruleset, RulesetName
from kesef_engine.state import HOTEL_LEVEL, DebtFrame, GameState, Obligation, PropertyState

BROWN = (1, 3)
"""house_cost 50, so half price is 25."""
LIGHT_BLUE = (6, 8, 9)
"""house_cost 50 as well — three members, so the odd-group even-build cases live here."""


def _owned(tiles: tuple[int, ...], levels: tuple[int, ...], owner: int = 0) -> dict[int, PropertyState]:
    return {tile: PropertyState(owner=owner, houses=level) for tile, level in zip(tiles, levels, strict=True)}


def _levels(state: GameState, tiles: tuple[int, ...]) -> tuple[int, ...]:
    return tuple(state.properties[tile].houses for tile in tiles)


# --- Even build going up (trap 3, first half) ---------------------------------


def test_building_is_offered_only_at_the_group_minimum() -> None:
    state = make_state(properties=_owned(LIGHT_BLUE, (1, 0, 0)))
    builds = {command.tile for command in legal_commands(state) if isinstance(command, BuildHouse)}
    assert builds == {8, 9}, "the tile already at one house is not the minimum"


def test_building_past_the_minimum_is_rejected_with_the_uneven_build_key() -> None:
    state = make_state(properties=_owned(LIGHT_BLUE, (1, 0, 0)))
    with pytest.raises(IllegalCommandError) as excinfo:
        apply(state, BuildHouse(player=0, tile=6))
    assert excinfo.value.reason_key == "error.uneven_build"


def test_a_group_climbs_evenly_one_house_at_a_time() -> None:
    state = make_state(properties=_owned(LIGHT_BLUE, (0, 0, 0)))
    for _ in range(9):
        builds = [command for command in legal_commands(state) if isinstance(command, BuildHouse)]
        state, _ = apply(state, builds[0])
        assert max(_levels(state, LIGHT_BLUE)) - min(_levels(state, LIGHT_BLUE)) <= 1
    assert _levels(state, LIGHT_BLUE) == (3, 3, 3)


# --- The hotel ----------------------------------------------------------------


def test_the_fifth_house_erects_a_hotel_and_returns_four_houses_to_the_bank() -> None:
    state = make_state(properties=_owned(BROWN, (4, 4)))
    assert state.houses_remaining == state.ruleset.houses_available - 8
    new_state, events = apply(state, BuildHouse(player=0, tile=1))
    assert new_state.properties[1].houses == HOTEL_LEVEL
    assert new_state.hotels_on_board == 1
    assert new_state.houses_remaining == state.houses_remaining + 4, "the four houses went back"
    assert new_state.houses_on_board == 4, "only tile 3's four houses are still houses"
    built = next(event for event in events if isinstance(event, BuildingChanged))
    assert (built.tile, built.houses, built.delta) == (1, HOTEL_LEVEL, 1)


def test_a_hotel_is_refused_when_the_bank_holds_none() -> None:
    ruleset = Ruleset(name=RulesetName.UNIVERSAL, hotels_available=0)
    state = make_state(ruleset=ruleset, properties=_owned(BROWN, (4, 4)))
    with pytest.raises(IllegalCommandError) as excinfo:
        apply(state, BuildHouse(player=0, tile=1))
    assert excinfo.value.reason_key == "error.no_hotels_left"


def test_a_hotel_counts_as_five_for_even_build() -> None:
    state = make_state(properties=_owned(LIGHT_BLUE, (5, 4, 4)))
    builds = {command.tile for command in legal_commands(state) if isinstance(command, BuildHouse)}
    assert builds == {8, 9}, "the hotel sits at five, so it is not the minimum"
    sells = {command.tile for command in legal_commands(state) if isinstance(command, SellHouse)}
    assert sells == {6}, "the hotel is the group maximum, so it is the only sellable tile"


# --- Even build coming down (trap 3, second half) -----------------------------


def test_selling_is_offered_only_at_the_group_maximum() -> None:
    state = make_state(properties=_owned(LIGHT_BLUE, (2, 1, 1)))
    sells = {command.tile for command in legal_commands(state) if isinstance(command, SellHouse)}
    assert sells == {6}


def test_selling_below_the_maximum_is_rejected_with_the_uneven_build_key() -> None:
    state = make_state(properties=_owned(LIGHT_BLUE, (2, 1, 1)))
    with pytest.raises(IllegalCommandError) as excinfo:
        apply(state, SellHouse(player=0, tile=8))
    assert excinfo.value.reason_key == "error.uneven_build"


def test_a_group_descends_evenly_and_the_bank_gets_every_house_back() -> None:
    state = make_state(properties=_owned(LIGHT_BLUE, (3, 3, 3)))
    stock = state.ruleset.houses_available
    for _ in range(9):
        sells = [command for command in legal_commands(state) if isinstance(command, SellHouse)]
        state, _ = apply(state, sells[0])
        assert max(_levels(state, LIGHT_BLUE)) - min(_levels(state, LIGHT_BLUE)) <= 1
    assert _levels(state, LIGHT_BLUE) == (0, 0, 0)
    assert state.houses_remaining == stock, "every house came back"


def test_selling_one_level_refunds_half_the_build_cost_and_returns_one_house() -> None:
    state = make_state(properties=_owned(BROWN, (2, 2)))
    new_state, events = apply(state, SellHouse(player=0, tile=1))
    assert new_state.properties[1].houses == 1
    assert new_state.houses_remaining == state.houses_remaining + 1
    refund = next(event for event in events if isinstance(event, CashChanged))
    assert (refund.delta, refund.reason, refund.counterparty) == (25, CashReason.SELL_BUILDING, "bank")


def test_a_hotel_downgrades_to_four_houses_when_the_bank_can_supply_them() -> None:
    state = make_state(properties=_owned(BROWN, (5, 5)))
    new_state, events = apply(state, SellHouse(player=0, tile=1))
    assert new_state.properties[1].houses == 4
    assert new_state.hotels_remaining == state.hotels_remaining + 1
    assert new_state.houses_remaining == state.houses_remaining - 4, "four houses left the bank"
    assert next(event for event in events if isinstance(event, CashChanged)).delta == 25


# --- The shortage escape hatch (GAP G-B3b) ------------------------------------


def _empty_house_bank() -> dict[int, PropertyState]:
    """32 houses standing on another player's estate leaves the bank with none."""
    return {index: PropertyState(owner=1, houses=4) for index in (6, 8, 9, 11, 13, 14, 16, 18)}


def test_a_hotel_cannot_downgrade_when_the_bank_has_fewer_than_four_houses() -> None:
    state = make_state(properties={**_owned(BROWN, (5, 5)), **_empty_house_bank()})
    assert state.houses_remaining == 0
    with pytest.raises(IllegalCommandError) as excinfo:
        apply(state, SellHouse(player=0, tile=1))
    assert excinfo.value.reason_key == "error.no_houses_left"


def test_demolishing_clears_the_whole_group_at_half_price_and_keeps_even_build() -> None:
    """The official "all buildings on one colour-group may be sold at once" clause. It is
    what a debtor hits in a shortage (G-B3b) and it is the only sale that moves more than
    one level, so it is the one that must not leave the group uneven."""
    state = make_state(properties={**_owned(BROWN, (5, 5)), **_empty_house_bank()})
    new_state, events = apply(state, SellHouse(player=0, tile=1, demolish_hotel=True))
    assert _levels(new_state, BROWN) == (0, 0), "even-build survives the shortage sale"
    assert new_state.hotels_remaining == state.hotels_remaining + 2
    refund = next(event for event in events if isinstance(event, CashChanged))
    assert refund.delta == 10 * 25, "ten levels at half the build cost"
    changed = {event.tile: (event.houses, event.delta) for event in events if isinstance(event, BuildingChanged)}
    assert changed == {1: (0, -5), 3: (0, -5)}


def test_demolishing_is_offered_and_is_the_only_sale_during_a_shortage() -> None:
    state = make_state(properties={**_owned(BROWN, (5, 5)), **_empty_house_bank()})
    sells = [command for command in legal_commands(state) if isinstance(command, SellHouse) and command.player == 0]
    assert [(command.tile, command.demolish_hotel) for command in sells] == [(1, True), (3, True)]


def test_demolishing_needs_a_hotel_on_the_named_tile() -> None:
    state = make_state(properties=_owned(BROWN, (4, 4)))
    with pytest.raises(IllegalCommandError) as excinfo:
        apply(state, SellHouse(player=0, tile=1, demolish_hotel=True))
    assert excinfo.value.reason_key == "error.no_hotel_to_demolish"


def test_a_debtor_in_a_shortage_can_still_raise_cash_by_demolishing() -> None:
    """Why the escape hatch exists: without it a hotel-only estate has no raising move at
    all during a house shortage, and DEBT_SETTLEMENT offers nothing but concession."""
    seats = (make_player(0, cash=0), make_player(1), make_player(2))
    debt = DebtFrame(
        resume=Phase.AWAITING_END_TURN,
        debtor=0,
        obligations=(Obligation(creditor=2, amount=200),),
        reason=CashReason.RENT,
    )
    state = make_state(
        seats=seats,
        phase=Phase.DEBT_SETTLEMENT,
        interrupts=(debt,),
        properties={**_owned(BROWN, (5, 5)), **_empty_house_bank()},
    )
    assert state.houses_remaining == 0
    raising = [command for command in legal_commands(state) if command.player == 0 and command.kind == "sell_house"]
    assert raising, "the shortage must not strand the debtor"
    settled, _ = apply(state, SellHouse(player=0, tile=1, demolish_hotel=True))
    assert settled.phase is Phase.AWAITING_END_TURN, "250 raised covers the 200 debt, which settles itself"
    assert settled.player(0).cash == 250 - 200
    assert settled.interrupts == ()


# --- Stock conservation -------------------------------------------------------


def test_building_stock_is_conserved_across_a_full_build_and_sell_cycle() -> None:
    state = make_state(properties=_owned(BROWN, (0, 0)))
    ruleset = state.ruleset
    commands: list[BuildHouse | SellHouse] = []
    for _ in range(10):
        builds = [command for command in legal_commands(state) if isinstance(command, BuildHouse)]
        commands.append(builds[0])
        state, _ = apply(state, builds[0])
        assert state.houses_remaining + state.houses_on_board == ruleset.houses_available
        assert state.hotels_remaining + state.hotels_on_board == ruleset.hotels_available
    assert _levels(state, BROWN) == (HOTEL_LEVEL, HOTEL_LEVEL)
    for _ in range(10):
        sells = [command for command in legal_commands(state) if isinstance(command, SellHouse)]
        state, _ = apply(state, sells[0])
        assert state.houses_remaining + state.houses_on_board == ruleset.houses_available
        assert state.hotels_remaining + state.hotels_on_board == ruleset.hotels_available
    assert _levels(state, BROWN) == (0, 0)
    assert state.houses_remaining == ruleset.houses_available


def test_a_build_is_refused_when_the_bank_holds_no_houses() -> None:
    state = make_state(properties={**_owned(BROWN, (0, 0)), **_empty_house_bank()})
    with pytest.raises(IllegalCommandError) as excinfo:
        apply(state, BuildHouse(player=0, tile=1))
    assert excinfo.value.reason_key == "error.no_houses_left"


# --- What went up or came down (MON-413) --------------------------------------


def _building_events(events: tuple[Event, ...]) -> list[BuildingChanged]:
    return [event for event in events if isinstance(event, BuildingChanged)]


def test_a_build_names_a_house_until_the_fifth_one_names_a_hotel() -> None:
    """MON-413: the event says *what* went up, so the log never has to say "a building".

    "The fifth house is a hotel" is a rule. Before ``level`` the only way for a client to say
    "hotel" was ``houses === 5`` in TypeScript, which is that rule living in the UI — so the log
    said "a building went up" for both, which is the one thing a child watching a hotel appear does
    not want to be told.
    """
    state = make_state(properties=_owned(BROWN, (0, 0)))
    levels: list[str] = []
    for _ in range(10):
        build = next(command for command in legal_commands(state) if isinstance(command, BuildHouse))
        state, events = apply(state, build)
        levels.append(_building_events(events)[0].level)
    # Two brown squares climbing together, so the two hotels are the last two builds.
    assert levels == ["house"] * 8 + ["hotel", "hotel"]


def test_selling_a_house_names_a_house_and_demolishing_a_hotel_names_the_hotel() -> None:
    """``level`` is what came *off*, so a demolished hotel is a hotel even though the tile is bare."""
    state = make_state(properties=_owned(BROWN, (1, 1)))
    _, sold = apply(state, SellHouse(player=0, tile=1))
    assert [event.level for event in _building_events(sold)] == ["house"]

    hotels = make_state(properties=_owned(BROWN, (HOTEL_LEVEL, HOTEL_LEVEL)))
    _, demolished = apply(hotels, SellHouse(player=0, tile=1, demolish_hotel=True))
    events = _building_events(demolished)
    assert [event.level for event in events] == ["hotel", "hotel"]
    assert all(event.houses == 0 and event.delta == -HOTEL_LEVEL for event in events)
