"""Purchase and decline (MON-103)."""

from __future__ import annotations

from kesef_engine.commands import Command
from kesef_engine.events import Event
from kesef_engine.state import GameState


def decide(state: GameState, command: Command) -> tuple[GameState, tuple[Event, ...]]:
    raise NotImplementedError("TODO(MON-103): buy at list price, or decline into an auction")
