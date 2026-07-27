"""Dice and movement (MON-102).

The rules everyone gets wrong live here, named: three consecutive doubles go to jail and
the third roll's movement does not happen (spec §3.6 trap 7); passing GO pays the salary
but going to jail is never passing GO (trap 10).
"""

from __future__ import annotations

from typing import Literal

from kesef_engine.board.models import BOARD_SIZE
from kesef_engine.commands import RollDice
from kesef_engine.events import DiceRolled, Event, TokenMoved
from kesef_engine.phases import Phase
from kesef_engine.primitives import CashReason, PlayerId
from kesef_engine.rules import tiles
from kesef_engine.rules.cash import move_cash
from kesef_engine.rules.common import send_to_jail, update_player
from kesef_engine.state import DiceState, GameState

THREE_DOUBLES = 3


def roll(
    state: GameState, player_id: PlayerId, *, purpose: Literal["move", "jail", "rent"], doubles_streak: int
) -> tuple[GameState, DiceState, tuple[Event, ...]]:
    """Roll two dice from ``state.rng`` — the only randomness source (rule 3).

    ``doubles_streak`` is what the event narrates; the *caller* decides whether the roll
    changes the streak, because a jail or rent roll must not (GAP G-10).
    """
    first, second, rng = state.rng.roll_dice()
    dice = DiceState(first=first, second=second, purpose=purpose)
    event = DiceRolled(
        player=player_id,
        first=first,
        second=second,
        total=dice.total,
        doubles_streak=doubles_streak,
        purpose=purpose,
    )
    return state._replace(rng=rng, dice=dice), dice, (event,)


def move_token(state: GameState, player_id: PlayerId, total: int) -> tuple[GameState, tuple[Event, ...]]:
    """Advance the token, paying the GO salary on the way past (or onto) GO."""
    origin = state.player(player_id).position
    destination = (origin + total) % BOARD_SIZE
    passed_go = origin + total >= BOARD_SIZE
    state = update_player(state, player_id, position=destination)
    events: list[Event] = [
        TokenMoved(player=player_id, from_tile=origin, to_tile=destination, forward=True, passed_go=passed_go)
    ]
    if passed_go:
        salary = state.ruleset.go_salary
        if destination == 0 and state.ruleset.double_salary_on_exact_go:
            salary *= 2  # house rule, off under the official rules (ADR-004)
        state, paid = move_cash(state, source="bank", dest=player_id, amount=salary, reason=CashReason.GO_SALARY)
        events.extend(paid)
    return state, tuple(events)


def handle_roll_dice(state: GameState, command: RollDice) -> tuple[GameState, tuple[Event, ...]]:
    player_id = command.player
    first, second, rng = state.rng.roll_dice()
    dice = DiceState(first=first, second=second, purpose="move")
    # The streak belongs to the turn and only a *move* roll changes it (GAP G-10).
    streak = state.doubles_streak + 1 if dice.is_doubles else 0
    state = state._replace(rng=rng, dice=dice)
    all_events: list[Event] = [
        DiceRolled(
            player=player_id, first=first, second=second, total=dice.total, doubles_streak=streak, purpose="move"
        )
    ]
    if streak >= THREE_DOUBLES:
        # Trap 7: jail, and the third roll's movement does NOT happen.
        state, jailed = send_to_jail(state, player_id, via="three_doubles")
        all_events.extend(jailed)
        return state._replace(phase=Phase.AWAITING_END_TURN), tuple(all_events)
    state = state._replace(doubles_streak=streak)
    state, moved = move_token(state, player_id, dice.total)
    all_events.extend(moved)
    state, resolved = tiles.resolve_landing(state, player_id)
    all_events.extend(resolved)
    return state, tuple(all_events)
