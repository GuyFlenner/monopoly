"""HTTP + WebSocket transport for the rules engine.

The server owns sessions, serialization and fan-out. It owns no rules. If a conditional in
this file starts to look like a rule, it belongs in :mod:`kesef_engine`.

Concretely, three things and only three things happen in every game route here:

1. ``legal_commands(state)`` or ``is_legal(state, command)`` is asked — never answered.
2. ``apply(state, command)`` is called, and whatever it returns is stored.
3. The result is projected onto the wire shape in :mod:`kesef_server.schemas` (ADR-008).

There is one deliberate exception to purity, and it is documented where it happens: the
server stamps ``EndTurn.elapsed_seconds`` from its own clock. A client-supplied clock would
let a player force or dodge Kids Mode's time limit, so the field is overwritten, never read
(GAP G-6, MON-100 security review).
"""

from __future__ import annotations

import asyncio
import secrets
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Query, Request, Response, WebSocket, WebSocketDisconnect, status
from fastapi.exceptions import RequestValidationError, WebSocketRequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

from kesef_engine.board.loader import available_boards, load_board
from kesef_engine.commands import Command, EndTurn
from kesef_engine.errors import BoardDataError, EngineError, IllegalCommandError
from kesef_engine.events import Event
from kesef_engine.factory import new_game
from kesef_engine.legality import is_legal, legal_commands
from kesef_engine.reducer import apply
from kesef_engine.ruleset import Ruleset, RulesetName
from kesef_engine.state import GameState
from kesef_server import errors
from kesef_server.config import Settings, settings
from kesef_server.errors import CONTENT_TOO_LARGE, UNPROCESSABLE, ApiError
from kesef_server.log import configure_logging, get_logger
from kesef_server.schemas import (
    BoardSummary,
    BoardView,
    CommandRequest,
    ErrorResponse,
    GameStateView,
    GameSummary,
    GameView,
    LegalityView,
    LoggedEvent,
    NewGameRequest,
    is_addressable_game_id,
)
from kesef_server.sessions import (
    DuplicateGameError,
    Session,
    SessionLimitReachedError,
    SessionStore,
    Subscriber,
    SubscriberLimitReachedError,
    UnknownGameError,
)

configure_logging()
log = get_logger()

WS_EVENT_STREAM_PATH = "/games/{game_id}/ws"
"""Declared in the OpenAPI document by hand — see :func:`_openapi`."""

WS_GAME_NOT_FOUND = 4404
"""Close code for a socket opened against a game that does not exist. In the application
range (4000-4999); it mirrors the HTTP 404 so a client can branch on one number."""

WS_TOO_MANY_WATCHERS = 4429
"""This game is already carrying ``max_subscribers_per_game`` listeners. Mirrors HTTP 429."""

WS_WATCHER_TOO_SLOW = 4413
"""This socket fell ``subscriber_queue_size`` events behind, so its mailbox overflowed and it
is closed rather than grown. Mirrors HTTP 413 — the client asked for more than it would take."""

WS_MALFORMED_REQUEST = 4422
"""A handshake FastAPI's validation refused — an unparseable ``?since=``, say. Mirrors the 422
``error.malformed_request`` the HTTP routes answer; without it FastAPI's default closed the
socket with 1008 and pydantic's *English* error list as the reason (G-33)."""

