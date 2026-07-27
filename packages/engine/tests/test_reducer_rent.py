"""MON-104 — rent. The single most-often-wrong area: each backlog bullet is a named test."""

from __future__ import annotations

import pytest

from helpers import make_player, make_state
from kesef_engine.commands import RollDice
from kesef_engine.events import CashChanged, DebtIncurred, DiceRolled, Event, RentCharged
from kesef_engine.phases import Phase
from kesef_engine.primitives import CashReason
from kesef_engine.rng import Rng
from kesef_engine.state import DebtFrame, GameState, PropertyState

_PLAIN_SEED = next(seed for seed in range(1000) if (r := Rng(seed=seed).roll_dice())[0] != r[1])
_DOUBLES_SEED = next(seed for seed in range(1000) if (r := Rng(seed=seed).roll_dice())[0] == r[1])
ORANGES = (16, 18, 19)  # New York Avenue is 19: rent (16, 80, 220, 600, 800, 1000)
RAILROADS = (5, 15, 25, 35)
ELECTRIC, WATER = 12, 28


def _total(seed: int) -> int:
    return sum(Rng(seed=seed).roll_dice()[:2])


def _land_on(
    target: int,
    properties: dict[int, PropertyState],
    *,
    seed: int = _PLAIN_SEED,
    cash: int = 1500,
) -> tuple[GameState, tuple[Event, ...]]:
    from kesef_engine.reducer import apply

    start = (target - _total(seed)) % 40
    seats = (make_player(0, position=start, cash=cash), make_player(1), make_player(2))
    state = make_state(seats=seats, seed=seed, properties=properties)
    return apply(state, RollDice(player=0))


def _rent_event(events: tuple[Event, ...]) -> RentCharged:
    return next(e for e in events if isinstance(e, RentCharged))


def test_property_rent_follows_the_house_tier() -> None:
    new_state, events = _land_on(19, {19: PropertyState(owner=1, houses=3)})
    rent = _rent_event(events)
    assert (rent.payer, rent.owner, rent.tile, rent.amount) == (0, 1, 19, 600)
    assert (rent.base_rent, rent.houses, rent.multiplier) == (600, 3, 1)
    moves = [e for e in events if isinstance(e, CashChanged)]
    assert [(e.player, e.delta, e.counterparty) for e in moves] == [(0, -600, 1), (1, 600, 0)]
    assert new_state.player(0).cash == 900
    assert new_state.player(1).cash == 2100


def test_undeveloped_rent_doubles_when_the_owner_holds_the_whole_group() -> None:
    props = {tile: PropertyState(owner=1) for tile in ORANGES}
    _, events = _land_on(19, props)
    rent = _rent_event(events)
    assert (rent.amount, rent.base_rent, rent.multiplier) == (32, 16, 2)
    assert "rent.note.full_group_doubled" in rent.note_keys


def test_undeveloped_rent_stays_single_without_the_whole_group() -> None:
    _, events = _land_on(19, {19: PropertyState(owner=1), 16: PropertyState(owner=1)})
    rent = _rent_event(events)
    assert (rent.amount, rent.multiplier) == (16, 1)


def test_a_mortgaged_property_charges_no_rent() -> None:
    new_state, events = _land_on(19, {19: PropertyState(owner=1, mortgaged=True)})
    assert not [e for e in events if isinstance(e, RentCharged)]
    assert not [e for e in events if isinstance(e, CashChanged)]
    assert new_state.phase is Phase.AWAITING_END_TURN


def test_a_mortgaged_sibling_still_counts_toward_group_completion() -> None:
    props = {
        16: PropertyState(owner=1, mortgaged=True),
        18: PropertyState(owner=1),
        19: PropertyState(owner=1),
    }
    _, events = _land_on(19, props)
    rent = _rent_event(events)
    assert (rent.amount, rent.multiplier) == (32, 2), "the mortgaged member completes the group"


@pytest.mark.parametrize(("owned", "expected"), [(1, 25), (2, 50), (3, 100), (4, 200)])
def test_railroad_rent_climbs_25_50_100_200_by_count_owned(owned: int, expected: int) -> None:
    props = {tile: PropertyState(owner=1) for tile in RAILROADS[:owned]}
    _, events = _land_on(15 if owned >= 2 else 5, props)
    rent = _rent_event(events)
    assert rent.amount == expected
    assert rent.note_keys == ("rent.note.railroad_count",)
    assert rent.note_params == {"count": owned}


