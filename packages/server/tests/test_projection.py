"""ADR-008 — the view is a projection of the state, and the projection cannot drift.

Two kinds of test live here.

**Parity.** For every engine model the wire re-declares, the view's field set must equal
the engine's, minus an explicitly named omission set, plus an explicitly named promotion
set. That is what makes the projection *falsifiable*: adding a field to ``GameState`` and
forgetting the view fails here, and so does declaring an omission that does not exist.

**Semantics.** Every promoted field is compared against the engine property it copies —
never against a number recomputed here, because a copy of the rule in the test is the same
defect as a copy of the rule in the server.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import NamedTuple

import pytest
from conftest import minimal_state
from pydantic import BaseModel

from kesef_engine.board.loader import load_board
from kesef_engine.board.models import BOARD_SIZE, Board, ColorGroup, Tile
from kesef_engine.commands import TradeOffer, TradeSide
from kesef_engine.decks import CHANCE_CARD_IDS, COMMUNITY_CHEST_CARD_IDS
from kesef_engine.events import RentQuote
from kesef_engine.phases import Phase
from kesef_engine.primitives import AuctionReason, CashReason, Deck, TileLot
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
from kesef_engine.state import GroupHoldings as EngineGroupHoldings
from kesef_server.schemas import (
    AuctionFrameView,
    BoardView,
    CardFrameView,
    DebtFrameView,
    DeckCounts,
    DiceView,
    GameStateView,
    GroupHoldings,
    PlayerView,
    TileView,
    TradeFrameView,
)

# --- What the projection deliberately hides and promotes ---------------------
#
# These constants are the contract ADR-008 states in prose. They live in the test, not in
# the source, so that the source cannot both make and mark its own homework.

STATE_OMITS = {"rng", "chance_deck", "community_chest_deck"}
"""G-35: the RNG seed and the ordered decks are hidden information."""

STATE_PROMOTES = {"deck_counts", "houses_remaining", "hotels_remaining", "rent_quotes"}
"""``deck_counts`` replaces the ordered decks; the two stock counts are engine-derived
properties the bank display and the MON-605 hints would otherwise re-derive (a hotel is
not four houses, so counting them client-side is a rule).

``rent_quotes`` is ``state.rent_due`` per square (MON-420) — the multipliers live in
``rules/rent.py``, so a screen that wanted the current figure had nothing to render."""

PLAYER_PROMOTES = {"net_worth", "group_holdings", "tiles_owned", "is_bot"}
"""G-31: the dossier must not re-implement the valuation rule or group completion."""

DICE_PROMOTES = {"total", "is_doubles"}
TILE_PROMOTES = {"is_ownable"}
BOARD_PROMOTES = {"go_to_jail_target"}
AUCTION_PROMOTES = {"withdrawn"}
DEBT_PROMOTES = {"total", "creditors"}


def _fields(model: type[BaseModel]) -> set[str]:
    return set(model.model_fields)


@pytest.mark.parametrize(
    ("engine_model", "view_model", "omits", "promotes"),
    [
        (GameState, GameStateView, STATE_OMITS, STATE_PROMOTES),
        (PlayerState, PlayerView, set(), PLAYER_PROMOTES),
        (DiceState, DiceView, set(), DICE_PROMOTES),
        (Tile, TileView, set(), TILE_PROMOTES),
        (Board, BoardView, set(), BOARD_PROMOTES),
        (AuctionFrame, AuctionFrameView, set(), AUCTION_PROMOTES),
        (DebtFrame, DebtFrameView, set(), DEBT_PROMOTES),
        (TradeFrame, TradeFrameView, set(), set()),
        (CardFrame, CardFrameView, set(), set()),
        # MON-421: the wire twin of an engine model now, rather than four copied fields beside two
        # engine calls. Held to the same parity contract as every other re-declared model.
        (EngineGroupHoldings, GroupHoldings, set(), set()),
    ],
    ids=lambda value: getattr(value, "__name__", ""),
)
def test_the_view_declares_exactly_the_engine_fields_minus_omissions_plus_promotions(
    engine_model: type[BaseModel], view_model: type[BaseModel], omits: set[str], promotes: set[str]
) -> None:
    assert _fields(engine_model) - omits | promotes == _fields(view_model)


def test_the_omissions_are_real_engine_fields() -> None:
    """Guards the guard: an omission that does not exist would hide a real field silently."""
    assert _fields(GameState) >= STATE_OMITS


# --- Semantics --------------------------------------------------------------


def test_deck_counts_replace_the_ordered_decks() -> None:
    state = minimal_state(chance_deck=CHANCE_CARD_IDS, community_chest_deck=COMMUNITY_CHEST_CARD_IDS)
    view = GameStateView.from_state(state)
    assert view.deck_counts == DeckCounts(chance=len(CHANCE_CARD_IDS), community_chest=len(COMMUNITY_CHEST_CARD_IDS))


def test_net_worth_is_the_engines_number_not_a_recomputed_one() -> None:
    """Boardwalk with two houses: the promoted figure must equal ``state.net_worth``."""
    properties = list(minimal_state().properties)
    properties[39] = PropertyState(owner=0, houses=2)
    state = minimal_state(properties=tuple(properties))
    view = GameStateView.from_state(state)
    assert view.players[0].net_worth == state.net_worth(0)
    assert view.players[0].net_worth > state.player(0).cash


def test_a_mortgaged_property_still_counts_for_nothing_in_the_view() -> None:
    """The valuation rule (MON-208) is the engine's; the view must not soften it."""
    properties = list(minimal_state().properties)
    properties[39] = PropertyState(owner=0, mortgaged=True)
    state = minimal_state(properties=tuple(properties))
    assert GameStateView.from_state(state).players[0].net_worth == state.player(0).cash


