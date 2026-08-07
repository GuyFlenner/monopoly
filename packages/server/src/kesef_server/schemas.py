"""The HTTP contract — and, per ADR-008, the *projection*.

These models are the single source of truth for the frontend's types: CI generates
``packages/web/src/api/generated.ts`` from this app's OpenAPI schema, so a field renamed
here becomes a TypeScript error there rather than an undefined at runtime (MON-302).

**Why these are not the engine's models.** ``GameView`` used to embed ``GameState``
verbatim, which failed in both directions at once (ADR-008, GAP G-30..G-36):

* *Too little reached the wire.* Everything the UI needs in order to render is a
  ``@property``, and pydantic drops properties from ``model_dump`` and therefore from the
  OpenAPI document — the board itself, ``net_worth``, group completion, the dice total.
  Re-deriving those in TypeScript would put the valuation rule in the client, which is the
  ``if cash < rent`` defect this architecture exists to prevent, one layer up.
* *Too much reached the wire.* The RNG seed and the full deck order shipped with every
  poll: a cheat channel in devtools today and a real one when networked play lands.

So every field below is one of exactly two things, and never a third:

1. a **copy** of an engine field, or
2. a **promotion** of an engine-derived property (``state.net_worth(id)``,
   ``tile.is_ownable``, ``frame.withdrawn``).

No arithmetic and no conditional here decides anything about the game. If a field cannot be
written as one of those two, it is a rule and it belongs in the engine.
``packages/server/tests/test_projection.py`` checks the field-by-field parity mechanically,
so the engine cannot grow a field that quietly fails to reach the client.

The views are plain models that *copy*, rather than subclasses of the engine's models: a
subclass cannot declare a field whose name a parent already uses for a property, which is
precisely the set of names being promoted here. Copying costs a mapping function per model
and buys an explicit, greppable wire shape.

The full ``GameState`` is still reachable, at ``GET /games/{id}/save`` — the reducer's "the
JSON is the save file" property is kept, just no longer conflated with what a client may see.
"""

from __future__ import annotations

import re
from enum import StrEnum
from typing import Annotated, Literal, Self, assert_never

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from kesef_engine.board.models import Board, ColorGroup, Tile, TileKind
from kesef_engine.commands import Command, TradeOffer
from kesef_engine.events import Event, RentQuote
from kesef_engine.factory import Seat
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
from kesef_engine.ruleset import AuctionMinimum, Ruleset, RulesetName
from kesef_engine.state import (
    AuctionFrame,
    CardFrame,
    DebtFrame,
    DiceState,
    GameState,
    Obligation,
    PlayerKind,
    PlayerState,
    PropertyState,
    TradeFrame,
)

# --- Errors -----------------------------------------------------------------


class ErrorResponse(BaseModel):
    """Every failure this API reports, in one shape (GAP G-33).

    ``reason_key`` is an i18n key, never a sentence, and ``params`` carries the context the
    catalogue entry interpolates — which is what lets ``error.insufficient_funds`` say how
    much short. The engine's ``IllegalCommandError`` already carries both; before ADR-008
    the transport dropped the params on the floor.
    """

    reason_key: str = Field(examples=["error.not_your_turn"])
    params: dict[str, int | str] = {}


# --- Requests ---------------------------------------------------------------

GAME_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$"
"""What a ``game_id`` may contain, on every wire path that accepts one.

Constrained only by a length, a client could name a game ``kitchen/table``: ``POST /games``
answered 201, the game took one of ``max_sessions`` slots,
and it was then unreachable by ``GET``, ``POST``, ``%2F`` *or* ``DELETE``. ``"  "`` did the
same. So an unauthenticated client could wedge ``POST /games`` and ``POST /games/load`` at
503 permanently, with no recovery short of a restart (MON-303 security review).

The set here is exactly the set that survives a URL path segment intact. What is at stake is
the id's *addressability*, not its prettiness — this is a transport constraint, not a rule,
which is why it lives here and not in ``kesef_engine`` (the engine has no URLs).

**The leading character class is not decoration.** The review prescribed
``^[A-Za-z0-9_.-]{1,64}$``, which still admits ``.`` and ``..``, and a path segment is where
those two mean something else. Measured against the app: ``..`` created 201, then answered
404 to both ``GET`` and ``DELETE``; ``.`` created 201, answered 200 to ``GET`` and **405** to
``DELETE``. Both kept the slot forever, which is the whole of the finding. Requiring the first
character to be alphanumeric closes it without a lookahead — pydantic v2's default regex
engine is ``rust-regex``, which has none.
"""

