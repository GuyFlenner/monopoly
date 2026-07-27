"""Endgame (M1 slice of MON-208): last solvent player wins.

Evaluated only when the interrupt stack is empty (GAP G-8) — a bankruptcy inside a
nested interrupt must drain before anyone is declared a winner. TODO(MON-208): the Kids
Mode time limit and the ``no_survivors`` cascade ending.
"""

from __future__ import annotations

from kesef_engine.events import Event, GameEnded, PlayerStanding
from kesef_engine.phases import Phase
from kesef_engine.state import GameState


def maybe_end(state: GameState) -> tuple[GameState, tuple[Event, ...]]:
    if state.interrupts or len(state.solvent_players) > 1:
        return state, ()
    winner = state.solvent_players[0].id
    standings = final_standings(state)
    state = state._replace(phase=Phase.GAME_OVER, winner=winner)
    return state, (GameEnded(winner=winner, reason="last_solvent", final_standings=standings),)


def final_standings(state: GameState) -> tuple[PlayerStanding, ...]:
    """Ranked, named, self-contained (GAP G-B5).

    Solvent players rank by net worth (seat order breaks ties); bankrupt players all sit
    at zero, so the elimination order breaks *their* ties — the later you fell, the
    higher you finish.
    """
    seat_order = {player.id: index for index, player in enumerate(state.players)}
    solvent = sorted(state.solvent_players, key=lambda player: (-state.net_worth(player.id), seat_order[player.id]))
    eliminated = {player_id: position for position, player_id in enumerate(state.elimination_order)}
    bankrupt = sorted(
        (player for player in state.players if player.bankrupt),
        key=lambda player: (-eliminated.get(player.id, -1), seat_order[player.id]),
    )
    ranked = [(player.id, state.net_worth(player.id)) for player in solvent]
    ranked += [(player.id, 0) for player in bankrupt]
    return tuple(
        PlayerStanding(player=player_id, net_worth=worth, rank=rank)
        for rank, (player_id, worth) in enumerate(ranked, start=1)
    )
