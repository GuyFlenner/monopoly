"""GameState — the entire game, as one serializable value.

Everything needed to resume a game lives here, including the RNG. There is no hidden
state anywhere: no module globals, no caches that matter, no clock. Two consequences
worth naming, because they are the whole reason for the design:

* ``model_dump_json()`` is a complete save file, and ``model_validate_json()`` a complete
  load. Save/load needed no extra code.
* A bot can copy the state, play a hundred hypothetical turns through ``apply()``, and
  throw the copies away without touching the real game.

The state is frozen. ``apply()`` returns a new one.

Two shapes here carry most of the design weight:

**Interrupts are a stack, not a scalar (ADR-007).** An auction, a debt, a trade review or
a half-finished card is a :class:`AuctionFrame` / :class:`DebtFrame` / :class:`TradeFrame`
/ :class:`CardFrame` pushed onto :attr:`GameState.interrupts`, each carrying the phase to
resume when it pops. The specced rules nest these three deep — a card sends a player to
rent they cannot pay, and they trade to raise the cash — so a single nullable slot per kind
could not express the game, and nothing recorded where to return to.

**Nothing is stored that the board and the ruleset already imply.** The building stock is
derived (:attr:`GameState.houses_remaining`), the withdrawn bidders are derived
(:attr:`AuctionFrame.withdrawn`), and a validator cross-checks every property against the
board rather than trusting the caller. A field that can disagree with another field
eventually will.
"""

from __future__ import annotations

from typing import Annotated, Any, Final, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from kesef_engine.board.loader import load_board
from kesef_engine.board.models import BOARD_SIZE, Board, ColorGroup, TileKind
from kesef_engine.commands import TradeOffer
from kesef_engine.phases import Phase
from kesef_engine.primitives import (
    AuctionReason,
    BotLevel,
    CashReason,
    Deck,
    Lot,
    PlayerId,
    TileIndex,
)
from kesef_engine.ruleset import Ruleset

SCHEMA_VERSION: Final = 2
"""The save-file shape. Bumped to 2 by ADR-007; enforced, not merely documented."""

MIN_PLAYERS = 2
MAX_PLAYERS = 6
HOTEL_LEVEL = 5
"""``PropertyState.houses == 5`` means a hotel stands on the tile."""

DIE_FACES = 6


class PlayerKind(BaseModel, frozen=True):
    """Whether a seat is driven by a person or by a bot, and how strong the bot is.

    ``bot_level`` is the only field: a separate ``is_bot`` flag was a second, independently
    settable source of the same truth, and ``bot_level: str`` accepted ``"banana"``
    (GAP G-19).
    """

    bot_level: BotLevel | None = None
    """None for humans."""

    @property
    def is_bot(self) -> bool:
        return self.bot_level is not None


class PlayerState(BaseModel, frozen=True):
    id: PlayerId = Field(ge=0)
    """Stable identity. Not an index into ``GameState.players`` — see ``PlayerId``."""
    name: str = Field(min_length=1, max_length=24)
    """The one piece of free text in the engine — a player typed it, so it is not a key."""
    kind: PlayerKind
    token: str = Field(min_length=1)
    """Asset key for the pawn, e.g. ``token.dog``."""
    cash: int = Field(default=0, ge=0)
    """Never negative. What a player cannot pay lives in a :class:`DebtFrame` instead —
    the shortfall-as-data model (GAP G-18)."""
    position: TileIndex = Field(default=0, ge=0, lt=BOARD_SIZE)
    in_jail: bool = False
    jail_turns: int = Field(default=0, ge=0)
    jail_cards: tuple[Deck, ...] = ()
    """*Which* get-out-of-jail cards are held, not how many: a used card returns to the
    bottom of its own deck, and a count cannot say which deck that is (GAP G-11)."""
    bankrupt: bool = False
    grammatical_gender: Literal["m", "f", "n"] = "n"
    """Hebrew conjugates verbs by the subject's gender, so "you rolled" needs to know.
    Chosen per seat at setup; ``"n"`` is the neutral fallback (owner decision 5)."""

    @model_validator(mode="after")
    def _check(self) -> Self:
        if len(set(self.jail_cards)) != len(self.jail_cards):
            raise ValueError(f"player {self.id} holds the same deck's jail card twice")
        if self.bankrupt and (self.in_jail or self.jail_cards):
            raise ValueError(f"bankrupt player {self.id} cannot be in jail or hold jail cards")
        return self


