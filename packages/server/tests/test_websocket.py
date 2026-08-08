"""MON-303 — the event stream.

Three things the backlog asks for, and one the animation queue needs (G-34):

* each command's events are pushed to whoever is watching,
* a late or reconnecting client replays from the session's append-only log,
* a disconnect never affects game state,
* and a replayed event is distinguishable from a new one, so the same event is never
  animated twice.
"""

from __future__ import annotations

import asyncio
from typing import Any, cast

import pytest
from conftest import SESSION_TTL_SECONDS, minimal_state, new_game_payload
from fastapi import WebSocket, status
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from kesef_engine.events import TurnStarted
from kesef_server.api import (
    WS_CURSOR_RESET,
    WS_GAME_NOT_FOUND,
    WS_MALFORMED_REQUEST,
    WS_TOO_MANY_WATCHERS,
    WS_WATCHER_TOO_SLOW,
    StreamEnd,
    app,
    get_settings,
    next_entry,
    stream_events,
)
from kesef_server.config import Settings
from kesef_server.schemas import LoggedEvent
from kesef_server.sessions import SessionStore

ROLL = {"command": {"kind": "roll_dice", "player": 0}}
BUY = {"command": {"kind": "buy_property", "player": 0}}


def _create(client: TestClient) -> str:
    response = client.post("/games", json=new_game_payload())
    assert response.status_code == status.HTTP_201_CREATED, response.text
    game_id: str = response.json()["state"]["game_id"]
    return game_id


def test_the_socket_pushes_the_events_of_a_command_sent_while_it_is_open(client: TestClient) -> None:
    game_id = _create(client)
    with client.websocket_connect(f"/games/{game_id}/ws") as socket:
        applied = client.post(f"/games/{game_id}/commands", json=ROLL).json()
        received = [socket.receive_json() for _ in applied["events"]]
    assert [frame["seq"] for frame in received] == [entry["seq"] for entry in applied["events"]]
    assert [frame["event"] for frame in received] == [entry["event"] for entry in applied["events"]]


def test_a_frame_is_the_same_envelope_the_http_view_carries(client: TestClient) -> None:
    """One type for both transports, so a client de-duplicates by `seq` and nothing else."""
    game_id = _create(client)
    with client.websocket_connect(f"/games/{game_id}/ws") as socket:
        client.post(f"/games/{game_id}/commands", json=ROLL)
        frame = socket.receive_json()
    assert set(frame) == {"seq", "event"}
    LoggedEvent.model_validate(frame)


def test_a_late_client_replays_the_whole_game_from_zero(client: TestClient) -> None:
    game_id = _create(client)
    applied = client.post(f"/games/{game_id}/commands", json=ROLL).json()
    with client.websocket_connect(f"/games/{game_id}/ws?since=0") as socket:
        replayed = [socket.receive_json() for _ in applied["events"]]
    assert [frame["seq"] for frame in replayed] == [entry["seq"] for entry in applied["events"]]


def test_a_reconnecting_client_replays_only_what_it_missed(client: TestClient) -> None:
    game_id = _create(client)
    first = client.post(f"/games/{game_id}/commands", json=ROLL).json()
    cursor = first["event_cursor"]
    with client.websocket_connect(f"/games/{game_id}/ws?since={cursor}") as socket:
        # Nothing to replay, so the next frame must belong to the *next* command.
        following = client.post(
            f"/games/{game_id}/commands",
            json={"command": {"kind": "buy_property", "player": 0}},
        ).json()
        frame = socket.receive_json()
    assert frame["seq"] == following["events"][0]["seq"] > cursor


def test_the_default_cursor_replays_the_backlog(client: TestClient) -> None:
    """`since` defaults to 0, so a client that just opens a socket is never mid-story."""
    game_id = _create(client)
    applied = client.post(f"/games/{game_id}/commands", json=ROLL).json()
    with client.websocket_connect(f"/games/{game_id}/ws") as socket:
        assert socket.receive_json()["seq"] == applied["events"][0]["seq"]


def test_two_watchers_both_see_every_event(client: TestClient) -> None:
    game_id = _create(client)
    with (
        client.websocket_connect(f"/games/{game_id}/ws") as first,
        client.websocket_connect(f"/games/{game_id}/ws") as second,
    ):
        client.post(f"/games/{game_id}/commands", json=ROLL)
        assert first.receive_json()["seq"] == second.receive_json()["seq"] == 1


def test_an_unknown_game_closes_the_socket_with_a_key(client: TestClient) -> None:
    with client.websocket_connect("/games/nope/ws") as socket, pytest.raises(WebSocketDisconnect) as raised:
        socket.receive_json()
    assert raised.value.code == WS_GAME_NOT_FOUND
    assert raised.value.reason == "error.game_not_found"