def test_group_holdings_report_completion_from_the_engine() -> None:
    board = load_board("classic")
    browns = board.group_members(ColorGroup.BROWN)
    properties = list(minimal_state().properties)
    for index in browns:
        properties[index] = PropertyState(owner=0)
    properties[browns[0]] = PropertyState(owner=0, houses=3)
    state = minimal_state(properties=tuple(properties))
    holdings = {entry.group: entry for entry in GameStateView.from_state(state).players[0].group_holdings}

    brown = holdings[ColorGroup.BROWN]
    assert brown == GroupHoldings(
        group=ColorGroup.BROWN, owned=len(browns), total=len(browns), complete=True, houses=3, mortgaged_count=0
    )
    assert state.owns_whole_group(0, ColorGroup.BROWN) is brown.complete
    assert holdings[ColorGroup.RED].owned == 0
    assert holdings[ColorGroup.RED].complete is False


def test_group_holdings_cover_every_colour_group_for_every_player() -> None:
    """A dossier that has to guess which groups are missing renders a ragged table."""
    view = GameStateView.from_state(minimal_state())
    for player in view.players:
        assert [entry.group for entry in player.group_holdings] == list(ColorGroup)


def test_group_holdings_count_mortgages() -> None:
    board = load_board("classic")
    browns = board.group_members(ColorGroup.BROWN)
    properties = list(minimal_state().properties)
    properties[browns[0]] = PropertyState(owner=0, mortgaged=True)
    state = minimal_state(properties=tuple(properties))
    holdings = {entry.group: entry for entry in GameStateView.from_state(state).players[0].group_holdings}
    assert holdings[ColorGroup.BROWN].mortgaged_count == 1
    assert holdings[ColorGroup.BROWN].complete is False


def test_rent_quotes_are_index_aligned_with_the_board_and_priced_for_the_acting_seat() -> None:
    """MON-420: forty entries, and each is ``state.rent_due`` for the seat about to act."""
    properties = list(minimal_state().properties)
    properties[39] = PropertyState(owner=1, houses=2)
    state = minimal_state(properties=tuple(properties))
    quotes = GameStateView.from_state(state).rent_quotes

    assert len(quotes) == len(state.board.tiles)
    assert quotes[39] == state.rent_due(39, payer_id=state.current_player_id)
    assert quotes[39] is not None and quotes[39].amount == load_board("classic").tile(39).rent[2]
    # An unowned square owes nothing, and so does the acting seat's own — the projection must not
    # soften either into a zero.
    assert quotes[0] is None
    assert quotes[1] is None


