"""The bot interface.

``BotLevel`` is re-exported here for the callers that think in terms of bots, but it is
defined in :mod:`kesef_engine.primitives`: the engine's ``PlayerKind`` and the server's
seat configuration both need it, and neither should have to import the bot package to
name a difficulty (GAP G-19).
"""

from __future__ import annotations

from typing import Protocol

from kesef_engine.commands import Command
from kesef_engine.primitives import BotLevel as BotLevel
from kesef_engine.primitives import PlayerId
from kesef_engine.state import GameState


class Bot(Protocol):
    """Chooses a move. Deterministic given the state it is handed.

    Determinism matters here as much as in the engine: a bot that consulted a global RNG
    would make the golden-game tests non-reproducible. Bots that need randomness draw it
    from ``state.rng.fork(...)``.
    """

    level: BotLevel

    def choose(self, state: GameState, player: PlayerId, legal: tuple[Command, ...]) -> Command:
        """Pick one of ``legal``. Must never return a command outside that tuple."""
        ...