_GAME_ID = re.compile(GAME_ID_PATTERN)

GameId = Annotated[str, Field(pattern=GAME_ID_PATTERN)]
"""A ``game_id`` as a request field. Rejected by pydantic, so the answer is the ordinary
``error.malformed_request`` naming the field."""


def is_addressable_game_id(game_id: str) -> bool:
    """Whether ``game_id`` satisfies :data:`GAME_ID_PATTERN`.

    ``POST /games/load`` takes its id from *inside* a ``GameState``, where it is not a request
    field and cannot carry a field constraint, so that route checks it by hand.
    """
    return _GAME_ID.fullmatch(game_id) is not None


class SeatConfig(BaseModel):
    """One seat at the table. A seat is either a person or a bot.

    ``is_bot`` stays on the *wire* even though the engine's ``PlayerKind`` derives it from
    ``bot_level``: a client that sends ``is_bot: true`` and forgets the level has made a
    mistake, and a 422 says so instead of silently seating a human.
    """

    name: str = Field(min_length=1, max_length=24)
    is_bot: bool = False
    bot_level: BotLevel | None = None
    token: str
    grammatical_gender: Literal["m", "f", "n"] = "n"
    """Hebrew conjugates verbs by the subject's gender, so the setup screen asks (owner
    decision 5, GAP G-42). ``"n"`` is the neutral fallback, never the masculine."""

    @model_validator(mode="after")
    def _check(self) -> Self:
        if self.is_bot and self.bot_level is None:
            raise ValueError("a bot seat needs a bot_level")
        if not self.is_bot and self.bot_level is not None:
            raise ValueError("a human seat must not carry a bot_level")
        return self

    def to_seat(self) -> Seat:
        """The engine's ``Seat`` — the one place the wire's shape meets the factory's.

        Replaces the ``player_kind`` property this model used to carry: with a real seating
        route (MON-301) there is one mapping from the wire's two fields onto the engine's
        one, and two ways to spell it is one too many.
        """
        return Seat(
            name=self.name,
            bot_level=self.bot_level,
            token=self.token,
            grammatical_gender=self.grammatical_gender,
        )


class HouseRules(BaseModel):
    """What this table has agreed to change about the rules it is playing (MON-712).

    Every field is optional and ``None`` means *leave the named rule set alone*, which is what makes
    this composable with Kids Mode: a kids game already has auctions off, and a house rule that said
    nothing about auctions must not turn them back on.

    ## Why the product's default lives in the client and not here

    The owner asked for auctions to be **off by default**, and the temptation is to spell that here,
    where every caller would inherit it. It is the wrong place. ``Ruleset.universal()`` is what this
    repository means by *correct* — the goldens replay against it and the invariant tests measure
    it — so a default that quietly diverged would make every one of them a record of a variant. The
    default belongs to whatever *decides which game to start*, which is the setup screen; the wire
    stays a faithful description of what was asked for.
    """

    model_config = ConfigDict(extra="forbid")

    auctions_enabled: bool | None = None
    """``False`` turns the declined-purchase auction off: the square simply stays with the bank."""
    auction_minimum: AuctionMinimum | None = None
    """The floor a lot opens at. See :class:`~kesef_engine.ruleset.AuctionMinimum`."""

    def applied_to(self, ruleset: Ruleset) -> Ruleset:
        """``ruleset`` with the stated amendments, and only the stated ones.

        ``model_copy`` rather than a constructor call, so a field this class does not mention keeps
        whatever the named rule set gave it. Validated afterwards, because ``model_copy`` skips
        validators by design and a frozen model is not the same thing as a checked one.
        """
        stated = self.model_dump(exclude_none=True)
        return Ruleset.model_validate({**ruleset.model_dump(), **stated}) if stated else ruleset


