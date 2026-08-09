"""The half of a route that is not HTTP.

Every game route in this server does the same four things — look the session up, ask the
engine, store what it returned, project the result onto the wire shape — and *none* of those
four needs a request object, a response class or a framework. This module is that half,
extracted so it has exactly one implementation.

It was extracted for MON-805. The browser build (:mod:`kesef_server.browser`) runs the same
handlers with no server in front of them, and the first draft of it re-typed ``_view``,
``_logged``, ``_stamped``, ``_session`` and ``_create`` beside the originals in
:mod:`kesef_server.api`. Two copies of the projection is precisely the defect
:mod:`kesef_server.bots` opens by describing: "who is the game blocked on" having two
implementations is how that module's original bug happened. A parity test catches a *divergence*
after it exists; one function catches it by construction.

Two properties this module keeps, and they are the same two ``api.py`` claims:

* **No rules.** Nothing here compares cash against a price or decides what is legal. It asks
  ``legal_commands``, calls ``apply``, and copies the answer.
* **One clock.** :func:`stamped` overwrites ``EndTurn.elapsed_seconds`` from the store's clock,
  never from the caller. That is what stops a player forcing or dodging Kids Mode's ending
  (GAP G-6, MON-100 security review), and it holds for the browser transport too — where the
  clock happens to belong to the same person, so there is nothing to defend, but a second
  reading of a second clock would still be a second thing to keep in step.

Since MON-906 there is a third, and it is the reason ADR-012 put authority *here* rather than in
either transport:

* **One enforcement point.** :func:`speaker_for` resolves a request's ``Authorization`` secret to a
  speaker, and :func:`require_seat` / :func:`require_host` refuse before the engine is consulted.
  ``api.py`` and ``browser.py`` both call these, so the HTTP API and the Pyodide build cannot
  disagree about who may move a piece — which matters most in the build where the answer is
  "everybody at this screen", because that is the one nobody would think to test.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from typing import assert_never

from kesef_engine.board.loader import available_boards, load_board
from kesef_engine.commands import Command, EndTurn
from kesef_engine.events import Event
from kesef_engine.legality import legal_commands
from kesef_engine.ruleset import Ruleset, RulesetName
from kesef_engine.state import GameState, PlayerState
from kesef_server import errors
from kesef_server.bots import drive, seats_that_proposed_this_turn
from kesef_server.schemas import (
    BoardSummary,
    BoardView,
    GameCreated,
    GameStateView,
    GameView,
    IfExists,
    LoggedEvent,
    RulesetView,
    SaveFile,
    SeatClaimed,
    SeatClaimView,
    SpeakerView,
    is_addressable_game_id,
)
from kesef_server.sessions import (
    ClientSessionLimitReachedError,
    DuplicateGameError,
    Session,
    SessionLimitReachedError,
    SessionStore,
    UnknownGameError,
    mint_secret,
)

# --- Sessions ---------------------------------------------------------------


def session(store: SessionStore, game_id: str) -> Session:
    """The live session, or an :class:`~kesef_server.errors.ApiError` naming the 404."""
    try:
        return store.get(game_id)
    except UnknownGameError:
        raise errors.game_not_found(game_id) from None


def create(
    store: SessionStore, state: GameState, events: tuple[Event, ...] = (), *, client_id: str | None = None
) -> Session:
    """Seat a new game, translating the store's three refusals into keyed failures.

    ``client_id`` is who to charge the game to, for ``max_sessions_per_client`` (MON-905). It is
    ``None`` from the browser transport, which has one caller and nothing to divide the store
    between — see :attr:`~kesef_server.sessions.Session.client_id`.
    """
    try:
        return store.create(state, events, client_id)
    except DuplicateGameError:
        raise errors.game_already_exists(state.game_id) from None
    except ClientSessionLimitReachedError as refused:
        raise errors.too_many_games(refused.limit) from None
    except SessionLimitReachedError:
        raise errors.server_at_capacity(len(store)) from None


def minted_game_id() -> str:
    """A game id for a game that did not name itself.

    One spelling, because there are three callers — both transports' ``POST /games`` and the
    ``if_exists=copy`` branch below — and three literals is how two of them drift.
    """
    return f"game-{secrets.token_hex(8)}"


def load(
    store: SessionStore,
    save: SaveFile,
    if_exists: IfExists,
    *,
    enforcing: bool,
    client_id: str | None = None,
    secret: str | None = None,
) -> Session:
    """Seat a restored game, answering the conflict the player was asked about (ADR-011).

    The three policies are :class:`~kesef_server.schemas.IfExists`, and the conflict is only ever
    resolved *on* a conflict: a load with nothing in its way keeps the file's own id whatever the
    policy says, so ``if_exists`` is a conflict answer rather than a mode.

    ``copy`` rewrites one field of a copy of the state — the id, which is identity and not a rule —
    and mints rather than derives, because :data:`~kesef_server.schemas.GAME_ID_PATTERN` bounds both
    the character set and the length and a derived id can fail either.

    ``replace`` is **host-only** since ADR-012, and it is the branch that needed it: it ends whatever
    game is currently under that id, so before MON-906 a stranger holding a shared link could
    overwrite somebody's game with a file of their own choosing. ADR-011 §Security said so at the
    time and parked it — "belongs on the same list as every other route when MON-901 makes the API a
    network API" — which is this. The other two policies stay open to anybody: ``refuse`` changes
    nothing and ``copy`` seats a *different* game under a minted id.
    """
    if not is_addressable_game_id(save.state.game_id):
        raise errors.invalid_game_id()
    try:
        return store.create(save.state, save.events, client_id)
    except DuplicateGameError:
        pass
    except ClientSessionLimitReachedError as refused:
        raise errors.too_many_games(refused.limit) from None
    except SessionLimitReachedError:
        raise errors.server_at_capacity(len(store)) from None
    if if_exists is IfExists.REFUSE:
        raise errors.game_already_exists(save.state.game_id)
    if if_exists is IfExists.REPLACE:
        # Asked of the session being *ended*, not of the one being seated: the credential that
        # matters is the one belonging to the game about to disappear. Resolved through `session`
        # rather than `store.get` so a game evicted between the `create` above and here is the
        # ordinary keyed 404 instead of a `KeyError`.
        require_host(session(store, save.state.game_id), secret, enforcing=enforcing)
        # Charged like any other seating (MON-905): `replace` detaches the old session before it
        # counts, so taking over a game this client already holds is free, and taking over somebody
        # else's is refused once this client is at its cap.
        try:
            return store.replace(save.state, save.events, client_id)
        except ClientSessionLimitReachedError as refused:
            raise errors.too_many_games(refused.limit) from None
    if if_exists is IfExists.COPY:
        copied = save.state.model_copy(update={"game_id": minted_game_id()})
        return create(store, copied, save.events, client_id=client_id)
    assert_never(if_exists)


# --- Seat authority (ADR-012, MON-906) --------------------------------------
#
# Who a connection speaks for. Three speakers, one resolver, two guards, and a filter on the
# projection — that is the whole model, and it lives here rather than in either transport so the
# HTTP API and the in-tab Pyodide build enforce the same thing by construction.


@dataclass(frozen=True)
class Host:
    """Speaks for every **unclaimed human** seat, and for the host-only routes.

    "Every unclaimed human seat" is what makes hotseat play byte-identical under this design: one
    screen, one secret handed to its own client at creation, and all six seats playable exactly as
    before. A seat somebody has claimed drops out of the host's reach — which is the point, since
    the person who claimed it is somewhere else."""


@dataclass(frozen=True)
class Seat:
    """Speaks for exactly one seat. Not to be confused with :class:`kesef_engine.factory.Seat`,
    which is a *chair at the table* — this is a claim on one."""

    player: int


@dataclass(frozen=True)
class Spectator:
    """Speaks for nothing: the full board and state, an empty ``legal_commands``, no mutations.

    The default for a request carrying no secret, and for one carrying a secret this session has
    never heard of. Those two are deliberately the same answer — distinguishing "you sent nothing"
    from "you sent the wrong thing" would turn the claim route into an oracle for guessing
    credentials, and there is nothing a client could usefully do differently about it.
    """


Speaker = Host | Seat | Spectator
"""Who a request speaks for. ``None`` wherever a :class:`Speaker` is optional means "authority is
not in force" — the ``seat_authority=off`` rollout position, where every caller speaks for every
seat exactly as they did before this module grew a fourth section."""

HOST = Host()
SPECTATOR = Spectator()
"""The two singletons. Neither carries state, and a fresh instance per request would only make
``is`` comparisons in tests read as false for no reason."""


def _same_secret(presented: str, stored: str) -> bool:
    """Constant-time comparison, on bytes.

    ``secrets.compare_digest`` accepts ``str`` only for ASCII, and raises ``TypeError`` otherwise —
    and the presented value arrives from an ``Authorization`` header, where a caller may put any
    UTF-8 they like. Encoding first means a header full of Hebrew is a mismatch rather than a 500.
    """
    return secrets.compare_digest(presented.encode("utf-8"), stored.encode("utf-8"))


def speaker_for(held: Session, secret: str | None) -> Speaker:
    """Resolve one presented secret to a speaker. The whole authority model, in one function.

    Order matters only in that the host is checked first, which is the common case on the hotseat
    path. Every comparison is :func:`secrets.compare_digest`, and the loop over claimed seats does
    not stop early on a mismatch for the same reason — a resolver that returned as soon as a byte
    differed would leak which prefix was right, one request at a time.

    **Under the authority's lock** (MON-906 review, finding 3). This runs on a threadpool worker for
    every sync route, so iterating ``seat_secrets`` here while :func:`claim_seat` inserts into it on
    another thread is a ``dictionary changed size during iteration`` 500 without the lock — a read
    path made to crash by a concurrent write. A snapshot copy under the lock would do as well; the
    lock is simpler and the loop is over at most six entries.
    """
    if secret is None or secret == "":
        return SPECTATOR
    if _same_secret(secret, held.authority.host_secret):
        return HOST
    found: Speaker = SPECTATOR
    with held.authority.lock:
        for player, seat_secret in held.authority.seat_secrets.items():
            if _same_secret(secret, seat_secret):
                found = Seat(player)
    return found


def speaker_view(speaker: Speaker) -> SpeakerView:
    """The wire projection of a resolved speaker (ADR-012, MON-906).

    The one place :class:`Speaker` becomes :class:`~kesef_server.schemas.SpeakerView`, so the client
    can read who it speaks for rather than infer it from ``localStorage``. Carries the seat number
    only for a :class:`Seat`: a host speaks for many and a spectator for none.
    """
    if isinstance(speaker, Seat):
        return SpeakerView(kind="seat", player=speaker.player)
    return SpeakerView(kind="host" if isinstance(speaker, Host) else "spectator")


def _human_seats(held: Session) -> tuple[PlayerState, ...]:
    """The seats a person could be sitting in. Bot seats are the server's to drive (MON-304)."""
    return tuple(player for player in held.state.players if not player.kind.is_bot)