def test_a_rent_quote_is_absent_for_the_seat_that_owns_the_square() -> None:
    """The payer identity is load-bearing: quoted against ``current_player_id``, nobody pays
    themselves. Reading the *owner* as payer would have priced every square in the game."""
    properties = list(minimal_state().properties)
    properties[39] = PropertyState(owner=0)
    state = minimal_state(properties=tuple(properties))
    assert state.current_player_id == 0
    assert GameStateView.from_state(state).rent_quotes[39] is None
    # And it appears the moment somebody else is the one to act.
    assert (
        GameStateView.from_state(minimal_state(properties=tuple(properties), current_player_id=1)).rent_quotes[39]
        is not None
    )


def test_a_rent_quote_carries_the_note_keys_that_explain_it() -> None:
    """The whole point of one shape: the sentence a player reads before deciding is assembled
    from the same ``rent.note.*`` keys the log uses afterwards."""
    board = load_board("classic")
    properties = list(minimal_state().properties)
    for index in board.group_members(ColorGroup.DARK_BLUE):
        properties[index] = PropertyState(owner=1)
    quote = GameStateView.from_state(minimal_state(properties=tuple(properties))).rent_quotes[39]
    assert quote is not None
    assert quote.note_keys == ("rent.note.full_group_doubled",)
    assert quote.note_params["group_key"] == "group.dark_blue"


def test_tiles_owned_and_bot_flags_are_copies_of_engine_truth() -> None:
    properties = list(minimal_state().properties)
    properties[1] = PropertyState(owner=1)
    state = minimal_state(properties=tuple(properties))
    view = GameStateView.from_state(state)
    assert view.players[1].tiles_owned == state.tiles_owned_by(1)
    assert view.players[1].is_bot is state.player(1).kind.is_bot


def test_dice_carry_their_own_total_and_doubles_flag() -> None:
    state = minimal_state(dice=DiceState(first=3, second=3, purpose="jail"))
    dice = GameStateView.from_state(state).dice
    assert dice is not None
    assert (dice.total, dice.is_doubles, dice.purpose) == (6, True, "jail")


def test_no_dice_projects_to_none() -> None:
    assert GameStateView.from_state(minimal_state()).dice is None


def test_the_board_projection_promotes_ownability_and_the_jail_target() -> None:
    board = load_board("classic")
    view = BoardView.from_board(board)
    assert view.go_to_jail_target == board.go_to_jail_target
    assert [tile.is_ownable for tile in view.tiles] == [tile.is_ownable for tile in board.tiles]
    assert sum(1 for tile in view.tiles if tile.is_ownable) == 28


def test_the_auction_frame_projects_its_derived_withdrawn_list() -> None:
    frame = AuctionFrame(
        resume=Phase.AWAITING_PURCHASE_DECISION,
        lot=TileLot(tile=1),
        reason=AuctionReason.DECLINED_PURCHASE,
        eligible=(0, 1),
        active=(1,),
        turn=1,
    )
    state = minimal_state(phase=Phase.AUCTION, interrupts=(frame,))
    projected = GameStateView.from_state(state).interrupts[0]
    assert isinstance(projected, AuctionFrameView)
    assert projected.withdrawn == frame.withdrawn == (0,)
    assert (projected.min_bid, projected.max_bid, projected.high_bid) == (frame.min_bid, frame.max_bid, frame.high_bid)


def test_the_debt_frame_projects_its_total_and_creditors() -> None:
    frame = DebtFrame(
        resume=Phase.RESOLVING_TILE,
        debtor=0,
        obligations=(Obligation(creditor=1, amount=50), Obligation(creditor="bank", amount=25)),
        reason=CashReason.RENT,
    )
    state = minimal_state(phase=Phase.DEBT_SETTLEMENT, interrupts=(frame,))
    projected = GameStateView.from_state(state).interrupts[0]
    assert isinstance(projected, DebtFrameView)
    assert projected.total == frame.total == 75
    assert projected.creditors == frame.creditors == (1, "bank")