class NewGameRequest(BaseModel):
    seats: tuple[SeatConfig, ...]
    """Unconstrained on purpose, since MON-418: **how many players a game takes is a rule.**

    This field used to carry ``min_length=MIN_PLAYERS, max_length=MAX_PLAYERS``, and the effect was
    that removing a seat on the setup screen was answered with ``error.malformed_request`` and a
    field path — pydantic refused the body, so ``new_game`` never ran and the engine never got to
    say what was wrong. A parent was told the *form* was broken when the answer is "a game needs
    two players". The factory now raises keyed errors
    (:class:`~kesef_engine.errors.InvalidSeatingError`) and ``api.create_game`` forwards them, so
    the count is enforced in one place and explained in the player's language.

    Nothing is lost by dropping the ceiling: pydantic validated every item before checking
    ``max_length`` anyway, so the work an oversized body costs is unchanged.
    """
    board_id: str = "classic"
    ruleset: RulesetName = RulesetName.UNIVERSAL
    house_rules: HouseRules = HouseRules()
    """Per-game amendments to the named rule set (MON-712).

    Separate from ``ruleset`` because they answer different questions. The name says *which rules
    this is a variant of* — it is what Kids Mode is, and what the golden games are recorded
    against. House rules say what this table has agreed to do differently tonight, and a table that
    turns auctions off has not started playing Kids Mode.

    A closed set of fields rather than an open patch over ``Ruleset``: a client that could post any
    flag could post ``houses_available: 500`` and call it a house rule, and the engine's model would
    have become the wire format. Each field here is one the product actually offers a control for.
    """
    locale: str = "en"
    seed: int | None = None
    """None means the server picks one and returns it, so a game can be replayed."""
    game_id: GameId | None = None
    """None means the server names the game. A client may name it — to reserve a link, or
    to restore a save under its own id — and a name already in use is a 409 rather than a
    silent overwrite of somebody's live game. See :data:`GAME_ID_PATTERN` for why the
    character set is closed and not merely length-limited."""


class CommandRequest(BaseModel):
    command: Command


# --- The board projection ---------------------------------------------------


class TileView(BaseModel):
    """One square, plus the ownability the engine derives from its kind.

    ADR-008 says "``board: Board`` ships whole", which is *almost* enough: ``is_ownable``
    is a property, so pydantic drops it, and a client recomputing
    ``kind in {property, railroad, utility}`` has copied ``OWNABLE_KINDS`` — engine
    knowledge — into TypeScript. One promoted boolean is cheaper than that.
    """

    index: int
    kind: TileKind
    name_key: str
    group: ColorGroup | None = None
    price: int | None = None
    rent: tuple[int, ...] = ()
    house_cost: int | None = None
    mortgage: int | None = None
    tax: int | None = None
    is_ownable: bool

    @classmethod
    def from_tile(cls, tile: Tile) -> Self:
        return cls(**dict(tile), is_ownable=tile.is_ownable)


class BoardView(BaseModel):
    """The whole board: static per game, ~4 KB, and the reason a client can draw anything
    at all (G-30 — before ADR-008 no endpoint returned a single tile)."""

    id: str
    name_key: str
    tiles: tuple[TileView, ...]
    catalogue_ready: bool
    """Copied from the board data (MON-419). Shipped here as well as on ``BoardSummary`` because
    the parity contract is that every engine field reaches the wire; in a game already under way
    it is inert, since the picker is what filters on it."""
    go_to_jail_target: TileIndex
    """Promoted: where the GO_TO_JAIL tile sends a token. Finding it client-side means
    knowing that it is the JAIL tile's index, which is a rule."""

    @classmethod
    def from_board(cls, board: Board) -> Self:
        return cls(
            id=board.id,
            name_key=board.name_key,
            tiles=tuple(TileView.from_tile(tile) for tile in board.tiles),
            catalogue_ready=board.catalogue_ready,
            go_to_jail_target=board.go_to_jail_target,
        )


# --- The player projection --------------------------------------------------


