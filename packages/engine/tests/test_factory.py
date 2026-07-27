"""MON-106 — ``new_game``: a valid opening state from seats + board + ruleset + seed."""

from __future__ import annotations

import pytest

from kesef_engine.decks import CHANCE_CARD_IDS, COMMUNITY_CHEST_CARD_IDS
from kesef_engine.factory import STREAM_CHANCE, STREAM_COMMUNITY_CHEST, STREAM_DICE, Seat, new_game
from kesef_engine.phases import Phase
from kesef_engine.primitives import BotLevel
from kesef_engine.rng import Rng
from kesef_engine.ruleset import Ruleset

SEATS = (Seat(name="Ada"), Seat(name="Boaz"))


def test_opening_state_is_a_valid_start() -> None:
    state = new_game(SEATS, seed=42)
    assert state.phase is Phase.AWAITING_ROLL
    assert state.turn_number == 1
    assert state.current_player_id == state.players[0].id
    assert state.interrupts == ()
    assert state.dice is None
    assert state.free_parking_pot == 0
    assert state.winner is None
    assert all(prop.owner is None for prop in state.properties)
    for player in state.players:
        assert player.cash == state.ruleset.starting_cash
        assert player.position == 0
        assert not player.in_jail and not player.bankrupt
        assert player.jail_cards == ()


def test_seats_become_players_in_order_with_stable_ids() -> None:
    state = new_game((Seat(name="Ada"), Seat(name="Boaz", bot_level=BotLevel.EASY), Seat(name="Car")), seed=1)
    assert [player.id for player in state.players] == [0, 1, 2]
    assert [player.name for player in state.players] == ["Ada", "Boaz", "Car"]
    assert not state.players[0].kind.is_bot
    assert state.players[1].kind.is_bot and state.players[1].kind.bot_level is BotLevel.EASY


def test_default_tokens_are_unique_and_custom_tokens_respected() -> None:
    state = new_game((Seat(name="Ada", token="token.crown"), Seat(name="Boaz")), seed=1)
    tokens = [player.token for player in state.players]
    assert tokens[0] == "token.crown"
    assert len(set(tokens)) == len(tokens)


def test_grammatical_gender_reaches_the_player() -> None:
    state = new_game((Seat(name="Ada", grammatical_gender="f"), Seat(name="Boaz", grammatical_gender="m")), seed=1)
    assert state.players[0].grammatical_gender == "f"
    assert state.players[1].grammatical_gender == "m"


def test_both_decks_are_shuffled_permutations_of_the_full_card_lists() -> None:
    state = new_game(SEATS, seed=7)
    assert len(state.chance_deck) == 16
    assert len(state.community_chest_deck) == 16
    assert sorted(state.chance_deck) == sorted(CHANCE_CARD_IDS)
    assert sorted(state.community_chest_deck) == sorted(COMMUNITY_CHEST_CARD_IDS)


def test_some_seed_actually_reorders_each_deck() -> None:
    reordered_chance = any(new_game(SEATS, seed=seed).chance_deck != CHANCE_CARD_IDS for seed in range(5))
    reordered_chest = any(
        new_game(SEATS, seed=seed).community_chest_deck != COMMUNITY_CHEST_CARD_IDS for seed in range(5)
    )
    assert reordered_chance and reordered_chest


def test_decks_come_from_their_own_rng_streams_and_leave_the_dice_stream_untouched() -> None:
    """Shuffling the decks must not shift the dice sequence (ADR-002 stream separation)."""
    state = new_game(SEATS, seed=42)
    assert state.rng == Rng(seed=42, counter=0, stream=STREAM_DICE)
    assert len({STREAM_DICE, STREAM_CHANCE, STREAM_COMMUNITY_CHEST}) == 3


def test_same_seed_means_the_same_game() -> None:
    left = new_game(SEATS, seed=99)
    right = new_game(SEATS, seed=99)
    assert left.model_dump_json() == right.model_dump_json()


def test_different_seeds_shuffle_differently() -> None:
    decks = {new_game(SEATS, seed=seed).chance_deck for seed in range(8)}
    assert len(decks) > 1


def test_rejects_too_few_and_too_many_seats() -> None:
    with pytest.raises(ValueError, match="2"):
        new_game((Seat(name="Solo"),), seed=1)
    with pytest.raises(ValueError, match="6"):
        new_game(tuple(Seat(name=f"P{n}") for n in range(7)), seed=1)


def test_rejects_duplicate_names_case_insensitively() -> None:
    with pytest.raises(ValueError, match="duplicate"):
        new_game((Seat(name="Ada"), Seat(name="ada")), seed=1)


def test_ruleset_and_board_are_honoured() -> None:
    state = new_game(SEATS, seed=1, board_id="israel", ruleset=Ruleset.kids())
    assert state.board_id == "israel"
    assert state.ruleset.starting_cash == 2000
    assert all(player.cash == 2000 for player in state.players)


def test_game_id_defaults_from_the_seed_and_can_be_overridden() -> None:
    assert new_game(SEATS, seed=5).game_id == "game-5"
    assert new_game(SEATS, seed=5, game_id="my-game").game_id == "my-game"