app = FastAPI(
    title="Kesef Street",
    version="0.1.0",
    summary="A bilingual property-trading board game",
    description=(
        "Transport for the kesef-engine rules core. All human-facing strings in this API "
        "are i18n keys, never prose — the client owns language."
    ),
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

_store = SessionStore(
    max_sessions=settings.max_sessions,
    ttl_seconds=settings.session_ttl_minutes * 60,
)


def get_store() -> SessionStore:
    """Overridable in tests so each test gets a clean store."""
    return _store


def get_settings() -> Settings:
    return settings


StoreDep = Annotated[SessionStore, Depends(get_store)]
SettingsDep = Annotated[Settings, Depends(get_settings)]

ERROR_RESPONSES: dict[int | str, dict[str, Any]] = {
    status.HTTP_404_NOT_FOUND: {"model": ErrorResponse, "description": "No game with that id."},
    UNPROCESSABLE: {"model": ErrorResponse, "description": "Rejected, with an i18n key."},
}
"""Declared on the routes so the shape reaches ``generated.ts`` — a 422 the client cannot
type is a 422 the client will render as prose (G-33)."""


# --- Error handling ---------------------------------------------------------


def _api_error_handler(request: Request, exc: Exception) -> Response:
    assert isinstance(exc, ApiError)  # registered for ApiError only
    body = ErrorResponse(reason_key=exc.reason_key, params=exc.params)
    # The key and the status, and the route *template* rather than the path: the path carries a
    # caller-supplied game_id, and a log line is an untrusted-input sink like any other. See
    # kesef_server.log.
    log.info("request.rejected", reason_key=exc.reason_key, status=exc.status_code, route=_route_of(request))
    return JSONResponse(status_code=exc.status_code, content=body.model_dump(mode="json"))


def _route_of(request: Request) -> str:
    """The matched route's template, or ``"-"`` when nothing matched."""
    route = request.scope.get("route")
    path = getattr(route, "path", None)
    return path if isinstance(path, str) else "-"


def _illegal_command_handler(request: Request, exc: Exception) -> Response:
    """The engine's rejection, forwarded whole: key *and* context params (G-33)."""
    assert isinstance(exc, IllegalCommandError)
    body = ErrorResponse(reason_key=exc.reason_key, params=_wire_params(exc.context))
    return JSONResponse(status_code=UNPROCESSABLE, content=body.model_dump(mode="json"))


def _validation_error_handler(request: Request, exc: Exception) -> Response:
    """A malformed body, reported as a key.

    FastAPI's default renders pydantic's English ``msg`` fields. Those are developer prose,
    so the client is given the offending field paths and a key instead.
    """
    assert isinstance(exc, RequestValidationError)
    fields = ", ".join(".".join(str(part) for part in error["loc"][1:]) for error in exc.errors())
    return _api_error_handler(request, errors.malformed_request(fields))


def _engine_error_handler(request: Request, exc: Exception) -> Response:
    """An ``EngineError`` that is not an ``IllegalCommandError``, still as a key.

    ``IllegalCommandError`` has its own handler; every other engine failure — a
    ``BoardDataError`` from a rule module, or a subclass that does not exist yet — had none, so
    it left the server as a bare 500 with a traceback. 500 rather than 4xx is deliberate and
    honest: an engine error reaching here is a defect on this side of the wire, not a client
    mistake, and the key says so without leaking the exception's text.
    """
    assert isinstance(exc, EngineError)
    body = ErrorResponse(reason_key="error.engine_failure")
    log.error("engine.failed", reason_key=body.reason_key, exception=type(exc).__name__)
    return JSONResponse(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, content=body.model_dump(mode="json"))


HTTP_ERROR_KEYS: dict[int, str] = {
    status.HTTP_404_NOT_FOUND: "error.not_found",
    status.HTTP_405_METHOD_NOT_ALLOWED: "error.method_not_allowed",
}
"""Keys for the failures starlette itself raises, before any handler of ours runs."""

UNKEYED_HTTP_ERROR = "error.http_error"
"""The fallback for a status starlette raises that :data:`HTTP_ERROR_KEYS` does not name. The
``status`` param is what makes one catalogue entry enough for all of them."""


def _http_exception_handler(request: Request, exc: Exception) -> Response:
    """Starlette's own refusals, in this API's one error shape.

    ``errors.py`` opens by asserting that "every failure a client can cause leaves this server
    as ``{reason_key, params}``", and that was false: with no handler registered for
    ``StarletteHTTPException``, ``GET /nope`` answered ``{"detail":"Not Found"}``,
    ``GET /games/a/b`` the same, and ``PUT /games`` ``{"detail":"Method Not Allowed"}``. That
    shape is declared nowhere in the document, so a generated client cannot branch on it — the
    G-33 / ADR-008 §4 defect, one layer below the routes that had already fixed it.

    ``exc.headers`` is forwarded because a 405's ``Allow`` is part of the answer, not decoration.
    """
    assert isinstance(exc, StarletteHTTPException)
    body = ErrorResponse(
        reason_key=HTTP_ERROR_KEYS.get(exc.status_code, UNKEYED_HTTP_ERROR),
        params={"status": exc.status_code},
    )
    log.info("request.rejected", reason_key=body.reason_key, status=exc.status_code, route=_route_of(request))
    return JSONResponse(status_code=exc.status_code, content=body.model_dump(mode="json"), headers=exc.headers)


async def _ws_validation_error_handler(websocket: WebSocket, exc: Exception) -> None:
    """A handshake pydantic refused, reported as a close code rather than as prose.

    FastAPI's default closes with 1008 and ``str(exc.errors())`` as the reason — pydantic's
    English, on a WebSocket, which is the same G-33 defect as ``{"detail": ...}`` on HTTP. An
    unparseable ``?since=`` now gets exactly the treatment ``WS_GAME_NOT_FOUND`` gets.
    """
    assert isinstance(exc, WebSocketRequestValidationError)
    log.info("ws.refused", reason_key="error.malformed_request")
    await websocket.close(code=WS_MALFORMED_REQUEST, reason="error.malformed_request")


app.add_exception_handler(StarletteHTTPException, _http_exception_handler)
app.add_exception_handler(ApiError, _api_error_handler)
app.add_exception_handler(IllegalCommandError, _illegal_command_handler)
# Registered *after* IllegalCommandError, which is a subclass: starlette matches on the most
# derived registered class, so the order is not what selects it — but reading them in this order
# is what makes the relationship obvious.
app.add_exception_handler(EngineError, _engine_error_handler)
app.add_exception_handler(RequestValidationError, _validation_error_handler)
app.add_exception_handler(WebSocketRequestValidationError, _ws_validation_error_handler)


def _wire_params(context: dict[str, object]) -> dict[str, int | str]:
    """Coerce an error's context to what the catalogue can interpolate.

    ``IllegalCommandError`` is typed ``**context: object``; every rule in the engine passes
    ints and strings, and anything else would be a bug in the *engine* rather than something
    to hide here — so it is stringified rather than dropped.
    """
    return {key: value if isinstance(value, int | str) else str(value) for key, value in context.items()}


async def _read_bounded(request: Request, limit: int) -> bytes:
    """Read the request body, refusing the moment it crosses ``limit`` bytes.

    ``await request.body()`` buffers the *whole* upload and only then permits a comparison
    against the ceiling, so a 60 MB body sent against a 1 KB limit still allocated 60 MB —
    twice over, because starlette joins the accumulated chunks — and answered 413 only after
    the damage was done. N concurrent uploads from an unauthenticated client were therefore an
    arbitrary allocation primitive: ``config.py`` calls an unbounded body read "a denial-of-
    service invitation" and the code performed one (MON-303 security review).

    Streaming and aborting on the first chunk that crosses the line means the process never
    holds more than the ceiling plus one chunk. The ``Content-Length`` check in the caller is
    a fast path only — a chunked upload declares no length, so *this* is the authoritative
    guard and ``test_the_bounded_read_never_buffers_more_than_the_ceiling`` measures it.
    """
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            raise errors.save_too_large(limit)
        chunks.append(chunk)
    return b"".join(chunks)


# --- Meta ------------------------------------------------------------------


@app.get("/health", tags=["meta"])
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/boards", tags=["meta"])
def list_boards() -> list[BoardSummary]:
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
            )
        )
    return summaries