class GroupHoldings(BaseModel):
    """One colour group as one player holds it (G-31/G-32) — a verbatim copy since MON-421.

    Every number used to be "a copy or an engine call", and three of the six were the second kind
    only in the sense that they were arithmetic *beside* an engine call: ``owned``, ``houses`` and
    ``mortgaged_count`` were computed here from ``state.properties``, which made this the third
    copy of the ``properties[i].owner == player`` predicate while ``complete`` came from the
    engine. Half a row from the rules and half from a loop next to them is how the two halves end
    up able to disagree.

    ``kesef_engine.state.GroupHoldings`` now answers all six, and this is the wire twin of it —
    declared rather than re-exported for the reason the module docstring gives: a view is a copy
    with an explicit, greppable shape, and ``test_projection.py`` checks the field-by-field parity
    mechanically.
    """

    group: ColorGroup
    owned: int = Field(ge=0)
    total: int = Field(ge=0)
    complete: bool
    houses: int = Field(ge=0)
    mortgaged_count: int = Field(ge=0)

    @classmethod
    def from_state(cls, state: GameState, player_id: PlayerId, group: ColorGroup) -> Self:
        return cls(**dict(state.group_holdings(player_id, group)))


class PlayerView(BaseModel):
    """A seat, plus the four derived facts the dossier would otherwise re-derive."""

    id: PlayerId
    name: str
    kind: PlayerKind
    token: str
    cash: int
    position: TileIndex
    in_jail: bool
    jail_turns: int
    jail_cards: tuple[Deck, ...]
    bankrupt: bool
    grammatical_gender: Literal["m", "f", "n"]

    net_worth: int = Field(ge=0)
    """``state.net_worth(id)``. A mortgaged property counts for zero (MON-208) — a rule
    the client must not own a second copy of."""
    group_holdings: tuple[GroupHoldings, ...]
    """One entry per colour group, always all eight, so the dossier table is never ragged."""
    tiles_owned: tuple[TileIndex, ...]
    """``state.tiles_owned_by(id)``."""
    is_bot: bool
    """``kind.is_bot``. Promoted for the same reason ``SeatConfig`` keeps it on the wire."""

    @classmethod
    def from_state(cls, state: GameState, player: PlayerState) -> Self:
        return cls(
            **dict(player),
            net_worth=state.net_worth(player.id),
            group_holdings=tuple(GroupHoldings.from_state(state, player.id, group) for group in ColorGroup),
            tiles_owned=state.tiles_owned_by(player.id),
            is_bot=player.kind.is_bot,
        )


# --- The dice and deck projections ------------------------------------------


class DiceView(BaseModel):
    """The last roll, carrying its own total and doubles flag (G-36)."""

    first: int
    second: int
    purpose: Literal["move", "jail", "rent"]
    total: int
    is_doubles: bool

    @classmethod
    def from_dice(cls, dice: DiceState) -> Self:
        return cls(**dict(dice), total=dice.total, is_doubles=dice.is_doubles)


class DeckCounts(BaseModel):
    """How many cards each pile holds. The *order* stays hidden — that is the whole of
    G-35: shipping the shuffled list told the client every card it was about to draw."""

    chance: int = Field(ge=0)
    community_chest: int = Field(ge=0)


# --- The interrupt-stack projection -----------------------------------------
#
# One view per frame kind, so the union stays homogeneous and ``generated.ts`` gets a real
# discriminated union. Two of the four promote nothing; they exist so the discriminator has
# four members of one family rather than a mix of engine and view models.


class AuctionFrameView(BaseModel):
    kind: Literal["auction"] = "auction"
    resume: Phase
    lot: Lot
    reason: AuctionReason
    eligible: tuple[PlayerId, ...]
    active: tuple[PlayerId, ...] = ()
    turn: PlayerId | None = None
    high_bid: int = Field(ge=0)
    high_bidder: PlayerId | None = None
    min_bid: int = Field(ge=1)
    max_bid: int | None = None
    queue: tuple[Lot, ...] = ()

    withdrawn: tuple[PlayerId, ...]
    """Derived on the frame so it cannot disagree with ``active``; promoted for the same
    reason. ``min_bid``/``max_bid`` are real fields and ship as copies, which is what stops
    the bid widget computing a bidder's ceiling — a rule — in TypeScript (G-36)."""

    @classmethod
    def from_frame(cls, frame: AuctionFrame) -> Self:
        return cls(**dict(frame), withdrawn=frame.withdrawn)


