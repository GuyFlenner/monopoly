"""Events — what happened, in order.

``apply()`` returns the new state *and* the events that produced it. The state tells the
UI what to draw; the events tell it what to *animate* and narrate. A client that only
diffs states would know the token is on Boardwalk but not that it passed GO on the way.

Events are also the audit trail: appended to a log, they reconstruct a whole game, which
is what makes the golden-game regression tests possible.

**Every event is self-contained** (ADR-008 §3). An event carries every number its
catalogue sentence needs in either language, because the log is *history*: a line rendered
by looking up current state shows turn-20 figures against a turn-3 entry. That is why
``RentCharged`` carries the base rent, the house count and the multiplier rather than a
tile index the renderer would have to re-price.

Like everything else in the engine, events carry keys and numbers, never sentences.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from kesef_engine.board.models import ColorGroup
from kesef_engine.commands import TradeOffer
from kesef_engine.phases import Phase
from kesef_engine.primitives import (
    AuctionReason,
    BuildingLevel,
    CashReason,
    Deck,
    Lot,
    PlayerId,
    TileIndex,
)

Counterparty = PlayerId | Literal["bank", "free_parking_pot"]
"""Who the money came from or went to. Named explicitly rather than ``None``-as-bank: the
Free Parking pot is a third party, and the money-conservation test has to tell it from the
bank to balance (GAP G-60)."""

Creditor = PlayerId | Literal["bank"]
"""Who is owed. The bank is a party, not a missing value."""


class _EventBase(BaseModel):
    model_config = ConfigDict(frozen=True)


class TurnStarted(_EventBase):
    type: Literal["turn_started"] = "turn_started"
    player: PlayerId
    turn_number: int = Field(ge=1)


class DiceRolled(_EventBase):
    type: Literal["dice_rolled"] = "dice_rolled"
    player: PlayerId
    first: int = Field(ge=1, le=6)
    second: int = Field(ge=1, le=6)
    total: int
    """Carried, not derived by the client — an event must narrate itself (ADR-008 §3)."""
    doubles_streak: int = Field(default=0, ge=0)
    purpose: Literal["move", "jail", "rent"] = "move"
    """Mirrors ``DiceState.purpose``: a utility rent roll is not a move and must not be
    animated or narrated as one (GAP G-10)."""

    @model_validator(mode="after")
    def _check(self) -> Self:
        if self.total != self.first + self.second:
            raise ValueError("total does not match the dice")
        return self


class TokenMoved(_EventBase):
    type: Literal["token_moved"] = "token_moved"
    player: PlayerId
    from_tile: TileIndex
    to_tile: TileIndex
    forward: bool = True
    """False for the 'go back three spaces' card — the UI must animate backwards."""
    passed_go: bool = False


class CashChanged(_EventBase):
    """The single ledger entry. Every movement of money is exactly one of these."""

    type: Literal["cash_changed"] = "cash_changed"
    player: PlayerId
    delta: int
    reason: CashReason
    balance: int = Field(ge=0)
    counterparty: Counterparty = "bank"


class RentQuote(BaseModel):
    """What a square charges, before anybody has landed on it (MON-420).

    ``RentCharged`` is this shape plus *who paid*, and that is enforced structurally: the event
    inherits from here. Before MON-420 the multipliers lived only inside
    ``rules.rent._property_rent``, so the "explain this rent" affordance on the board and in the
    dossier had nothing to render and the UI's only options were to say nothing or to re-derive
    the tier ladder in TypeScript. One shape means the sentence a player reads *before* deciding
    is assembled from the same ``rent.note.*`` keys as the one they read in the log afterwards.

    **A utility quote carries no amount.** Its rent is a multiple of a throw that has not
    happened, so ``amount`` and ``dice_total`` are both ``None`` and ``multiplier`` carries the
    figure the throw will be multiplied by — which is what ``rent.note.utility_quote`` says. An
    invented amount (the last roll's, or the average) would be a number the engine cannot stand
    behind, and is exactly the sort of plausible fiction the log's self-containment rule exists
    to prevent.
    """

    model_config = ConfigDict(frozen=True)

    owner: PlayerId
    tile: TileIndex
    amount: int | None = Field(default=None, ge=0)
    """What is owed. ``None`` only on a utility quote — see the class docstring."""
    base_rent: int = Field(default=0, ge=0)
    """The tier's printed rent, before any multiplier. 0 on a utility quote, whose base is the
    throw."""
    houses: int = Field(default=0, ge=0, le=5)
    """Buildings standing. 5 means a hotel."""
    multiplier: int = Field(default=1, ge=1)
    """2 for an undeveloped full group; 4 or 10 for a utility."""
    dice_total: int | None = None
    """The roll a utility's rent was multiplied by. None for everything else, and for a quote."""
    group: ColorGroup | None = None
    note_keys: tuple[str, ...] = ()
    """i18n keys explaining the maths, e.g. ``rent.note.full_group_doubled``."""
    note_params: Mapping[str, int | str] = Field(default_factory=dict)
    """Interpolation values for ``note_keys``. Keys and numbers only — never a sentence.

    A param whose name ends in ``_key`` carries an i18n key rather than a value, which is how
    ``rent.note.full_group_doubled`` names a colour group without shipping the enum's English
    identifier into a Hebrew sentence (MON-415).

    MON-741: ``frozen=True`` blocks rebinding this field and the ``Mapping`` annotation blocks
    typed mutation under ``mypy``, but the underlying dict's ``__setitem__`` remains physically
    callable at runtime — that residual hole is closed by review, not by the type system."""


class RentCharged(RentQuote):
    """Narration for a rent payment. The money itself moves in ``CashChanged``.

    Everything needed to *explain* the figure is here, because "every rent figure can be
    explained, not merely charged" is a product gate and the explanation must survive in
    the log after the board has changed underneath it.

    The explanation is inherited rather than restated: see :class:`RentQuote`.
    """

    type: Literal["rent_charged"] = "rent_charged"
    payer: PlayerId
    amount: int = Field(ge=0)
    """Narrowed from the quote's optional: a charge that happened has a figure. The utility
    caveat belongs to the quote alone, because charging one rolls for it."""


class PropertyAcquired(_EventBase):
    type: Literal["property_acquired"] = "property_acquired"
    player: PlayerId
    tile: TileIndex
    price: int = Field(ge=0)
    via: Literal["purchase", "auction", "trade", "bankruptcy"]


class AuctionStarted(_EventBase):
    type: Literal["auction_started"] = "auction_started"
    lot: Lot
    """A tile or a building — a building-shortage auction has no tile to name (GAP G-3)."""
    reason: AuctionReason
    eligible: tuple[PlayerId, ...]


class BidPlaced(_EventBase):
    type: Literal["bid_placed"] = "bid_placed"
    player: PlayerId
    amount: int = Field(gt=0)


class BidderWithdrew(_EventBase):
    type: Literal["bidder_withdrew"] = "bidder_withdrew"
    player: PlayerId


class AuctionEnded(_EventBase):
    type: Literal["auction_ended"] = "auction_ended"
    lot: Lot
    winner: PlayerId | None = None
    """None when every player withdrew: the property stays with the bank."""
    price: int = Field(default=0, ge=0)


class CardDrawn(_EventBase):
    type: Literal["card_drawn"] = "card_drawn"
    player: PlayerId
    deck: Deck
    card_id: str = Field(min_length=1)
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
    houses: int = Field(ge=0, le=5)
    """0-4 houses, 5 means a hotel."""
    delta: int
    level: BuildingLevel
    """Which building went up or came down (MON-413).

    Carried because "the fifth house is a hotel" is a rule, and a client that read it off
    ``houses == 5`` would be holding a copy of that rule in TypeScript — so before this field the
    log could only say "a building", which is the one thing a six-year-old watching a hotel go up
    does not want to be told. ``houses`` and ``delta`` still say how many stand and how many
    moved; this says *what* moved.
    """


class MortgageChanged(_EventBase):
    type: Literal["mortgage_changed"] = "mortgage_changed"
    player: PlayerId
    """Who mortgaged or paid it off (MON-414). Without it the log had no subject and rendered in
    the passive voice — "Boardwalk was mortgaged" — which in a six-seat game says nothing about
    the fact a reader wants, and reads worse in Hebrew than in English."""
    tile: TileIndex
    mortgaged: bool


class TradeProposed(_EventBase):
    """Without this the WebSocket stream never carried the offer, so a replay could not
    reconstruct the pending trade (GAP G-16)."""

    type: Literal["trade_proposed"] = "trade_proposed"
    offer: TradeOffer


class TradeExecuted(_EventBase):
    type: Literal["trade_executed"] = "trade_executed"
    offer: TradeOffer


class TradeDeclined(_EventBase):
    type: Literal["trade_declined"] = "trade_declined"
    offer: TradeOffer


class TradeCancelled(_EventBase):
    type: Literal["trade_cancelled"] = "trade_cancelled"
    offer: TradeOffer
    by: Literal["proposer", "system"] = "proposer"
    """``system`` when the engine voided it — a party went bankrupt, or a named holding
    changed hands before the recipient answered."""


class DebtIncurred(_EventBase):
    type: Literal["debt_incurred"] = "debt_incurred"
    debtor: PlayerId
    creditor: Creditor
    amount: int = Field(gt=0)
    """The outstanding gross. The shortfall against cash is derivable, and carrying both
    implied two opposite debt models (GAP G-18)."""


class DebtSettled(_EventBase):
    type: Literal["debt_settled"] = "debt_settled"
    debtor: PlayerId
    creditor: Creditor
    amount: int = Field(gt=0)


class BankruptcyShare(BaseModel, frozen=True):
    """One creditor's slice of a bankrupt estate, divided proportionally to claim (G-7).

    Part of :class:`PlayerBankrupted`, not an event of its own — the estate divides once,
    in one act, and a per-creditor event would invite a reader to treat the halves as
    independent.
    """

    creditor: Creditor
    claim: int = Field(gt=0)
    """What this creditor was owed. The divisor of their share."""
    cash: int = Field(default=0, ge=0)
    tiles: tuple[TileIndex, ...] = ()
    jail_cards: tuple[Deck, ...] = ()


class PlayerBankrupted(_EventBase):
    type: Literal["player_bankrupted"] = "player_bankrupted"
    player: PlayerId
    creditor: Creditor
    tiles_transferred: tuple[TileIndex, ...] = ()
    cash_transferred: int = Field(default=0, ge=0)
    jail_cards_transferred: tuple[Deck, ...] = ()
    """Named, so the cards land in the right deck when the recipient uses them (GAP G-11)."""
    shares: tuple[BankruptcyShare, ...] = ()
    """How the estate divided when there was more than one creditor (G-7). Empty in the
    ordinary case, where ``creditor`` and the three fields above are the whole story; when
    it is populated, ``creditor`` names the *principal* claim (the largest) and the shares
    carry the division."""


class PhaseChanged(_EventBase):
    type: Literal["phase_changed"] = "phase_changed"
    previous: Phase
    current: Phase


class PlayerStanding(BaseModel, frozen=True):
    """One line of the final table. Part of ``GameEnded``, not an event of its own."""

    player: PlayerId
    net_worth: int = Field(ge=0)
    rank: int = Field(ge=1)


class GameEnded(_EventBase):
    type: Literal["game_ended"] = "game_ended"
    winner: PlayerId | None = None
    """None only when nobody survived — reachable because the official mortgage transfer
    fee can cascade onto the creditor (GAP G-13)."""
    reason: Literal["last_solvent", "time_limit", "concession", "no_survivors"]
    final_standings: tuple[PlayerStanding, ...] = ()
    """Ranked, named and self-contained. A positional net-worth tuple could not say who
    was eliminated when, so every bankrupt player tied at zero."""

    @model_validator(mode="after")
    def _check(self) -> Self:
        if (self.winner is None) != (self.reason == "no_survivors"):
            raise ValueError("a winner is absent exactly when the reason is no_survivors")
        return self


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
    | TradeProposed
    | TradeExecuted
    | TradeDeclined
    | TradeCancelled
    | DebtIncurred
    | DebtSettled
    | PlayerBankrupted
    | PhaseChanged
    | GameEnded,
    Field(discriminator="type"),
]