@app.get("/rulesets", tags=["meta"])
def list_rulesets() -> list[Ruleset]:
    """Both rulesets, fully expanded, so the UI can show what Kids Mode actually changes."""
    return [Ruleset.by_name(name) for name in RulesetName]


# --- Games -----------------------------------------------------------------


@app.post(
    "/games",
    status_code=status.HTTP_201_CREATED,
    tags=["game"],
    responses={
        status.HTTP_409_CONFLICT: {"model": ErrorResponse, "description": "That game_id is already live."},
        UNPROCESSABLE: {"model": ErrorResponse},
        status.HTTP_503_SERVICE_UNAVAILABLE: {"model": ErrorResponse, "description": "Session cap reached."},
    },
)
def create_game(request: NewGameRequest, store: StoreDep) -> GameView:
    """Start a game and return the opening view."""
    seed = request.seed if request.seed is not None else secrets.randbits(32)
    try:
        state = new_game(
            [seat.to_seat() for seat in request.seats],
            seed=seed,
            game_id=request.game_id or f"game-{secrets.token_hex(8)}",
            board_id=request.board_id,
            ruleset=Ruleset.by_name(request.ruleset),
            locale=request.locale,
        )
    except BoardDataError:
        # `new_game` loads the board up front precisely so that a bad board id fails here
        # rather than on the first roll. Narrowed from `EngineError`: that caught every engine
        # failure and labelled all of them `error.unknown_board`, so a rule module raising for
        # any other reason answered a 422 naming the wrong cause. Anything else now falls
        # through to `_engine_error_handler`, which reports what it actually was.
        raise errors.unknown_board(request.board_id) from None
    except ValueError:
        raise errors.invalid_new_game() from None
    return _view(_create(store, state))