class DebtFrameView(BaseModel):
    kind: Literal["debt"] = "debt"
    resume: Phase
    debtor: PlayerId
    obligations: tuple[Obligation, ...]
    reason: CashReason
    source_tile: TileIndex | None = None

    total: int = Field(ge=0)
    """What is owed in all. Summing ``obligations`` client-side is harmless arithmetic
    today and a divergence the day a rule touches it."""
    creditors: tuple[PlayerId | Literal["bank"], ...]

    @classmethod
    def from_frame(cls, frame: DebtFrame) -> Self:
        return cls(**dict(frame), total=frame.total, creditors=frame.creditors)


class TradeFrameView(BaseModel):
    """A verbatim copy. Declared so the union below is homogeneous."""

    kind: Literal["trade"] = "trade"
    resume: Phase
    offer: TradeOffer

    @classmethod
    def from_frame(cls, frame: TradeFrame) -> Self:
        return cls(**dict(frame))


class CardFrameView(BaseModel):
    """A verbatim copy. The whole stack ships, so a half-resolved card stays face-up under
    the debt dialog sitting on top of it (G-9)."""

    kind: Literal["card"] = "card"
    resume: Phase
    card_id: str
    deck: Deck
    step: int = Field(ge=0)

    @classmethod
    def from_frame(cls, frame: CardFrame) -> Self:
        return cls(**dict(frame))


InterruptFrameView = Annotated[
    AuctionFrameView | DebtFrameView | TradeFrameView | CardFrameView, Field(discriminator="kind")
]


def _project_frame(frame: AuctionFrame | DebtFrame | TradeFrame | CardFrame) -> InterruptFrameView:
    """Dispatch on the frame's own tag. Not a rule: no branch here decides anything about
    the game, it only chooses which copy to make."""
    match frame:
        case AuctionFrame():
            return AuctionFrameView.from_frame(frame)
        case DebtFrame():
            return DebtFrameView.from_frame(frame)
        case TradeFrame():
            return TradeFrameView.from_frame(frame)
        case CardFrame():
            return CardFrameView.from_frame(frame)
        case _:  # pragma: no cover - unreachable by construction; see below
            # A fifth frame kind is a *type* error here rather than a `None` that pydantic
            # rejects at the far end of the call with a message about the wrong field. Excluded
            # from coverage rather than left as an unexplained miss: the whole point of
            # `assert_never` is that mypy has already proved no test can reach it.
            assert_never(frame)


# --- The state projection ---------------------------------------------------


