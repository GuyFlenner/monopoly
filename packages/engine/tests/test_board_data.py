"""The bundled board data is load-bearing: if it is wrong, every rent in the game is wrong.

These tests assert the *economics*, not just that the JSON parses.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from kesef_engine.board.loader import PREFERRED_BOARDS, available_boards, load_board
from kesef_engine.board.models import BOARD_SIZE, Board, ColorGroup, Tile, TileKind
from kesef_engine.errors import BoardDataError

BOARDS = available_boards()


def test_both_boards_ship() -> None:
    assert set(BOARDS) == {"classic", "israel"}


def test_the_israeli_board_is_offered_first_and_is_therefore_the_default() -> None:
    """MON-716. The order *is* the default — see `PREFERRED_BOARDS` and `SetupScreen.tsx`.

    Asserted on the first element rather than on the whole tuple, because what the product promises is
    "a family who presses nothing plays the Israeli board", and that is this one fact. The rest of the
    order is the alphabet, checked below.
    """
    assert BOARDS[0] == "israel"


def test_the_boards_after_the_preferred_ones_stay_alphabetical() -> None:
    """A picker that reshuffles between two reads is one nobody can describe over the phone."""
    rest = [board_id for board_id in BOARDS if board_id not in PREFERRED_BOARDS]
    assert rest == sorted(rest)
    assert available_boards() == BOARDS, "two reads disagreed"


def test_a_preferred_board_that_does_not_ship_is_ignored_rather_than_raising() -> None:
    """A preference, not a manifest: removing a board must not take the picker down with it."""
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr("kesef_engine.board.loader.PREFERRED_BOARDS", ("no-such-board", "israel"))
        assert available_boards()[0] == "israel"


@pytest.mark.parametrize("board_id", BOARDS)
def test_board_loads_and_validates(board_id: str) -> None:
    board = load_board(board_id)
    assert len(board.tiles) == BOARD_SIZE
    assert [tile.index for tile in board.tiles] == list(range(BOARD_SIZE))


@pytest.mark.parametrize("board_id", BOARDS)
def test_tile_census(board_id: str) -> None:
    """22 properties, 4 railroads, 2 utilities, 3+3 cards, 2 taxes, 4 corners."""
    board = load_board(board_id)
    census = {kind: len(board.indexes_of_kind(kind)) for kind in TileKind}
    assert census[TileKind.PROPERTY] == 22
    assert census[TileKind.RAILROAD] == 4
    assert census[TileKind.UTILITY] == 2
    assert census[TileKind.CHANCE] == 3
    assert census[TileKind.COMMUNITY_CHEST] == 3
    assert census[TileKind.TAX] == 2
    assert census[TileKind.GO] == census[TileKind.JAIL] == 1
    assert census[TileKind.FREE_PARKING] == census[TileKind.GO_TO_JAIL] == 1


@pytest.mark.parametrize("board_id", BOARDS)
def test_colour_groups_are_pairs_or_triples(board_id: str) -> None:
    board = load_board(board_id)
    sizes = {group: len(board.group_members(group)) for group in ColorGroup}
    assert sizes[ColorGroup.BROWN] == 2
    assert sizes[ColorGroup.DARK_BLUE] == 2
    assert all(size == 3 for group, size in sizes.items() if group not in (ColorGroup.BROWN, ColorGroup.DARK_BLUE))


@pytest.mark.parametrize("board_id", BOARDS)
def test_corners_are_where_the_rules_expect(board_id: str) -> None:
    board = load_board(board_id)
    assert board.tile(0).kind is TileKind.GO
    assert board.tile(10).kind is TileKind.JAIL
    assert board.tile(20).kind is TileKind.FREE_PARKING
    assert board.tile(30).kind is TileKind.GO_TO_JAIL
    assert board.go_to_jail_target == 10


@pytest.mark.parametrize("board_id", BOARDS)
def test_mortgage_is_half_the_price(board_id: str) -> None:
    board = load_board(board_id)
    for tile in board.tiles:
        if tile.is_ownable:
            assert tile.price is not None and tile.mortgage == tile.price // 2, tile.name_key


@pytest.mark.parametrize("board_id", BOARDS)
def test_rent_rises_monotonically_with_development(board_id: str) -> None:
    board = load_board(board_id)
    for tile in board.tiles:
        if tile.kind is TileKind.PROPERTY:
            assert list(tile.rent) == sorted(tile.rent), tile.name_key
            assert len(set(tile.rent)) == len(tile.rent), tile.name_key


@pytest.mark.parametrize("board_id", BOARDS)
def test_prices_rise_around_the_board(board_id: str) -> None:
    """Properties get more expensive clockwise — a design invariant of the layout."""
    board = load_board(board_id)
    prices = [tile.price for tile in board.tiles if tile.kind is TileKind.PROPERTY and tile.price is not None]
    assert prices == sorted(prices)
    assert prices[0] == 60
    assert prices[-1] == 400


@pytest.mark.parametrize("board_id", BOARDS)
def test_railroads_and_utilities_use_the_standard_schedule(board_id: str) -> None:
    board = load_board(board_id)
    for index in board.indexes_of_kind(TileKind.RAILROAD):
        assert board.tile(index).price == 200
        assert board.tile(index).rent == (25, 50, 100, 200)
    for index in board.indexes_of_kind(TileKind.UTILITY):
        assert board.tile(index).price == 150
        assert board.tile(index).rent == (4, 10)


def test_the_two_boards_are_economically_identical() -> None:
    """Only the names differ. This is what keeps one ruleset valid for both boards."""
    classic, israel = load_board("classic"), load_board("israel")
    for left, right in zip(classic.tiles, israel.tiles, strict=True):
        assert left.model_dump(exclude={"name_key"}) == right.model_dump(exclude={"name_key"})
        assert left.name_key != right.name_key


@pytest.mark.parametrize("board_id", BOARDS)
def test_name_keys_are_namespaced_and_unique(board_id: str) -> None:
    board = load_board(board_id)
    keys = [tile.name_key for tile in board.tiles]
    assert len(set(keys)) == BOARD_SIZE
    assert all(key.startswith(f"tile.{board_id}.") for key in keys)


def test_unknown_board_is_rejected() -> None:
    with pytest.raises(BoardDataError, match="unknown board"):
        load_board("atlantis")


def test_loader_caches() -> None:
    assert load_board("classic") is load_board("classic")


# --- Model-level validation ------------------------------------------------


def test_property_without_group_is_rejected() -> None:
    with pytest.raises(ValidationError, match="colour group"):
        Tile(
            index=1,
            kind=TileKind.PROPERTY,
            name_key="t",
            price=60,
            rent=(1, 2, 3, 4, 5, 6),
            house_cost=50,
            mortgage=30,
        )


def test_wrong_rent_length_is_rejected() -> None:
    with pytest.raises(ValidationError, match="needs 4 rent entries"):
        Tile(index=5, kind=TileKind.RAILROAD, name_key="t", price=200, rent=(25, 50), mortgage=100)


def test_group_on_a_non_property_is_rejected() -> None:
    with pytest.raises(ValidationError, match="must not carry a colour group"):
        Tile(index=12, kind=TileKind.UTILITY, name_key="t", price=150, rent=(4, 10), mortgage=75, group=ColorGroup.PINK)


def test_tax_field_is_required_only_on_tax_tiles() -> None:
    with pytest.raises(ValidationError, match="`tax` is required"):
        Tile(index=4, kind=TileKind.TAX, name_key="t")
    with pytest.raises(ValidationError, match="`tax` is required"):
        Tile(index=20, kind=TileKind.FREE_PARKING, name_key="t", tax=100)


def test_short_board_is_rejected() -> None:
    with pytest.raises(BoardDataError, match="expected 40 tiles"):
        Board(id="stub", name_key="b", tiles=(Tile(index=0, kind=TileKind.GO, name_key="go"),))


# --- catalogue_ready (MON-419) -------------------------------------------------


@pytest.mark.parametrize("board_id", BOARDS)
def test_every_shipped_board_declares_its_catalogue_ready(board_id: str) -> None:
    """Both boards have verified names in both languages, so both may be offered.

    The flag itself is *declared*, so this only says what the data claims. Whether the claim is
    true is cross-checked against the actual catalogues in ``tests/test_key_contract.py``, which is
    the only place that can read both sides.
    """
    assert load_board(board_id).catalogue_ready is True


def test_a_board_that_says_nothing_is_not_offered() -> None:
    """The default is the safe one: an undeclared board is hidden, not painted blank (G-46).

    The failure this prevents is a new board reaching the picker before its names do — which is
    what happened to the Israeli layout, and what the dossier and the event log still carry
    ``i18n.exists`` guards for.
    """
    tiles = load_board("classic").tiles
    assert Board(id="undeclared", name_key="board.undeclared.name", tiles=tiles).catalogue_ready is False