class PropertyState(BaseModel, frozen=True):
    """Ownership and development of one tile. Index-aligned with ``Board.tiles``."""

    owner: PlayerId | None = None
    houses: int = Field(default=0, ge=0, le=HOTEL_LEVEL)
    mortgaged: bool = False

    @model_validator(mode="after")
    def _check(self) -> Self:
        if self.mortgaged and self.houses:
            raise ValueError("a mortgaged property cannot carry buildings")
        if self.owner is None and (self.houses or self.mortgaged):
            raise ValueError("an unowned tile cannot be mortgaged or built on")
        return self


class DiceState(BaseModel, frozen=True):
    """The last roll. ``purpose`` matters: a card-driven utility rent roll is not a move,
    and a roll for doubles out of jail moves the token without granting another turn.
    Conflating the three made ``is_doubles`` lie (GAP G-10)."""

    first: int = Field(ge=1, le=DIE_FACES)
    second: int = Field(ge=1, le=DIE_FACES)
    purpose: Literal["move", "jail", "rent"] = "move"

    @property
    def total(self) -> int:
        return self.first + self.second

    @property
    def is_doubles(self) -> bool:
        return self.first == self.second


# --- Interrupt frames (ADR-007) ---------------------------------------------


class _FrameBase(BaseModel):
    model_config = ConfigDict(frozen=True)

    resume: Phase
    """The phase to return to when this frame pops. This field is the whole point of the
    stack: without it a saved game cannot resume mid-interrupt."""


class AuctionFrame(_FrameBase):
    """A live auction.

    The lot is a :class:`~kesef_engine.primitives.TileLot` or
    :class:`~kesef_engine.primitives.BuildingLot` rather than a tile index, because the
    building-shortage rule auctions a *house*; ``queue`` holds the rest of an estate being
    liquidated after a bankruptcy to the bank (GAP G-3).
    """

    kind: Literal["auction"] = "auction"
    lot: Lot
    reason: AuctionReason
    eligible: tuple[PlayerId, ...]
    """Bidding order, stored. It used to exist only on the ``AuctionStarted`` event and was
    therefore lost on reload."""
    active: tuple[PlayerId, ...] = ()
    """Those who have not withdrawn, in bidding order."""
    turn: PlayerId | None = None
    """Whose turn it is to bid. None between lots."""
    high_bid: int = Field(default=0, ge=0)
    high_bidder: PlayerId | None = None
    min_bid: int = Field(default=1, ge=1)
    """The smallest acceptable *next* bid."""
    max_bid: Annotated[int, Field(ge=1)] | None = None
    """A ceiling, when a variant imposes one. None means unbounded."""
    queue: tuple[Lot, ...] = ()
    """Lots still to be auctioned after this one, in order."""

    @property
    def withdrawn(self) -> tuple[PlayerId, ...]:
        """Derived, so it cannot disagree with ``active``."""
        return tuple(player for player in self.eligible if player not in self.active)

    @model_validator(mode="after")
    def _check(self) -> Self:
        if len(set(self.eligible)) != len(self.eligible):
            raise ValueError("duplicate bidders in the eligible order")
        if len(set(self.active)) != len(self.active):
            raise ValueError("duplicate bidders in the active order")
        if not set(self.active) <= set(self.eligible):
            raise ValueError("an active bidder is not eligible")
        if self.turn is not None and self.turn not in self.active:
            raise ValueError("the bidding turn belongs to a bidder who is not active")
        if (self.high_bid > 0) != (self.high_bidder is not None):
            raise ValueError("high_bid and high_bidder must be set together")
        if self.high_bidder is not None and self.high_bidder not in self.eligible:
            raise ValueError("the high bidder is not eligible")
        if self.max_bid is not None and self.max_bid < self.min_bid:
            raise ValueError("max_bid is below min_bid")
        return self

    def player_ids(self) -> frozenset[PlayerId]:
        bidders = set(self.eligible) | set(self.active)
        if self.high_bidder is not None:
            bidders.add(self.high_bidder)
        if self.turn is not None:
            bidders.add(self.turn)
        return frozenset(bidders)