class GameStateView(BaseModel):
    """What the state carries, minus the hidden information, plus the derived facts.

    Field order follows ``GameState`` so the two read side by side; the omissions and the
    promotions are enumerated in ``test_projection.py`` and checked mechanically.
    """

    schema_version: int
    game_id: str
    board_id: str
    ruleset: Ruleset
    locale: str

    players: tuple[PlayerView, ...]
    properties: tuple[PropertyState, ...]

    phase: Phase
    current_player_id: PlayerId
    dice: DiceView | None = None
    doubles_streak: int = Field(ge=0)
    turn_number: int = Field(ge=1)

    interrupts: tuple[InterruptFrameView, ...] = ()
    """Outermost first; the last entry is live (ADR-007). The stack ships whole, which is
    what keeps a suspended card, trade or auction visible underneath the live frame."""

    deck_counts: DeckCounts
    """Replaces ``chance_deck``/``community_chest_deck``, whose *order* is the deal (G-35)."""

    free_parking_pot: int = Field(ge=0)
    elapsed_seconds: int = Field(ge=0)
    elimination_order: tuple[PlayerId, ...] = ()
    winner: PlayerId | None = None

    houses_remaining: int = Field(ge=0)
    hotels_remaining: int = Field(ge=0)
    """The bank's stock, which the engine derives from the ruleset. A hotel is not four
    houses, so counting buildings client-side is a rule, not a sum."""

    rent_quotes: tuple[RentQuote | None, ...] = ()
    """What each square would charge the seat that is about to act (MON-420).

    ``state.rent_due(index, payer_id=current_player_id)`` per square, index-aligned with
    ``board.tiles``; ``None`` where nothing is owed — unowned, mortgaged, owned by that seat, or
    owned by somebody who has left the game.

    **Quoted against ``current_player_id``, deliberately.** A quote is payer-dependent only in
    whether it exists at all (nobody pays themselves), so one array answers the question the UI is
    actually asking — "what would this cost the player being asked to decide" — and the alternative,
    a quote per seat per square, is thirty times the payload for a question nobody poses. A screen
    wanting another seat's exposure asks the engine, which is what the accessor is for.

    Ships the engine's ``RentQuote`` verbatim rather than a view of it, like ``PropertyState`` and
    ``Obligation``: there is no hidden information in a rent figure and nothing to promote. Forty
    entries of which most are ``None`` — the array is index-aligned rather than a map so a client
    never has to parse a key into a tile index.
    """

    @classmethod
    def from_state(cls, state: GameState) -> Self:
        return cls(
            schema_version=state.schema_version,
            game_id=state.game_id,
            board_id=state.board_id,
            ruleset=state.ruleset,
            locale=state.locale,
            players=tuple(PlayerView.from_state(state, player) for player in state.players),
            properties=state.properties,
            phase=state.phase,
            current_player_id=state.current_player_id,
            dice=DiceView.from_dice(state.dice) if state.dice is not None else None,
            doubles_streak=state.doubles_streak,
            turn_number=state.turn_number,
            interrupts=tuple(_project_frame(frame) for frame in state.interrupts),
            deck_counts=DeckCounts(
                chance=len(state.deck(Deck.CHANCE)),
                community_chest=len(state.deck(Deck.COMMUNITY_CHEST)),
            ),
            free_parking_pot=state.free_parking_pot,
            elapsed_seconds=state.elapsed_seconds,
            elimination_order=state.elimination_order,
            winner=state.winner,
            houses_remaining=state.houses_remaining,
            hotels_remaining=state.hotels_remaining,
            rent_quotes=tuple(
                state.rent_due(tile.index, payer_id=state.current_player_id) for tile in state.board.tiles
            ),
        )


# --- The view ---------------------------------------------------------------


class LoggedEvent(BaseModel):
    """One event with the session-assigned sequence number the store gave it (G-34).

    The envelope lives on the transport, not on the event: ``seq`` is a fact about *this
    session's log*, and the engine — which has no session — must not have to invent one.
    The same envelope is what the WebSocket pushes (MON-303), so both transports carry one
    type and a reconnecting client can de-duplicate by ``seq``.
    """

    seq: int = Field(ge=1)
    event: Event


