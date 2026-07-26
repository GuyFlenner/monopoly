"""In-memory game sessions.

Hotseat play means one client holds one game, so a process-local dict is the right
storage: no database, no serialization on every turn, no operational surface. The trade is
that a restart loses in-flight games — acceptable for v1, and the mitigation already
exists because :class:`~kesef_engine.state.GameState` serializes losslessly, so the client
can save a game to a file and re-upload it.

If networked play arrives (MON-9xx), this is the seam that grows a Redis backend. The
interface is deliberately narrow so that swap touches nothing else.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from kesef_engine.events import Event
from kesef_engine.state import GameState


class SessionLimitReachedError(RuntimeError):
    """The server is holding as many games as it will."""


class UnknownGameError(KeyError):
    """No game with that id."""


@dataclass
class Session:
    """One game plus its event history."""

    state: GameState
    log: list[Event] = field(default_factory=list)
    """Append-only. Replaying it against the initial state reproduces the game exactly."""


class SessionStore:
    """Process-local game storage."""

    def __init__(self, max_sessions: int) -> None:
        self._max_sessions = max_sessions
        self._sessions: dict[str, Session] = {}

    def create(self, state: GameState) -> Session:
        if len(self._sessions) >= self._max_sessions:
            raise SessionLimitReachedError(f"server is holding {self._max_sessions} games")
        session = Session(state=state)
        self._sessions[state.game_id] = session
        return session

    def get(self, game_id: str) -> Session:
        try:
            return self._sessions[game_id]
        except KeyError as exc:
            raise UnknownGameError(game_id) from exc

    def update(self, game_id: str, state: GameState, events: tuple[Event, ...]) -> Session:
        session = self.get(game_id)
        session.state = state
        session.log.extend(events)
        return session

    def delete(self, game_id: str) -> None:
        self._sessions.pop(game_id, None)

    def all(self) -> tuple[Session, ...]:
        return tuple(self._sessions.values())

    def __len__(self) -> int:
        return len(self._sessions)
