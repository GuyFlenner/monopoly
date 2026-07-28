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

import pytest
from conftest import minimal_state
from pydantic import BaseModel

from kesef_engine.board.loader import load_board
from kesef_engine.board.models import Board, ColorGroup, Tile
from kesef_engine.commands import TradeOffer, TradeSide
from kesef_engine.decks import CHANCE_CARD_IDS, COMMUNITY_CHEST_CARD_IDS
from kesef_engine.phases import Phase
from kesef_engine.primitives import AuctionReason, CashReason, Deck, TileLot
from kesef_engine.state import (
    AuctionFrame,
    CardFrame,
    DebtFrame,
    DiceState,
    GameState,
    Obligation,
    PlayerState,
    PropertyState,
    TradeFrame,
)
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

STATE_PROMOTES = {"deck_counts", "houses_remaining", "hotels_remaining"}
"""``deck_counts`` replaces the ordered decks; the two stock counts are engine-derived
properties the bank display and the MON-605 hints would otherwise re-derive (a hotel is
not four houses, so counting them client-side is a rule)."""

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


def test_building_stock_is_the_engines_remainder() -> None:
    properties = list(minimal_state().properties)
    properties[39] = PropertyState(owner=0, houses=5)
    state = minimal_state(properties=tuple(properties))
    view = GameStateView.from_state(state)
    assert (view.houses_remaining, view.hotels_remaining) == (state.houses_remaining, state.hotels_remaining)
    assert view.hotels_remaining == state.ruleset.hotels_available - 1