class SaveFile(BaseModel):
    """A whole session on disk: the state, and the events that produced it (ADR-011).

    ``GET /games/{id}/save`` answers with this and ``POST /games/load`` accepts it. It exists
    because a save used to be a bare ``GameState`` and a session is more than one — ``Session.log``
    is not a state field, so a restored game came back with its board, money and deeds exactly right
    and *"What's happened"* empty. Both halves of that are here now.

    **The events are the engine's, without ``seq``.** ``LoggedEvent.seq`` is assigned by the store
    and nowhere else (see :mod:`kesef_server.sessions`), so a file that carried numbers would be
    asking the next session to honour a previous one's. The store stamps a restored log ``1..N``
    exactly as it stamps a live one.

    **A bare ``GameState`` still loads.** Every file saved before ADR-011 is one, and
    :meth:`from_json` reads it as the state with no events. The two shapes cannot be confused: an
    envelope has a ``state`` field and ``GameState`` declares none, so neither validates as the other.

    **No version of its own.** Whether a save loads is decided by ``state.schema_version``, and the
    events are validated by the same union the live log is built from. A second version field beside
    the engine's would be a second thing to keep in step and the first to go stale.
    """

    state: GameState
    events: tuple[Event, ...] = ()
    """Oldest first. Replaying these against the *opening* state reproduces the game; they are
    carried so a restored session can show its history, not so anything replays them."""

    @classmethod
    def from_json(cls, raw: bytes) -> Self:
        """A save file's bytes, in whichever of the two shapes they are.

        **Parsed by pydantic, never by :mod:`json`.** The first draft of this read
        ``json.loads(raw)`` and branched on whether a ``state`` key was present, which reads more
        plainly and hands an unauthenticated route a way to raise ``RecursionError``: 3000 nested
        brackets is six kilobytes, well inside ``max_save_bytes``, and Python's parser recurses per
        level. ``RecursionError`` is not a ``ValueError``, so it escaped the callers' ``except`` as a
        500 with a traceback — the same shape of defect the MON-100 review found in this very route
        when a ``BoardDataError`` escaped it. pydantic-core parses without Python recursion and
        answers its depth limit as an ordinary ``ValidationError``.

        The envelope is tried first and the bare state second. That is not a preference between the
        two: an envelope has a ``state`` field that ``GameState`` does not declare, and ``GameState``
        requires seven fields an envelope does not carry, so at most one of them can validate.

        Raises whatever pydantic raises — the callers turn every one of them into the single
        ``error.save_schema_mismatch`` key, because from the player's side the file did not load and
        that is the whole of what there is to say.
        """
        try:
            return cls.model_validate_json(raw)
        except ValidationError:
            return cls(state=GameState.model_validate_json(raw))


class IfExists(StrEnum):
    """What ``POST /games/load`` should do when that save's ``game_id`` is already live (ADR-011).

    The policy is a *request* field rather than something inferred from the body, and it defaults to
    :attr:`REFUSE` — so the unchanged request keeps answering the 409 it always did, and a client
    that has not been taught the question cannot silently end somebody's game.
    """

    REFUSE = "refuse"
    """``409 error.game_already_exists``. The first attempt, before the player has been asked."""
    REPLACE = "replace"
    """The live session under that id is dropped and the file takes its place."""
    COPY = "copy"
    """A freshly minted id. The live game is untouched and the file behaves as a template."""


class GameView(BaseModel):
    """Everything a client needs to render one frame — a projection, not the state.

    Bundling the legal commands with the state is what lets the UI stay rules-free: it
    renders the buttons it is handed instead of re-deriving them and drifting.
    """

    board: BoardView
    state: GameStateView
    legal_commands: tuple[Command, ...]
    events: tuple[LoggedEvent, ...] = ()
    """The events this response reports — the animation script. For a command, what that
    command produced; for a poll, whatever followed ``?since=``."""
    event_cursor: int = Field(default=0, ge=0)
    """The session's highest ``seq``. Poll or reconnect with ``?since=`` this."""


class LegalityView(BaseModel):
    """``POST /games/{id}/validate``'s answer — the engine's ``LegalityResult``, copied.

    The trade builder validates a draft here rather than firing speculative commands and
    reading 422s (G-32); ADR-005 delegates trade legality to ``is_legal``, and without this
    route that delegation dead-ends at the HTTP boundary.
    """

    legal: bool
    reason_key: str | None = None
    params: dict[str, int | str] = {}


class BoardSummary(BaseModel):
    """Board metadata for the new-game screen. Names arrive as keys; the UI translates."""

    id: str
    name_key: str
    tile_count: int
    ownable_count: int
    catalogue_ready: bool
    """Whether every square on this board has a verified name (MON-419, G-46).

    A copy of ``Board.catalogue_ready`` — see that field for why the flag is declared in the board
    data rather than worked out here: the names live in the web package's catalogues, which this
    service cannot read and may be deployed without.

    The picker offers only boards where this is true. Without it, a board could be selected whose
    forty ``tile.*`` keys resolve to nothing, and the result is a board of blank squares — which is
    what the ``i18n.exists`` guards in the event log, the action bar and the dossier were added to
    survive rather than to make acceptable.
    """


