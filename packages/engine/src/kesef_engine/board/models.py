"""Board data model.

A board is *data*, not code. Two boards ship with the engine — ``classic`` (the
Atlantic City layout) and ``israel`` (the Israeli-edition city layout) — and they share
identical economics slot for slot. That is deliberate: it means one universal ruleset
stays valid for both, and choosing a board is independent of choosing a language.

Tile names are i18n **keys**. ``tile.classic.boardwalk`` resolves to "Boardwalk" in the
``en`` catalogue and to a Hebrew string in the ``he`` catalogue. The engine never sees
either.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Self

from pydantic import BaseModel, model_validator

from kesef_engine.errors import BoardDataError

BOARD_SIZE = 40
"""Tiles on a board. The universal rules assume 40; the validator enforces it."""


class TileKind(StrEnum):
    """What happens when a token lands here."""

    GO = "go"
    PROPERTY = "property"
    RAILROAD = "railroad"
    UTILITY = "utility"
    CHANCE = "chance"
    COMMUNITY_CHEST = "community_chest"
    TAX = "tax"
    JAIL = "jail"
    """"Just visiting" — landing here is inert; you arrive *in* jail only via GO_TO_JAIL."""
    FREE_PARKING = "free_parking"
    GO_TO_JAIL = "go_to_jail"


class ColorGroup(StrEnum):
    """The eight buildable colour groups.

    Rendering note for the UI: every group must also carry a *pattern or icon*, never
    colour alone — that serves both young children and colourblind players.
    """

    BROWN = "brown"
    LIGHT_BLUE = "light_blue"
    PINK = "pink"
    ORANGE = "orange"
    RED = "red"
    YELLOW = "yellow"
    GREEN = "green"
    DARK_BLUE = "dark_blue"


OWNABLE_KINDS = frozenset({TileKind.PROPERTY, TileKind.RAILROAD, TileKind.UTILITY})


class Tile(BaseModel, frozen=True):
    """One square.

    The meaning of ``rent`` depends on ``kind`` — six numbers for a property, four for
    a railroad, two multipliers for a utility. Packing three shapes into one field is a
    compromise, but the alternative (three tile subclasses) makes the JSON and every
    downstream lookup noticeably more awkward for no correctness gain. The validator
    below enforces the right length per kind, so a malformed board fails at load.

    * ``PROPERTY``  — ``(base, 1 house, 2, 3, 4, hotel)``
    * ``RAILROAD``  — ``(1 owned, 2 owned, 3 owned, 4 owned)``
    * ``UTILITY``   — ``(multiplier with 1 owned, multiplier with 2 owned)`` × dice total
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

    @property
    def is_ownable(self) -> bool:
        return self.kind in OWNABLE_KINDS

    @model_validator(mode="after")
    def _check_shape(self) -> Self:
        expected_rent_len = {TileKind.PROPERTY: 6, TileKind.RAILROAD: 4, TileKind.UTILITY: 2}.get(self.kind, 0)
        if len(self.rent) != expected_rent_len:
            raise ValueError(
                f"tile {self.index} ({self.kind}) needs {expected_rent_len} rent entries, got {len(self.rent)}"
            )
        if self.is_ownable:
            if self.price is None or self.price <= 0:
                raise ValueError(f"tile {self.index} is ownable and needs a positive price")
            if self.mortgage is None:
                raise ValueError(f"tile {self.index} is ownable and needs a mortgage value")
        if self.kind is TileKind.PROPERTY:
            if self.group is None:
                raise ValueError(f"tile {self.index} is a property and needs a colour group")
            if self.house_cost is None or self.house_cost <= 0:
                raise ValueError(f"tile {self.index} is a property and needs a positive house_cost")
        elif self.group is not None:
            raise ValueError(f"tile {self.index} is not a property and must not carry a colour group")
        if (self.kind is TileKind.TAX) != (self.tax is not None):
            raise ValueError(f"tile {self.index}: `tax` is required for TAX tiles and forbidden elsewhere")
        return self


class Board(BaseModel, frozen=True):
    """A complete, validated board layout."""

    id: str
    name_key: str
    tiles: tuple[Tile, ...]

    @model_validator(mode="after")
    def _check_layout(self) -> Self:
        if len(self.tiles) != BOARD_SIZE:
            raise BoardDataError(f"board {self.id!r}: expected {BOARD_SIZE} tiles, got {len(self.tiles)}")
        for position, tile in enumerate(self.tiles):
            if tile.index != position:
                raise BoardDataError(f"board {self.id!r}: tile at position {position} declares index {tile.index}")
        for kind in (TileKind.GO, TileKind.JAIL, TileKind.GO_TO_JAIL, TileKind.FREE_PARKING):
            count = sum(1 for tile in self.tiles if tile.kind is kind)
            if count != 1:
                raise BoardDataError(f"board {self.id!r}: expected exactly one {kind} tile, found {count}")
        for group in ColorGroup:
            size = len(self.group_members(group))
            if size not in (2, 3):
                raise BoardDataError(f"board {self.id!r}: colour group {group} has {size} members, expected 2 or 3")
        keys = [tile.name_key for tile in self.tiles]
        if len(set(keys)) != len(keys):
            raise BoardDataError(f"board {self.id!r}: duplicate name_key values")
        return self

    def tile(self, index: int) -> Tile:
        """The tile at ``index``, wrapping around the board."""
        return self.tiles[index % BOARD_SIZE]

    def group_members(self, group: ColorGroup) -> tuple[int, ...]:
        """Tile indexes belonging to ``group`` — the set you must complete to build."""
        return tuple(tile.index for tile in self.tiles if tile.group is group)

    def indexes_of_kind(self, kind: TileKind) -> tuple[int, ...]:
        return tuple(tile.index for tile in self.tiles if tile.kind is kind)

    @property
    def go_to_jail_target(self) -> int:
        """Where the GO_TO_JAIL tile sends you — the JAIL tile's index."""
        return self.indexes_of_kind(TileKind.JAIL)[0]