@app.get("/games", tags=["game"])
def list_games(store: StoreDep) -> list[GameSummary]:
    return [
        GameSummary(
            game_id=session.state.game_id,
            board_id=session.state.board_id,
            ruleset=session.state.ruleset.name,
            turn_number=session.state.turn_number,
            player_names=tuple(player.name for player in session.state.players),
        )
        for session in store.all()
    ]


@app.post(
    "/games/load",
    status_code=status.HTTP_201_CREATED,
    tags=["game"],
    responses={
        status.HTTP_409_CONFLICT: {"model": ErrorResponse},
        CONTENT_TOO_LARGE: {"model": ErrorResponse},
        UNPROCESSABLE: {"model": ErrorResponse},
        status.HTTP_503_SERVICE_UNAVAILABLE: {"model": ErrorResponse},
    },
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": {"$ref": "#/components/schemas/GameState"}}},
        }
    },
)
async def load_game(request: Request, store: StoreDep, config: SettingsDep) -> GameView:
    """Restore a saved game — the body is exactly what ``GET /games/{id}/save`` returned.

    The body is read raw rather than declared as a ``GameState`` parameter, for two reasons
    carried forward from the MON-100 security review:

    * **Size.** This is the only route whose body is not a small fixed shape, so it gets an
      explicit ceiling instead of reading whatever arrives — enforced *while* reading, by
      :func:`_read_bounded`, not after.
    * **Every load failure is one key.** A stale ``schema_version`` raises ``ValueError``
      (pydantic wraps it), but a save naming an unknown board raises ``BoardDataError``,
      which is *not* a ``ValueError`` — pydantic lets it through, and as a declared body
      parameter it escaped as a 500 with a traceback. Validating inside the handler is what
      lets both become ``error.save_schema_mismatch``.

    The OpenAPI request body is declared by hand above, so the contract still says
    ``GameState`` and ``generated.ts`` still types it.
    """
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > config.max_save_bytes:
        raise errors.save_too_large(config.max_save_bytes)
    raw = await _read_bounded(request, config.max_save_bytes)
    try:
        state = GameState.model_validate_json(raw)
    except (ValidationError, ValueError, EngineError):
        raise errors.save_schema_mismatch() from None
    # The id arrives from inside the body, where it is not a request field and so cannot carry
    # the constraint ``NewGameRequest.game_id`` does. Unchecked, a save named ``kitchen/table``
    # took a session slot that no route could then reach or free (schemas.GAME_ID_PATTERN).
    if not is_addressable_game_id(state.game_id):
        raise errors.invalid_game_id()
    return _view(_create(store, state))


