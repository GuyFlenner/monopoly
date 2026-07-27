"""Rent (MON-104). The single most-often-wrong area, so every branch is a named test."""

from __future__ import annotations

from kesef_engine.events import Event
from kesef_engine.primitives import PlayerId, TileIndex
from kesef_engine.rules.common import post_move_phase
from kesef_engine.state import GameState


def charge(state: GameState, payer_id: PlayerId, tile_index: TileIndex) -> tuple[GameState, tuple[Event, ...]]:
    """Charge ``payer_id`` for standing on another player's ``tile_index``.

    Returns a state resting in its final phase (the charge can open a DebtFrame).
    TODO(MON-104): tier rent, full-group doubling, railroads, utilities, mortgage and
    bankrupt-owner exemptions — landing on an owned tile is inert until then.
    """
    return state._replace(phase=post_move_phase(state, payer_id)), ()
