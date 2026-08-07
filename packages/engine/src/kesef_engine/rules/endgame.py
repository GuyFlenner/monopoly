"""Endgame (MON-208): who has won, and when the question is even asked.

Three ways a game ends, and the order between them is the rule:

1. **No survivors** — the official mortgage transfer fee can cascade onto the creditor
   (GAP G-13), so the last two players can leave together. ``GameEnded.winner`` is None.
2. **Last solvent player** — the ordinary ending.
3. **The clock** — Kids Mode's ``Ruleset.target_duration_minutes``. Net worth decides,
   because the point of the rule is to stop while it is still fun rather than to play a
   property game to its natural end.

Solvency comes first because it is the *stronger* fact: a game with one player left is
over whatever the clock says, and calling that ``time_limit`` would file a bankruptcy win
under the wrong reason on the results screen.

**The engine still owns no clock.** ``elapsed_seconds`` is stamped by the caller on
``EndTurn`` and accumulates on the state (GAP G-6); :func:`time_is_up` only compares two
integers that are already part of the saved game. Replaying the same commands therefore
ends the same game at the same moment, which is what keeps the goldens meaningful.

**When the question is asked.** Once, per command, from
:func:`kesef_engine.rules.insolvency.close_command`, and only when the interrupt
stack is empty (G-8) — a bankruptcy inside a nested interrupt has to drain first, or a
two-player bankruptcy to the bank freezes on an estate auction nobody may bid in.
:func:`kesef_engine.rules.turns.handle_end_turn` consults :func:`time_is_up` before it
hands the seat on, so a game that ends on the clock does not first announce a turn nobody
plays; the *ending* itself still happens in one place only.
"""

from __future__ import annotations

from typing import Literal

from kesef_engine.events import Event, GameEnded, PlayerStanding
from kesef_engine.phases import Phase
from kesef_engine.primitives import PlayerId
from kesef_engine.state import GameState

SECONDS_PER_MINUTE = 60

EndReason = Literal["last_solvent", "time_limit", "no_survivors"]
"""The three endings the engine can reach. ``GameEnded.reason`` also admits
``"concession"``, which needs a resign command the engine does not yet have (GAP §1 minor)."""


def time_is_up(state: GameState) -> bool:
    """Whether Kids Mode's time limit has been reached, per the caller-stamped clock.

    False whenever ``target_duration_minutes`` is None, which is every ruleset but Kids
    Mode — so the universal game has no time ending at all rather than an unreachable one.
    """
    limit = state.ruleset.target_duration_minutes
    if limit is None:
        return False
    return state.elapsed_seconds >= limit * SECONDS_PER_MINUTE


def maybe_end(state: GameState) -> tuple[GameState, tuple[Event, ...]]:
    """Declare the game over if it is. A no-op — no state change, no events — if not."""
    if state.interrupts:
        return state, ()
    solvent = state.solvent_players
    standings = final_standings(state)
    if not solvent:
        return _end(state, winner=None, reason="no_survivors", standings=standings)
    if len(solvent) == 1:
        return _end(state, winner=solvent[0].id, reason="last_solvent", standings=standings)
    if time_is_up(state):
        # ``standings`` already ranks the solvent players by net worth ahead of every
        # bankrupt one, so the richest survivor is simply the top line. Deriving the winner
        # from the table the results screen shows keeps the two from ever disagreeing.
        return _end(state, winner=standings[0].player, reason="time_limit", standings=standings)
    return state, ()


def _end(
    state: GameState,
    *,
    winner: PlayerId | None,
    reason: EndReason,
    standings: tuple[PlayerStanding, ...],
) -> tuple[GameState, tuple[Event, ...]]:
    state = state._replace(phase=Phase.GAME_OVER, winner=winner)
    return state, (GameEnded(winner=winner, reason=reason, final_standings=standings),)


def final_standings(state: GameState) -> tuple[PlayerStanding, ...]:
    """Ranked, named, self-contained (GAP G-B5).

    Solvent players rank by :meth:`~kesef_engine.state.GameState.net_worth` (seat order
    breaks ties); a **mortgaged property contributes nothing** to that figure — the deed is
    pledged, so counting it would let a player borrow their way up the table (decided at
    MON-208, enforced in ``GameState.net_worth`` and cited in its docstring).

    Bankrupt players all sit at zero, so the elimination order breaks *their* ties: the
    later you fell, the higher you finish. Without it every bankrupt seat tied and the
    table could not be ranked at all (GAP §1 minor, promoted into the ADR-007 rework).
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
