"""MON-102 — dispatch, the cash ledger, dice, movement and turn handover."""

from __future__ import annotations

import pytest

from helpers import make_player, make_state
from kesef_engine.board.models import TileKind
from kesef_engine.commands import EndTurn, RollDice
from kesef_engine.errors import IllegalCommandError
from kesef_engine.events import CashChanged, DiceRolled, PhaseChanged, SentToJail, TokenMoved, TurnStarted
from kesef_engine.phases import TRANSIENT_PHASES, Phase
from kesef_engine.primitives import CashReason
from kesef_engine.reducer import apply
from kesef_engine.rng import Rng
from kesef_engine.state import GameState, PropertyState

# Deterministic seed archaeology: the tests need known dice, so they search the
# splitmix64 stream once, here, instead of hardcoding magic seeds that rot silently.
_DOUBLES_SEED = next(seed for seed in range(1000) if (r := Rng(seed=seed).roll_dice())[0] == r[1])
_PLAIN_SEED = next(seed for seed in range(1000) if (r := Rng(seed=seed).roll_dice())[0] != r[1])


def _own_everything(player_id: int) -> dict[int, PropertyState]:
    """Every ownable tile owned by ``player_id`` — landing anywhere ownable is inert."""
    board = make_state().board
    return {tile.index: PropertyState(owner=player_id) for tile in board.tiles if tile.is_ownable}


def _roll_total(seed: int) -> int:
    first, second, _ = Rng(seed=seed).roll_dice()
    return first + second


def test_a_plain_roll_moves_the_token_and_awaits_end_turn() -> None:
    state = make_state(seed=_PLAIN_SEED, properties=_own_everything(0))
    new_state, events = apply(state, RollDice(player=0))
    total = _roll_total(_PLAIN_SEED)
    assert new_state.phase is Phase.AWAITING_END_TURN
    assert new_state.player(0).position == total
    rolled = next(e for e in events if isinstance(e, DiceRolled))
    assert (rolled.total, rolled.purpose, rolled.doubles_streak) == (total, "move", 0)
    moved = next(e for e in events if isinstance(e, TokenMoved))
    assert (moved.from_tile, moved.to_tile, moved.forward, moved.passed_go) == (0, total, True, False)


def test_a_doubles_roll_grants_another_roll() -> None:
    state = make_state(seed=_DOUBLES_SEED, properties=_own_everything(0))
    new_state, _ = apply(state, RollDice(player=0))
    assert new_state.phase is Phase.AWAITING_ROLL
    assert new_state.doubles_streak == 1


def test_passing_go_pays_the_salary_as_exactly_one_ledger_entry() -> None:
    seats = (make_player(0, position=39), make_player(1))
    state = make_state(seats=seats, seed=_PLAIN_SEED, properties=_own_everything(0))
    new_state, events = apply(state, RollDice(player=0))
    cash_events = [e for e in events if isinstance(e, CashChanged)]
    assert len(cash_events) == 1
    (salary,) = cash_events
    assert salary.player == 0
    assert salary.delta == 200
    assert salary.reason is CashReason.GO_SALARY
    assert salary.counterparty == "bank"
    assert salary.balance == 1700 == new_state.player(0).cash
    moved = next(e for e in events if isinstance(e, TokenMoved))
    assert moved.passed_go is True
    assert new_state.player(0).position == (39 + _roll_total(_PLAIN_SEED)) % 40


def test_not_passing_go_pays_nothing() -> None:
    state = make_state(seed=_PLAIN_SEED, properties=_own_everything(0))
    _, events = apply(state, RollDice(player=0))
    assert not [e for e in events if isinstance(e, CashChanged)]


