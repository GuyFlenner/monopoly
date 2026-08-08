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


class ClientSessionLimitReachedError(RuntimeError):
    """*This client* is holding as many games as one client may (MON-905).

    Distinct from :class:`SessionLimitReachedError` because the two are different news for the
    caller: the server being full is somebody else's doing, and having five games open is your own.
    The transport answers them with different statuses and different keys for exactly that reason.

    Carries the limit it enforced, so the refusal can name the number without the transport reaching
    back into the store for it.
    """

    def __init__(self, limit: int) -> None:
        self.limit = limit
        super().__init__(f"this client is holding {limit} games")


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

    Both flags on this object are "why this stream ended", set by whoever caused it and acted on by
    the one coroutine that owns the socket. Neither ever closes anything itself.
    """

    queue: asyncio.Queue[LoggedEvent]
    overflowed: asyncio.Event = field(default_factory=asyncio.Event)
    detached: asyncio.Event = field(default_factory=asyncio.Event)
    """Set when the session feeding this mailbox stopped being the one under its ``game_id``
    (MON-907), so its reader can close the socket instead of waiting on a log nothing will append
    to again.

    **One event per mailbox, not one shared with the session**, and that is not a style choice: an
    ``asyncio.Event`` binds itself to the loop that first waits on it, so a single event shared by
    two watchers is an event the second watcher cannot wait on. The session therefore keeps the
    *fact* (:attr:`Session.detached`, a plain bool) and :meth:`Session.detach` hands it to each
    mailbox — which is the same shape as :attr:`queue`, created per subscription for the same
    reason."""

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
    client_id: str | None = None
    """Who asked for this game, for ``max_sessions_per_client`` only (MON-905).

    **Transport, not state.** It lives on the ``Session`` and never on the ``GameState``, so it is
    absent from every ``GameView``, from ``GET /games/{id}/save``, and from anything a player can
    read or a save file can carry — a save that remembered an address would hand it to whoever the
    file was next mailed to. It is a counting key, nothing more: it confers no authority, and
    ``DELETE`` still asks nobody who they are. Seat ownership is MON-906's question, and answering
    it with an address would answer it wrongly, because a household shares one.

    ``None`` for a session created by a transport that has no callers to tell apart — the browser
    build (MON-805), where the one caller is the tab itself.
    """
    log: list[LoggedEvent] = field(default_factory=list)
    """Append-only. Replaying it against the initial state reproduces the game exactly."""
    _subscribers: list[Subscriber] = field(default_factory=list)
    """Live WebSocket listeners (MON-303). Capped, and a dropped client removes its own
    mailbox. See :meth:`subscribe`."""
    detached: bool = False
    """True once this session is no longer the one reachable under its ``game_id`` (MON-907).

    A fact rather than a signal — the signalling is per mailbox, see :attr:`Subscriber.detached` —
    and it is kept because a mailbox can be created *after* the detachment: ``game_event_stream``
    resolves the game and then subscribes, and a load can land between the two. Nothing in this
    module reacts to it; the reader that owns a socket decides what it costs. See :meth:`detach`
    and ``api.stream_events``."""
    advance_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    """Serializes bot drivers for this game (MON-806).

    Every request that changes a game queues an ``_advance_bots`` background task, so two quick
    requests give one game two drivers, and each driver's read-one-step-write loop races the
    other's: both read the same position, compute the same move, and append the same events
    twice. The lock lives here rather than in the API module because its lifetime *is* the
    session's — a per-``game_id`` dict at module scope would leak entries for deleted games or,
    cleaned carelessly, hand two drivers different locks for one game.
    """

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

    def detach(self) -> None:
        """Say, once, that this session is no longer the one under its ``game_id`` (MON-907).

        Idempotent, and it changes nothing about the game: the log, the state and the subscriber
        list are all left exactly as they are, because a detached session may still be mid-write
        from a bot driver that read it before the replacement (see :meth:`SessionStore.update`) and
        an object that mutates under that write would be a race rather than a fix. Each mailbox is
        *told*; none is removed, because a subscription is owned by the socket that opened it and
        removing one here would leave that socket's ``with`` block unwinding a list it is not in.
        """
        self.detached = True
        for subscriber in self._subscribers:
            subscriber.detached.set()

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
        if self.detached:
            # `replace` popped this session before this mailbox existed, so `detach` never saw it
            # (MON-907). Without this the socket waits forever on a log that is closed for writing.
            subscriber.detached.set()
        self._subscribers.append(subscriber)
        try:
            yield subscriber
        finally:
            self._subscribers.remove(subscriber)


class SessionStore:
    """Process-local game storage."""

    def __init__(
        self,
        max_sessions: int,
        ttl_seconds: float,
        clock: Callable[[], float] = time.monotonic,
        max_sessions_per_client: int | None = None,
    ) -> None:
        self._max_sessions = max_sessions
        self._ttl_seconds = ttl_seconds
        # An instance attribute, not a class-level default: a plain function stored on a
        # class would bind as a method and swallow the call.
        self._clock = clock
        # `None` is "no per-client cap", not a number in disguise (MON-905). The browser transport
        # has one caller and nothing to divide the store between, and a store built without the
        # setting should not silently inherit a limit nobody chose — a default here would be a
        # second copy of `Settings.max_sessions_per_client` that could drift from it.
        self._max_sessions_per_client = max_sessions_per_client
        self._sessions: dict[str, Session] = {}

    def held_by(self, client_id: str) -> int:
        """How many live games this client is holding.

        Counted rather than tallied in a second dict, because a count that is *derived* cannot
        disagree with the sessions it counts: every eviction, delete and replace would otherwise
        have to remember to decrement, and the one that forgot would lock a player out of a game
        they had already closed. O(sessions) against a store bounded at ``max_sessions``.
        """
        return sum(1 for session in self._sessions.values() if session.client_id == client_id)

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

    def create(self, state: GameState, events: tuple[Event, ...] = (), client_id: str | None = None) -> Session:
        """Seat a game. ``events`` is a restored log, stamped ``1..N`` (ADR-011).

        A restored log is stamped here rather than carried in from the file for the reason the module
        docstring gives: ``seq`` is this session's own numbering, and a file that brought its own
        would be asking this session to honour a previous one's. Nothing is offered to a subscriber —
        a session nobody has yet been handed cannot have one.

        **The per-client cap is checked before the global one, and the order is the whole point**
        (MON-905). Reversed, a client would be told "the table is full" only once it *had* filled the
        table — which is the failure the cap exists to prevent, reported after the fact and blamed on
        the wrong party. Checked in this order, one client's fifth game is its last, and the fiftieth
        slot stays available to somebody else.

        ``client_id`` of ``None`` skips the check entirely: a transport with one caller has nothing
        to divide the store between (see :attr:`Session.client_id`).
        """
        self._evict_idle()
        if state.game_id in self._sessions:
            raise DuplicateGameError(state.game_id)
        if (
            client_id is not None
            and self._max_sessions_per_client is not None
            and self.held_by(client_id) >= self._max_sessions_per_client
        ):
            raise ClientSessionLimitReachedError(self._max_sessions_per_client)
        if len(self._sessions) >= self._max_sessions:
            raise SessionLimitReachedError(f"server is holding {self._max_sessions} games")
        now = self._clock()
        session = Session(state=state, started_at=now, touched_at=now, client_id=client_id)
        session.log.extend(LoggedEvent(seq=seq, event=event) for seq, event in enumerate(events, start=1))
        self._sessions[state.game_id] = session
        return session

    def replace(self, state: GameState, events: tuple[Event, ...] = (), client_id: str | None = None) -> Session:
        """Let ``state`` take over its ``game_id`` from whatever is holding it (ADR-011).

        The live session is **detached, not edited**. Editing one in place would keep its
        subscribers pointed at a log whose numbering had just restarted — every event of the
        restored game would arrive at or below their high-water mark and be dropped as a duplicate,
        so a watching tab would go quiet forever and look like a working socket.

        Detaching is also what makes the bot driver safe: a driver that read the old session before
        this call writes to the old session after it, and that write lands on an object nothing can
        reach. See :meth:`update`.

        Since MON-907 the detachment is **said out loud**: :meth:`Session.detach` sets a flag every
        one of that session's mailboxes already holds, and the coroutine owning each socket closes
        it with ``WS_CURSOR_RESET`` so the client forgets its cursor and replays the restored game
        from the beginning. Before that, "the socket receives nothing from now on" was the whole
        behaviour, accepted in ADR-011 §"what this does not do" on the ground that a reconnect at a
        stale cursor is just as quiet — which is true, and is why the close code had to arrive
        together with the client-side reset rather than on its own.
        """
        self._evict_idle()
        # Detached *before* `create` counts, so a client replacing its own game is not charged twice
        # for one game_id — the slot it is about to reuse is already gone from the count. The pop
        # and the detach are one act: the popped session's watchers get the 4409 the moment their
        # session stops being the one this id names (MON-907).
        replaced = self._sessions.pop(state.game_id, None)
        if replaced is not None:
            replaced.detach()
        return self.create(state, events, client_id)

    def get(self, game_id: str) -> Session:
        self._evict_idle()
        try:
            session = self._sessions[game_id]
        except KeyError as exc:
            raise UnknownGameError(game_id) from exc
        session.touch(self._clock())
        return session

    def update(self, session: Session, state: GameState, events: tuple[Event, ...]) -> Session:
        """Commit a command's result: the new state, and its events with ``seq`` assigned.

        **The session, not the id.** A caller reads a session, asks the engine, and writes the answer
        back; between the read and the write there may be an ``await`` — the bot driver's thinking
        delay — and :meth:`replace` may have put a *different* session under that id in the meantime.
        Re-resolving the id here would append the old game's move to the new game's log, and
        ``Session.advance_lock`` cannot prevent it because the replacement carries a different lock.
        Writing to the session that was actually read means that stale move lands on a detached
        object and is collected, which is the correct outcome and needs no lock at all.
        """
        session.touch(self._clock())
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
        """Every live game. Sweeps first, but does not *touch*: enumerating the store must not
        be able to keep an abandoned game alive forever.

        No route reaches this since MON-909 deleted ``GET /games`` — it is the store's own
        inventory, used by the eviction tests and by anything that has to reason about the
        whole set rather than one game."""
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
