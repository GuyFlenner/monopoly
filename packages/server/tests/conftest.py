"""Shared fixtures.

Every test gets its own :class:`SessionStore`, so no test can see another's games, and
the store's clock is fake — the server's one deliberate clock read (the
``EndTurn.elapsed_seconds`` stamp, MON-301) is therefore assertable rather than flaky.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from kesef_engine.rng import Rng
from kesef_engine.ruleset import Ruleset
from kesef_engine.state import GameState, PlayerKind, PlayerState, PropertyState
from kesef_server.api import app, get_settings, get_store
from kesef_server.config import Settings
from kesef_server.sessions import SessionStore

BOARD_TILES = 40

SESSION_TTL_SECONDS = 3600.0
"""The idle-eviction window every test store uses. Generous relative to the seconds the
``FakeClock`` is wound by elsewhere, so only the tests that mean to provoke an eviction do."""


class FakeClock:
    """A monotonic clock a test can wind forward by hand."""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def store(clock: FakeClock) -> SessionStore:
    return SessionStore(max_sessions=8, ttl_seconds=SESSION_TTL_SECONDS, clock=clock)


@pytest.fixture
def settings() -> Settings:
    return Settings()


@pytest.fixture
def client(store: SessionStore, settings: Settings) -> Iterator[TestClient]:
    """A client with a clean, isolated session store and its own settings."""
    app.dependency_overrides[get_store] = lambda: store
    app.dependency_overrides[get_settings] = lambda: settings
    yield TestClient(app)
    app.dependency_overrides.clear()


def seat(name: str, **overrides: object) -> dict[str, object]:
    return {"name": name, "is_bot": False, "token": f"token.{name}", **overrides}


def new_game_payload(**overrides: object) -> dict[str, object]:
    """A two-seat universal game on a fixed seed, so every test is reproducible."""
    return {"seats": [seat("Ann"), seat("Ben")], "seed": 7, **overrides}


def minimal_state(**overrides: object) -> GameState:
    """The smallest valid state. Used where a real game would only add noise."""
    defaults: dict[str, object] = {
        "game_id": "g",
        "board_id": "classic",
        "ruleset": Ruleset.universal(),
        "rng": Rng(seed=1),
        "players": tuple(
            PlayerState(id=i, name=f"P{i}", kind=PlayerKind(), token=f"token.{i}", cash=1500) for i in range(2)
        ),
        "properties": tuple(PropertyState() for _ in range(BOARD_TILES)),
        # MON-100 / ADR-007: the state names the acting seat by id, not by tuple index.
        "current_player_id": 0,
    }
    return GameState(**(defaults | overrides))
