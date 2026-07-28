"""The session store — the only mutable thing the server owns (ADR-006).

What is worth testing here is the append-only log's sequencing (G-34: without a stable
``seq`` the animation queue cannot tell a replayed event from a new one) and the two
refusals: the cap, and a duplicate ``game_id`` that used to overwrite a live game
silently.
"""

from __future__ import annotations

import pytest
from conftest import SESSION_TTL_SECONDS, FakeClock, minimal_state

from kesef_engine.events import PhaseChanged, TurnStarted
from kesef_engine.phases import Phase
from kesef_server.api import get_settings, get_store
from kesef_server.sessions import (
    DuplicateGameError,
    SessionLimitReachedError,
    SessionStore,
    SubscriberLimitReachedError,
    UnknownGameError,
)


def _store(
    max_sessions: int = 4,
    ttl_seconds: float = SESSION_TTL_SECONDS,
    clock: FakeClock | None = None,
) -> SessionStore:
    return SessionStore(max_sessions=max_sessions, ttl_seconds=ttl_seconds, clock=clock or FakeClock())


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
    store = SessionStore(max_sessions=0, ttl_seconds=SESSION_TTL_SECONDS, clock=FakeClock())
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
    store = SessionStore(max_sessions=1, ttl_seconds=SESSION_TTL_SECONDS, clock=FakeClock())
    store.create(minimal_state())
    store.delete("g")
    assert len(store) == 0
    store.create(minimal_state())
    assert len(store) == 1


# --- Idle eviction (MON-303 security review) --------------------------------


def test_an_idle_game_is_evicted_and_its_slot_reclaimed() -> None:
    """``session_ttl_minutes`` used to be declared, documented and referenced nowhere, so a
    full ``max_sessions`` had no recovery but a restart."""
    clock = FakeClock()
    store = _store(max_sessions=1, ttl_seconds=100.0, clock=clock)
    store.create(minimal_state())

    clock.advance(101.0)
    with pytest.raises(UnknownGameError):
        store.get("g")
    assert len(store) == 0
    assert store.all() == ()
    # And the reclaimed slot is genuinely usable, which is the point of reclaiming it.
    assert store.create(minimal_state(game_id="next")).state.game_id == "next"


def test_a_game_still_being_played_is_never_evicted() -> None:
    """The sweep reads ``touched_at``, not ``started_at``: a four-hour hotseat game that has
    seen a command every ten minutes is not idle."""
    clock = FakeClock()
    store = _store(ttl_seconds=100.0, clock=clock)
    store.create(minimal_state())

    for _ in range(10):
        clock.advance(99.0)
        assert store.get("g").state.game_id == "g"

    clock.advance(101.0)
    with pytest.raises(UnknownGameError):
        store.get("g")


def test_listing_games_sweeps_but_does_not_defer_the_eviction() -> None:
    """A lobby screen polling ``GET /games`` must not keep an abandoned game alive forever."""
    clock = FakeClock()
    store = _store(ttl_seconds=100.0, clock=clock)
    store.create(minimal_state())

    clock.advance(60.0)
    assert len(store.all()) == 1
    clock.advance(60.0)
    assert store.all() == (), "polling the list refreshed touched_at"


def test_an_idle_game_is_swept_before_the_cap_refuses_a_new_one() -> None:
    clock = FakeClock()
    store = _store(max_sessions=1, ttl_seconds=100.0, clock=clock)
    store.create(minimal_state())
    clock.advance(101.0)
    assert store.create(minimal_state(game_id="new")).state.game_id == "new"


def test_all_lists_every_live_session() -> None:
    store = _store()
    store.create(minimal_state(game_id="a"))
    store.create(minimal_state(game_id="b"))
    assert {session.state.game_id for session in store.all()} == {"a", "b"}


def test_elapsed_seconds_come_from_the_stores_clock_and_are_floored_at_zero() -> None:
    """The server's one deliberate clock read (MON-301 / GAP G-6)."""
    clock = FakeClock()
    store = SessionStore(max_sessions=4, ttl_seconds=SESSION_TTL_SECONDS, clock=clock)
    session = store.create(minimal_state())
    assert store.elapsed_seconds(session) == 0
    clock.advance(90.7)
    assert store.elapsed_seconds(session) == 90
    clock.now = -5.0
    assert store.elapsed_seconds(session) == 0


def test_subscribers_receive_appended_events_and_unsubscribe_cleanly() -> None:
    """MON-303's fan-out seam. A dropped client must not leave a mailbox behind."""
    store = _store()
    session = store.create(minimal_state())
    with session.subscribe(max_subscribers=4, queue_size=8) as subscriber:
        store.update("g", minimal_state(), (TurnStarted(player=0, turn_number=1),))
        assert subscriber.queue.get_nowait().seq == 1
    assert session.subscribers == ()


# --- The two bounds on a listener (MON-303 security review) -----------------


def test_the_subscriber_cap_refuses_the_next_listener() -> None:
    """Uncapped, sixty sockets on one game all registered and the list grew without bound."""
    session = _store().create(minimal_state())
    with (
        session.subscribe(max_subscribers=2, queue_size=4),
        session.subscribe(max_subscribers=2, queue_size=4),
    ):
        assert len(session.subscribers) == 2
        with pytest.raises(SubscriberLimitReachedError), session.subscribe(max_subscribers=2, queue_size=4):
            pass
        assert len(session.subscribers) == 2, "the refused listener must not have registered"
    assert len(session.subscribers) == 0


def test_a_full_mailbox_is_flagged_rather_than_grown_and_never_blocks_the_writer() -> None:
    """The liveness half of MON-303 stays: ``offer`` never waits. What changes is that the
    queue has a ceiling, so a client that stopped reading is a closed socket and not an
    exhausted process."""
    store = _store()
    session = store.create(minimal_state())
    with session.subscribe(max_subscribers=2, queue_size=2) as subscriber:
        for turn in range(1, 6):
            store.update("g", minimal_state(), (TurnStarted(player=0, turn_number=turn),))

        assert subscriber.queue.qsize() == 2, "the mailbox grew past its ceiling"
        assert subscriber.overflowed.is_set()
        assert len(session.log) == 5, "the game itself carried on regardless"


def test_one_overflowing_mailbox_does_not_touch_the_others() -> None:
    store = _store()
    session = store.create(minimal_state())
    with (
        session.subscribe(max_subscribers=2, queue_size=1) as small,
        session.subscribe(max_subscribers=2, queue_size=8) as roomy,
    ):
        for turn in range(1, 5):
            store.update("g", minimal_state(), (TurnStarted(player=0, turn_number=turn),))

        assert small.overflowed.is_set()
        assert not roomy.overflowed.is_set()
        assert roomy.queue.qsize() == 4


def test_events_are_logged_even_with_no_subscribers() -> None:
    store = _store()
    store.create(minimal_state())
    session = store.update("g", minimal_state(), (TurnStarted(player=0, turn_number=1),))
    assert len(session.log) == 1


def test_the_process_wide_store_and_settings_are_shared_singletons() -> None:
    """The defaults the tests override. One process holds one store, or two clients would
    see two different games under one id."""
    assert get_store() is get_store()
    assert get_settings() is get_settings()
    assert len(get_store()) == 0