@app.get("/games/{game_id}", tags=["game"], responses=ERROR_RESPONSES)
def get_game(
    game_id: str,
    store: StoreDep,
    since: Annotated[int | None, Query(ge=0, description="Replay the events after this cursor.")] = None,
) -> GameView:
    """The current view. Safe to poll, and the reconnect path for the UI.

    ``since`` is the event cursor (G-34). Omit it for state only; ``since=0`` replays the
    whole game, which is what a reconnecting client wants.
    """
    session = _session(store, game_id)
    events = session.events_since(since) if since is not None else ()
    return _view(session, events)


@app.get("/games/{game_id}/save", tags=["game"], responses=ERROR_RESPONSES)
def save_game(game_id: str, store: StoreDep) -> GameState:
    """The complete state, RNG and deck order included — the save file.

    This is the *only* route that returns hidden information, which is the whole of
    ADR-008 §2: "the JSON is the save file" survives without being conflated with what a
    client may see while playing.
    """
    return _session(store, game_id).state


@app.post("/games/{game_id}/commands", tags=["game"], responses=ERROR_RESPONSES)
async def submit_command(game_id: str, request: CommandRequest, store: StoreDep) -> GameView:
    """Apply one command. The only way a game changes.

    ``async`` on purpose: it puts the handler on the event loop, so appending to a live
    WebSocket subscriber's queue (MON-303) happens on the loop's own thread rather than from
    a thread-pool worker.
    """
    session = _session(store, game_id)
    state, events = apply(session.state, _stamped(store, session, request.command))
    return _view(store.update(game_id, state, events), _logged(session, events))


@app.post("/games/{game_id}/validate", tags=["game"], responses=ERROR_RESPONSES)
def validate_command(game_id: str, request: CommandRequest, store: StoreDep) -> LegalityView:
    """Ask whether a command would be accepted, changing nothing (G-32).

    An illegal command is a 200 with ``legal: false`` here, not a 422 — the trade builder
    asks this on every keystroke, and "not valid yet" is a normal answer, not an error.
    """
    session = _session(store, game_id)
    result = is_legal(session.state, _stamped(store, session, request.command))
    return LegalityView(legal=result.legal, reason_key=result.reason_key, params=result.params)


@app.delete(
    "/games/{game_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    tags=["game"],
    responses={status.HTTP_404_NOT_FOUND: {"model": ErrorResponse}},
)
def delete_game(game_id: str, store: StoreDep) -> None:
    _session(store, game_id)
    store.delete(game_id)


@app.websocket(WS_EVENT_STREAM_PATH)
async def game_event_stream(
    websocket: WebSocket,
    game_id: str,
    store: StoreDep,
    config: SettingsDep,
    since: Annotated[int, Query(ge=0)] = 0,
) -> None:
    """Push every event this game produces, as ``LoggedEvent`` frames (MON-303).

    A late or reconnecting client passes ``?since=`` its last ``seq`` and is sent the
    backlog before the live stream. Subscribing *before* replaying, then dropping anything
    the replay already covered, is what closes the window in which a command applied between
    the two would be lost.

    Nothing here touches game state: a disconnect only removes a mailbox. Both refusals below
    are keyed close codes rather than a silent drop, because a socket that is open and will
    never receive anything is harder to diagnose than one that said why it left.
    """
    await websocket.accept()
    try:
        session = store.get(game_id)
    except UnknownGameError:
        await websocket.close(code=WS_GAME_NOT_FOUND, reason="error.game_not_found")
        return
    log.info("ws.connected", since=since)
    try:
        with session.subscribe(
            max_subscribers=config.max_subscribers_per_game,
            queue_size=config.subscriber_queue_size,
        ) as subscriber:
            await stream_events(websocket, session, subscriber, since)
    except SubscriberLimitReachedError:
        log.info("ws.refused", reason_key="error.too_many_watchers")
        await websocket.close(code=WS_TOO_MANY_WATCHERS, reason="error.too_many_watchers")
    finally:
        log.info("ws.disconnected")


