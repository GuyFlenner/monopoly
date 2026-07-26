"""What can be done right now.

This is the most important function in the project for UI quality. The client does not
decide whether the Build button is enabled — it asks here, and renders what it is told.
That single inversion removes the classic bug family where the UI and the rules disagree
about what is allowed, and it means a bot and a human are offered exactly the same moves.

Two guarantees the implementation must hold, both covered by property tests:

1. Every command returned is accepted by :func:`kesef_engine.reducer.apply`.
2. Any command *not* returned is rejected by it.
"""

from __future__ import annotations

from kesef_engine.commands import Command
from kesef_engine.state import GameState


def legal_commands(state: GameState) -> tuple[Command, ...]:
    """Every command that is legal in ``state``, for every player who may act.

    Includes concrete parameters — ``BuildHouse(tile=16)``, not "you may build
    somewhere" — so the UI can bind a button straight to a command. Unbounded parameter
    spaces are the one exception: :class:`kesef_engine.commands.PlaceBid` is returned with
    the minimum legal bid, and :class:`kesef_engine.commands.ProposeTrade` is not
    enumerated at all (the trade builder validates its own draft via
    :func:`is_legal`).
    """
    raise NotImplementedError("MON-101: legality enumeration — see docs/BACKLOG.md")


def is_legal(state: GameState, command: Command) -> bool:
    """Whether one specific command is legal. Used for the un-enumerable commands."""
    raise NotImplementedError("MON-101: legality check — see docs/BACKLOG.md")
