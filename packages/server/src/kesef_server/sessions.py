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
* **The clock lives here.** The server reads a clock for two things and only two — the
  ``EndTurn.elapsed_seconds`` stamp that lets Kids Mode's time limit fire (GAP G-6), and the
  idle sweep in :meth:`SessionStore._evict_idle`. This is the transport, so a clock is
  allowed here; the engine's rule 3 forbids one *there*. It is injected, so tests wind it by
  hand and no other module is tempted to read a clock of its own. A client-supplied elapsed
  time is never trusted: it would let a player force or dodge the ending.
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


class SubscriberLimitReachedError(RuntimeError):
    """This game is carrying as many WebSocket listeners as it will."""


class UnknownGameError(KeyError):
    """No game with that id."""


class DuplicateGameError(KeyError):
    """A game with that id is already live.

    Raised rather than overwriting: the store is keyed by ``game_id``, so a silent
    overwrite would end somebody's game from another client's new-game screen (MON-301).
    """


@dataclass
class Subscriber:
    """One live socket's mailbox, bounded in both dimensions (MON-303 security review).

    The liveness design is unchanged and deliberate: the writer never blocks, so a client that
    has stopped reading cannot stall the game for everybody else. What was wrong was the
    *memory*. The queue was unbounded, so a stalled reader's mailbox grew until the process
    died, and the commit that introduced it said "unbounded on purpose" without naming that
    cost.

    An overflow is not a reason to drop an event quietly — the socket would then be silently
    telling a lie, and the animation queue on the other end would replay a game that never
    happened. So the writer records the overflow and the *reader* closes its own socket.
    """

    queue: asyncio.Queue[LoggedEvent]
    overflowed: asyncio.Event = field(default_factory=asyncio.Event)

    def offer(self, entry: LoggedEvent) -> None:
        """Hand an event to this listener without ever waiting for it.

        Called from whichever coroutine applied the command, so it must not block: a slow
        socket is a slow socket, not a slow game.
        """
        try:
            self.queue.put_nowait(entry)
        except asyncio.QueueFull:
            self.overflowed.set()


@dataclass
class Session:
    """One game, its sequenced history, and whoever is watching it."""

    state: GameState
    started_at: float
    """The store's clock reading when the game was created. See the module docstring."""
    touched_at: float
    """The store's clock reading when this game was last reached. What the idle sweep reads —
    ``started_at`` would evict a long game that is being played."""
    log: list[LoggedEvent] = field(default_factory=list)
    """Append-only. Replaying it against the initial state reproduces the game exactly."""
    _subscribers: list[Subscriber] = field(default_factory=list)
    """Live WebSocket listeners (MON-303). Capped, and a dropped client removes its own
    mailbox. See :meth:`subscribe`."""

    @property
    def cursor(self) -> int:
        """The highest ``seq`` assigned so far. 0 means nothing has happened yet."""
        return self.log[-1].seq if self.log else 0

    @property
    def subscribers(self) -> tuple[Subscriber, ...]:
        return tuple(self._subscribers)

    def touch(self, now: float) -> None:
        """Mark this game as in use, so the idle sweep leaves it alone."""
        self.touched_at = now

    def events_since(self, cursor: int) -> tuple[LoggedEvent, ...]:
        """Everything after ``cursor``. ``events_since(0)`` is the whole game."""
        return tuple(entry for entry in self.log if entry.seq > cursor)

    @contextmanager
    def subscribe(self, *, max_subscribers: int, queue_size: int) -> Iterator[Subscriber]:
        """Listen for appended events for the duration of the block.

        A context manager rather than a pair of methods so that a disconnect — however it
        happens — cannot leave a mailbox behind that the store would fill forever.

        Both bounds are arguments rather than constants because they are operator settings
        (``max_subscribers_per_game``, ``subscriber_queue_size``) and this module holds no
        configuration. Raising on the N+1 listener rather than accepting it is what makes the
        cap a cap: a silently-dropped subscription is a socket that stays open and never
        receives, which is worse than a close code.
        """
        if len(self._subscribers) >= max_subscribers:
            raise SubscriberLimitReachedError(f"game is carrying {max_subscribers} listeners")
        subscriber = Subscriber(queue=asyncio.Queue(maxsize=queue_size))
        self._subscribers.append(subscriber)
        try:
            yield subscriber
        finally:
            self._subscribers.remove(subscriber)


class SessionStore:
    """Process-local game storage."""

    def __init__(self, max_sessions: int, ttl_seconds: float, clock: Callable[[], float] = time.monotonic) -> None:
        self._max_sessions = max_sessions
        self._ttl_seconds = ttl_seconds
        # An instance attribute, not a class-level default: a plain function stored on a
        # class would bind as a method and swallow the call.
        self._clock = clock
        self._sessions: dict[str, Session] = {}

    def _evict_idle(self) -> None:
        """Forget every game untouched for longer than the TTL.

        Swept on access rather than on a timer, because the server runs no background task and
        a sweep that happens when somebody asks is enough for the property that matters: a slot
        is never held forever by a game nobody is playing. Before this, ``session_ttl_minutes``
        was declared, documented as "idle games are evicted", and referenced nowhere — so the
        session cap had no recovery path at all except a restart (MON-303 security review).

        The clock is **monotonic** (see the module docstring), so a system time change can
        neither evict a live game nor resurrect a dead one. A live WebSocket does not defer
        eviction: it only reads, and a game no command has touched in four hours is idle
        whoever is watching it.
        """
        now = self._clock()
        idle = [game_id for game_id, session in self._sessions.items() if now - session.touched_at > self._ttl_seconds]
        for game_id in idle:
            del self._sessions[game_id]

    def create(self, state: GameState) -> Session:
        self._evict_idle()
        if state.game_id in self._sessions:
            raise DuplicateGameError(state.game_id)
        if len(self._sessions) >= self._max_sessions:
            raise SessionLimitReachedError(f"server is holding {self._max_sessions} games")
        now = self._clock()
        session = Session(state=state, started_at=now, touched_at=now)
        self._sessions[state.game_id] = session
        return session

    def get(self, game_id: str) -> Session:
        self._evict_idle()
        try:
            session = self._sessions[game_id]
        except KeyError as exc:
            raise UnknownGameError(game_id) from exc
        session.touch(self._clock())
        return session

    def update(self, game_id: str, state: GameState, events: tuple[Event, ...]) -> Session:
        """Commit a command's result: the new state, and its events with ``seq`` assigned."""
        session = self.get(game_id)
        session.state = state
        seq = session.cursor
        for event in events:
            seq += 1
            entry = LoggedEvent(seq=seq, event=event)
            session.log.append(entry)
            for subscriber in session.subscribers:
                subscriber.offer(entry)
        return session

    def delete(self, game_id: str) -> None:
        self._sessions.pop(game_id, None)

    def all(self) -> tuple[Session, ...]:
        """Every live game. Sweeps first, but does not *touch*: a polling lobby screen must not
        be able to keep an abandoned game alive forever."""
        self._evict_idle()
        return tuple(self._sessions.values())

    def elapsed_seconds(self, session: Session) -> int:
        """Whole seconds since ``session`` was created — the server's only clock read.

        Floored at zero so a clock that steps backwards (an injected test clock, or a
        platform quirk) can never produce a negative value the engine would reject.
        """
        return max(0, int(self._clock() - session.started_at))

    def __len__(self) -> int:
        return len(self._sessions)