async def next_entry(subscriber: Subscriber) -> LoggedEvent | None:
    """Whichever comes first: the next event, or this mailbox overflowing (``None``).

    Two waiters rather than a plain ``queue.get()`` because an overflow has to reach the socket
    *now*. Checking the flag between gets would only notice once the client had drained the
    backlog — and a client that drains its backlog is not the one that overflows.

    Public for the same reason :func:`stream_events` is: a tie, where the mailbox is both
    non-empty *and* already overflowed, is reachable in one loop turn and unreachable from a
    test client, so the rule that the overflow wins it has to be assertable directly.
    """
    get = asyncio.ensure_future(subscriber.queue.get())
    overflow = asyncio.ensure_future(subscriber.overflowed.wait())
    done, pending = await asyncio.wait((get, overflow), return_when=asyncio.FIRST_COMPLETED)
    for task in pending:
        task.cancel()
    if overflow in done:
        # The mailbox is full whenever the flag is set — ``offer`` only sets it on ``QueueFull``,
        # and ``subscriber_queue_size`` is at least 1 — so ``get`` finished in the same turn.
        # Its event is retrieved and dropped rather than sent on: a stream silently missing
        # whatever the overflow ate is worse than a socket that said why it left.
        assert get in done
        get.result()
        return None
    return get.result()


async def stream_events(
    websocket: WebSocket,
    session: Session,
    subscriber: Subscriber,
    since: int,
) -> None:
    """Replay the backlog after ``since``, then push everything that follows it.

    Split out of the endpoint so the rule below can be *tested* rather than assumed: the
    caller owns the subscription (and therefore the cleanup), and this owns the ordering.

    Subscribing before the replay is what closes the window in which a command applied
    between the two would be lost. The cost of that ordering is that an event can reach both
    the snapshot and the queue, so anything at or below the high-water mark is dropped —
    without it the animation queue would play one event twice (G-34).

    A mailbox that overflowed ends the stream here rather than in the writer: the writer must
    never block on a socket, and this is the only coroutine that owns this one.
    """
    sent = since
    try:
        for entry in session.events_since(since):
            await websocket.send_json(entry.model_dump(mode="json"))
            sent = entry.seq
        while True:
            pushed = await next_entry(subscriber)
            if pushed is None:
                log.info("ws.overflowed", reason_key="error.watcher_too_slow")
                await websocket.close(code=WS_WATCHER_TOO_SLOW, reason="error.watcher_too_slow")
                return
            if pushed.seq <= sent:
                continue  # already covered by the replay above
            await websocket.send_json(pushed.model_dump(mode="json"))
            sent = pushed.seq
    except WebSocketDisconnect:
        return  # an ordinary end of stream: the client closed the tab


# --- Helpers ---------------------------------------------------------------


def _session(store: SessionStore, game_id: str) -> Session:
    try:
        return store.get(game_id)
    except UnknownGameError:
        raise errors.game_not_found(game_id) from None


def _create(store: SessionStore, state: GameState) -> Session:
    try:
        return store.create(state)
    except DuplicateGameError:
        raise errors.game_already_exists(state.game_id) from None
    except SessionLimitReachedError:
        raise errors.server_at_capacity(len(store)) from None


