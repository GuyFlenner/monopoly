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

PREFERRED_BOARDS: tuple[str, ...] = ("israel",)
"""Boards to offer *before* the alphabet does, most-preferred first (MON-716).

**The first id this module returns is the board a client with no preference will play.** That is not
an accident of the ordering being read as a default — the setup screen says so in as many words
("falls back to the first the server offered rather than to a hardcoded ``classic``: the list of
boards is the server's to decide"), so the order is part of the answer and this is where the answer
belongs. A default chosen in TypeScript would be a second opinion about the engine's own data.

Why Israel: the app opens in Hebrew, its own name is ``רחוב הכסף``, and its board catalogue was
verified against a photograph (MON-503). The classic board is still offered, still complete, and one
press away — what changes is which one a family gets if they press nothing.

Ids listed here that no longer ship are ignored rather than raising: this is a *preference*, and a
board that has been removed should not take the picker down with it. ``test_board_loader.py`` pins
both halves — that the preferred board leads, and that the rest stay alphabetical."""


def available_boards() -> tuple[str, ...]:
    """Board ids that ship with the engine, in the order a client should offer them.

    :data:`PREFERRED_BOARDS` first (and therefore the default), then everything else alphabetically
    — a stable order either way, because a picker that reshuffles between two reads is a picker
    nobody can describe to somebody else over the phone.
    """
    files = resources.files(_DATA_PACKAGE)
    shipped = {entry.name.removesuffix(".json") for entry in files.iterdir() if entry.name.endswith(".json")}
    preferred = tuple(board_id for board_id in PREFERRED_BOARDS if board_id in shipped)
    return preferred + tuple(sorted(shipped - set(preferred)))


@cache
def load_board(board_id: str) -> Board:
    """Load and validate a bundled board. Cached — boards are immutable."""
    if board_id not in available_boards():
        raise BoardDataError(f"unknown board {board_id!r}; available: {', '.join(available_boards())}")
    raw = (resources.files(_DATA_PACKAGE) / f"{board_id}.json").read_text(encoding="utf-8")
    return Board.model_validate(json.loads(raw))
