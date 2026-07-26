"""GameState invariants, derived views, and the save/load round-trip."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from helpers import make_state
from kesef_engine.board.models import ColorGroup, TileKind
from kesef_engine.ruleset import Ruleset, RulesetName
from kesef_engine.state import MAX_PLAYERS, GameState, PlayerKind, PropertyState

BROWN_TILES = (1, 3)
LIGHT_BLUE_TILES = (6, 8, 9)


def test_a_game_needs_at_least_two_players() -> None:
    with pytest.raises(ValidationError, match="2-6 players"):
        make_state(players=1)


def test_a_game_caps_at_six_players() -> None:
    make_state(players=MAX_PLAYERS)
    with pytest.raises(ValidationError, match="2-6 players"):
        make_state(players=7)


def test_duplicate_player_ids_are_rejected() -> None:
    payload = make_state().model_dump()
    payload["players"] = [payload["players"][0], payload["players"][0]]
    with pytest.raises(ValidationError, match="duplicate player ids"):
        GameState.model_validate(payload)


def test_properties_must_cover_the_whole_board() -> None:
    state = make_state()
    with pytest.raises(ValidationError, match="must be 40 long"):
        GameState.model_validate(state.model_dump() | {"properties": [PropertyState().model_dump()] * 39})


def test_bot_must_declare_a_level() -> None:
    with pytest.raises(ValidationError, match="bot_level"):
        PlayerKind(is_bot=True)
    with pytest.raises(ValidationError, match="bot_level"):
        PlayerKind(is_bot=False, bot_level="hard")


def test_save_load_round_trip_is_lossless() -> None:
    """A save file is just the state. This test is the entire save/load feature."""
    state = make_state(players=4, seed=1234, properties={39: PropertyState(owner=2, houses=3)})
    restored = GameState.model_validate_json(state.model_dump_json())
    assert restored == state
    assert restored.rng == state.rng


def test_current_player_follows_the_index() -> None:
    state = make_state(players=3).model_copy(update={"current_player_index": 2})
    assert state.current_player.id == 2


def test_solvent_players_excludes_the_bankrupt() -> None:
    state = make_state(players=3)
    players = (state.players[0], state.players[1].model_copy(update={"bankrupt": True}), state.players[2])
    state = state.model_copy(update={"players": players})
    assert [player.id for player in state.solvent_players] == [0, 2]


def test_owns_whole_group_gates_building() -> None:
    partial = make_state(properties={1: PropertyState(owner=0)})
    assert not partial.owns_whole_group(0, ColorGroup.BROWN)

    complete = make_state(properties={index: PropertyState(owner=0) for index in BROWN_TILES})
    assert complete.owns_whole_group(0, ColorGroup.BROWN)
    assert not complete.owns_whole_group(1, ColorGroup.BROWN)


def test_group_owned_by_two_players_is_nobody_s_monopoly() -> None:
    state = make_state(properties={1: PropertyState(owner=0), 3: PropertyState(owner=1)})
    assert not state.owns_whole_group(0, ColorGroup.BROWN)
    assert not state.owns_whole_group(1, ColorGroup.BROWN)


def test_count_of_kind_owned_sets_the_rent_tier() -> None:
    state = make_state(properties={5: PropertyState(owner=0), 15: PropertyState(owner=0), 25: PropertyState(owner=1)})
    assert state.count_of_kind_owned(0, TileKind.RAILROAD) == 2
    assert state.count_of_kind_owned(1, TileKind.RAILROAD) == 1
    assert state.count_of_kind_owned(0, TileKind.UTILITY) == 0


def test_tiles_owned_by_is_ordered_by_board_position() -> None:
    state = make_state(properties={39: PropertyState(owner=0), 1: PropertyState(owner=0)})
    assert state.tiles_owned_by(0) == (1, 39)


def test_net_worth_counts_cash_property_and_buildings() -> None:
    # Mediterranean Avenue: price 60, house_cost 50. Two houses => 60 + 100.
    state = make_state(properties={1: PropertyState(owner=0, houses=2)})
    assert state.net_worth(0) == 1500 + 60 + 100


def test_mortgaged_property_does_not_count_toward_net_worth() -> None:
    state = make_state(properties={1: PropertyState(owner=0, houses=0, mortgaged=True)})
    assert state.net_worth(0) == 1500


def test_unknown_player_raises() -> None:
    with pytest.raises(KeyError):
        make_state().player(99)


def test_board_is_resolved_from_the_id() -> None:
    assert make_state(board_id="israel").board.id == "israel"


def test_kids_ruleset_switches_the_hard_rules_off() -> None:
    kids = Ruleset.kids()
    assert kids.name is RulesetName.KIDS
    assert not kids.auctions_enabled
    assert not kids.mortgages_enabled
    assert kids.hints_enabled
    assert kids.target_duration_minutes == 45
    # Even-build stays on: dropping it would unbalance the game, not simplify it.
    assert kids.even_build_enforced


def test_universal_ruleset_is_the_official_game() -> None:
    universal = Ruleset.universal()
    assert universal.auctions_enabled
    assert universal.mortgages_enabled
    assert universal.even_build_enforced
    assert universal.starting_cash == 1500
    assert universal.go_salary == 200
    assert universal.houses_available == 32
    assert universal.hotels_available == 12
    # House rules stay off unless someone opts in.
    assert not universal.free_parking_pot
    assert not universal.double_salary_on_exact_go


def test_ruleset_by_name_round_trips() -> None:
    for name in RulesetName:
        assert Ruleset.by_name(name).name is name