def test_a_disconnect_leaves_the_game_untouched_and_removes_the_queue(client: TestClient, store: SessionStore) -> None:
    game_id = _create(client)
    with client.websocket_connect(f"/games/{game_id}/ws"):
        client.post(f"/games/{game_id}/commands", json=ROLL)
    after_disconnect = client.get(f"/games/{game_id}").json()

    assert store.get(game_id).subscribers == ()
    assert after_disconnect["state"]["dice"] is not None
    # And the game keeps playing with nobody watching.
    played_on = client.post(f"/games/{game_id}/commands", json={"command": {"kind": "buy_property", "player": 0}})
    assert played_on.status_code == status.HTTP_200_OK, played_on.text
    assert client.get(f"/games/{game_id}").json()["event_cursor"] > after_disconnect["event_cursor"]


def test_a_watcher_that_never_reads_does_not_block_the_game(client: TestClient) -> None:
    """A stalled client must not become a stalled game.

    The mailbox is bounded now (MON-303 security review), but the liveness property this test
    pins is unchanged and is the reason it was bounded rather than made blocking: the writer
    offers and never waits, so a slow socket is a slow socket and not a slow game.
    """
    game_id = _create(client)
    with client.websocket_connect(f"/games/{game_id}/ws"):
        # One roll is enough: the point is that the POST returns while nobody is reading.
        assert client.post(f"/games/{game_id}/commands", json=ROLL).status_code == status.HTTP_200_OK
    assert client.get(f"/games/{game_id}").json()["event_cursor"] > 0


# --- The two bounds on a listener (MON-303 security review) -----------------


def test_the_watcher_cap_closes_the_next_socket_with_a_key(client: TestClient) -> None:
    """Uncapped, sixty sockets on one game all registered — memory unbounded in the count as
    well as in each mailbox."""
    app.dependency_overrides[get_settings] = lambda: Settings(max_subscribers_per_game=1)
    game_id = _create(client)
    with (
        client.websocket_connect(f"/games/{game_id}/ws"),
        client.websocket_connect(f"/games/{game_id}/ws") as extra,
        pytest.raises(WebSocketDisconnect) as raised,
    ):
        extra.receive_json()
    assert raised.value.code == WS_TOO_MANY_WATCHERS
    assert raised.value.reason == "error.too_many_watchers"


def test_the_cap_counts_only_live_watchers(client: TestClient, store: SessionStore) -> None:
    """A cap that leaked a slot per disconnect would turn a page reload into a permanent
    refusal — the cap has to bound concurrency, not lifetime connections."""
    app.dependency_overrides[get_settings] = lambda: Settings(max_subscribers_per_game=1)
    game_id = _create(client)
    for turn in range(3):
        with client.websocket_connect(f"/games/{game_id}/ws") as socket:
            client.post(f"/games/{game_id}/commands", json=ROLL if turn == 0 else BUY)
            assert socket.receive_json()["seq"] >= 1
        assert store.get(game_id).subscribers == ()


def test_an_invalid_cursor_closes_the_socket_with_a_key(client: TestClient) -> None:
    """`?since=banana` used to close with 1008 and pydantic's English error list as the reason —
    the same G-33 defect as `{"detail": ...}` on HTTP."""
    game_id = _create(client)
    with pytest.raises(WebSocketDisconnect) as raised, client.websocket_connect(f"/games/{game_id}/ws?since=banana"):
        pass  # pragma: no cover - the handshake never completes
    assert raised.value.code == WS_MALFORMED_REQUEST
    assert raised.value.reason == "error.malformed_request"


async def test_a_mailbox_that_overflows_closes_its_own_socket_and_nothing_else() -> None:
    """The memory half of MON-303's fan-out, which the first pass left unbounded.

    Driven through the helper for the same reason the de-duplication test below is: a socket
    that has genuinely stopped reading cannot be built out of ``TestClient``, whose transport
    drains whatever the server sends into an unbounded portal stream. So the stalled reader here
    is a pump that has not been started, which is what a stalled reader *is* from the writer's
    side.
    """
    store = SessionStore(max_sessions=2, ttl_seconds=SESSION_TTL_SECONDS)
    store.create(minimal_state())
    session = store.get("g")
    stalled, healthy = _FakeSocket(), _FakeSocket()

    with (
        session.subscribe(max_subscribers=2, queue_size=1) as small,
        session.subscribe(max_subscribers=2, queue_size=64) as roomy,
    ):
        pump = asyncio.create_task(stream_events(cast(WebSocket, healthy), session, roomy, since=0))
        for turn in range(1, 6):
            store.update(store.get("g"), minimal_state(), (TurnStarted(player=0, turn_number=turn),))
        await _wait_for_frames(healthy, 5)
        assert small.overflowed.is_set(), "queue_size=1 should not have absorbed five events"

        # The stalled socket's own pump, run at last: it must leave, not carry on lying.
        await stream_events(cast(WebSocket, stalled), session, small, since=0)
        assert stalled.closed == (WS_WATCHER_TOO_SLOW, "error.watcher_too_slow")

        # ... and the healthy neighbour is untouched, as is the game.
        assert healthy.closed is None
        assert [frame["seq"] for frame in healthy.sent] == [1, 2, 3, 4, 5]
        pump.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pump

    assert [entry.seq for entry in session.log] == [1, 2, 3, 4, 5]
    assert store.get("g").state.game_id == "g"