def speaks_for(held: Session, speaker: Speaker | None, player: int) -> bool:
    """Whether ``speaker`` may act as seat ``player``. The one rule, asked by the guard and by the
    projection so the buttons a client is offered and the commands it may send cannot disagree.

    ``None`` — authority not in force — speaks for everything, which is the pre-MON-906 behaviour
    the rollout flag's ``off`` position reproduces.
    """
    if speaker is None:
        return True
    if isinstance(speaker, Seat):
        return speaker.player == player
    if isinstance(speaker, Spectator):
        return False
    seated = next((seat for seat in held.state.players if seat.id == player), None)
    # The host: every human seat nobody has claimed. A bot seat is excluded from *everybody*,
    # including the host — the server drives it, `seatedCommands.ts` already declines to offer its
    # moves on the client, and a route that accepted one would let a person play the computer's turn.
    return seated is not None and not seated.kind.is_bot and player not in held.authority.seat_secrets


def require_seat(held: Session, secret: str | None, player: int, *, enforcing: bool) -> None:
    """Refuse, with a key, before the engine is consulted (ADR-012).

    **Before**, and that ordering is the acceptance criterion rather than an optimisation: a
    cross-seat command that reached ``apply`` would append events to the log — the game would
    *happen* — and a 403 afterwards would be a refusal of a move that had already been made. The
    test asserts the cursor is unmoved, which is what makes the ordering checkable.

    ``enforcing`` is the rollout flag (``Settings.enforcing_seats``), read by the caller and passed
    in so this module stays free of configuration the way its bot functions do. It has **no default**
    (MON-906 review, finding 8): a security guard that fails open when a caller forgets a keyword is
    the one default worth refusing to provide, so an omission is a ``TypeError`` at import-adjacent
    call time rather than a silent no-op in production. Off, this returns without looking at anything.
    """
    if not enforcing:
        return
    if not speaks_for(held, speaker_for(held, secret), player):
        raise errors.seat_not_yours(player)


