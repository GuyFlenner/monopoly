"""In-memory game sessions.

Hotseat play means one client holds one game, so a process-local dict is the right
storage: no database, no serialization on every turn, no operational surface. The trade is
that a restart loses in-flight games — acceptable for v1, and the mitigation already
exists because :class:`~kesef_engine.state.GameState` serializes losslessly, so the client
can save a game to a file and re-upload it.

If networked play arrives (MON-9xx), this is the seam that grows a Redis backend. The
interface is deliberately narrow so that swap touches nothing else.

Two things beyond storage live here, and both are deliberate:

* **The log is sequenced.** Every event the store accepts is wrapped in a
  :class:`~kesef_server.schemas.LoggedEvent` carrying a session-assigned ``seq``, so a
  reconnecting client can say "everything after 12" and the animation queue can tell a
  replayed event from a new one (GAP G-34). ``seq`` is assigned here and nowhere else.
* **The clock lives here.** The server owns exactly one clock read — the
  ``EndTurn.elapsed_seconds`` stamp that lets Kids Mode's time limit fire (GAP G-6). It is
  injected, so tests wind it by hand and no other module is tempted to read a clock of its
  own. A client-supplied elapsed time is never trusted: it would let a player force or
  dodge the ending.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field

from kesef_engine.events import Event
from kesef_engine.state import GameState
from kesef_server.schemas import LoggedEvent


class SessionLimitReachedError(RuntimeError):
    """The server is holding as many games as it will."""


class UnknownGameError(KeyError):
    """No game with that id."""


class DuplicateGameError(KeyError):
    """A game with that id is already live.

    Raised rather than overwriting: the store is keyed by ``game_id``, so a silent
    overwrite would end somebody's game from another client's new-game screen (MON-301).
    """


@dataclass
class Session:
    """One game, its sequenced history, and whoever is watching it."""

    state: GameState
    started_at: float
    """The store's clock reading when the game was created. See the module docstring."""
    log: list[LoggedEvent] = field(default_factory=list)
    """Append-only. Replaying it against the initial state reproduces the game exactly."""
    _subscribers: list[asyncio.Queue[LoggedEvent]] = field(default_factory=list)
    """Live WebSocket listeners (MON-303). A dropped client removes its own queue."""

    @property
    def cursor(self) -> int:
        """The highest ``seq`` assigned so far. 0 means nothing has happened yet."""
        return self.log[-1].seq if self.log else 0

    @property
    def subscribers(self) -> tuple[asyncio.Queue[LoggedEvent], ...]:
        return tuple(self._subscribers)

    def events_since(self, cursor: int) -> tuple[LoggedEvent, ...]:
        """Everything after ``cursor``. ``events_since(0)`` is the whole game."""
        return tuple(entry for entry in self.log if entry.seq > cursor)

    @contextmanager
    def subscribe(self) -> Iterator[asyncio.Queue[LoggedEvent]]:
        """Listen for appended events for the duration of the block.

        A context manager rather than a pair of methods so that a disconnect — however it
        happens — cannot leave a queue behind that the store would fill forever.
        """
        queue: asyncio.Queue[LoggedEvent] = asyncio.Queue()
        self._subscribers.append(queue)
        try:
            yield queue
        finally:
            self._subscribers.remove(queue)


class SessionStore:
    """Process-local game storage."""

    def __init__(self, max_sessions: int, clock: Callable[[], float] = time.monotonic) -> None:
        self._max_sessions = max_sessions
        # An instance attribute, not a class-level default: a plain function stored on a
        # class would bind as a method and swallow the call.
        self._clock = clock
        self._sessions: dict[str, Session] = {}

    def create(self, state: GameState) -> Session:
        if state.game_id in self._sessions:
            raise DuplicateGameError(state.game_id)
        if len(self._sessions) >= self._max_sessions:
            raise SessionLimitReachedError(f"server is holding {self._max_sessions} games")
        session = Session(state=state, started_at=self._clock())
        self._sessions[state.game_id] = session
        return session

    def get(self, game_id: str) -> Session:
        try:
            return self._sessions[game_id]
        except KeyError as exc:
            raise UnknownGameError(game_id) from exc

    def update(self, game_id: str, state: GameState, events: tuple[Event, ...]) -> Session:
        """Commit a command's result: the new state, and its events with ``seq`` assigned."""
        session = self.get(game_id)
        session.state = state
        seq = session.cursor
        for event in events:
            seq += 1
            entry = LoggedEvent(seq=seq, event=event)
            session.log.append(entry)
            for queue in session.subscribers:
                queue.put_nowait(entry)
        return session

    def delete(self, game_id: str) -> None:
        self._sessions.pop(game_id, None)

    def all(self) -> tuple[Session, ...]:
        return tuple(self._sessions.values())

    def elapsed_seconds(self, session: Session) -> int:
        """Whole seconds since ``session`` was created — the server's only clock read.

        Floored at zero so a clock that steps backwards (an injected test clock, or a
        platform quirk) can never produce a negative value the engine would reject.
        """
        return max(0, int(self._clock() - session.started_at))

    def __len__(self) -> int:
        return len(self._sessions)
