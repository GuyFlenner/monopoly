"""Commands — the only way to change a game.

Every command names its actor (``player``), and the engine verifies that this player is
entitled to act in the current phase. There is no other write path into ``GameState``.

Commands are a *closed* discriminated union so that adding one without handling it is a
type error rather than a runtime surprise.
"""

from __future__ import annotations

from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from kesef_engine.primitives import BOARD_SIZE, Deck, PlayerId, TileIndex


class _CommandBase(BaseModel):
    model_config = ConfigDict(frozen=True)

    player: PlayerId


# --- Turn flow -------------------------------------------------------------


class RollDice(_CommandBase):
    kind: Literal["roll_dice"] = "roll_dice"


class EndTurn(_CommandBase):
    kind: Literal["end_turn"] = "end_turn"
    elapsed_seconds: Annotated[int, Field(ge=0)] | None = None
    """Wall-clock seconds since the game began, stamped by the *caller*.

    The engine owns no clock (rule 3), but Kids Mode ends a game after
    ``Ruleset.target_duration_minutes``. Passing the time in with the one command that
    always closes a turn keeps the rule inside the engine and the clock outside it
    (GAP G-6). ``None`` means the caller is not keeping time.
    """


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
    tile: TileIndex = Field(ge=0, lt=BOARD_SIZE)


class SellHouse(_CommandBase):
    """Sell buildings back to the bank at half the build cost.

    One level at a time by default — a hotel becomes four houses, which the bank must be
    able to supply. ``demolish_hotel`` invokes the official "all buildings on one colour-
    group may be sold at once" clause instead, which is the only way off the board when
    the bank has run out of houses (GAP G-B3b, MON-201).
    """

    kind: Literal["sell_house"] = "sell_house"
    tile: TileIndex = Field(ge=0, lt=BOARD_SIZE)
    demolish_hotel: bool = False
    """Sell every building in ``tile``'s colour group at once. Requires a hotel on
    ``tile``. Selling the whole group rather than the one tile is what keeps even-build
    true coming down: a single hotel dropped to zero would leave its siblings five
    levels above it."""


class MortgageProperty(_CommandBase):
    kind: Literal["mortgage_property"] = "mortgage_property"
    tile: TileIndex = Field(ge=0, lt=BOARD_SIZE)


class UnmortgageProperty(_CommandBase):
    kind: Literal["unmortgage_property"] = "unmortgage_property"
    tile: TileIndex = Field(ge=0, lt=BOARD_SIZE)


# --- Trading ---------------------------------------------------------------


class TradeSide(BaseModel, frozen=True):
    """What one party puts on the table."""

    cash: int = Field(default=0, ge=0)
    tiles: tuple[TileIndex, ...] = ()
    jail_cards: tuple[Deck, ...] = ()
    """*Which* cards, not how many: a used card must go back to the bottom of its own
    deck, and a count cannot say which deck that is (GAP G-11)."""

    @model_validator(mode="after")
    def _check(self) -> Self:
        if len(set(self.tiles)) != len(self.tiles):
            raise ValueError("a trade side lists the same tile twice")
        if any(not 0 <= tile < BOARD_SIZE for tile in self.tiles):
            raise ValueError("a trade side lists a tile that is not on the board")
        if len(set(self.jail_cards)) != len(self.jail_cards):
            raise ValueError("a trade side lists the same jail card twice")
        return self


class TradeOffer(BaseModel, frozen=True):
    proposer: PlayerId
    recipient: PlayerId
    give: TradeSide
    """What the proposer hands over."""
    receive: TradeSide
    """What the proposer asks for in return."""

    @model_validator(mode="after")
    def _check(self) -> Self:
        if self.proposer == self.recipient:
            raise ValueError("proposer and recipient are the same player")
        return self


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
    """Concede that the debt in the live :class:`~kesef_engine.state.DebtFrame` cannot be met."""

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