def require_host(held: Session, secret: str | None, *, enforcing: bool) -> None:
    """The guard on ``/save``, ``DELETE`` and ``if_exists=replace``. See :func:`errors.host_only`.

    ``enforcing`` has no default, for the reason :func:`require_seat` gives: a fail-open security
    guard is not a thing to make convenient to reach by accident.
    """
    if not enforcing:
        return
    if not isinstance(speaker_for(held, secret), Host):
        raise errors.host_only()


def claim_seat(held: Session, player: int) -> str:
    """Take one unclaimed human seat, first come first served, and mint its secret.

    Deliberately **not** authority-guarded: anybody holding the game id may claim, because the id
    *is* the invitation — "the link is how you join" is the product, and a second credential to get a
    seat would be a lobby nobody asked for (ADR-012 §Open questions 1, answered "one link" by
    default). The bound on that openness is the id itself, which is unguessable and shared on purpose.

    But it **is** taken under the authority's lock (MON-906 review, finding 3), and the whole
    check-then-mint-then-set is one critical section rather than three statements. On the threadpool
    two requests for one seat otherwise both pass the "is it free" test before either writes, and the
    second silently overwrites the first's secret — measured at 93 double-claims in 2000 concurrent
    attempts. Inside the lock the second finds the seat already in ``seat_secrets`` and is refused,
    so exactly one caller wins.

    Two refusals, both keyed: a seat that is not a seat at this table, and a seat somebody
    (or something) already occupies.
    """
    seated = next((seat for seat in held.state.players if seat.id == player), None)
    if seated is None:
        raise errors.unknown_player(player)
    with held.authority.lock:
        if seated.kind.is_bot or player in held.authority.seat_secrets:
            raise errors.seat_taken(player)
        secret = mint_secret()
        held.authority.seat_secrets[player] = secret
    return secret