class Obligation(BaseModel, frozen=True):
    """One creditor's share of a debt. The bank is named, not a ``None`` sentinel."""

    creditor: PlayerId | Literal["bank"]
    amount: int = Field(gt=0)


class DebtFrame(_FrameBase):
    """What one player owes and cannot currently pay in cash.

    ``obligations`` is plural because "pay each player ₪50" creates one debt with up to
    five creditors (GAP G-7). Semantics are shortfall-as-data: cash never goes negative,
    and the outstanding gross lives here.
    """

    kind: Literal["debt"] = "debt"
    debtor: PlayerId
    obligations: tuple[Obligation, ...] = Field(min_length=1)
    reason: CashReason
    """What triggered the debt — rent, tax, a card, a mortgage transfer fee."""
    source_tile: Annotated[TileIndex, Field(ge=0, lt=BOARD_SIZE)] | None = None
    """The tile that caused it, when there was one. Narration and audit only."""

    @property
    def total(self) -> int:
        return sum(obligation.amount for obligation in self.obligations)

    @property
    def creditors(self) -> tuple[PlayerId | Literal["bank"], ...]:
        return tuple(obligation.creditor for obligation in self.obligations)

    @model_validator(mode="after")
    def _check(self) -> Self:
        if self.debtor in self.creditors:
            raise ValueError("the debtor cannot be one of their own creditors")
        return self

    def player_ids(self) -> frozenset[PlayerId]:
        parties = {self.debtor}
        parties.update(creditor for creditor in self.creditors if creditor != "bank")
        return frozenset(parties)


class TradeFrame(_FrameBase):
    """A proposed trade awaiting the recipient's answer."""

    kind: Literal["trade"] = "trade"
    offer: TradeOffer

    def player_ids(self) -> frozenset[PlayerId]:
        return frozenset({self.offer.proposer, self.offer.recipient})


class CardFrame(_FrameBase):
    """A drawn card that has not finished resolving.

    ``step`` is what makes "advance to the nearest utility, then pay ten times the dice"
    resumable when the payment opens a debt halfway through (GAP G-9).
    """

    kind: Literal["card"] = "card"
    card_id: str = Field(min_length=1)
    """i18n key for the card text, e.g. ``card.chance.advance_to_go``."""
    deck: Deck
    step: int = Field(default=0, ge=0)
    """How much of the card's effect has already been applied."""

    def player_ids(self) -> frozenset[PlayerId]:
        return frozenset()


InterruptFrame = Annotated[AuctionFrame | DebtFrame | TradeFrame | CardFrame, Field(discriminator="kind")]

PHASE_OF_FRAME: Final[dict[str, Phase]] = {
    "auction": Phase.AUCTION,
    "debt": Phase.DEBT_SETTLEMENT,
    "trade": Phase.TRADE_REVIEW,
    "card": Phase.CARD_RESOLUTION,
}
"""Which phase each frame kind puts the game in while it is the live interrupt.

A validator enforces this in both directions, which is what keeps ``phase`` — the UI's
single "what is happening" signal — from drifting away from the stack.
"""

FRAME_PHASES: Final = frozenset(PHASE_OF_FRAME.values())