def test_the_whole_interrupt_stack_ships_so_a_card_stays_face_up_under_a_debt() -> None:
    """G-9: the UI keeps the card visible while the debt dialog sits on top of it."""
    card = CardFrame(resume=Phase.RESOLVING_TILE, card_id="card.chance.advance_to_go", deck=Deck.CHANCE)
    debt = DebtFrame(
        resume=Phase.CARD_RESOLUTION,
        debtor=0,
        obligations=(Obligation(creditor="bank", amount=50),),
        reason=CashReason.CARD,
    )
    state = minimal_state(phase=Phase.DEBT_SETTLEMENT, interrupts=(card, debt))
    projected = GameStateView.from_state(state).interrupts
    assert [type(frame) for frame in projected] == [CardFrameView, DebtFrameView]
    assert isinstance(projected[0], CardFrameView)
    assert projected[0].card_id == card.card_id


def test_a_trade_frame_projects_its_offer_verbatim() -> None:
    offer = TradeOffer(proposer=0, recipient=1, give=TradeSide(cash=10), receive=TradeSide(tiles=(1,)))
    frame = TradeFrame(resume=Phase.AWAITING_ROLL, offer=offer)
    state = minimal_state(phase=Phase.TRADE_REVIEW, interrupts=(frame,))
    projected = GameStateView.from_state(state).interrupts[0]
    assert isinstance(projected, TradeFrameView)
    assert projected.offer == offer


# --- Who was asked (MON-303 review, MAJOR 4) --------------------------------
#
# The semantics tests above compare a promoted field to the engine property it copies, which
# proves the two *agree* and not that the engine was ever consulted. That is a weaker claim
# than schemas.py makes, and the gap is not theoretical: replacing every single engine call
# below with faithful-looking arithmetic left all 111 server tests green. Measured, one mutant
# at a time:
#
#     GroupHoldings.complete            -> len(held) == len(members)                SURVIVED
#     DebtFrameView.total               -> sum(o.amount for o in obligations)       SURVIVED
#     DebtFrameView.creditors           -> tuple(o.creditor for o in obligations)   SURVIVED
#     PlayerView.net_worth              -> cash + unmortgaged prices + buildings    SURVIVED
#     PlayerView.tiles_owned            -> enumerate(properties) by owner           SURVIVED
#     PlayerView.is_bot                 -> kind.bot_level is not None               SURVIVED
#     DiceView.total / is_doubles       -> first + second / first == second         SURVIVED
#     TileView.is_ownable               -> kind in {PROPERTY, RAILROAD, UTILITY}    SURVIVED
#     BoardView.go_to_jail_target       -> first tile whose kind is JAIL            SURVIVED
#     AuctionFrameView.withdrawn        -> eligible not in active                   SURVIVED
#     houses_remaining/hotels_remaining -> available - counted on the board         SURVIVED
#
# Each of those is the rule copy schemas.py says it avoids, and each agrees with the engine on
# every state a shipped board can produce — which is exactly why comparing values cannot catch
# it. So these tests assert *who was asked*: the engine member is replaced by a stub returning
# a value nothing else could produce, and the view has to carry that value through. Arithmetic
# in the projection then fails, whatever it computes.
#
# ``monkeypatch.setattr`` raises when the attribute does not exist, so this also guards the
# guard: an engine member renamed out from under the projection fails here by name.

SENTINEL_INT = 4242
"""A number no state below produces by any other route."""

_SENTINEL_HOLDINGS = EngineGroupHoldings(
    group=ColorGroup.PINK, owned=7, total=7, complete=True, houses=SENTINEL_INT, mortgaged_count=3
)
"""A group roll-up no board can produce: seven pink squares, 4242 houses on them.

Every field is impossible, not just one — a projection that copied ``group`` faithfully and
recomputed the numbers has to fail on the numbers, and one that trusted the numbers and relabelled
the group has to fail on the group."""

_SENTINEL_QUOTE = RentQuote(owner=SENTINEL_INT, tile=1, amount=SENTINEL_INT, note_keys=("rent.note.base",))
"""A rent no tile charges. ``owner`` is a seat that does not exist, so the quote cannot have come
from pricing the board."""


def _stub_method(monkeypatch: pytest.MonkeyPatch, model: type, name: str, value: object) -> None:
    monkeypatch.setattr(model, name, lambda self, *args, **kwargs: value)


