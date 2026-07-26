"""Commands — the only way to change a game.

Every command names its actor (``player``), and the engine verifies that this player is
entitled to act in the current phase. There is no other write path into ``GameState``.

Commands are a *closed* discriminated union so that adding one without handling it is a
type error rather than a runtime surprise.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

PlayerId = int
TileIndex = int


class _CommandBase(BaseModel):
    model_config = ConfigDict(frozen=True)

    player: PlayerId


# --- Turn flow -------------------------------------------------------------


class RollDice(_CommandBase):
    kind: Literal["roll_dice"] = "roll_dice"


class EndTurn(_CommandBase):
    kind: Literal["end_turn"] = "end_turn"


# --- Buying ----------------------------------------------------------------


class BuyProperty(_CommandBase):
    """Buy the tile you are standing on at its list price."""

    kind: Literal["buy_property"] = "buy_property"


class DeclinePurchase(_CommandBase):
    """Decline. Under the universal ruleset this opens an auction."""

    kind: Literal["decline_purchase"] = "decline_purchase"


# --- Auction ---------------------------------------------------------------


class PlaceBid(_CommandBase):
    kind: Literal["place_bid"] = "place_bid"
    amount: int = Field(gt=0)


class WithdrawFromAuction(_CommandBase):
    kind: Literal["withdraw_from_auction"] = "withdraw_from_auction"


# --- Development -----------------------------------------------------------


class BuildHouse(_CommandBase):
    """Build one house (or the hotel, on the fifth) on ``tile``."""

    kind: Literal["build_house"] = "build_house"
    tile: TileIndex


class SellHouse(_CommandBase):
    """Sell one house back to the bank at half the build cost."""

    kind: Literal["sell_house"] = "sell_house"
    tile: TileIndex


class MortgageProperty(_CommandBase):
    kind: Literal["mortgage_property"] = "mortgage_property"
    tile: TileIndex


class UnmortgageProperty(_CommandBase):
    kind: Literal["unmortgage_property"] = "unmortgage_property"
    tile: TileIndex


# --- Trading ---------------------------------------------------------------


class TradeSide(BaseModel, frozen=True):
    """What one party puts on the table."""

    cash: int = Field(default=0, ge=0)
    tiles: tuple[TileIndex, ...] = ()
    jail_cards: int = Field(default=0, ge=0)


class TradeOffer(BaseModel, frozen=True):
    proposer: PlayerId
    recipient: PlayerId
    give: TradeSide
    """What the proposer hands over."""
    receive: TradeSide
    """What the proposer asks for in return."""


class ProposeTrade(_CommandBase):
    kind: Literal["propose_trade"] = "propose_trade"
    offer: TradeOffer


class RespondToTrade(_CommandBase):
    kind: Literal["respond_to_trade"] = "respond_to_trade"
    accept: bool


class CancelTrade(_CommandBase):
    kind: Literal["cancel_trade"] = "cancel_trade"


# --- Jail ------------------------------------------------------------------


class PayJailFine(_CommandBase):
    kind: Literal["pay_jail_fine"] = "pay_jail_fine"


class UseJailCard(_CommandBase):
    kind: Literal["use_jail_card"] = "use_jail_card"


class RollForJail(_CommandBase):
    """Attempt to roll doubles to leave jail."""

    kind: Literal["roll_for_jail"] = "roll_for_jail"


# --- Insolvency ------------------------------------------------------------


class DeclareBankruptcy(_CommandBase):
    """Concede that the debt in ``pending_debt`` cannot be met."""

    kind: Literal["declare_bankruptcy"] = "declare_bankruptcy"


Command = Annotated[
    RollDice
    | EndTurn
    | BuyProperty
    | DeclinePurchase
    | PlaceBid
    | WithdrawFromAuction
    | BuildHouse
    | SellHouse
    | MortgageProperty
    | UnmortgageProperty
    | ProposeTrade
    | RespondToTrade
    | CancelTrade
    | PayJailFine
    | UseJailCard
    | RollForJail
    | DeclareBankruptcy,
    Field(discriminator="kind"),
]