class GameState(BaseModel, frozen=True):
    """A complete game. See the module docstring for why this is one flat value."""

    schema_version: int = SCHEMA_VERSION
    """Checked on load, so an old save file fails loudly instead of half-working."""

    game_id: str = Field(min_length=1)
    board_id: str = Field(min_length=1)
    ruleset: Ruleset
    locale: str = "en"
    """The UI's starting language. The engine itself never reads it — it emits keys."""

    rng: Rng  # noqa: F821  (forward ref resolved below)
    players: tuple[PlayerState, ...]
    """Seating order. Turn order walks this tuple; identity is ``PlayerState.id``."""
    properties: tuple[PropertyState, ...]
    """Always ``BOARD_SIZE`` long and index-aligned with the board, including the tiles
    that can never be owned. Wasting 12 slots buys O(1) lookup with no index arithmetic."""

    phase: Phase = Phase.AWAITING_ROLL
    current_player_id: PlayerId = Field(ge=0)
    """Whose turn it is, by id. Commands and events identify players by id, so the state
    does too; an index would have to be kept in step with a tuple that outlives seats."""
    dice: DiceState | None = None
    doubles_streak: int = Field(default=0, ge=0)
    """Consecutive doubles this turn. Three sends the player to jail. It belongs to the
    turn, not to a roll — a card-driven rent roll must not reset it (GAP G-10)."""
    turn_number: int = Field(default=1, ge=1)
    """Counts *player* turns, not rounds: it increases every time a seat is handed on."""

    interrupts: tuple[InterruptFrame, ...] = ()
    """The interrupt stack, outermost first. The last entry is live (ADR-007)."""

    chance_deck: tuple[str, ...] = ()
    community_chest_deck: tuple[str, ...] = ()
    """Card ids in draw order; a drawn card returns to the bottom."""

    free_parking_pot: int = Field(default=0, ge=0)
    """Money resting on Free Parking. Only ever non-zero under the house rule
    ``Ruleset.free_parking_pot_enabled``."""
    elapsed_seconds: int = Field(default=0, ge=0)
    """Wall-clock seconds, stamped by the caller through ``EndTurn`` (GAP G-6). The engine
    reads it to decide whether Kids Mode's time limit has been reached; it never sets it
    from a clock of its own."""
    elimination_order: tuple[PlayerId, ...] = ()
    """Bankrupt players, earliest first. Without it every bankrupt player ties at zero
    net worth and the final standings cannot be ranked."""
    winner: PlayerId | None = None

    # --- Validation ---------------------------------------------------------

    @model_validator(mode="after")
    def _check_schema_version(self) -> Self:
        if self.schema_version != SCHEMA_VERSION:
            # The one validation failure a *player* can cause, by loading yesterday's save
            # file — so it gets an i18n key. The rest are programmer errors and read as
            # developer prose.
            raise ValueError("error.save_schema_mismatch")
        return self

    @model_validator(mode="after")
    def _check_players(self) -> Self:
        if not MIN_PLAYERS <= len(self.players) <= MAX_PLAYERS:
            raise ValueError(f"a game needs {MIN_PLAYERS}-{MAX_PLAYERS} players, got {len(self.players)}")
        ids = [player.id for player in self.players]
        if len(set(ids)) != len(ids):
            raise ValueError("duplicate player ids")
        names = [player.name.casefold() for player in self.players]
        if len(set(names)) != len(names):
            raise ValueError("duplicate player names")
        tokens = [player.token for player in self.players]
        if len(set(tokens)) != len(tokens):
            raise ValueError("duplicate player tokens")
        held = [card for player in self.players for card in player.jail_cards]
        if len(set(held)) != len(held):
            raise ValueError("two players hold the same deck's jail card")
        return self

    @model_validator(mode="after")
    def _check_properties(self) -> Self:
        if len(self.properties) != BOARD_SIZE:
            raise ValueError(f"properties must be {BOARD_SIZE} long, got {len(self.properties)}")
        seated = {player.id for player in self.players}
        for index, prop in enumerate(self.properties):
            tile = self.board.tile(index)
            if prop.owner is not None:
                if not tile.is_ownable:
                    raise ValueError(f"tile {index} ({tile.kind}) cannot be owned")
                if prop.owner not in seated:
                    raise ValueError(f"tile {index} has an unknown owner {prop.owner}")
            if prop.houses and tile.kind is not TileKind.PROPERTY:
                raise ValueError(f"tile {index} ({tile.kind}) cannot hold buildings")
        if self.houses_remaining < 0:
            raise ValueError(f"the board holds more houses than the bank owns ({self.ruleset.houses_available})")
        if self.hotels_remaining < 0:
            raise ValueError(f"the board holds more hotels than the bank owns ({self.ruleset.hotels_available})")
        return self

    @model_validator(mode="after")
    def _check_turn(self) -> Self:
        if self.current_player_id not in {player.id for player in self.players}:
            raise ValueError(f"current_player_id {self.current_player_id} is not seated")
        return self

    @model_validator(mode="after")
    def _check_interrupts(self) -> Self:
        """``phase`` and the live frame are one fact, so they are checked against each other."""
        live = self.interrupts[-1] if self.interrupts else None
        if live is None:
            if self.phase in FRAME_PHASES:
                raise ValueError(f"phase {self.phase} requires a live interrupt frame, but the stack is empty")
        else:
            expected = PHASE_OF_FRAME[live.kind]
            if self.phase is not expected:
                raise ValueError(f"phase {self.phase} contradicts the live {live.kind} interrupt (expected {expected})")
        seated = {player.id for player in self.players}
        bankrupt = {player.id for player in self.players if player.bankrupt}
        for frame in self.interrupts:
            unknown = frame.player_ids() - seated
            if unknown:
                raise ValueError(f"{frame.kind} interrupt names unknown player(s) {sorted(unknown)}")
            # Two cross-frame invariants that need a player's cash or solvency, so they
            # cannot live on the frames themselves. Both were previously enforced nowhere
            # and merely asserted in a generator comment, which is not enforcement.
            if isinstance(frame, AuctionFrame) and frame.high_bidder is not None:
                # A bid is capped by cash at placement and a high bidder only *gains* cash
                # while an auction runs, so an unaffordable standing bid could not be
                # awarded: it would break the ledger's ge=0 backstop instead.
                available = self.player(frame.high_bidder).cash
                if frame.high_bid > available:
                    raise ValueError(
                        f"auction high_bid {frame.high_bid} exceeds high bidder {frame.high_bidder}'s "
                        f"cash ({available})"
                    )
            if isinstance(frame, DebtFrame):
                # A bankrupt player's claims are settled or voided as they leave the game
                # (MON-207), so a creditor is always a solvent player or the bank.
                insolvent = sorted(
                    creditor for creditor in frame.creditors if creditor != "bank" and creditor in bankrupt
                )
                if insolvent:
                    raise ValueError(f"debt names bankrupt creditor(s) {insolvent}")
        return self

    @model_validator(mode="after")
    def _check_endgame(self) -> Self:
        seated = {player.id for player in self.players}
        bankrupt = {player.id for player in self.players if player.bankrupt}
        if len(set(self.elimination_order)) != len(self.elimination_order):
            raise ValueError("duplicate entries in elimination_order")
        if not set(self.elimination_order) <= bankrupt:
            raise ValueError("elimination_order names a player who is not bankrupt")
        if self.winner is not None:
            if self.winner not in seated:
                raise ValueError(f"winner {self.winner} is not seated")
            if self.winner in bankrupt:
                raise ValueError(f"winner {self.winner} is bankrupt")
            if self.phase is not Phase.GAME_OVER:
                raise ValueError("a winner exists, so the phase must be GAME_OVER")
        elif self.phase is Phase.GAME_OVER and self.solvent_players:
            raise ValueError("GAME_OVER with no winner and surviving players is unresolved")
        return self

    # --- Derived views ------------------------------------------------------

    @property
    def board(self) -> Board:
        """The board layout. ``load_board`` is cached, so this is cheap to call."""
        return load_board(self.board_id)

    @property
    def current_seat_index(self) -> int:
        """Where the current player sits. Turn advance walks from here."""
        return next(index for index, player in enumerate(self.players) if player.id == self.current_player_id)

    @property
    def current_player(self) -> PlayerState:
        return self.player(self.current_player_id)

    def player(self, player_id: PlayerId) -> PlayerState:
        for candidate in self.players:
            if candidate.id == player_id:
                return candidate
        raise KeyError(player_id)

    @property
    def solvent_players(self) -> tuple[PlayerState, ...]:
        return tuple(player for player in self.players if not player.bankrupt)

    # --- Interrupts ---------------------------------------------------------

    @property
    def top_interrupt(self) -> InterruptFrame | None:
        """The live interrupt — the one whose commands are legal right now."""
        return self.interrupts[-1] if self.interrupts else None

    @property
    def auction(self) -> AuctionFrame | None:
        """The innermost auction, live or suspended. Read convenience only: what may be
        *done* is decided by :attr:`top_interrupt`."""
        return self._innermost(AuctionFrame)

    @property
    def pending_debt(self) -> DebtFrame | None:
        return self._innermost(DebtFrame)

    @property
    def pending_trade(self) -> TradeFrame | None:
        return self._innermost(TradeFrame)

    @property
    def pending_card(self) -> CardFrame | None:
        """A card that has not finished resolving — the UI keeps it face-up while a debt
        dialog sits on top of it (GAP G-9)."""
        return self._innermost(CardFrame)

    def _innermost[FrameT: (AuctionFrame, DebtFrame, TradeFrame, CardFrame)](
        self, frame_type: type[FrameT]
    ) -> FrameT | None:
        for frame in reversed(self.interrupts):
            if isinstance(frame, frame_type):
                return frame
        return None

    def push_interrupt(self, frame: InterruptFrame) -> GameState:
        """Suspend the current phase and make ``frame`` the live interrupt.

        The frame's ``resume`` is overwritten with the phase being suspended, so a caller
        cannot push a frame that returns to somewhere the game never was.
        """
        suspended = frame.model_copy(update={"resume": self.phase})
        return self._replace(interrupts=(*self.interrupts, suspended), phase=PHASE_OF_FRAME[suspended.kind])

    def pop_interrupt(self) -> GameState:
        """Finish the live interrupt and return to the phase it suspended."""
        live = self.top_interrupt
        if live is None:
            raise ValueError("no interrupt to pop")
        return self._replace(interrupts=self.interrupts[:-1], phase=live.resume)

    def _replace(self, **changes: Any) -> GameState:
        """A validated copy. ``model_copy`` skips validators, which would let these
        helpers build a state that no save file could restore."""
        merged: dict[str, Any] = dict(self) | changes
        return GameState(**merged)

    # --- Board and portfolio queries ----------------------------------------

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

    @property
    def houses_on_board(self) -> int:
        """Houses the bank has handed out. A hotel is not four houses — the houses go back."""
        return sum(prop.houses for prop in self.properties if 0 < prop.houses < HOTEL_LEVEL)

    @property
    def hotels_on_board(self) -> int:
        return sum(1 for prop in self.properties if prop.houses == HOTEL_LEVEL)

    @property
    def houses_remaining(self) -> int:
        """The bank's stock, derived. Storing it let a custom ruleset be silently
        contradicted by a stale default of 32 (GAP G-19)."""
        return self.ruleset.houses_available - self.houses_on_board

    @property
    def hotels_remaining(self) -> int:
        return self.ruleset.hotels_available - self.hotels_on_board

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