def _stub_property(monkeypatch: pytest.MonkeyPatch, model: type, name: str, value: object) -> None:
    monkeypatch.setattr(model, name, property(lambda self: value))


def _auction_state() -> GameState:
    """Nobody has withdrawn, so honest arithmetic would answer ``()``."""
    frame = AuctionFrame(
        resume=Phase.AWAITING_PURCHASE_DECISION,
        lot=TileLot(tile=1),
        reason=AuctionReason.DECLINED_PURCHASE,
        eligible=(0, 1),
        active=(0, 1),
    )
    return minimal_state(phase=Phase.AUCTION, interrupts=(frame,))


def _debt_state() -> GameState:
    """One 50 owed to player 1, so honest arithmetic would answer 50 and ``(1,)``."""
    frame = DebtFrame(
        resume=Phase.RESOLVING_TILE,
        debtor=0,
        obligations=(Obligation(creditor=1, amount=50),),
        reason=CashReason.RENT,
    )
    return minimal_state(phase=Phase.DEBT_SETTLEMENT, interrupts=(frame,))


class _Promotion(NamedTuple):
    """One promoted field, the engine member it must consult, and a value only that path gives."""

    field: str
    patch: Callable[[pytest.MonkeyPatch], None]
    read: Callable[[], object]
    expected: object


def _debt_frame_view() -> DebtFrameView:
    projected = GameStateView.from_state(_debt_state()).interrupts[0]
    assert isinstance(projected, DebtFrameView)
    return projected


def _auction_frame_view() -> AuctionFrameView:
    projected = GameStateView.from_state(_auction_state()).interrupts[0]
    assert isinstance(projected, AuctionFrameView)
    return projected


def _dice_view() -> DiceView:
    dice = GameStateView.from_state(minimal_state(dice=DiceState(first=3, second=4))).dice
    assert dice is not None
    return dice


PROMOTIONS = [
    _Promotion(
        "GroupHoldings.complete",
        lambda mp: _stub_method(mp, GameState, "owns_whole_group", True),
        lambda: {
            entry.complete for p in GameStateView.from_state(minimal_state()).players for entry in p.group_holdings
        },
        {True},
    ),
    _Promotion(
        # MON-421's falsifier. `complete` above stubs `owns_whole_group`, which `group_holdings`
        # calls — so it passes either way and cannot tell "the engine answered the row" from "the
        # engine answered one field of it". This one replaces the whole accessor.
        "PlayerView.group_holdings",
        lambda mp: _stub_method(mp, GameState, "group_holdings", _SENTINEL_HOLDINGS),
        lambda: [
            entry for player in GameStateView.from_state(minimal_state()).players for entry in player.group_holdings
        ],
        # Two seats, eight groups each, and every row is the sentinel.
        [GroupHoldings(**dict(_SENTINEL_HOLDINGS))] * 16,
    ),
    _Promotion(
        # MON-420's. Honest arithmetic over a board where nothing is owned answers `None` for all
        # forty squares, so a projection that priced rent itself could not produce this.
        "GameStateView.rent_quotes",
        lambda mp: _stub_method(mp, GameState, "rent_due", _SENTINEL_QUOTE),
        lambda: list(GameStateView.from_state(minimal_state()).rent_quotes),
        [_SENTINEL_QUOTE] * BOARD_SIZE,
    ),
    _Promotion(
        "PlayerView.net_worth",
        lambda mp: _stub_method(mp, GameState, "net_worth", SENTINEL_INT),
        lambda: [p.net_worth for p in GameStateView.from_state(minimal_state()).players],
        [SENTINEL_INT, SENTINEL_INT],
    ),
    _Promotion(
        "PlayerView.tiles_owned",
        lambda mp: _stub_method(mp, GameState, "tiles_owned_by", (7,)),
        lambda: [p.tiles_owned for p in GameStateView.from_state(minimal_state()).players],
        [(7,), (7,)],
    ),
    _Promotion(
        "PlayerView.is_bot",
        lambda mp: _stub_property(mp, PlayerKind, "is_bot", True),
        lambda: [p.is_bot for p in GameStateView.from_state(minimal_state()).players],
        [True, True],
    ),
    _Promotion(
        "GameStateView.houses_remaining",
        lambda mp: _stub_property(mp, GameState, "houses_remaining", SENTINEL_INT),
        lambda: GameStateView.from_state(minimal_state()).houses_remaining,
        SENTINEL_INT,
    ),
    _Promotion(
        "GameStateView.hotels_remaining",
        lambda mp: _stub_property(mp, GameState, "hotels_remaining", SENTINEL_INT),
        lambda: GameStateView.from_state(minimal_state()).hotels_remaining,
        SENTINEL_INT,
    ),
    _Promotion(
        "DiceView.total",
        lambda mp: _stub_property(mp, DiceState, "total", SENTINEL_INT),
        lambda: _dice_view().total,
        SENTINEL_INT,
    ),
    _Promotion(
        "DiceView.is_doubles",
        lambda mp: _stub_property(mp, DiceState, "is_doubles", True),
        lambda: _dice_view().is_doubles,
        True,
    ),
    _Promotion(
        "DebtFrameView.total",
        lambda mp: _stub_property(mp, DebtFrame, "total", SENTINEL_INT),
        lambda: _debt_frame_view().total,
        SENTINEL_INT,
    ),
    _Promotion(
        "DebtFrameView.creditors",
        lambda mp: _stub_property(mp, DebtFrame, "creditors", ("bank",)),
        lambda: _debt_frame_view().creditors,
        ("bank",),
    ),
    _Promotion(
        "AuctionFrameView.withdrawn",
        lambda mp: _stub_property(mp, AuctionFrame, "withdrawn", (5,)),
        lambda: _auction_frame_view().withdrawn,
        (5,),
    ),
    _Promotion(
        "TileView.is_ownable",
        lambda mp: _stub_property(mp, Tile, "is_ownable", True),
        lambda: {tile.is_ownable for tile in BoardView.from_board(load_board("classic")).tiles},
        {True},
    ),
    _Promotion(
        "BoardView.go_to_jail_target",
        lambda mp: _stub_property(mp, Board, "go_to_jail_target", 37),
        lambda: BoardView.from_board(load_board("classic")).go_to_jail_target,
        37,
    ),
]


