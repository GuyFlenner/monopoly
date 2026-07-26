"""The bot interface."""

from __future__ import annotations

from enum import StrEnum
from typing import Protocol

from kesef_engine.commands import Command, PlayerId
from kesef_engine.state import GameState


class BotLevel(StrEnum):
    EASY = "easy"
    NORMAL = "normal"
    HARD = "hard"


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