def _view(session: Session, events: tuple[LoggedEvent, ...] = ()) -> GameView:
    """The projection. Every field is a copy or an engine call (ADR-008)."""
    return GameView(
        board=BoardView.from_board(session.state.board),
        state=GameStateView.from_state(session.state),
        legal_commands=legal_commands(session.state),
        events=events,
        event_cursor=session.cursor,
    )


def _logged(session: Session, events: tuple[Event, ...]) -> tuple[LoggedEvent, ...]:
    """The just-applied events, with the ``seq`` the store assigned them."""
    return tuple(session.log[-len(events) :]) if events else ()


def _stamped(store: SessionStore, session: Session, command: Command) -> Command:
    """Overwrite ``EndTurn.elapsed_seconds`` with the server's own reading.

    The engine owns no clock, but Kids Mode ends a game after
    ``Ruleset.target_duration_minutes``, so the time has to arrive on a command (GAP G-6).
    It arrives from *here*, never from the request: a client that chose its own number could
    force the ending on the turn it happens to be winning, or postpone it forever. This is
    the only clock read in the server, and ``SessionStore`` is the only thing that holds a
    clock (see its module docstring).
    """
    if isinstance(command, EndTurn):
        return command.model_copy(update={"elapsed_seconds": store.elapsed_seconds(session)})
    return command


def _retype_validation_errors(document: dict[str, Any]) -> None:
    """Point FastAPI's auto-generated 422 at ``ErrorResponse``.

    FastAPI declares ``HTTPValidationError`` on every route that validates anything — a
    shape this app never returns, because ``_validation_error_handler`` rewrites a malformed
    body into ``{reason_key, params}``. Leaving it in the document would export two TypeScript
    types for one status code, one of which is a fiction, and the client would branch on the
    wrong one (G-33).
    """
    error_ref = {"$ref": "#/components/schemas/ErrorResponse"}
    for operations in document["paths"].values():
        for operation in operations.values():
            response = operation.get("responses", {}).get("422")
            if response is not None:
                response["content"] = {"application/json": {"schema": error_ref}}
    for name in ("HTTPValidationError", "ValidationError"):
        document.get("components", {}).get("schemas", {}).pop(name, None)


def _openapi() -> dict[str, Any]:
    """The generated document, plus the WebSocket route declared by hand.

    FastAPI does not put ``@app.websocket`` routes into the OpenAPI document, so before this
    the event stream was advertised in a docstring and typed nowhere — MON-402 had no
    contract to build against (G-34). Declaring it as the GET that the handshake actually
    is, with the ``LoggedEvent`` frame as its 101 body, gives ``generated.ts`` the real frame
    type. ``LoggedEvent`` is the same envelope ``GameView.events`` carries, so one type
    covers both transports.
    """
    document = _fastapi_openapi()
    _retype_validation_errors(document)
    document["paths"][WS_EVENT_STREAM_PATH] = {
        "get": {
            "tags": ["game"],
            "summary": "WebSocket event stream",
            "description": (
                "Handshake for the WebSocket event stream. Each frame after the upgrade is one "
                "LoggedEvent; `since` replays the backlog from a cursor. Not a JSON GET — the "
                "operation is declared so the frame type reaches the generated client (MON-303)."
            ),
            "operationId": "game_event_stream",
            "parameters": [
                {"name": "game_id", "in": "path", "required": True, "schema": {"type": "string"}},
                {"name": "since", "in": "query", "required": False, "schema": {"type": "integer", "minimum": 0}},
            ],
            "responses": {
                "101": {
                    "description": "Switching protocols. Every frame that follows is one LoggedEvent.",
                    "content": {"application/json": {"schema": {"$ref": "#/components/schemas/LoggedEvent"}}},
                },
                "404": {
                    "description": f"No such game; the socket closes with code {WS_GAME_NOT_FOUND}.",
                    "content": {"application/json": {"schema": {"$ref": "#/components/schemas/ErrorResponse"}}},
                },
            },
        }
    }
    return document


_fastapi_openapi = app.openapi
app.openapi = _openapi  # type: ignore[method-assign]