@pytest.mark.parametrize("promotion", PROMOTIONS, ids=lambda promotion: promotion.field)
def test_a_promoted_field_carries_the_engines_answer_and_not_its_own(
    promotion: _Promotion, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Stub the engine member; the view must carry the stub's answer.

    Arithmetic in the projection cannot pass this however faithfully it copies the rule, which
    is the point: every one of these fields *did* pass while it was arithmetic.
    """
    baseline = promotion.read()
    assert baseline != promotion.expected, f"{promotion.field}: the sentinel is not distinguishable"

    promotion.patch(monkeypatch)
    assert promotion.read() == promotion.expected, f"{promotion.field} did not come from the engine"


def test_every_promoted_field_in_the_projection_contract_has_a_falsifier() -> None:
    """Guards the guard. The promotion sets above enumerate what ADR-008 promotes; each one
    needs an entry in ``PROMOTIONS``, or a field could go back to arithmetic unnoticed."""
    covered = {promotion.field.rsplit(".", 1)[1] for promotion in PROMOTIONS}
    promoted = (
        STATE_PROMOTES
        | PLAYER_PROMOTES
        | DICE_PROMOTES
        | TILE_PROMOTES
        | BOARD_PROMOTES
        | AUCTION_PROMOTES
        | DEBT_PROMOTES
    )
    # ``deck_counts`` is a container of two lengths rather than an engine call, and the lengths are
    # covered by ``test_deck_counts_replace_the_ordered_decks``. ``group_holdings`` used to be
    # exempted on the same grounds and no longer is: MON-421 made it one engine call, so it has a
    # falsifier like everything else, which is what shrank this set from two names to one.
    assert promoted - covered == {"deck_counts"}


def test_building_stock_is_the_engines_remainder() -> None:
    properties = list(minimal_state().properties)
    properties[39] = PropertyState(owner=0, houses=5)
    state = minimal_state(properties=tuple(properties))
    view = GameStateView.from_state(state)
    assert (view.houses_remaining, view.hotels_remaining) == (state.houses_remaining, state.hotels_remaining)
    assert view.hotels_remaining == state.ruleset.hotels_available - 1