def release_seat(held: Session, player: int) -> None:
    """Void a seat's claim, so the seat can be taken again.

    The unstick for a lost seat secret — a guest closes the tab in a browser that keeps no storage,
    and the seat is otherwise held by a credential nobody has any more. The host precondition is the
    caller's (``require_host``), because this function is also how a future "kick" would be spelled
    and the two would want different preconditions.

    Idempotent: releasing an unclaimed seat is not an error, it is the state the caller asked for.

    Under the authority's lock (MON-906 review, finding 3), so a release racing a claim or a speaker
    resolution cannot mutate the dict mid-read on another thread.
    """
    with held.authority.lock:
        held.authority.seat_secrets.pop(player, None)


def claims(held: Session) -> tuple[SeatClaimView, ...]:
    """Which human seats are taken — the join screen's whole input (ADR-012).

    Derived from the authority on every projection rather than tracked beside it, for the reason
    ``SessionStore.held_by`` gives about counting rather than tallying: a derived answer cannot
    disagree with the thing it describes.

    The set of taken seats is snapshotted under the authority's lock, so a projection built while a
    claim is landing on another thread reads a consistent picture rather than a dict mid-insert
    (MON-906 review, finding 3).
    """
    with held.authority.lock:
        taken = frozenset(held.authority.seat_secrets)
    return tuple(SeatClaimView(player=seat.id, claimed=seat.id in taken) for seat in _human_seats(held))


# --- Projections ------------------------------------------------------------


def board_summaries() -> list[BoardSummary]:
    """The boards available on the new-game screen."""
    summaries = []
    for board_id in available_boards():
        board = load_board(board_id)
        summaries.append(
            BoardSummary(
                id=board.id,
                name_key=board.name_key,
                tile_count=len(board.tiles),
                ownable_count=sum(1 for tile in board.tiles if tile.is_ownable),
                # Copied, not judged: see `Board.catalogue_ready` for why the flag is board data.
                # Every board is listed and the *picker* filters, so a board held back is visible
                # to a developer reading this response and absent from a parent's choices (MON-419).
                catalogue_ready=board.catalogue_ready,
            )
        )
    return summaries


def rulesets() -> list[RulesetView]:
    """Both rulesets, expanded and labelled (MON-417, G-36).

    The universal rules are the baseline every view is measured against, so they are resolved once
    here rather than per view. ``differing_settings`` is the engine's answer — a client working out
    which rules differ would be holding a rule.
    """
    universal = Ruleset.universal()
    return [RulesetView.from_ruleset(Ruleset.by_name(name), universal) for name in RulesetName]