async def test_the_overflow_flag_wins_a_tie_with_a_waiting_event() -> None:
    """A mailbox can be non-empty *and* already overflowed, in the same loop turn.

    Draining it would begin a stream that is silently missing whatever the overflow ate, and a
    silently incomplete stream is worse than a closed socket — so the flag wins the tie.
    """
    store = SessionStore(max_sessions=1, ttl_seconds=SESSION_TTL_SECONDS)
    session = store.create(minimal_state())
    with session.subscribe(max_subscribers=1, queue_size=1) as subscriber:
        subscriber.offer(LoggedEvent(seq=1, event=TurnStarted(player=0, turn_number=1)))
        subscriber.offer(LoggedEvent(seq=2, event=TurnStarted(player=1, turn_number=2)))
        assert subscriber.queue.qsize() == 1 and subscriber.overflowed.is_set()

        assert await next_entry(subscriber) is StreamEnd.OVERFLOWED


# --- A save that takes this id over (MON-907) -------------------------------


def test_a_load_that_takes_the_id_over_closes_the_watcher_with_the_cursor_reset_code(
    client: TestClient,
) -> None:
    """The whole product path, end to end: somebody loads a save over the game being watched.

    Driven through ``POST /games/load?if_exists=replace`` rather than by calling ``store.replace``
    from the test thread, for a reason that is not stylistic: the detachment flag is an
    ``asyncio.Event``, and setting one from outside the loop the socket is waiting on is not a thing
    that reliably wakes anybody. The route is the only caller in the product anyway.

    ``since`` is the current cursor so there is no backlog to drain — the *next* thing this socket
    receives is therefore the close, and nothing else can be mistaken for it.
    """
    game_id = _create(client)
    client.post(f"/games/{game_id}/commands", json=ROLL)
    save = client.get(f"/games/{game_id}/save").json()
    cursor = client.get(f"/games/{game_id}").json()["event_cursor"]
    assert cursor > 0, "the save has to carry a log, or 'the numbering restarts' is not a claim"

    with client.websocket_connect(f"/games/{game_id}/ws?since={cursor}") as socket:
        taken_over = client.post("/games/load?if_exists=replace", json=save)
        assert taken_over.status_code == status.HTTP_201_CREATED, taken_over.text
        with pytest.raises(WebSocketDisconnect) as raised:
            socket.receive_json()

    assert raised.value.code == WS_CURSOR_RESET
    assert raised.value.reason == "error.session_replaced"


async def test_a_replaced_session_closes_every_one_of_its_watchers() -> None:
    """Two mailboxes, one takeover, and the game underneath is a different session afterwards.

    Through the helper rather than a test client for the same reason the overflow test is: this
    asserts what ``stream_events`` does with a flag, and the flag is set by the store rather than by
    anything a socket can see.
    """
    store = SessionStore(max_sessions=2, ttl_seconds=SESSION_TTL_SECONDS)
    store.create(minimal_state())
    session = store.update(store.get("g"), minimal_state(), (TurnStarted(player=0, turn_number=1),))
    first, second = _FakeSocket(), _FakeSocket()

    with (
        session.subscribe(max_subscribers=2, queue_size=8) as one,
        session.subscribe(max_subscribers=2, queue_size=8) as two,
    ):
        pumps = [
            asyncio.create_task(stream_events(cast(WebSocket, first), session, one, since=1)),
            asyncio.create_task(stream_events(cast(WebSocket, second), session, two, since=1)),
        ]
        store.replace(minimal_state())
        await asyncio.wait_for(asyncio.gather(*pumps), timeout=2.0)

    assert first.closed == (WS_CURSOR_RESET, "error.session_replaced")
    assert second.closed == (WS_CURSOR_RESET, "error.session_replaced")
    # Neither socket was sent anything: the point of the close code is that there was nothing left
    # to send them, because the log they were reading is not the one under this id any more.
    assert first.sent == second.sent == []
    assert store.get("g").log == []


