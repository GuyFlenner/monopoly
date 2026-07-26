"""GameState invariants, derived views, and the save/load round-trip."""

from __future__ import annotations

from collections import Counter
from typing import Any

import pytest
from pydantic import ValidationError

from helpers import make_player, make_state
from kesef_engine.board.models import ColorGroup, TileKind
from kesef_engine.phases import Phase
from kesef_engine.primitives import BotLevel, Deck
from kesef_engine.ruleset import Ruleset, RulesetName
from kesef_engine.state import (
    MAX_PLAYERS,
    SCHEMA_VERSION,
    DiceState,
    GameState,
    PlayerKind,
    PlayerState,
    PropertyState,
)

BROWN_TILES = (1, 3)
LIGHT_BLUE_TILES = (6, 8, 9)
GO_TILE = 0
"""Nothing can be owned or built on it — the cross-validation canary."""
RAILROAD_TILE = 5
"""Ownable, but buildings on it are nonsense — the second half of the same canary."""


def _payload(**changes: Any) -> dict[str, Any]:
    """A valid two-player state as a dict, with ``changes`` applied on top."""
    return make_state().model_dump() | changes


# --- Player count and identity ---------------------------------------------


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


def test_duplicate_player_names_are_rejected_case_insensitively() -> None:
    """Two "dana"s at one table is a usability bug, and hotseat has no other handle."""
    with pytest.raises(ValidationError, match="duplicate player names"):
        GameState.model_validate(
            _payload(players=[make_player(0, "Dana").model_dump(), make_player(1, "DANA").model_dump()])
        )


def test_duplicate_tokens_are_rejected() -> None:
    players = [make_player(0).model_dump(), make_player(1).model_dump() | {"token": "token.0"}]
    with pytest.raises(ValidationError, match="duplicate player tokens"):
        GameState.model_validate(_payload(players=players))


def test_non_contiguous_player_ids_are_legal() -> None:
    """Seat order and player identity are different things; bankruptcy leaves gaps."""
    state = make_state(ids=(0, 4, 9))
    assert [player.id for player in state.players] == [0, 4, 9]
    assert state.player(9).name == "P9"


# --- Bots -------------------------------------------------------------------


def test_is_bot_is_derived_from_the_level() -> None:
    """G-19: ``is_bot`` was a second, independently settable source of truth."""
    assert not PlayerKind().is_bot
    assert PlayerKind(bot_level=BotLevel.HARD).is_bot


def test_bot_level_is_a_closed_enum() -> None:
    """G-19: ``bot_level: str`` accepted "banana" while the BotLevel enum existed."""
    with pytest.raises(ValidationError):
        PlayerKind(bot_level="banana")


# --- Schema version ---------------------------------------------------------


def test_a_stale_schema_version_is_rejected_with_a_key() -> None:
    """G-19: the version was documented as a load guard and never checked."""
    with pytest.raises(ValidationError, match="error.save_schema_mismatch"):
        GameState.model_validate(_payload(schema_version=1))


def test_the_current_schema_version_is_two() -> None:
    assert SCHEMA_VERSION == 2
    assert make_state().schema_version == SCHEMA_VERSION


# --- Properties cross-validated against the board ---------------------------


def test_a_building_on_an_unbuildable_tile_is_rejected() -> None:
    """G-19: a hotel on GO used to validate. So did a hotel on a railroad."""
    with pytest.raises(ValidationError):
        make_state(properties={GO_TILE: PropertyState(owner=0, houses=5)})
    with pytest.raises(ValidationError, match="cannot hold buildings"):
        make_state(properties={RAILROAD_TILE: PropertyState(owner=0, houses=5)})


def test_an_unownable_tile_cannot_have_an_owner() -> None:
    with pytest.raises(ValidationError, match="cannot be owned"):
        make_state(properties={GO_TILE: PropertyState(owner=0)})


def test_an_unknown_owner_is_rejected() -> None:
    """G-19: ``owner=99`` used to validate."""
    with pytest.raises(ValidationError, match="unknown owner"):
        make_state(properties={1: PropertyState(owner=99)})


def test_a_mortgaged_property_cannot_carry_buildings() -> None:
    """G-19: mortgaged + houses used to validate. The rules forbid it in both directions."""
    with pytest.raises(ValidationError, match="mortgaged"):
        PropertyState(owner=0, houses=1, mortgaged=True)


def test_an_unowned_property_cannot_be_mortgaged_or_built() -> None:
    with pytest.raises(ValidationError, match="unowned"):
        PropertyState(mortgaged=True)
    with pytest.raises(ValidationError, match="unowned"):
        PropertyState(houses=1)


def test_properties_must_cover_the_whole_board() -> None:
    with pytest.raises(ValidationError, match="must be 40 long"):
        GameState.model_validate(_payload(properties=[PropertyState().model_dump()] * 39))


# --- Building stock is derived, not stored ----------------------------------


