"""Auction bidding and resolution (M1 slice with MON-103; MON-203 owns the full rules)."""

from __future__ import annotations

from kesef_engine.commands import Command
from kesef_engine.events import Event
from kesef_engine.state import GameState


def act(state: GameState, command: Command) -> tuple[GameState, tuple[Event, ...]]:
    raise NotImplementedError("TODO(MON-103): bids, withdrawals and the raising commands")
