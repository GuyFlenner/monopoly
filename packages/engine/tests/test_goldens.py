"""MON-107 — the golden-game regression net.

Each committed golden replays its recorded commands from ``new_game`` and must land on
the *exact* recorded final state plus the recorded event projection. The regenerator
(``python -m kesef_engine.goldens --regenerate``) is a separate entry point this module
never imports; CI additionally fails on any uncommitted diff under ``tests/goldens/``,
so regeneration is always a visible, reviewed act.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import TypeAdapter

from kesef_engine.commands import Command
from kesef_engine.events import (
    CashChanged,
    DiceRolled,
    Event,
    MortgageChanged,
    PhaseChanged,
    RentCharged,
    SentToJail,
    TokenMoved,
)
from kesef_engine.factory import Seat, new_game
from kesef_engine.primitives import CashReason
from kesef_engine.reducer import apply_all
from kesef_engine.ruleset import Ruleset
from kesef_engine.state import GameState

GOLDENS_DIR = Path(__file__).parent / "goldens"
GOLDEN_PATHS = sorted(path for path in GOLDENS_DIR.glob("*.json") if path.name != "traps.json")
GOLDEN_NAMES = [path.stem for path in GOLDEN_PATHS]
M1_TRAPS = {"1", "2", "7", "9", "10"}  # spec §3.6; 3-6 and 8 arrive with the M2 modules

_COMMANDS: TypeAdapter[Command] = TypeAdapter(Command)


def _load(path: Path) -> dict[str, Any]:
    payload: dict[str, Any] = json.loads(path.read_text(encoding="ascii"))
    return payload


def _replay(golden: dict[str, Any]) -> tuple[GameState, tuple[Event, ...]]:
    state = new_game(
        tuple(Seat.model_validate(seat) for seat in golden["seats"]),
        seed=golden["seed"],
        board_id=golden["board_id"],
        ruleset=Ruleset.model_validate(golden["ruleset"]),
    )
    return apply_all(state, tuple(_COMMANDS.validate_python(command) for command in golden["commands"]))


def _project(event: Event) -> dict[str, Any]:
    """(type, actor, principal amount). Duplicated knowingly from the regenerator —
    the test must not import it; drift between the copies fails the comparison."""
    dumped = event.model_dump(mode="json")
    player = next((dumped[field] for field in ("player", "payer", "debtor", "winner") if field in dumped), None)
    amount = next((dumped[field] for field in ("delta", "amount", "price", "total") if field in dumped), None)
    return {"type": dumped["type"], "player": player, "amount": amount}


def test_at_least_three_goldens_are_committed_and_one_ends_in_bankruptcy() -> None:
    assert len(GOLDEN_PATHS) >= 3
    bankruptcies = [path.stem for path in GOLDEN_PATHS if _load(path)["final_state"]["elimination_order"]]
    assert bankruptcies, "at least one golden must end in a bankruptcy"


@pytest.mark.parametrize("path", GOLDEN_PATHS, ids=GOLDEN_NAMES)
def test_replay_reaches_the_exact_recorded_final_state(path: Path) -> None:
    golden = _load(path)
    final_state, _ = _replay(golden)
    assert json.loads(final_state.model_dump_json()) == golden["final_state"]


@pytest.mark.parametrize("path", GOLDEN_PATHS, ids=GOLDEN_NAMES)
def test_replay_reproduces_the_recorded_event_projection(path: Path) -> None:
    golden = _load(path)
    _, events = _replay(golden)
    assert [_project(event) for event in events] == golden["events"]


@pytest.mark.parametrize("path", GOLDEN_PATHS, ids=GOLDEN_NAMES)
def test_the_recorded_rng_draw_costs_still_hold(path: Path) -> None:
    """A changed dice or shuffle cost is a named failure here, never a mystery golden
    shift: two draws roll the dice, fifteen shuffle a sixteen-card deck."""
    from kesef_engine.rng import Rng

    probe = Rng(seed=1)
    _, _, after_dice = probe.roll_dice()
    _, after_shuffle = probe.shuffled(tuple(range(16)))
    actual = {"dice_roll_draws": after_dice.counter, "deck_shuffle_draws_16": after_shuffle.counter}
    assert _load(path)["rng_costs"] == actual


@pytest.mark.parametrize("path", GOLDEN_PATHS, ids=GOLDEN_NAMES)
def test_the_ledger_balances_on_replay(path: Path) -> None:
    """Every CashChanged balance must equal the running cash it claims — the ledger
    rule (G-60) audited over whole recorded games, not single commands."""
    golden = _load(path)
    running = dict.fromkeys(range(len(golden["seats"])), golden["ruleset"]["starting_cash"])
    _, events = _replay(golden)
    for event in events:
        if isinstance(event, CashChanged):
            running[event.player] += event.delta
            assert running[event.player] == event.balance >= 0


# --- traps.json: every M1-scope §3.6 trap occurred through real play ---------------


def test_traps_json_maps_every_m1_trap() -> None:
    traps = _load(GOLDENS_DIR / "traps.json")
    assert set(traps) == M1_TRAPS
    for entry in traps.values():
        assert entry["golden"] in GOLDEN_NAMES


@pytest.fixture(scope="module")
def replayed() -> dict[str, tuple[Event, ...]]:
    return {path.stem: _replay(_load(path))[1] for path in GOLDEN_PATHS}


def _trap_events(replayed: dict[str, tuple[Event, ...]], trap: str) -> tuple[tuple[Event, ...], int]:
    entry = _load(GOLDENS_DIR / "traps.json")[trap]
    return replayed[entry["golden"]], entry["event_index"]


def test_trap_1_undeveloped_rent_doubles_on_a_full_group(replayed: dict[str, tuple[Event, ...]]) -> None:
    events, index = _trap_events(replayed, "1")
    rent = events[index]
    assert isinstance(rent, RentCharged)
    assert (rent.multiplier, rent.houses) == (2, 0)
    assert rent.group is not None
    assert rent.amount == rent.base_rent * 2
    assert "rent.note.full_group_doubled" in rent.note_keys


def test_trap_2_a_mortgaged_property_charges_no_rent(replayed: dict[str, tuple[Event, ...]]) -> None:
    events, index = _trap_events(replayed, "2")
    landing = events[index]
    assert isinstance(landing, TokenMoved)
    flips = [event for event in events[:index] if isinstance(event, MortgageChanged) and event.tile == landing.to_tile]
    assert flips and flips[-1].mortgaged, "the tile was mortgaged when the token arrived"
    for event in events[index + 1 :]:
        if isinstance(event, DiceRolled):
            break
        assert not isinstance(event, RentCharged)
        assert not (isinstance(event, CashChanged) and event.reason is CashReason.RENT)


def test_trap_7_the_third_double_jails_without_moving(replayed: dict[str, tuple[Event, ...]]) -> None:
    events, index = _trap_events(replayed, "7")
    jailed = events[index]
    assert isinstance(jailed, SentToJail)
    assert jailed.via == "three_doubles"
    roll = events[index - 1]
    assert isinstance(roll, DiceRolled)
    assert roll.doubles_streak == 3
    assert roll.first == roll.second


def test_trap_9_utility_rent_multiplies_the_dice(replayed: dict[str, tuple[Event, ...]]) -> None:
    events, index = _trap_events(replayed, "9")
    rent = events[index]
    assert isinstance(rent, RentCharged)
    assert rent.dice_total is not None
    assert rent.multiplier in (4, 10)
    assert rent.amount == rent.multiplier * rent.dice_total


def test_trap_10_going_to_jail_is_not_passing_go(replayed: dict[str, tuple[Event, ...]]) -> None:
    events, index = _trap_events(replayed, "10")
    jailed = events[index]
    assert isinstance(jailed, SentToJail)
    assert jailed.via == "tile"
    for event in events[index:]:
        if isinstance(event, DiceRolled):
            break
        assert not (isinstance(event, CashChanged) and event.reason is CashReason.GO_SALARY)


# --- Coverage floor: what the goldens collectively visit ---------------------------

M1_PHASE_FLOOR = {
    "awaiting_roll",
    "awaiting_end_turn",
    "awaiting_purchase_decision",
    "auction",
    "debt_settlement",
    "jail_decision",
    "game_over",
}
# TRADE_REVIEW joins with MON-204's golden; CARD_RESOLUTION with MON-206's (MON-209
# then raises this floor to "every Phase and CashReason", per the backlog).
M1_REASON_FLOOR = {
    CashReason.GO_SALARY,
    CashReason.RENT,
    CashReason.PURCHASE,
    CashReason.AUCTION_WIN,
    CashReason.TAX,
    CashReason.JAIL_FINE,
    CashReason.BUILD,
    CashReason.SELL_BUILDING,
    CashReason.MORTGAGE,
    CashReason.BANKRUPTCY_TRANSFER,
}


def test_the_goldens_collectively_visit_the_m1_phase_and_reason_floor(
    replayed: dict[str, tuple[Event, ...]],
) -> None:
    phases: set[str] = {"awaiting_roll"}  # every game opens here
    reasons: set[CashReason] = set()
    for events in replayed.values():
        for event in events:
            if isinstance(event, PhaseChanged):
                phases.update((event.previous.value, event.current.value))
            elif isinstance(event, CashChanged):
                reasons.add(event.reason)
    assert phases >= M1_PHASE_FLOOR
    assert reasons >= M1_REASON_FLOOR
