"""``new_game`` — a valid opening state from seats, a board, a ruleset and a seed (MON-106).

The factory is the only place an opening state is assembled, so the RNG stream layout is
decided here, once: the game's own ``state.rng`` runs on the dice stream, and each deck
is shuffled from its own fork of the same seed. Shuffling a deck therefore cannot shift
a single dice roll (ADR-002), and a saved seed reproduces the whole game.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Final, Literal

from pydantic import BaseModel, ConfigDict, Field

from kesef_engine.board.loader import load_board
from kesef_engine.board.models import BOARD_SIZE
from kesef_engine.decks import CHANCE_CARD_IDS, COMMUNITY_CHEST_CARD_IDS
from kesef_engine.primitives import BotLevel
from kesef_engine.rng import Rng
from kesef_engine.ruleset import Ruleset
from kesef_engine.state import (
    MAX_PLAYERS,
    MIN_PLAYERS,
    GameState,
    PlayerKind,
    PlayerState,
    PropertyState,
)

STREAM_DICE: Final = 0
"""``state.rng`` lives on this stream: every in-game dice roll draws from it."""
STREAM_CHANCE: Final = 1
"""The Chance shuffle's stream. Used once, at setup."""
STREAM_COMMUNITY_CHEST: Final = 2
"""The Community Chest shuffle's stream. Used once, at setup."""

DEFAULT_TOKENS: Final = ("token.rocket", "token.dog", "token.cat", "token.ship", "token.car", "token.crown")
"""Asset keys for the six pawns, assigned by seat order when a seat names none."""


class Seat(BaseModel):
    """One seat at the table, as the caller describes it.

    The engine-side twin of the server's ``SeatConfig`` (which keeps a redundant
    ``is_bot`` on the wire for 422s); here ``bot_level`` alone decides, per GAP G-19.
    """

    model_config = ConfigDict(frozen=True)

    name: str = Field(min_length=1, max_length=24)
    bot_level: BotLevel | None = None
    """None seats a human."""
    token: str | None = None
    """Pawn asset key; None takes the seat's entry from ``DEFAULT_TOKENS``."""
    grammatical_gender: Literal["m", "f", "n"] = "n"


def new_game(
    seats: Sequence[Seat],
    *,
    seed: int,
    game_id: str = "",
    board_id: str = "classic",
    ruleset: Ruleset | None = None,
    locale: str = "en",
) -> GameState:
    """Build the opening state. Deterministic: the same arguments give the same game.

    Raises ``ValueError`` for fewer than 2 or more than 6 seats and for duplicate names
    (case-insensitive) — the same rules the state model enforces, raised here with the
    caller's vocabulary before a half-built state ever exists.
    """
    if not MIN_PLAYERS <= len(seats) <= MAX_PLAYERS:
        raise ValueError(f"a game needs {MIN_PLAYERS}-{MAX_PLAYERS} seats, got {len(seats)}")
    names = [seat.name.casefold() for seat in seats]
    if len(set(names)) != len(names):
        raise ValueError("duplicate seat names")
    load_board(board_id)  # unknown boards fail here, loudly, not on the first roll

    rules = ruleset if ruleset is not None else Ruleset.universal()
    base = Rng(seed=seed)
    chance_deck = _shuffled_deck(CHANCE_CARD_IDS, base.fork(STREAM_CHANCE))
    community_chest_deck = _shuffled_deck(COMMUNITY_CHEST_CARD_IDS, base.fork(STREAM_COMMUNITY_CHEST))

    players = tuple(
        PlayerState(
            id=index,
            name=seat.name,
            kind=PlayerKind(bot_level=seat.bot_level),
            token=seat.token or DEFAULT_TOKENS[index],
            cash=rules.starting_cash,
            grammatical_gender=seat.grammatical_gender,
        )
        for index, seat in enumerate(seats)
    )
    return GameState(
        game_id=game_id or f"game-{seed}",
        board_id=board_id,
        ruleset=rules,
        locale=locale,
        rng=base.fork(STREAM_DICE),
        players=players,
        properties=tuple(PropertyState() for _ in range(BOARD_SIZE)),
        current_player_id=players[0].id,
        chance_deck=chance_deck,
        community_chest_deck=community_chest_deck,
    )


def _shuffled_deck(card_ids: tuple[str, ...], rng: Rng) -> tuple[str, ...]:
    order, _ = rng.shuffled(tuple(range(len(card_ids))))
    return tuple(card_ids[position] for position in order)