def test_building_stock_is_derived_from_the_board_and_the_ruleset() -> None:
    """G-19: a stored ``houses_remaining=32`` silently contradicted a custom ruleset."""
    state = make_state(properties={1: PropertyState(owner=0, houses=3), 39: PropertyState(owner=0, houses=5)})
    assert state.houses_on_board == 3
    assert state.hotels_on_board == 1
    assert state.houses_remaining == 32 - 3
    assert state.hotels_remaining == 12 - 1


def test_a_board_holding_more_buildings_than_the_bank_owns_is_rejected() -> None:
    lean = Ruleset.universal().model_copy(update={"houses_available": 4})
    with pytest.raises(ValidationError, match="more houses"):
        make_state(
            ruleset=lean,
            properties={index: PropertyState(owner=0, houses=2) for index in LIGHT_BLUE_TILES},
        )


def test_a_board_holding_more_hotels_than_the_bank_owns_is_rejected() -> None:
    lean = Ruleset.universal().model_copy(update={"hotels_available": 1})
    with pytest.raises(ValidationError, match="more hotels"):
        make_state(ruleset=lean, properties={index: PropertyState(owner=0, houses=5) for index in BROWN_TILES})


# --- Turn, dice and bounds --------------------------------------------------


def test_current_player_is_resolved_by_id() -> None:
    """ADR-007/G-19: the state names the actor by id, as every command and event does."""
    state = make_state(ids=(0, 4, 9)).model_copy(update={"current_player_id": 9})
    assert state.current_player.id == 9
    assert state.current_seat_index == 2


def test_an_unseated_current_player_is_rejected() -> None:
    with pytest.raises(ValidationError, match="current_player_id"):
        GameState.model_validate(_payload(current_player_id=99))


def test_dice_faces_are_bounded() -> None:
    DiceState(first=1, second=6)
    with pytest.raises(ValidationError):
        DiceState(first=0, second=3)
    with pytest.raises(ValidationError):
        DiceState(first=3, second=7)


def test_dice_carry_the_purpose_of_the_roll() -> None:
    """G-10: one slot must distinguish a move roll from a jail or utility-rent roll."""
    assert DiceState(first=2, second=4).purpose == "move"
    assert DiceState(first=2, second=4, purpose="rent").purpose == "rent"
    with pytest.raises(ValidationError):
        DiceState(first=2, second=4, purpose="bribe")


def test_doubles_streak_belongs_to_the_turn_not_the_roll() -> None:
    """G-10: a rent roll must not destroy the movement roll's streak."""
    assert make_state().doubles_streak == 0
    assert "doubles_streak" in GameState.model_fields
    assert "doubles_streak" not in DiceState.model_fields
    with pytest.raises(ValidationError):
        GameState.model_validate(_payload(doubles_streak=-1))


def test_cash_never_goes_negative() -> None:
    """G-18: shortfall-as-data. What a player cannot pay lives in the DebtFrame."""
    with pytest.raises(ValidationError):
        make_player(0, cash=-1)


def test_a_token_off_the_board_is_rejected() -> None:
    with pytest.raises(ValidationError):
        PlayerState(id=0, name="P", kind=PlayerKind(), token="t", position=40)


def test_elapsed_seconds_is_non_negative() -> None:
    """G-6: the caller stamps the clock; the engine only stores it."""
    assert make_state().elapsed_seconds == 0
    with pytest.raises(ValidationError):
        GameState.model_validate(_payload(elapsed_seconds=-1))


# --- Jail cards are deck-identified ----------------------------------------


def test_jail_cards_are_deck_identified() -> None:
    """G-11: a count cannot be returned to the bottom of the right deck."""
    player = make_player(0, jail_cards=(Deck.CHANCE,))
    assert player.jail_cards == (Deck.CHANCE,)
    with pytest.raises(ValidationError):
        make_player(0, jail_cards=("poker",))  # type: ignore[arg-type]


def test_a_deck_s_single_jail_card_cannot_be_in_two_hands() -> None:
    players = [
        make_player(0, jail_cards=(Deck.CHANCE,)).model_dump(),
        make_player(1, jail_cards=(Deck.CHANCE,)).model_dump(),
    ]
    with pytest.raises(ValidationError, match="jail card"):
        GameState.model_validate(_payload(players=players))


def test_the_jail_card_multiset_is_countable() -> None:
    """The shape the MON-209 conservation invariant is written against."""
    state = GameState.model_validate(
        _payload(
            players=[
                make_player(0, jail_cards=(Deck.CHANCE,)).model_dump(),
                make_player(1, jail_cards=(Deck.COMMUNITY_CHEST,)).model_dump(),
            ]
        )
    )
    held = Counter(card for player in state.players for card in player.jail_cards)
    assert held == Counter({Deck.CHANCE: 1, Deck.COMMUNITY_CHEST: 1})


def test_a_bankrupt_player_holds_nothing_and_is_not_in_jail() -> None:
    """G-12: bankruptcy hands the estate over — including the cards."""
    with pytest.raises(ValidationError, match="bankrupt"):
        make_player(0, bankrupt=True, jail_cards=(Deck.CHANCE,))
    with pytest.raises(ValidationError, match="bankrupt"):
        make_player(0, bankrupt=True, in_jail=True)


# --- Grammatical gender -----------------------------------------------------


