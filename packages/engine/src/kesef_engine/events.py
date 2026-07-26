"""Events — what happened, in order.

``apply()`` returns the new state *and* the events that produced it. The state tells the
UI what to draw; the events tell it what to *animate* and narrate. A client that only
diffs states would know the token is on Boardwalk but not that it passed GO on the way.

Events are also the audit trail: appended to a log, they reconstruct a whole game, which
is what makes the golden-game regression tests possible.

Like everything else in the engine, events carry keys and numbers, never sentences.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from kesef_engine.commands import PlayerId, TileIndex, TradeOffer
from kesef_engine.phases import Phase


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
    TRADE = "trade"
    BANKRUPTCY_TRANSFER = "bankruptcy_transfer"
    FREE_PARKING_POT = "free_parking_pot"


class Deck(StrEnum):
    CHANCE = "chance"
    COMMUNITY_CHEST = "community_chest"


class _EventBase(BaseModel):
    model_config = ConfigDict(frozen=True)


class TurnStarted(_EventBase):
    type: Literal["turn_started"] = "turn_started"
    player: PlayerId
    turn_number: int


class DiceRolled(_EventBase):
    type: Literal["dice_rolled"] = "dice_rolled"
    player: PlayerId
    first: int
    second: int
    doubles_streak: int


class TokenMoved(_EventBase):
    type: Literal["token_moved"] = "token_moved"
    player: PlayerId
    from_tile: TileIndex
    to_tile: TileIndex
    forward: bool = True
    """False for the 'go back three spaces' card — the UI must animate backwards."""
    passed_go: bool = False


class CashChanged(_EventBase):
    type: Literal["cash_changed"] = "cash_changed"
    player: PlayerId
    delta: int
    reason: CashReason
    balance: int
    counterparty: PlayerId | None = None
    """None means the bank."""


class RentCharged(_EventBase):
    type: Literal["rent_charged"] = "rent_charged"
    payer: PlayerId
    owner: PlayerId
    tile: TileIndex
    amount: int
    multiplier_note: str | None = None
    """i18n key explaining the maths, e.g. ``rent.note.full_group_doubled``."""


class PropertyAcquired(_EventBase):
    type: Literal["property_acquired"] = "property_acquired"
    player: PlayerId
    tile: TileIndex
    price: int
    via: Literal["purchase", "auction", "trade", "bankruptcy"]


class AuctionStarted(_EventBase):
    type: Literal["auction_started"] = "auction_started"
    tile: TileIndex
    eligible: tuple[PlayerId, ...]


class BidPlaced(_EventBase):
    type: Literal["bid_placed"] = "bid_placed"
    player: PlayerId
    amount: int


class BidderWithdrew(_EventBase):
    type: Literal["bidder_withdrew"] = "bidder_withdrew"
    player: PlayerId


class AuctionEnded(_EventBase):
    type: Literal["auction_ended"] = "auction_ended"
    tile: TileIndex
    winner: PlayerId | None = None
    """None when every player withdrew: the property stays with the bank."""
    price: int = 0


class CardDrawn(_EventBase):
    type: Literal["card_drawn"] = "card_drawn"
    player: PlayerId
    deck: Deck
    card_id: str
    """i18n key for the card text, e.g. ``card.chance.advance_to_go``."""


class SentToJail(_EventBase):
    type: Literal["sent_to_jail"] = "sent_to_jail"
    player: PlayerId
    via: Literal["tile", "card", "three_doubles"]


class LeftJail(_EventBase):
    type: Literal["left_jail"] = "left_jail"
    player: PlayerId
    via: Literal["fine", "card", "doubles", "time_served"]


class BuildingChanged(_EventBase):
    type: Literal["building_changed"] = "building_changed"
    tile: TileIndex
    houses: int
    """0-4 houses, 5 means a hotel."""
    delta: int


class MortgageChanged(_EventBase):
    type: Literal["mortgage_changed"] = "mortgage_changed"
    tile: TileIndex
    mortgaged: bool


class TradeExecuted(_EventBase):
    type: Literal["trade_executed"] = "trade_executed"
    offer: TradeOffer


class TradeDeclined(_EventBase):
    type: Literal["trade_declined"] = "trade_declined"
    offer: TradeOffer


class DebtIncurred(_EventBase):
    type: Literal["debt_incurred"] = "debt_incurred"
    debtor: PlayerId
    creditor: PlayerId | None
    amount: int
    shortfall: int


class PlayerBankrupted(_EventBase):
    type: Literal["player_bankrupted"] = "player_bankrupted"
    player: PlayerId
    creditor: PlayerId | None
    tiles_transferred: tuple[TileIndex, ...]


class PhaseChanged(_EventBase):
    type: Literal["phase_changed"] = "phase_changed"
    previous: Phase
    current: Phase


class GameEnded(_EventBase):
    type: Literal["game_ended"] = "game_ended"
    winner: PlayerId
    reason: Literal["last_solvent", "time_limit", "concession"]
    final_net_worth: tuple[int, ...]


Event = Annotated[
    TurnStarted
    | DiceRolled
    | TokenMoved
    | CashChanged
    | RentCharged
    | PropertyAcquired
    | AuctionStarted
    | BidPlaced
    | BidderWithdrew
    | AuctionEnded
    | CardDrawn
    | SentToJail
    | LeftJail
    | BuildingChanged
    | MortgageChanged
    | TradeExecuted
    | TradeDeclined
    | DebtIncurred
    | PlayerBankrupted
    | PhaseChanged
    | GameEnded,
    Field(discriminator="type"),
]
