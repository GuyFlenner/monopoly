"""GameState — the entire game, as one serializable value.

Everything needed to resume a game lives here, including the RNG. There is no hidden
state anywhere: no module globals, no caches that matter, no clock. Two consequences
worth naming, because they are the whole reason for the design:

* ``model_dump_json()`` is a complete save file, and ``model_validate_json()`` a complete
  load. Save/load needed no extra code.
* A bot can copy the state, play a hundred hypothetical turns through ``apply()``, and
  throw the copies away without touching the real game.

The state is frozen. ``apply()`` returns a new one.
"""

from __future__ import annotations

from typing import Self

from pydantic import BaseModel, Field, model_validator

from kesef_engine.board.loader import load_board
from kesef_engine.board.models import BOARD_SIZE, Board, ColorGroup, TileKind
from kesef_engine.commands import PlayerId, TileIndex, TradeOffer
from kesef_engine.events import Deck
from kesef_engine.phases import Phase
from kesef_engine.ruleset import Ruleset

MIN_PLAYERS = 2
MAX_PLAYERS = 6
HOTEL_LEVEL = 5
"""``PropertyState.houses == 5`` means a hotel stands on the tile."""


class PlayerKind(BaseModel, frozen=True):
    """Whether a seat is driven by a person or by a bot, and how strong the bot is."""

    is_bot: bool = False
    bot_level: str | None = None
    """``easy`` | ``normal`` | ``hard``. None for humans."""

    @model_validator(mode="after")
    def _check(self) -> Self:
        if self.is_bot != (self.bot_level is not None):
            raise ValueError("bot_level must be set for bots and unset for humans")
        return self


class PlayerState(BaseModel, frozen=True):
    id: PlayerId
    name: str = Field(min_length=1, max_length=24)
    """The one piece of free text in the engine — a player typed it, so it is not a key."""
    kind: PlayerKind
    token: str
    """Asset key for the pawn, e.g. ``token.dog``."""
    cash: int = 0
    position: TileIndex = 0
    in_jail: bool = False
    jail_turns: int = 0
    jail_cards: int = 0
    bankrupt: bool = False


class PropertyState(BaseModel, frozen=True):
    """Ownership and development of one tile. Index-aligned with ``Board.tiles``."""

    owner: PlayerId | None = None
    houses: int = Field(default=0, ge=0, le=HOTEL_LEVEL)
    mortgaged: bool = False


class DiceState(BaseModel, frozen=True):
    first: int
    second: int
    doubles_streak: int = 0
    """Consecutive doubles this turn. Three sends the player to jail."""

    @property
    def total(self) -> int:
        return self.first + self.second

    @property
    def is_doubles(self) -> bool:
        return self.first == self.second


class AuctionState(BaseModel, frozen=True):
    tile: TileIndex
    high_bid: int = 0
    high_bidder: PlayerId | None = None
    active: tuple[PlayerId, ...] = ()
    """Players who have not withdrawn, in bidding order."""
    turn: PlayerId | None = None
    """Whose turn it is to bid."""


class DebtState(BaseModel, frozen=True):
    """An obligation the debtor cannot currently pay in cash."""

    debtor: PlayerId
    creditor: PlayerId | None
    """None means the bank."""
    amount: int


class GameState(BaseModel, frozen=True):
    """A complete game. See the module docstring for why this is one flat value."""

    schema_version: int = 1
    """Bump when the shape changes incompatibly, so old save files fail loudly."""

    game_id: str
    board_id: str
    ruleset: Ruleset
    locale: str = "en"
    """The UI's starting language. The engine itself never reads it — it emits keys."""

    rng: Rng  # noqa: F821  (forward ref resolved below)
    players: tuple[PlayerState, ...]
    properties: tuple[PropertyState, ...]
    """Always ``BOARD_SIZE`` long and index-aligned with the board, including the tiles
    that can never be owned. Wasting 18 slots buys O(1) lookup with no index arithmetic."""

    phase: Phase = Phase.AWAITING_ROLL
    current_player_index: int = 0
    dice: DiceState | None = None
    turn_number: int = 1

    houses_remaining: int = 32
    hotels_remaining: int = 12
    """The building shortage is a real rule, so the supply is real state."""

    auction: AuctionState | None = None
    pending_trade: TradeOffer | None = None
    pending_debt: DebtState | None = None

    chance_deck: tuple[str, ...] = ()
    community_chest_deck: tuple[str, ...] = ()
    """Card ids in draw order; a drawn card returns to the bottom."""

    free_parking_pot: int = 0
    winner: PlayerId | None = None

    @model_validator(mode="after")
    def _check(self) -> Self:
        if not MIN_PLAYERS <= len(self.players) <= MAX_PLAYERS:
            raise ValueError(f"a game needs {MIN_PLAYERS}-{MAX_PLAYERS} players, got {len(self.players)}")
        if len({player.id for player in self.players}) != len(self.players):
            raise ValueError("duplicate player ids")
        if len(self.properties) != BOARD_SIZE:
            raise ValueError(f"properties must be {BOARD_SIZE} long, got {len(self.properties)}")
        if not 0 <= self.current_player_index < len(self.players):
            raise ValueError("current_player_index out of range")
        return self

    # --- Derived views ------------------------------------------------------

    @property
    def board(self) -> Board:
        """The board layout. ``load_board`` is cached, so this is cheap to call."""
        return load_board(self.board_id)

    @property
    def current_player(self) -> PlayerState:
        return self.players[self.current_player_index]

    def player(self, player_id: PlayerId) -> PlayerState:
        for candidate in self.players:
            if candidate.id == player_id:
                return candidate
        raise KeyError(player_id)

    @property
    def solvent_players(self) -> tuple[PlayerState, ...]:
        return tuple(player for player in self.players if not player.bankrupt)

    def tiles_owned_by(self, player_id: PlayerId) -> tuple[TileIndex, ...]:
        return tuple(index for index, prop in enumerate(self.properties) if prop.owner == player_id)

    def owns_whole_group(self, player_id: PlayerId, group: ColorGroup) -> bool:
        """True when ``player_id`` owns every tile in ``group`` — the gate for building."""
        members = self.board.group_members(group)
        return bool(members) and all(self.properties[index].owner == player_id for index in members)

    def count_of_kind_owned(self, player_id: PlayerId, kind: TileKind) -> int:
        """How many railroads / utilities a player holds — sets their rent tier."""
        return sum(1 for index in self.board.indexes_of_kind(kind) if self.properties[index].owner == player_id)

    def deck(self, deck: Deck) -> tuple[str, ...]:
        return self.chance_deck if deck is Deck.CHANCE else self.community_chest_deck

    def net_worth(self, player_id: PlayerId) -> int:
        """Cash plus unmortgaged property value plus buildings at cost.

        This is the official tie-break for a time-limited game, and the yardstick the
        Kids Mode timer uses to pick a winner.
        """
        player = self.player(player_id)
        total = player.cash
        for index in self.tiles_owned_by(player_id):
            tile = self.board.tile(index)
            prop = self.properties[index]
            if prop.mortgaged:
                continue
            total += tile.price or 0
            total += prop.houses * (tile.house_cost or 0)
        return total


# Imported last: ``Rng`` is referenced as a forward annotation above so that the reading
# order of this module stays state-first.
from kesef_engine.rng import Rng  # noqa: E402

GameState.model_rebuild()
