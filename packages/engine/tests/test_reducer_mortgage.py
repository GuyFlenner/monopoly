"""MON-202 — mortgages, end to end.

Half the printed price out, mortgage value plus 10% back in, no rent while mortgaged but
still counting toward group completion (spec §3.6 trap 2), buildings off the whole group
before any of it can be mortgaged, and the entire feature absent under Kids Mode.

The legality half is pinned in ``test_legality.py``; what lives here is the money, the
round trip, and the rent consequence — the parts a legality test cannot see.
"""

from __future__ import annotations

import pytest

from helpers import make_player, make_state
from kesef_engine.board.models import Tile, TileKind
from kesef_engine.commands import BuildHouse, MortgageProperty, SellHouse, UnmortgageProperty
from kesef_engine.errors import IllegalCommandError
from kesef_engine.events import CashChanged, MortgageChanged, RentCharged
from kesef_engine.legality import legal_commands, unmortgage_cost
from kesef_engine.phases import Phase
from kesef_engine.primitives import CashReason
from kesef_engine.reducer import apply
from kesef_engine.ruleset import Ruleset
from kesef_engine.state import GameState, PropertyState

BROWN = (1, 3)
RAILROAD = 5
"""price 200, mortgage 100."""


def _portfolio(**kwargs: object) -> GameState:
    return make_state(phase=Phase.AWAITING_END_TURN, **kwargs)  # type: ignore[arg-type]


# --- Half the printed price ----------------------------------------------------


