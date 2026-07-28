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
from conftest import minimal_state, new_game_payload
from fastapi import WebSocket, status
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from kesef_engine.events import TurnStarted
from kesef_server.api import WS_GAME_NOT_FOUND, stream_events
from kesef_server.schemas import LoggedEvent
from kesef_server.sessions import SessionStore

ROLL = {"command": {"kind": "roll_dice", "player": 0}}


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
    """A stalled client must not become a stalled game — the queue is unbounded on purpose."""
    game_id = _create(client)
    with client.websocket_connect(f"/games/{game_id}/ws"):
        # One roll is enough: the point is that the POST returns while nobody is reading.
        assert client.post(f"/games/{game_id}/commands", json=ROLL).status_code == status.HTTP_200_OK
    assert client.get(f"/games/{game_id}").json()["event_cursor"] > 0


# --- The de-duplication rule ------------------------------------------------


class _FakeSocket:
    """Records what was sent. The stream helper only ever sends."""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


async def test_an_event_already_replayed_is_never_pushed_a_second_time() -> None:
    """G-34: the animation queue must not play one event twice.

    Driven through the helper rather than a socket, because the race it guards against — an
    event landing in the queue *and* in the replay snapshot — cannot be provoked from a test
    client: nothing awaits between subscribing and taking the snapshot. Exercising the helper
    is the only way to assert the rule instead of assuming it.
    """
    store = SessionStore(max_sessions=2)
    store.create(minimal_state())
    session = store.update("g", minimal_state(), (TurnStarted(player=0, turn_number=1),))
    already_seen = session.log[0]
    fresh = LoggedEvent(seq=2, event=TurnStarted(player=1, turn_number=2))

    socket = _FakeSocket()
    with session.subscribe() as queue:
        queue.put_nowait(already_seen)  # the duplicate the race would produce
        queue.put_nowait(fresh)
        pump = asyncio.create_task(stream_events(cast(WebSocket, socket), session, queue, since=0))
        await asyncio.wait_for(_drain(queue), timeout=2)
        pump.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pump

    assert [frame["seq"] for frame in socket.sent] == [1, 2]


async def test_the_helper_stops_when_the_client_goes_away() -> None:
    """A disconnect is an ordinary end of stream, not an error to escalate."""
    store = SessionStore(max_sessions=2)
    store.create(minimal_state())
    session = store.update("g", minimal_state(), (TurnStarted(player=0, turn_number=1),))

    class _GoneSocket(_FakeSocket):
        async def send_json(self, payload: dict[str, Any]) -> None:
            raise WebSocketDisconnect(code=1001)

    with session.subscribe() as queue:
        await stream_events(cast(WebSocket, _GoneSocket()), session, queue, since=0)
    assert session.subscribers == ()


async def _drain(queue: asyncio.Queue[LoggedEvent]) -> None:
    while not queue.empty():
        await asyncio.sleep(0)
    await asyncio.sleep(0)