async def test_a_mailbox_opened_after_the_takeover_is_told_at_once() -> None:
    """The window between ``replace`` popping a session and a socket subscribing to it.

    ``game_event_stream`` resolves the game, *then* subscribes, and a load can land between the two.
    A per-mailbox flag set by ``detach`` would miss that subscriber entirely and leave it waiting on
    a log nothing will ever append to — the exact silent socket this item exists to remove. Sharing
    the session's own event is what makes the late subscriber's answer immediate; the ``wait_for``
    is what turns "immediate" into an assertion rather than a hang.
    """
    store = SessionStore(max_sessions=2, ttl_seconds=SESSION_TTL_SECONDS)
    store.create(minimal_state())
    orphaned = store.get("g")
    store.replace(minimal_state())

    with orphaned.subscribe(max_subscribers=1, queue_size=8) as late:
        assert await asyncio.wait_for(next_entry(late), timeout=2.0) is StreamEnd.DETACHED


async def test_the_takeover_wins_a_tie_with_an_event_still_in_the_mailbox() -> None:
    """Detachment outranks a queued event, and outranks an overflow.

    Both losers are events of a game that no longer holds this id, and the client is about to throw
    its cursor away and replay the replacement from ``seq`` 1 — so delivering them would put the old
    game's tail on screen for the moment before it is discarded. Asserted directly because a tie in
    one loop turn is not reachable from a test client.
    """
    store = SessionStore(max_sessions=1, ttl_seconds=SESSION_TTL_SECONDS)
    session = store.create(minimal_state())
    with session.subscribe(max_subscribers=1, queue_size=1) as subscriber:
        subscriber.offer(LoggedEvent(seq=1, event=TurnStarted(player=0, turn_number=1)))
        subscriber.offer(LoggedEvent(seq=2, event=TurnStarted(player=1, turn_number=2)))
        session.detach()
        assert subscriber.queue.qsize() == 1 and subscriber.overflowed.is_set()

        assert await next_entry(subscriber) is StreamEnd.DETACHED


# --- The de-duplication rule ------------------------------------------------


class _FakeSocket:
    """Records what was sent, and whether the helper closed it."""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []
        self.closed: tuple[int, str | None] | None = None

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)

    async def close(self, code: int = 1000, reason: str | None = None) -> None:
        self.closed = (code, reason)


async def test_an_event_already_replayed_is_never_pushed_a_second_time() -> None:
    """G-34: the animation queue must not play one event twice.

    Driven through the helper rather than a socket, because the race it guards against — an
    event landing in the queue *and* in the replay snapshot — cannot be provoked from a test
    client: nothing awaits between subscribing and taking the snapshot. Exercising the helper
    is the only way to assert the rule instead of assuming it.
    """
    store = SessionStore(max_sessions=2, ttl_seconds=SESSION_TTL_SECONDS)
    store.create(minimal_state())
    session = store.update(store.get("g"), minimal_state(), (TurnStarted(player=0, turn_number=1),))
    already_seen = session.log[0]
    fresh = LoggedEvent(seq=2, event=TurnStarted(player=1, turn_number=2))

    socket = _FakeSocket()
    with session.subscribe(max_subscribers=2, queue_size=8) as subscriber:
        subscriber.offer(already_seen)  # the duplicate the race would produce
        subscriber.offer(fresh)
        pump = asyncio.create_task(stream_events(cast(WebSocket, socket), session, subscriber, since=0))
        await _wait_for_frames(socket, 2)
        pump.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pump

    assert [frame["seq"] for frame in socket.sent] == [1, 2]


async def test_the_helper_stops_when_the_client_goes_away() -> None:
    """A disconnect is an ordinary end of stream, not an error to escalate."""
    store = SessionStore(max_sessions=2, ttl_seconds=SESSION_TTL_SECONDS)
    store.create(minimal_state())
    session = store.update(store.get("g"), minimal_state(), (TurnStarted(player=0, turn_number=1),))

    class _GoneSocket(_FakeSocket):
        async def send_json(self, payload: dict[str, Any]) -> None:
            raise WebSocketDisconnect(code=1001)

    with session.subscribe(max_subscribers=2, queue_size=8) as subscriber:
        await stream_events(cast(WebSocket, _GoneSocket()), session, subscriber, since=0)
    assert session.subscribers == ()


async def _wait_for_frames(socket: _FakeSocket, count: int, timeout: float = 2.0) -> None:
    """Let the pump run until it has sent ``count`` frames.

    Waiting on the socket rather than on the queue being empty: the helper takes several loop
    turns per event now that it races the mailbox against its overflow flag, so "the queue is
    empty" no longer means "the frame has been sent".
    """

    async def poll() -> None:
        while len(socket.sent) < count:
            await asyncio.sleep(0)

    await asyncio.wait_for(poll(), timeout=timeout)
