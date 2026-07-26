"""Contract tests.

The 501 assertions are not placeholders to be deleted — they pin the routes and schemas
that the frontend generates types from. When MON-301 lands, each one becomes a real
behavioural test rather than disappearing.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi import status
from fastapi.testclient import TestClient

from kesef_engine.board.models import BOARD_SIZE
from kesef_engine.rng import Rng
from kesef_engine.ruleset import Ruleset
from kesef_engine.state import MAX_PLAYERS, GameState, PlayerKind, PlayerState, PropertyState
from kesef_server.api import app, get_store
from kesef_server.sessions import SessionLimitReachedError, SessionStore

UNPROCESSABLE = 422
"""Spelled as a number: starlette has renamed this constant once already."""


@pytest.fixture
def client() -> Iterator[TestClient]:
    """A client with a clean, isolated session store."""
    store = SessionStore(max_sessions=8)
    app.dependency_overrides[get_store] = lambda: store
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_health(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == status.HTTP_200_OK
    assert response.json() == {"status": "ok"}


def test_boards_endpoint_lists_both_boards(client: TestClient) -> None:
    response = client.get("/boards")
    assert response.status_code == status.HTTP_200_OK
    boards = {board["id"]: board for board in response.json()}
    assert set(boards) == {"classic", "israel"}
    assert boards["classic"]["tile_count"] == 40
    assert boards["classic"]["ownable_count"] == 28


def test_boards_endpoint_returns_keys_not_prose(client: TestClient) -> None:
    """The API must never hand the client an English string to display."""
    for board in client.get("/boards").json():
        assert board["name_key"].startswith("board.")


def test_rulesets_endpoint_exposes_what_kids_mode_changes(client: TestClient) -> None:
    rulesets = {ruleset["name"]: ruleset for ruleset in client.get("/rulesets").json()}
    assert set(rulesets) == {"universal", "kids"}
    assert rulesets["universal"]["auctions_enabled"] is True
    assert rulesets["kids"]["auctions_enabled"] is False
    assert rulesets["kids"]["hints_enabled"] is True


def test_games_list_starts_empty(client: TestClient) -> None:
    assert client.get("/games").json() == []


def test_deleting_an_unknown_game_is_a_404_with_a_key(client: TestClient) -> None:
    response = client.delete("/games/nope")
    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert response.json()["detail"] == "error.game_not_found"


def test_seat_count_is_validated_before_the_engine_is_reached(client: TestClient) -> None:
    """A one-player game is rejected by the schema, not by a 501 further in."""
    response = client.post("/games", json={"seats": [_seat("Solo")]})
    assert response.status_code == UNPROCESSABLE


def test_too_many_seats_is_rejected(client: TestClient) -> None:
    response = client.post("/games", json={"seats": [_seat(f"P{i}") for i in range(MAX_PLAYERS + 1)]})
    assert response.status_code == UNPROCESSABLE


def test_a_bot_seat_without_a_level_is_rejected(client: TestClient) -> None:
    seats = [_seat("Human"), {"name": "Bot", "is_bot": True, "token": "token.2"}]
    response = client.post("/games", json={"seats": seats})
    assert response.status_code == UNPROCESSABLE


def test_a_human_seat_with_a_bot_level_is_rejected(client: TestClient) -> None:
    seats = [_seat("Human"), {"name": "Also human", "is_bot": False, "bot_level": "hard", "token": "token.2"}]
    response = client.post("/games", json={"seats": seats})
    assert response.status_code == UNPROCESSABLE


@pytest.mark.parametrize(
    ("method", "path"),
    [("post", "/games"), ("get", "/games/abc"), ("post", "/games/abc/commands")],
)
def test_engine_backed_routes_are_declared_but_not_yet_implemented(client: TestClient, method: str, path: str) -> None:
    """Pins the route shape for the generated TypeScript client. Becomes real at MON-301."""
    roll = {"command": {"kind": "roll_dice", "player": 0}}
    payload = {"seats": [_seat("A"), _seat("B")]} if path == "/games" else roll
    response = client.request(method.upper(), path, json=payload if method == "post" else None)
    assert response.status_code == status.HTTP_501_NOT_IMPLEMENTED


def test_openapi_document_is_generated(client: TestClient) -> None:
    """The frontend's type generation depends on this document existing and being valid."""
    schema = client.get("/openapi.json").json()
    assert schema["info"]["title"] == "Kesef Street"
    assert "/games/{game_id}/commands" in schema["paths"]
    assert "GameView" in schema["components"]["schemas"]


def test_session_store_enforces_its_cap() -> None:
    store = SessionStore(max_sessions=0)
    with pytest.raises(SessionLimitReachedError):
        store.create(_minimal_state())


def _seat(name: str) -> dict[str, object]:
    return {"name": name, "is_bot": False, "token": f"token.{name}"}


def _minimal_state() -> GameState:
    return GameState(
        game_id="g",
        board_id="classic",
        ruleset=Ruleset.universal(),
        rng=Rng(seed=1),
        players=tuple(
            PlayerState(id=i, name=f"P{i}", kind=PlayerKind(), token=f"token.{i}", cash=1500) for i in range(2)
        ),
        properties=tuple(PropertyState() for _ in range(BOARD_SIZE)),
        # MON-100 / ADR-007: the state names the acting seat by id, not by tuple index.
        current_player_id=0,
    )
