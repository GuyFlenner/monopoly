"""The session store — the only mutable thing the server owns (ADR-006).

What is worth testing here is the append-only log's sequencing (G-34: without a stable
``seq`` the animation queue cannot tell a replayed event from a new one) and the two
refusals: the cap, and a duplicate ``game_id`` that used to overwrite a live game
silently.
"""

from __future__ import annotations

import pytest
from conftest import FakeClock, minimal_state

from kesef_engine.events import PhaseChanged, TurnStarted
from kesef_engine.phases import Phase
from kesef_server.sessions import (
    DuplicateGameError,
    SessionLimitReachedError,
    SessionStore,
    UnknownGameError,
)


def _store(**overrides: object) -> SessionStore:
    return SessionStore(max_sessions=int(overrides.get("max_sessions", 4)), clock=FakeClock())


def test_a_new_session_has_an_empty_log_and_a_zero_cursor() -> None:
    session = _store().create(minimal_state())
    assert session.log == []
    assert session.cursor == 0


def test_seq_numbers_start_at_one_and_never_restart_across_commands() -> None:
    store = _store()
    store.create(minimal_state())
    first = store.update("g", minimal_state(), (TurnStarted(player=0, turn_number=1),))
    assert [entry.seq for entry in first.log] == [1]
    second = store.update(
        "g",
        minimal_state(),
        (PhaseChanged(previous=Phase.AWAITING_ROLL, current=Phase.MOVING), TurnStarted(player=1, turn_number=2)),
    )
    assert [entry.seq for entry in second.log] == [1, 2, 3]
    assert second.cursor == 3


def test_events_since_a_cursor_excludes_what_the_client_already_has() -> None:
    store = _store()
    store.create(minimal_state())
    store.update("g", minimal_state(), (TurnStarted(player=0, turn_number=1),))
    session = store.update("g", minimal_state(), (TurnStarted(player=1, turn_number=2),))
    assert [entry.seq for entry in session.events_since(0)] == [1, 2]
    assert [entry.seq for entry in session.events_since(1)] == [2]
    assert session.events_since(2) == ()
    assert session.events_since(99) == ()


def test_the_cap_is_enforced() -> None:
    store = SessionStore(max_sessions=0, clock=FakeClock())
    with pytest.raises(SessionLimitReachedError):
        store.create(minimal_state())


def test_a_duplicate_game_id_raises_instead_of_overwriting_a_live_game() -> None:
    store = _store()
    store.create(minimal_state())
    with pytest.raises(DuplicateGameError):
        store.create(minimal_state(turn_number=9))
    assert store.get("g").state.turn_number == 1


def test_an_unknown_game_raises() -> None:
    with pytest.raises(UnknownGameError):
        _store().get("nope")
    with pytest.raises(UnknownGameError):
        _store().update("nope", minimal_state(), ())


def test_delete_frees_a_slot() -> None:
    store = SessionStore(max_sessions=1, clock=FakeClock())
    store.create(minimal_state())
    store.delete("g")
    assert len(store) == 0
    store.create(minimal_state())
    assert len(store) == 1


def test_all_lists_every_live_session() -> None:
    store = _store()
    store.create(minimal_state(game_id="a"))
    store.create(minimal_state(game_id="b"))
    assert {session.state.game_id for session in store.all()} == {"a", "b"}


def test_elapsed_seconds_come_from_the_stores_clock_and_are_floored_at_zero() -> None:
    """The server's one deliberate clock read (MON-301 / GAP G-6)."""
    clock = FakeClock()
    store = SessionStore(max_sessions=4, clock=clock)
    session = store.create(minimal_state())
    assert store.elapsed_seconds(session) == 0
    clock.advance(90.7)
    assert store.elapsed_seconds(session) == 90
    clock.now = -5.0
    assert store.elapsed_seconds(session) == 0


def test_subscribers_receive_appended_events_and_unsubscribe_cleanly() -> None:
    """MON-303's fan-out seam. A dropped client must not leave a queue behind."""
    store = _store()
    session = store.create(minimal_state())
    with session.subscribe() as queue:
        store.update("g", minimal_state(), (TurnStarted(player=0, turn_number=1),))
        assert queue.get_nowait().seq == 1
    assert session.subscribers == ()


def test_events_are_logged_even_with_no_subscribers() -> None:
    store = _store()
    store.create(minimal_state())
    session = store.update("g", minimal_state(), (TurnStarted(player=0, turn_number=1),))
    assert len(session.log) == 1
