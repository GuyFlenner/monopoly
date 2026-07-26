"""Board loading — the engine's only contact with a filesystem.

Boards are bundled package data read through ``importlib.resources``, so they keep
working from a wheel, a zipapp or a container image.
"""

from __future__ import annotations

import json
from functools import cache
from importlib import resources

from kesef_engine.board.models import Board
from kesef_engine.errors import BoardDataError

_DATA_PACKAGE = "kesef_engine.board.data"


def available_boards() -> tuple[str, ...]:
    """Board ids that ship with the engine, sorted for stable UI ordering."""
    files = resources.files(_DATA_PACKAGE)
    return tuple(sorted(entry.name.removesuffix(".json") for entry in files.iterdir() if entry.name.endswith(".json")))


@cache
def load_board(board_id: str) -> Board:
    """Load and validate a bundled board. Cached — boards are immutable."""
    if board_id not in available_boards():
        raise BoardDataError(f"unknown board {board_id!r}; available: {', '.join(available_boards())}")
    raw = (resources.files(_DATA_PACKAGE) / f"{board_id}.json").read_text(encoding="utf-8")
    return Board.model_validate(json.loads(raw))