def test_third_consecutive_double_jails_without_moving() -> None:
    seats = (make_player(0, position=7), make_player(1))
    state = make_state(seats=seats, seed=_DOUBLES_SEED, properties=_own_everything(0))
    state = GameState(**{**dict(state), "doubles_streak": 2})
    new_state, events = apply(state, RollDice(player=0))
    jail_tile = state.board.indexes_of_kind(TileKind.JAIL)[0]
    assert next(e for e in events if isinstance(e, SentToJail)).via == "three_doubles"
    assert not [e for e in events if isinstance(e, TokenMoved)], "the third roll's movement must not happen"
    assert not [e for e in events if isinstance(e, CashChanged)], "going to jail is not passing GO"
    assert new_state.player(0).in_jail
    assert new_state.player(0).position == jail_tile
    assert new_state.doubles_streak == 0
    assert new_state.phase is Phase.AWAITING_END_TURN
    rolled = next(e for e in events if isinstance(e, DiceRolled))
    assert rolled.doubles_streak == 3, "the event narrates the third double"


def test_end_turn_hands_the_seat_on_and_resets_the_turn_state() -> None:
    state = make_state(phase=Phase.AWAITING_END_TURN)
    new_state, events = apply(state, EndTurn(player=0))
    assert new_state.current_player_id == 1
    assert new_state.turn_number == 2
    assert new_state.phase is Phase.AWAITING_ROLL
    assert new_state.doubles_streak == 0
    assert new_state.dice is None
    started = next(e for e in events if isinstance(e, TurnStarted))
    assert (started.player, started.turn_number) == (1, 2)


def test_end_turn_skips_bankrupt_seats() -> None:
    seats = (make_player(0), make_player(1, cash=0, bankrupt=True), make_player(2))
    state = make_state(seats=seats, phase=Phase.AWAITING_END_TURN)
    state = GameState(**{**dict(state), "elimination_order": (1,)})
    new_state, _ = apply(state, EndTurn(player=0))
    assert new_state.current_player_id == 2


def test_end_turn_routes_a_jailed_player_to_the_jail_decision() -> None:
    seats = (make_player(0), make_player(1, position=10, in_jail=True))
    state = make_state(seats=seats, phase=Phase.AWAITING_END_TURN)
    new_state, _ = apply(state, EndTurn(player=0))
    assert new_state.phase is Phase.JAIL_DECISION
    assert new_state.current_player_id == 1


def test_end_turn_accumulates_the_caller_stamped_clock() -> None:
    state = make_state(phase=Phase.AWAITING_END_TURN)
    new_state, _ = apply(state, EndTurn(player=0, elapsed_seconds=90))
    assert new_state.elapsed_seconds == 90


def test_an_illegal_command_raises_with_the_is_legal_reason() -> None:
    state = make_state()  # AWAITING_ROLL
    with pytest.raises(IllegalCommandError) as excinfo:
        apply(state, EndTurn(player=0))
    assert excinfo.value.reason_key == "error.wrong_phase"
    with pytest.raises(IllegalCommandError) as excinfo:
        apply(state, RollDice(player=1))
    assert excinfo.value.reason_key == "error.not_your_turn"


def test_the_returned_state_never_rests_in_a_transient_phase() -> None:
    state = make_state(seed=_PLAIN_SEED, properties=_own_everything(0))
    new_state, _ = apply(state, RollDice(player=0))
    assert new_state.phase not in TRANSIENT_PHASES


def test_landing_on_your_own_tile_is_inert() -> None:
    state = make_state(seed=_PLAIN_SEED, properties=_own_everything(0))
    _, events = apply(state, RollDice(player=0))
    assert not [e for e in events if isinstance(e, CashChanged)]


def test_a_phase_change_is_narrated_once_from_entry_to_rest() -> None:
    state = make_state(seed=_PLAIN_SEED, properties=_own_everything(0))
    _, events = apply(state, RollDice(player=0))
    changes = [e for e in events if isinstance(e, PhaseChanged)]
    assert len(changes) == 1
    assert (changes[0].previous, changes[0].current) == (Phase.AWAITING_ROLL, Phase.AWAITING_END_TURN)
    assert events[-1] == changes[0]


def test_apply_is_pure_the_input_state_is_untouched() -> None:
    state = make_state(seed=_PLAIN_SEED, properties=_own_everything(0))
    snapshot = state.model_dump_json()
    apply(state, RollDice(player=0))
    assert state.model_dump_json() == snapshot
