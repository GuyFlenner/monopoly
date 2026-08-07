"""kesef-engine — a deterministic, UI-agnostic rules core for a property-trading board game.

Three rules govern everything in this package:

1. **No I/O.** The engine reads its own bundled board JSON and nothing else. No HTTP,
   no sockets, no printing, no clocks — except at the developer-surface entry points
   ADR-003 §7 names (``cli.py``, ``goldens/__main__.py``), which exist to be run by a
   programmer at a terminal and print key ids verbatim rather than resolving them.
2. **No prose.** The engine never returns human-readable text — only i18n *keys*
   (``tile.classic.boardwalk``, ``error.not_your_turn``). This is what makes the
   English and Hebrew builds correct by construction rather than by translation sweep.
3. **Deterministic.** Randomness lives in :class:`kesef_engine.rng.Rng`, which is part
   of the serialized state. Same seed plus same commands always means the same game,
   which is what buys us save/load, replay, regression tests and bot rollouts.

The public surface is deliberately tiny::

    state = new_game([Seat(name="Ada"), Seat(name="Boaz")], seed=42)
    legal = legal_commands(state)
    state, events = apply(state, legal[0])

Every name in that example is exported below, and ``test_public_surface.py`` runs the block
as written — an example that names something ``__all__`` does not carry is a first page that
does not work, which is how ``apply`` and ``legal_commands`` came to be demonstrated here and
importable only from their own modules (MON-740).
"""

from kesef_engine.board.loader import available_boards, load_board
from kesef_engine.board.models import Board, ColorGroup, Tile, TileKind
from kesef_engine.commands import Command
from kesef_engine.errors import IllegalCommandError
from kesef_engine.events import Event
from kesef_engine.factory import Seat, new_game
from kesef_engine.legality import legal_commands
from kesef_engine.reducer import apply
from kesef_engine.rng import Rng
from kesef_engine.state import GameState

__all__ = [
    "Board",
    "ColorGroup",
    "Command",
    "Event",
    "GameState",
    "IllegalCommandError",
    "Rng",
    "Seat",
    "Tile",
    "TileKind",
    "apply",
    "available_boards",
    "legal_commands",
    "load_board",
    "new_game",
]
