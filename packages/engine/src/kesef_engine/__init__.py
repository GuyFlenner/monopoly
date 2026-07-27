"""kesef-engine — a deterministic, UI-agnostic rules core for a property-trading board game.

Three rules govern everything in this package:

1. **No I/O.** The engine reads its own bundled board JSON and nothing else. No HTTP,
   no sockets, no printing, no clocks.
2. **No prose.** The engine never returns human-readable text — only i18n *keys*
   (``tile.classic.boardwalk``, ``error.not_your_turn``). This is what makes the
   English and Hebrew builds correct by construction rather than by translation sweep.
3. **Deterministic.** Randomness lives in :class:`kesef_engine.rng.Rng`, which is part
   of the serialized state. Same seed plus same commands always means the same game,
   which is what buys us save/load, replay, regression tests and bot rollouts.

The public surface is deliberately tiny::

    state = new_game(config)
    legal = legal_commands(state)
    state, events = apply(state, command)
"""

from kesef_engine.board.loader import available_boards, load_board
from kesef_engine.board.models import Board, ColorGroup, Tile, TileKind
from kesef_engine.errors import IllegalCommandError
from kesef_engine.factory import Seat, new_game
from kesef_engine.rng import Rng

__all__ = [
    "Board",
    "ColorGroup",
    "IllegalCommandError",
    "Rng",
    "Seat",
    "Tile",
    "TileKind",
    "available_boards",
    "load_board",
    "new_game",
]