def test_utility_rent_is_four_times_the_dice_with_one_owned() -> None:
    _, events = _land_on(ELECTRIC, {ELECTRIC: PropertyState(owner=1)})
    rent = _rent_event(events)
    assert rent.amount == 4 * _total(_PLAIN_SEED)
    assert (rent.multiplier, rent.dice_total) == (4, _total(_PLAIN_SEED))
    assert "rent.note.utility_multiplier" in rent.note_keys


def test_utility_rent_is_ten_times_the_dice_with_both_owned() -> None:
    props = {ELECTRIC: PropertyState(owner=1), WATER: PropertyState(owner=1)}
    _, events = _land_on(ELECTRIC, props)
    rent = _rent_event(events)
    assert rent.amount == 10 * _total(_PLAIN_SEED)
    assert rent.multiplier == 10


def test_a_card_arrival_rolls_fresh_dice_for_the_utility_rent() -> None:
    """The MON-206 hook, mechanics landed now: a purpose='rent' roll prices the charge."""
    from kesef_engine.rules import rent as rent_module

    seats = (make_player(0, position=ELECTRIC), make_player(1))
    state = make_state(seats=seats, seed=_PLAIN_SEED, properties={ELECTRIC: PropertyState(owner=1)})
    new_state, events = rent_module.charge(state, 0, ELECTRIC, roll_for_amount=True)
    rolled = next(e for e in events if isinstance(e, DiceRolled))
    assert rolled.purpose == "rent"
    rent = _rent_event(events)
    assert rent.amount == 4 * rolled.total
    assert rent.dice_total == rolled.total
    assert new_state.doubles_streak == state.doubles_streak, "a rent roll never feeds the streak"


def test_the_owner_is_never_charged_their_own_rent() -> None:
    _, events = _land_on(19, {19: PropertyState(owner=0)})
    assert not [e for e in events if isinstance(e, RentCharged)]


def test_a_bankrupt_owners_tiles_charge_nothing() -> None:
    from kesef_engine.reducer import apply

    start = (19 - _total(_PLAIN_SEED)) % 40
    seats = (make_player(0, position=start), make_player(1), make_player(2, cash=0, bankrupt=True))
    state = make_state(seats=seats, seed=_PLAIN_SEED, properties={19: PropertyState(owner=2)})
    state = GameState(**{**dict(state), "elimination_order": (2,)})
    _, events = apply(state, RollDice(player=0))
    assert not [e for e in events if isinstance(e, RentCharged)]
    assert not [e for e in events if isinstance(e, CashChanged)]


def test_unpayable_rent_opens_a_debt_to_the_owner() -> None:
    new_state, events = _land_on(19, {19: PropertyState(owner=1, houses=3)}, cash=100)
    assert new_state.phase is Phase.DEBT_SETTLEMENT
    frame = new_state.top_interrupt
    assert isinstance(frame, DebtFrame)
    assert (frame.debtor, frame.reason, frame.total) == (0, CashReason.RENT, 600)
    assert frame.obligations[0].creditor == 1
    assert frame.source_tile == 19
    rent = _rent_event(events)
    assert rent.amount == 600, "the figure is still explained even when it cannot be paid"
    assert [e for e in events if isinstance(e, DebtIncurred)]
    assert not [e for e in events if isinstance(e, CashChanged)], "no partial payment: shortfall-as-data"
    assert new_state.player(0).cash == 100


def test_paying_rent_on_doubles_still_grants_the_extra_roll() -> None:
    target = (0 + _total(_DOUBLES_SEED)) % 40
    board = make_state().board
    if not board.tile(target).is_ownable:  # keep the test honest for any doubles seed
        pytest.skip("this doubles seed does not land on an ownable tile from GO")
    new_state, _ = _land_on(target, {target: PropertyState(owner=1)}, seed=_DOUBLES_SEED)
    assert new_state.phase is Phase.AWAITING_ROLL