def test_grammatical_gender_defaults_to_neutral() -> None:
    """Owner decision 5 (GAP §7): per-seat pronoun choice, neutral fallback."""
    assert make_player(0).grammatical_gender == "n"
    assert make_player(0, gender="f").grammatical_gender == "f"
    with pytest.raises(ValidationError):
        make_player(0, gender="x")  # type: ignore[arg-type]


# --- Endgame ----------------------------------------------------------------


def test_a_winner_means_the_game_is_over() -> None:
    with pytest.raises(ValidationError, match="GAME_OVER"):
        GameState.model_validate(_payload(winner=0))
    GameState.model_validate(_payload(winner=0, phase=Phase.GAME_OVER))


def test_game_over_needs_a_winner_or_no_survivors() -> None:
    with pytest.raises(ValidationError, match="unresolved"):
        GameState.model_validate(_payload(phase=Phase.GAME_OVER))


def test_a_game_can_end_with_no_survivors() -> None:
    """G-13: the official transfer fee makes a creditor-side cascade reachable."""
    players = [make_player(0, cash=0, bankrupt=True).model_dump(), make_player(1, cash=0, bankrupt=True).model_dump()]
    state = GameState.model_validate(_payload(players=players, phase=Phase.GAME_OVER, elimination_order=[0, 1]))
    assert state.winner is None
    assert state.solvent_players == ()


def test_a_bankrupt_winner_is_rejected() -> None:
    players = [make_player(0, cash=0, bankrupt=True).model_dump(), make_player(1).model_dump()]
    with pytest.raises(ValidationError, match="winner"):
        GameState.model_validate(_payload(players=players, phase=Phase.GAME_OVER, winner=0, elimination_order=[0]))


def test_elimination_order_records_the_standings() -> None:
    """GAP §1 minor: without it every bankrupt player ties at zero."""
    players = [make_player(0, cash=0, bankrupt=True).model_dump(), make_player(1).model_dump()]
    state = GameState.model_validate(_payload(players=players, phase=Phase.GAME_OVER, winner=1, elimination_order=[0]))
    assert state.elimination_order == (0,)


def test_elimination_order_only_holds_bankrupt_players() -> None:
    with pytest.raises(ValidationError, match="elimination_order"):
        GameState.model_validate(_payload(elimination_order=[0]))


def test_elimination_order_rejects_duplicates() -> None:
    players = [make_player(0, cash=0, bankrupt=True).model_dump(), make_player(1).model_dump()]
    with pytest.raises(ValidationError, match="elimination_order"):
        GameState.model_validate(_payload(players=players, phase=Phase.GAME_OVER, winner=1, elimination_order=[0, 0]))


# --- Derived views ----------------------------------------------------------


def test_save_load_round_trip_is_lossless() -> None:
    """A save file is just the state. This test is the entire save/load feature."""
    state = make_state(players=4, seed=1234, properties={39: PropertyState(owner=2, houses=3)})
    restored = GameState.model_validate_json(state.model_dump_json())
    assert restored == state
    assert restored.rng == state.rng


def test_solvent_players_excludes_the_bankrupt() -> None:
    state = make_state(players=3)
    players = (
        state.players[0],
        state.players[1].model_copy(update={"bankrupt": True, "cash": 0}),
        state.players[2],
    )
    state = state.model_copy(update={"players": players, "elimination_order": (1,)})
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


def test_deck_lookup_is_by_deck_identity() -> None:
    state = make_state().model_copy(update={"chance_deck": ("card.chance.a",)})
    assert state.deck(Deck.CHANCE) == ("card.chance.a",)
    assert state.deck(Deck.COMMUNITY_CHEST) == ()


# --- Ruleset ----------------------------------------------------------------


def test_kids_ruleset_switches_the_hard_rules_off() -> None:
    kids = Ruleset.kids()
    assert kids.name is RulesetName.KIDS
    assert not kids.auctions_enabled
    assert not kids.mortgages_enabled
    assert kids.hints_enabled
    assert kids.target_duration_minutes == 45
    # Even-build stays on: dropping it would unbalance the game, not simplify it.
    assert kids.even_build_enforced
    # Owner decision 6 (GAP §7): trading stays on in Kids Mode, with a setup toggle.
    assert kids.trading_enabled


def test_universal_ruleset_is_the_official_game() -> None:
    universal = Ruleset.universal()
    assert universal.auctions_enabled
    assert universal.mortgages_enabled
    assert universal.even_build_enforced
    assert universal.starting_cash == 1500
    assert universal.go_salary == 200
    assert universal.houses_available == 32
    assert universal.hotels_available == 12
    # House rules stay off unless someone opts in. Renamed per GAP §1 minor: the old
    # `free_parking_pot` bool collided with `GameState.free_parking_pot`, an int.
    assert not universal.free_parking_pot_enabled
    assert not universal.double_salary_on_exact_go
    # Owner decision 1 (GAP §7): v1 ships first-come-first-served buildings.
    assert not universal.building_shortage_auction


def test_ruleset_by_name_round_trips() -> None:
    for name in RulesetName:
        assert Ruleset.by_name(name).name is name
