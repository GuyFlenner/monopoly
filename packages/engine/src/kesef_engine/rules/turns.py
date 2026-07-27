"""Turn handover (MON-102).

Bankrupt seats are skipped here, at the single point where the seat moves — which is
what makes "a state whose current player is bankrupt" unreachable (GAP G-14): the
insolvency module calls the same helper when the current player goes under.
"""

from __future__ import annotations

from kesef_engine.commands import EndTurn
from kesef_engine.events import Event, TurnStarted
from kesef_engine.phases import Phase
from kesef_engine.rules import endgame
from kesef_engine.state import GameState


def handle_end_turn(state: GameState, command: EndTurn) -> tuple[GameState, tuple[Event, ...]]:
    if command.elapsed_seconds is not None:
        # Caller-stamped wall clock, forced monotone here so a caller that stamps a stale
        # value cannot rewind the clock (GAP G-6). MON-208 reads it, never sets it.
        state = state._replace(elapsed_seconds=max(state.elapsed_seconds, command.elapsed_seconds))
    if endgame.time_is_up(state):
        # Kids Mode's clock ran out as this turn closed, so the seat is not handed on —
        # otherwise the log would announce a turn nobody gets to play. The *ending* is
        # still declared in one place only, the reducer's post-command hook (MON-208).
        return state, ()
    return advance_turn(state)


def advance_turn(state: GameState) -> tuple[GameState, tuple[Event, ...]]:
    """Hand the seat to the next solvent player and start their turn."""
    seat_count = len(state.players)
    for offset in range(1, seat_count + 1):
        candidate = state.players[(state.current_seat_index + offset) % seat_count]
        if not candidate.bankrupt:
            break
    else:  # pragma: no cover - the state model guarantees at least one solvent seat pre-GAME_OVER
        raise AssertionError("no solvent player to advance to")
    state = state._replace(
        current_player_id=candidate.id,
        turn_number=state.turn_number + 1,
        doubles_streak=0,
        dice=None,
        phase=Phase.JAIL_DECISION if candidate.in_jail else Phase.AWAITING_ROLL,
    )
    return state, (TurnStarted(player=candidate.id, turn_number=state.turn_number),)