def view(held: Session, events: tuple[LoggedEvent, ...] = (), *, speaker: Speaker, enforcing: bool) -> GameView:
    """The projection. Every field is a copy or an engine call (ADR-008).

    Two independent things ``speaker`` does, and keeping them independent is the MON-906 review's
    root-cause fix:

    * It is **always** reported, as ``GameView.speaker``, so the client reads who it speaks for
      rather than inferring it from ``localStorage``. A voided or replaced secret resolves to
      ``spectator`` here, so the seat picker reappears in the very next view — the self-heal.
    * It narrows ``legal_commands`` **only when ``enforcing``**. ``legal_commands(state)`` is still
      asked of the state alone, so ADR-005's soundness and completeness properties — stated over the
      state — are untouched, and what changes is which of its answers this *caller* is shown. That
      distinction is the reason ADR-012 rejected putting a credential on the ``GameState``: there,
      ``legal_commands`` itself would become caller-dependent and the property suite would quietly
      stop meaning anything.

    ``enforcing`` off is the ``seat_authority=off`` rollout position: the list is unfiltered, exactly
    what this function returned before MON-906 — but the ``speaker`` field is still the true speaker,
    which is what lets the client start reading it *before* the flag flips. Required, no default, for
    the reason :func:`require_seat` gives about a projection that must not silently stop filtering.
    """
    offered = legal_commands(held.state)
    mine = tuple(one for one in offered if speaks_for(held, speaker, one.player)) if enforcing else offered
    return GameView(
        board=BoardView.from_board(held.state.board),
        state=GameStateView.from_state(held.state),
        legal_commands=mine,
        events=events,
        event_cursor=held.cursor,
        claims=claims(held),
        speaker=speaker_view(speaker),
    )


def viewed(held: Session, secret: str | None, events: tuple[LoggedEvent, ...] = (), *, enforcing: bool) -> GameView:
    """The read path both transports share: resolve the speaker from the secret, then project.

    One function so ``api.py`` and ``browser.py`` stop each spelling "resolve the speaker, decide
    whether to filter by the flag, build the view" (MON-906 review, finding 9). It also resolves the
    speaker *once* — the previous shape resolved it in the route and again inside the projection.
    """
    return view(held, events, speaker=speaker_for(held, secret), enforcing=enforcing)


def created(held: Session, *, enforcing: bool) -> GameCreated:
    """A newly seated game and the one host secret for it (ADR-012).

    Both ``POST /games`` and ``POST /games/load`` answer this, through one function, because "the
    creator is handed the host secret" is a property of *seating a session* rather than of either
    route — and a second spelling is how a load ends up returning a game its own client cannot play.
    The view is the host's, since that is who is reading it: a bot seat's moves are already absent
    from the first frame rather than offered for one render.

    A :class:`GameCreated` is a :class:`GameView` plus ``host_secret`` (finding 1), so the view's
    fields are copied up verbatim — an old cached client still reads ``state.game_id`` off the top.
    """
    v = view(held, speaker=HOST, enforcing=enforcing)
    return GameCreated(host_secret=held.authority.host_secret, **dict(v))


def claimed(held: Session, player: int, *, enforcing: bool) -> SeatClaimed:
    """Take one seat under the authority lock, then project the view as that seat (ADR-012).

    The speaker is ``Seat(player)`` rather than the secret just minted, because this response *is*
    the answer to this claim and resolving would ask the session a question already answered.
    """
    secret = claim_seat(held, player)
    return SeatClaimed(seat_secret=secret, view=view(held, speaker=Seat(player), enforcing=enforcing))


def save_file(held: Session) -> SaveFile:
    """The whole session on disk: the state, and its log stripped back to engine events (ADR-011).

    ``seq`` is dropped on the way out for the same reason it is assigned on the way in — it belongs
    to a session, and the session that reads this file will not be this one.
    """
    return SaveFile(state=held.state, events=tuple(entry.event for entry in held.log))


def logged(held: Session, events: tuple[Event, ...]) -> tuple[LoggedEvent, ...]:
    """The just-applied events, with the ``seq`` the store assigned them."""
    return tuple(held.log[-len(events) :]) if events else ()