@pytest.mark.parametrize("tile_index", [1, 5, 12, 39])
def test_mortgaging_pays_out_exactly_half_the_printed_price(tile_index: int) -> None:
    state = _portfolio(properties={tile_index: PropertyState(owner=0)})
    tile = state.board.tile(tile_index)
    assert tile.price is not None
    new_state, events = apply(state, MortgageProperty(player=0, tile=tile_index))
    paid = next(event for event in events if isinstance(event, CashChanged))
    assert (paid.delta, paid.reason, paid.counterparty) == (tile.price // 2, CashReason.MORTGAGE, "bank")
    assert new_state.player(0).cash == state.player(0).cash + tile.price // 2
    assert new_state.properties[tile_index].mortgaged
    assert next(event for event in events if isinstance(event, MortgageChanged)).mortgaged is True


# --- Lifting at value + 10% ----------------------------------------------------


def test_unmortgaging_charges_the_value_plus_ten_percent() -> None:
    state = _portfolio(properties={RAILROAD: PropertyState(owner=0, mortgaged=True)})
    new_state, events = apply(state, UnmortgageProperty(player=0, tile=RAILROAD))
    assert not new_state.properties[RAILROAD].mortgaged
    paid = next(event for event in events if isinstance(event, CashChanged))
    assert (paid.delta, paid.reason) == (-110, CashReason.UNMORTGAGE), "100 + 10%"


def test_the_ten_percent_rounds_up() -> None:
    """The lift fee is ceiling-rounded, so a value the printed board never carries still
    costs the player rather than the bank. Every shipped board's mortgage values are
    multiples of ten, so nothing but a direct test can prove the rounding bites."""
    odd = Tile(index=1, kind=TileKind.RAILROAD, name_key="t", price=70, rent=(1, 2, 3, 4), mortgage=35)
    assert unmortgage_cost(odd) == 39, "35 + ceil(3.5)"
    exact = Tile(index=1, kind=TileKind.RAILROAD, name_key="t", price=60, rent=(1, 2, 3, 4), mortgage=30)
    assert unmortgage_cost(exact) == 33


def test_a_mortgage_round_trip_costs_the_player_the_interest() -> None:
    state = _portfolio(properties={RAILROAD: PropertyState(owner=0)})
    opening = state.player(0).cash
    state, _ = apply(state, MortgageProperty(player=0, tile=RAILROAD))
    state, _ = apply(state, UnmortgageProperty(player=0, tile=RAILROAD))
    assert not state.properties[RAILROAD].mortgaged
    assert state.player(0).cash == opening - 10, "the 10% is the whole cost of the loan"


# --- Buildings come off the whole group first ---------------------------------


def test_a_built_sibling_blocks_mortgaging_an_unbuilt_member() -> None:
    state = _portfolio(properties={1: PropertyState(owner=0, houses=1), 3: PropertyState(owner=0)})
    with pytest.raises(IllegalCommandError) as excinfo:
        apply(state, MortgageProperty(player=0, tile=3))
    assert excinfo.value.reason_key == "error.group_has_buildings"


def test_selling_the_group_bare_is_what_unlocks_the_mortgage() -> None:
    state = _portfolio(properties={1: PropertyState(owner=0, houses=1), 3: PropertyState(owner=0, houses=1)})
    assert not [command for command in legal_commands(state) if isinstance(command, MortgageProperty)]
    state, _ = apply(state, SellHouse(player=0, tile=1))
    state, _ = apply(state, SellHouse(player=0, tile=3))
    offered = {command.tile for command in legal_commands(state) if isinstance(command, MortgageProperty)}
    assert offered == set(BROWN)


def test_a_mortgaged_group_cannot_be_built_on_until_it_is_lifted() -> None:
    state = _portfolio(properties={1: PropertyState(owner=0), 3: PropertyState(owner=0, mortgaged=True)})
    with pytest.raises(IllegalCommandError) as excinfo:
        apply(state, BuildHouse(player=0, tile=1))
    assert excinfo.value.reason_key == "error.group_mortgaged"
    state, _ = apply(state, UnmortgageProperty(player=0, tile=3))
    assert BuildHouse(player=0, tile=1) in legal_commands(state)


# --- No rent while mortgaged, but the group still completes (trap 2) ----------


def _land_player_one_on(state: GameState, tile_index: int) -> tuple[GameState, tuple[object, ...]]:
    """Put player 1 on ``tile_index`` and resolve the landing through the tile router."""
    from kesef_engine.rules import tiles

    seats = tuple(
        make_player(player.id, cash=player.cash, position=tile_index if player.id == 1 else player.position)
        for player in state.players
    )
    state = GameState(**{**dict(state), "players": seats})
    return tiles.resolve_landing(state, 1)


def test_rent_stops_while_mortgaged_and_returns_when_the_mortgage_is_lifted() -> None:
    state = _portfolio(properties={RAILROAD: PropertyState(owner=0, mortgaged=True)})
    _, events = _land_player_one_on(state, RAILROAD)
    assert not [event for event in events if isinstance(event, RentCharged)]

    lifted, _ = apply(state, UnmortgageProperty(player=0, tile=RAILROAD))
    _, events = _land_player_one_on(lifted, RAILROAD)
    charged = next(event for event in events if isinstance(event, RentCharged))
    assert charged.amount == 25, "the single-railroad tier is charged again"


def test_a_mortgaged_member_still_doubles_the_undeveloped_group_rent() -> None:
    """Trap 2's second half: mortgaging kills the *tile's* rent, not the group's status."""
    state = _portfolio(properties={1: PropertyState(owner=0, mortgaged=True), 3: PropertyState(owner=0)})
    _, events = _land_player_one_on(state, 3)
    charged = next(event for event in events if isinstance(event, RentCharged))
    assert (charged.multiplier, charged.amount) == (2, 8), "tile 3's base rent of 4, doubled"
    assert "rent.note.full_group_doubled" in charged.note_keys


# --- Kids Mode has no mortgages at all ----------------------------------------


def test_kids_mode_offers_neither_mortgage_nor_unmortgage() -> None:
    state = _portfolio(
        ruleset=Ruleset.kids(),
        properties={RAILROAD: PropertyState(owner=0), 1: PropertyState(owner=0, mortgaged=True)},
    )
    assert not [
        command for command in legal_commands(state) if isinstance(command, MortgageProperty | UnmortgageProperty)
    ]
    for command in (MortgageProperty(player=0, tile=RAILROAD), UnmortgageProperty(player=0, tile=1)):
        with pytest.raises(IllegalCommandError) as excinfo:
            apply(state, command)
        assert excinfo.value.reason_key == "error.mortgages_disabled"


# --- Who did it (MON-414) -----------------------------------------------------


def test_both_mortgage_events_name_the_player_who_acted() -> None:
    """MON-414: without ``player`` the log had no subject and rendered in the passive voice.

    Mortgaging is legal off-turn, and holdings are public, so "Boardwalk was mortgaged" in a
    six-seat game withholds the one fact a reader wants. Asserted for both directions and against
    a non-current seat, because reading the actor off ``current_player_id`` instead would agree
    with this event on the ordinary path and be wrong on exactly that case.
    """
    state = _portfolio(properties={RAILROAD: PropertyState(owner=1), 1: PropertyState(owner=1, mortgaged=True)})
    assert state.current_player_id != 1, "the point of the case: seat 1 is acting off-turn"

    _, mortgaged = apply(state, MortgageProperty(player=1, tile=RAILROAD))
    taken = next(event for event in mortgaged if isinstance(event, MortgageChanged))
    assert (taken.player, taken.tile, taken.mortgaged) == (1, RAILROAD, True)

    _, lifted = apply(state, UnmortgageProperty(player=1, tile=1))
    paid_off = next(event for event in lifted if isinstance(event, MortgageChanged))
    assert (paid_off.player, paid_off.tile, paid_off.mortgaged) == (1, 1, False)
