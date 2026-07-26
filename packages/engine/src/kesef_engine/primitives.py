"""The shared vocabulary: ids, closed enumerations, and the small tagged values.

Nothing in this module imports anything else from the engine. That is the whole point:
``commands``, ``events``, ``state`` and ``board`` all need to speak about decks, cash
reasons and auction lots, and if any one of them *owned* those names the other three
would import it and the cycles would start. This module is where those cycles go to die.

Everything here is either a type alias, a closed enumeration, or a frozen value small
enough to have no behaviour of its own.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Final, Literal

from pydantic import BaseModel, ConfigDict, Field

PlayerId = int
"""A seat's stable identity. *Not* an index into ``GameState.players`` — ids survive
bankruptcy and need not be contiguous, so seat order and identity are separate things."""

TileIndex = int
"""A position on the board, ``0 <= index < BOARD_SIZE``."""

BOARD_SIZE: Final = 40
"""Tiles on a board. The universal rules assume 40; the board validator enforces it."""


class BotLevel(StrEnum):
    """How hard a bot plays. Single-sourced here because the engine's ``PlayerKind``,
    the bot protocol and the server's seat configuration all need the same three names."""

    EASY = "easy"
    NORMAL = "normal"
    HARD = "hard"


class Deck(StrEnum):
    """Which pile a card came from — and therefore which pile it must return to."""

    CHANCE = "chance"
    COMMUNITY_CHEST = "community_chest"


class CashReason(StrEnum):
    """Why money moved. Drives both the UI narration and the money-conservation test."""

    GO_SALARY = "go_salary"
    RENT = "rent"
    PURCHASE = "purchase"
    AUCTION_WIN = "auction_win"
    TAX = "tax"
    JAIL_FINE = "jail_fine"
    CARD = "card"
    BUILD = "build"
    SELL_BUILDING = "sell_building"
    MORTGAGE = "mortgage"
    UNMORTGAGE = "unmortgage"
    MORTGAGE_TRANSFER_FEE = "mortgage_transfer_fee"
    """The 10% the receiver of a mortgaged property owes (owner decision 2, GAP §7)."""
    TRADE = "trade"
    BANKRUPTCY_TRANSFER = "bankruptcy_transfer"
    FREE_PARKING_POT = "free_parking_pot"


class AuctionReason(StrEnum):
    """Why an auction opened. The continuation differs per cause, so it is stored."""

    DECLINED_PURCHASE = "declined_purchase"
    BANKRUPTCY_TO_BANK = "bankruptcy_to_bank"
    BUILDING_SHORTAGE = "building_shortage"
    """Ships behind ``Ruleset.building_shortage_auction`` (off in v1, owner decision 1)."""


class _LotBase(BaseModel):
    model_config = ConfigDict(frozen=True)


class TileLot(_LotBase):
    """One tile, offered whole. The ordinary auction."""

    kind: Literal["tile"] = "tile"
    tile: TileIndex = Field(ge=0, lt=BOARD_SIZE)


class BuildingLot(_LotBase):
    """One house or hotel from a bank that has run short of them.

    Bidders want it for their own tile, so the lot names no tile — which is exactly why
    ``AuctionState.tile: TileIndex`` could not express this auction (GAP G-3).
    """

    kind: Literal["building"] = "building"
    building: Literal["house", "hotel"]


Lot = Annotated[TileLot | BuildingLot, Field(discriminator="kind")]
"""What an auction is selling."""