def stamped(store: SessionStore, held: Session, command: Command) -> Command:
    """Overwrite ``EndTurn.elapsed_seconds`` with the store's own reading.

    The engine owns no clock, but Kids Mode ends a game after
    ``Ruleset.target_duration_minutes``, so the time has to arrive on a command (GAP G-6). It
    arrives from *here*, never from the request: a client that chose its own number could force
    the ending on the turn it happens to be winning, or postpone it forever. This is the only
    clock read in the server, and ``SessionStore`` is the only thing that holds a clock (see its
    module docstring).
    """
    if isinstance(command, EndTurn):
        return command.model_copy(update={"elapsed_seconds": store.elapsed_seconds(held)})
    return command


def wire_params(context: dict[str, object]) -> dict[str, int | str]:
    """Coerce an error's context to what the catalogue can interpolate.

    ``IllegalCommandError`` is typed ``**context: object``; every rule in the engine passes ints
    and strings, and anything else would be a bug in the *engine* rather than something to hide
    here — so it is stringified rather than dropped.
    """
    return {key: value if isinstance(value, int | str) else str(value) for key, value in context.items()}


# --- Bots -------------------------------------------------------------------


async def advance_bots_once(
    store: SessionStore, game_id: str, *, think_seconds: float
) -> tuple[LoggedEvent, ...] | None:
    """Let the seat the engine is waiting on move, if it is a bot. ``None`` if none can.

    **One step, stored before it returns.** Both transports drive bots a single move at a time
    for the same reason (MON-304): each move has to reach the log — and therefore the WebSocket
    subscribers, or the browser's fake socket — while the next one is still being thought about.
    A version that played a whole turn and returned it would turn the thinking delay into a
    silence followed by six moves in one frame, which is the freeze-then-jump the delay exists
    to prevent.

    The one thing passed *in* to the driver is which seats have already proposed a trade this
    turn (ADR-009), derived from the session log on every step because a proposal to a human ends
    the call altogether — a driver-local memory would reset before the human had answered, and
    the same offer would come straight back.

    **The caller must hold** ``Session.advance_lock`` (MON-806). This function reads a position and
    writes the move it produced, with an ``await`` in between, so two callers running it
    concurrently would both read the same position, compute the same move and append the same
    events twice. The lock is not taken *here* because the two transports hold it across different
    spans: :func:`advance_bots` holds it for a whole run of steps, and the browser facade holds it
    for one, since a page pumps step by step.

    Raises :class:`~kesef_server.sessions.UnknownGameError` if the game has been deleted since the
    caller last looked: whether that is worth reporting is the caller's decision, and the two
    transports make it differently — the HTTP background task is a quiet no-op, the browser's pump
    answers the 404 the page is waiting for.
    """
    held = store.get(game_id)
    async for step in drive(
        held.state,
        think_seconds=think_seconds,
        max_steps=1,
        traded_seats=seats_that_proposed_this_turn(entry.event for entry in held.log),
    ):
        # `held`, not `game_id`: this write happens after a thinking delay, and a load may have taken
        # the id over in the meantime (ADR-011). See `SessionStore.update`.
        return logged(store.update(held, step.state, step.events), step.events)
    return None


async def advance_bots(store: SessionStore, game_id: str, *, think_seconds: float, max_steps: int) -> None:
    """Let every bot that can act do so, one stored move at a time, under this game's lock.

    The HTTP transport's whole bot driver: :func:`api._advance_bots` is a background task that calls
    this and nothing else. The browser transport does *not* call it — a page cannot wait for a whole
    bot turn inside one call, so it pumps :func:`advance_bots_once` itself and holds the same lock
    per step.

    **One game gets one driver at a time (MON-806).** Every command queues one of these, so two
    quick commands give the same game two, and the read-one-step-write loop inside
    :func:`advance_bots_once` races against its twin. ``Session.advance_lock`` serializes them: the
    latecomer waits, re-reads a position the first driver has already finished, finds nothing to do
    and leaves. A skip-if-running flag would be cheaper but wrong — the running driver may already
    have decided "no bot can act" from the position *before* the command that queued the second
    task, and skipping would strand the bot until the next request.

    **A game deleted while this runs is a quiet no-op**, not an error: there is nobody left to
    advance, and this has no caller to report to.

    The step cap is per call, so the next command resumes. It is not decoration: an engine change
    that made two commands mutually re-enabling would otherwise turn this into a hang, and a hang in
    a game server is worse than a bot that stops moving and logs why.
    """
    try:
        held = store.get(game_id)
    except UnknownGameError:
        return
    async with held.advance_lock:
        for _ in range(max_steps):
            try:
                if await advance_bots_once(store, game_id, think_seconds=think_seconds) is None:
                    return
            except UnknownGameError:
                return