# --- The ruleset projection (MON-417, G-36) ---------------------------------
#
# ``GET /rulesets`` returned the raw engine model, so the setup screen diffed the two rule sets in
# TypeScript and kept its own ``Record<keyof Ruleset, "ruleset.${string}">`` label map. Both are
# deleted by what follows: a client that works out which rules are in force is one rename away from
# explaining the wrong ones, and a hand-kept label map is a bridge between the engine's vocabulary
# and the catalogue's that can silently drift (the GAP G-40 argument, applied to rule names).
#
# Neither the diff nor the labels are decided here either — ``Ruleset.differing_settings`` and
# ``Ruleset.label_key`` are the engine's, because what counts as a setting and how its values
# compare are facts about that model. What *is* decided here is the wire shape: a value classified
# so a client can render it without inspecting types, which is transport, not a rule.


class RuleFlagValue(BaseModel):
    kind: Literal["flag"] = "flag"
    on: bool


class RuleNumberValue(BaseModel):
    kind: Literal["number"] = "number"
    value: int


class RuleNumberListValue(BaseModel):
    kind: Literal["numbers"] = "numbers"
    values: tuple[int, ...]


class RuleAbsentValue(BaseModel):
    """No value at all — ``target_duration_minutes`` under the universal rules.

    Its own case rather than a nullable number, because "no target length" and "a target length of
    zero" are different sentences and the model allows both.
    """

    kind: Literal["absent"] = "absent"


RuleValueView = Annotated[
    RuleFlagValue | RuleNumberValue | RuleNumberListValue | RuleAbsentValue, Field(discriminator="kind")
]
"""A rule's value, tagged so ``generated.ts`` gets a real discriminated union rather than
``boolean | number | number[] | null`` for the client to sniff at."""


def _rule_value(raw: object) -> RuleValueView:
    """Classify one setting's value. A shape mapping, not a judgement about the game.

    ``bool`` is tested first because ``isinstance(True, int)`` is true in Python, and a flag
    classified as the number 1 is a row reading "Auctions: 1".
    """
    if isinstance(raw, bool):
        return RuleFlagValue(on=raw)
    if isinstance(raw, int):
        return RuleNumberValue(value=raw)
    if isinstance(raw, tuple):
        return RuleNumberListValue(values=tuple(int(entry) for entry in raw))
    return RuleAbsentValue()


class RuleFlagView(BaseModel):
    """One setting, named, valued, and marked if this rule set changes it."""

    field: str
    """The wire field name, which is also the row's stable React key."""
    label_key: str
    """``Ruleset.label_key(field)``. A key, never prose — ADR-003 §6."""
    value: RuleValueView
    universal_value: RuleValueView
    """What the official rules say — the "was" half of the sentence, so a row can read
    "Starting cash 2000 (full rules: 1500)" without the client fetching a baseline and comparing."""
    differs_from_universal: bool
    """``field in ruleset.differing_settings(universal)``. The engine's comparison, promoted."""


class RulesetView(BaseModel):
    """A rule set as a setup screen needs it: identified, labelled, and explained.

    ``ruleset`` still ships whole, because the *game* screen reads flags off it
    (``ruleset.jail_fine``, ``ruleset.simplified_trades``) and that is a copy, not a diff.
    """

    name: RulesetName
    label_key: str
    """``setup.<name>`` — the namespace the catalogue already uses for the two choices."""
    ruleset: Ruleset
    flags: tuple[RuleFlagView, ...]
    """Every setting, in the engine's declaration order, whether it differs or not.

    All of them rather than only the differences: the order is what makes a list of changes read
    the same way twice running, and a client filtering on ``differs_from_universal`` is doing
    presentation, where deciding *which* rules differ would have been a rule.
    """

    @classmethod
    def from_ruleset(cls, ruleset: Ruleset, universal: Ruleset) -> Self:
        differing = ruleset.differing_settings(universal)
        return cls(
            name=ruleset.name,
            label_key=f"setup.{ruleset.name.value}",
            ruleset=ruleset,
            flags=tuple(
                RuleFlagView(
                    field=field,
                    label_key=Ruleset.label_key(field),
                    value=_rule_value(getattr(ruleset, field)),
                    universal_value=_rule_value(getattr(universal, field)),
                    differs_from_universal=field in differing,
                )
                for field in Ruleset.setting_fields()
            ),
        )
