"""Shared state-editing helpers for the rule modules.

Every helper returns a *validated* new state: players and properties are rebuilt through
their constructors, never ``model_copy(update=...)``, so a rule cannot assemble a state
that no save file could restore (the same discipline as ``GameState._replace``).
"""

from __future__ import annotations

from typing import Any, Literal

from kesef_engine.board.models import TileKind
from kesef_engine.events import Event, SentToJail
from kesef_engine.phases import Phase
from kesef_engine.primitives import PlayerId, TileIndex
from kesef_engine.state import GameState, PlayerState, PropertyState


def update_player(state: GameState, player_id: PlayerId, **changes: Any) -> GameState:
    players = tuple(
        PlayerState(**{**dict(player), **changes}) if player.id == player_id else player for player in state.players
    )
    return state._replace(players=players)


def update_property(state: GameState, tile: TileIndex, **changes: Any) -> GameState:
    properties = tuple(
        PropertyState(**{**dict(prop), **changes}) if index == tile else prop
        for index, prop in enumerate(state.properties)
    )
    return state._replace(properties=properties)


def send_to_jail(
    state: GameState, player_id: PlayerId, via: Literal["tile", "card", "three_doubles"]
) -> tuple[GameState, tuple[Event, ...]]:
    """Straight to jail: no movement along the board, no salary (spec §3.6 trap 10),
    and the doubles streak dies with the turn. Lives here rather than in ``movement``
    because both the mover (three doubles) and the tile router (GO_TO_JAIL) need it.
    """
    jail_tile = state.board.indexes_of_kind(TileKind.JAIL)[0]
    state = update_player(state, player_id, position=jail_tile, in_jail=True, jail_turns=0)
    state = state._replace(doubles_streak=0)
    return state, (SentToJail(player=player_id, via=via),)


def post_move_phase(state: GameState, player_id: PlayerId) -> Phase:
    """Where the turn rests once the landed tile is fully resolved.

    Doubles grant another roll (MON-102) — but only a *move* roll: a doubles roll out of
    jail moves the token without granting another turn (``purpose == "jail"``, GAP G-10),
    and a player sent to jail rolls nothing more this turn.
    """
    if state.player(player_id).in_jail:
        return Phase.AWAITING_END_TURN
    dice = state.dice
    if dice is not None and dice.purpose == "move" and dice.is_doubles:
        return Phase.AWAITING_ROLL
    return Phase.AWAITING_END_TURN
