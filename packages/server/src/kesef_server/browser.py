"""The transport for a browser that has no server (MON-805).

Kesef Street is a hotseat game: one screen, up to six seats, and a rules core that is pure
Python with one dependency. Nothing about that needs a server — the only reason there is one is
that browsers do not run Python. Pyodide removes that reason, so this module is the same set of
handlers :mod:`kesef_server.api` exposes over HTTP, exposed instead as plain functions that a
page can call. The game then runs at a static URL with nothing behind it: no host, no session
cost, no thing to keep alive.

## What this is

A **transport**, exactly like ``api.py``, and held to the same three rules:

1. It owns no rules. It asks ``legal_commands``, calls ``apply``, stores what came back, and
   projects it through :mod:`kesef_server.schemas`. Every one of those four steps is
   :mod:`kesef_server.transport`'s, shared with the HTTP routes rather than restated here.
2. It returns no prose. Every failure leaves as ``{reason_key, params}`` with the status the
   HTTP route would have answered — see :class:`Reply`.
3. It holds no framework. Nothing on this module's import path imports FastAPI, starlette or
   anyio (``packages/server/tests/test_browser_parity.py`` asserts it), because
   ``uvicorn[standard]`` has native wheels and WebAssembly has none.

One game gets one bot driver at a time here too: ``advance_bots_step`` holds this session's
``Session.advance_lock``, the same lock ``transport.advance_bots`` holds for the HTTP transport
(MON-806). It is held for one step rather than for a whole run, because a page pumps step by step.

## Why the answers are envelopes rather than values

Every function here returns a JSON **string** of ``{"status": ..., "body": ...}``. Two reasons,
and they are the whole reason a browser build needs this module at all rather than a few calls
into the engine:

* **The status is data.** ``packages/web/src/api/client.ts`` turns a 404 into
  ``error.game_not_found`` and a 422 into the engine's own rejection key, and it does that by
  reading ``Response.status``. A local transport that raised Python exceptions instead would put
  that mapping in TypeScript, one copy per transport, which is how the two drift.
* **A string crosses the boundary once.** Pyodide can hand JavaScript a live proxy of a Python
  dict, and then the shape of the wire is a shape two languages have to agree about implicitly.
  JSON text is the same contract the HTTP transport has, checked by the same generated types.

## Bots, one step at a time

``api.py`` drives bots in a *background task* so a human's command answers immediately and the
computer's moves arrive behind it as WebSocket frames. There is no request to return from here
and nothing to background against, so the pump is inverted: :meth:`BrowserHost.advance_bots_step`
plays at most one bot move, and the page calls it in a loop until it answers ``done``. The
thinking delay (``Settings.bot_think_seconds``) is awaited *inside* that call, so pacing stays a
server-side setting rather than a number JavaScript picked, and the page stays responsive between
steps because each call is one await.

The step budget mirrors ``bot_max_steps_per_call`` exactly: it is set when a human's command
lands and spent by the pump, so a pair of mutually re-enabling commands stops the loop instead of
hanging the tab — the same bound, in the same place in the sequence, as the HTTP transport's.
"""

from __future__ import annotations

import json
import secrets
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, ValidationError

from kesef_engine.errors import BoardDataError, EngineError, IllegalCommandError, InvalidSeatingError
from kesef_engine.factory import new_game
from kesef_engine.legality import is_legal
from kesef_engine.reducer import apply
from kesef_engine.ruleset import Ruleset
from kesef_server import errors, transport
from kesef_server.config import Settings, settings
from kesef_server.errors import UNPROCESSABLE, ApiError
from kesef_server.log import configure_logging, get_logger
from kesef_server.schemas import (
    CommandRequest,
    ErrorResponse,
    IfExists,
    LegalityView,
    NewGameRequest,
    SaveFile,
)
from kesef_server.sessions import SessionStore, UnknownGameError

configure_logging()
log = get_logger()

OK = 200
CREATED = 201
NO_CONTENT = 204
SERVER_ERROR = 500
"""The statuses this transport answers with that :mod:`kesef_server.errors` does not name. Spelled
as numbers for the reason that module gives, and because ``fastapi.status`` is unimportable here."""


@dataclass(frozen=True)
class Reply:
    """One answer: the status the HTTP route would have used, and a JSON-ready body.

    ``body`` is ``None`` for the 204, which is the one answer with no body at all — the fake
    ``Response`` the page builds from this must have a null body there or the browser rejects it.
    """

    status: int
    body: object | None = None

    def to_json(self) -> str:
        return json.dumps({"status": self.status, "body": self.body})


def _dumped(model: BaseModel) -> dict[str, Any]:
    """One pydantic model as the JSON its HTTP counterpart would have serialized.

    ``mode="json"`` rather than ``mode="python"`` because the wire has no enums, no tuples and no
    dates: FastAPI's own encoder makes the same conversions, which is what
    ``test_browser_parity.py`` checks byte for byte.
    """
    return model.model_dump(mode="json")


def _listed(models: list[Any]) -> list[dict[str, Any]]:
    return [_dumped(model) for model in models]


def _error_body(reason_key: str, params: dict[str, int | str] | None = None) -> dict[str, Any]:
    return _dumped(ErrorResponse(reason_key=reason_key, params=params or {}))


def _fields(exc: ValidationError) -> str:
    """The offending field paths of a refused body, as ``api._validation_error_handler`` spells them.

    That handler drops the first element of each ``loc`` because FastAPI prefixes it with
    ``"body"``; validating a model directly produces the same path *without* the prefix, so
    nothing is dropped here. The two spellings agree, which is the point — and pydantic's English
    ``msg`` is discarded in both, because it is developer prose and a Hebrew-speaking child would
    be shown it.
    """
    return ", ".join(".".join(str(part) for part in error["loc"]) for error in exc.errors())


def _failure(exc: Exception, *, route: str) -> Reply:
    """One exception as the answer its HTTP counterpart would have sent.

    The three branches are ``api.py``'s three exception handlers, in the order starlette resolves
    them: ``ApiError`` carries its own status, ``IllegalCommandError`` is the engine's keyed
    rejection with its context params (G-33), and every other ``EngineError`` is an honest 500 —
    a defect on this side of the call, reported as a key rather than as an exception's text.
    """
    if isinstance(exc, ApiError):
        log.info("request.rejected", reason_key=exc.reason_key, status=exc.status_code, route=route)
        return Reply(exc.status_code, _error_body(exc.reason_key, exc.params))
    if isinstance(exc, IllegalCommandError):
        return Reply(UNPROCESSABLE, _error_body(exc.reason_key, transport.wire_params(exc.context)))
    if isinstance(exc, EngineError):
        log.error("engine.failed", reason_key="error.engine_failure", exception=type(exc).__name__)
        return Reply(SERVER_ERROR, _error_body("error.engine_failure"))
    raise exc


def _since(raw: str | int | None) -> int | None:
    """``?since=`` as ``api.get_game``'s ``Query(ge=0)`` reads it.

    ``None`` means "state only"; ``0`` replays the whole game. Anything that is not a
    non-negative integer is the ordinary ``error.malformed_request`` naming the parameter, which
    is what FastAPI answers for a query parameter its annotation refuses.
    """
    if raw is None:
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise errors.malformed_request("since") from None
    if value < 0:
        raise errors.malformed_request("since")
    return value


def _if_exists(raw: str | None) -> IfExists:
    """``?if_exists=`` as ``api.load_game``'s annotation reads it (ADR-011).

    Omitted is :attr:`~kesef_server.schemas.IfExists.REFUSE`, which is the default on the HTTP route
    too. Anything else is the ordinary ``error.malformed_request`` naming the parameter — what FastAPI
    answers for a query parameter its enum refuses, so a page that sent a typo is told the same thing
    by both transports.
    """
    if raw is None or raw == "":
        return IfExists.REFUSE
    try:
        return IfExists(raw)
    except ValueError:
        raise errors.malformed_request("if_exists") from None


class BrowserHost:
    """One page's worth of games: a session store, the settings, and the bot pump's state.

    A class rather than module state so a test can hold two of them — and, more importantly, so
    the store's clock is injectable exactly as it is for the HTTP transport. The module-level
    functions below share a single lazily-created instance, which is what a page calls.
    """

    def __init__(self, store: SessionStore | None = None, config: Settings | None = None) -> None:
        self.config = config if config is not None else settings
        self.store = (
            store
            if store is not None
            else SessionStore(
                max_sessions=self.config.max_sessions,
                ttl_seconds=self.config.session_ttl_minutes * 60,
            )
        )
        self._budget: dict[str, int] = {}
        """Bot steps still allowed for each game before the pump stops. See the module docstring."""

    # --- Meta ---------------------------------------------------------------

    def list_boards(self) -> str:
        return self._answer("/boards", lambda: Reply(OK, _listed(transport.board_summaries())))

    def list_rulesets(self) -> str:
        return self._answer("/rulesets", lambda: Reply(OK, _listed(list(transport.rulesets()))))

    # --- Games --------------------------------------------------------------

    def create_game(self, request_json: str) -> str:
        """``POST /games``. Bot moves do not stream in behind it — the page pumps them."""
        return self._answer("/games", lambda: self._create_game(request_json))

    def _create_game(self, request_json: str) -> Reply:
        try:
            request = NewGameRequest.model_validate_json(request_json)
        except ValidationError as exc:
            raise errors.malformed_request(_fields(exc)) from None
        seed = request.seed if request.seed is not None else secrets.randbits(32)
        try:
            state = new_game(
                [seat.to_seat() for seat in request.seats],
                seed=seed,
                game_id=request.game_id or transport.minted_game_id(),
                board_id=request.board_id,
                # The named rule set, plus whatever this table asked to change (MON-712).
                ruleset=request.house_rules.applied_to(Ruleset.by_name(request.ruleset)),
                locale=request.locale,
            )
        except BoardDataError:
            raise errors.unknown_board(request.board_id) from None
        except InvalidSeatingError as refused:
            # The engine's own key, forwarded whole, exactly as `api.create_game` forwards it
            # (MON-418, G-33). "Two to six players" and "no shared names" are rules, so neither
            # transport restates them nor flattens the three refusals into one coarse key.
            raise errors.invalid_seating(refused.reason_key, transport.wire_params(refused.context)) from None
        except ValueError:
            raise errors.invalid_new_game() from None
        session = transport.create(self.store, state)
        # Seat one can be a computer, and a game that opened waiting on it would look broken
        # before anybody had touched anything. The budget is opened here for the same reason
        # `api.create_game` queues `_advance_bots`: the pump has something to spend.
        self._open_budget(state.game_id)
        return Reply(CREATED, _dumped(transport.view(session)))

    def list_games(self) -> str:
        return self._answer("/games", lambda: Reply(OK, _listed(transport.game_summaries(self.store))))

    def load_game(self, save_json: str, if_exists: str | None = None) -> str:
        """``POST /games/load?if_exists=``. The body is exactly what :meth:`save_game` returned."""
        return self._answer("/games/load", lambda: self._load_game(save_json, if_exists))

    def _load_game(self, save_json: str, if_exists: str | None) -> Reply:
        raw = save_json.encode("utf-8")
        if len(raw) > self.config.max_save_bytes:
            raise errors.save_too_large(self.config.max_save_bytes)
        policy = _if_exists(if_exists)
        try:
            # Both save shapes ADR-011 accepts — the same one line `api.load_game` runs, and parsed
            # by pydantic for the reason `SaveFile.from_json` gives.
            save = SaveFile.from_json(raw)
        except (ValidationError, ValueError, EngineError):
            # One key for every way a save fails to load: a stale `schema_version` raises
            # `ValueError`, an unknown board raises `BoardDataError`. From the player's side the
            # file does not load, and that is the whole of what there is to say.
            raise errors.save_schema_mismatch() from None
        session = transport.load(self.store, save, policy)
        self._open_budget(session.state.game_id)
        return Reply(CREATED, _dumped(transport.view(session)))

    def get_game(self, game_id: str, since: str | int | None = None) -> str:
        """``GET /games/{id}?since=``. Safe to poll, and the reload path for the page."""
        return self._answer(f"/games/{game_id}", lambda: self._get_game(game_id, since))

    def _get_game(self, game_id: str, since: str | int | None) -> Reply:
        cursor = _since(since)
        session = transport.session(self.store, game_id)
        events = session.events_since(cursor) if cursor is not None else ()
        return Reply(OK, _dumped(transport.view(session, events)))

    def save_game(self, game_id: str) -> str:
        """``GET /games/{id}/save`` — the only answer carrying hidden information (ADR-008 §2).

        The state *and* the session's log since ADR-011, which is also what makes the reload
        insurance in ``src/local/rehydrate.ts`` keep the event log: it stores whatever this returns.
        """
        return self._answer(
            f"/games/{game_id}/save",
            lambda: Reply(OK, _dumped(transport.save_file(transport.session(self.store, game_id)))),
        )

    def submit_command(self, game_id: str, request_json: str) -> str:
        """``POST /games/{id}/commands``. The only way a game changes."""
        return self._answer(f"/games/{game_id}/commands", lambda: self._submit_command(game_id, request_json))

    def _submit_command(self, game_id: str, request_json: str) -> Reply:
        request = self._command(request_json)
        session = transport.session(self.store, game_id)
        state, events = apply(session.state, transport.stamped(self.store, session, request.command))
        updated = self.store.update(session, state, events)
        # The human's command may have handed the table to a computer — by ending a turn, by
        # declining a purchase into an auction a bot is eligible for, or by proposing a trade a bot
        # must answer. The budget says the pump may run; the page is what runs it.
        self._open_budget(game_id)
        return Reply(OK, _dumped(transport.view(updated, transport.logged(session, events))))

    def validate_command(self, game_id: str, request_json: str) -> str:
        """``POST /games/{id}/validate``: would this be accepted? Changes nothing (G-32)."""
        return self._answer(f"/games/{game_id}/validate", lambda: self._validate_command(game_id, request_json))

    def _validate_command(self, game_id: str, request_json: str) -> Reply:
        request = self._command(request_json)
        session = transport.session(self.store, game_id)
        result = is_legal(session.state, transport.stamped(self.store, session, request.command))
        view = LegalityView(legal=result.legal, reason_key=result.reason_key, params=result.params)
        return Reply(OK, _dumped(view))

    def delete_game(self, game_id: str) -> str:
        return self._answer(f"/games/{game_id}", lambda: self._delete_game(game_id))

    def _delete_game(self, game_id: str) -> Reply:
        transport.session(self.store, game_id)
        self.store.delete(game_id)
        self._budget.pop(game_id, None)
        return Reply(NO_CONTENT)

    # --- The event stream ---------------------------------------------------

    def events_since(self, game_id: str, cursor: int = 0) -> str:
        """What the WebSocket route replays: every logged event after ``cursor`` (G-34).

        The page's fake socket reads from here rather than being handed the events a command
        produced, so a subscription opened halfway through a bot's turn still gets the whole
        backlog — the same property ``api.stream_events`` gets from subscribing before replaying.
        """
        return self._answer(f"/games/{game_id}/ws", lambda: self._events_since(game_id, cursor))

    def _events_since(self, game_id: str, cursor: int) -> Reply:
        session = transport.session(self.store, game_id)
        entries = session.events_since(_since(cursor) or 0)
        return Reply(OK, {"events": _listed(list(entries)), "event_cursor": session.cursor})

    async def advance_bots_step(self, game_id: str) -> str:
        """Play at most one bot move, pausing first. ``done`` when there is nothing left to play.

        The page loops on this after every command and after creating a game. ``done`` is true for
        three different reasons and deliberately does not say which: the seat being waited on is
        not a bot, the game is over, or the step budget is spent. None of the three is the page's
        business — all three mean "stop calling me until the human does something".
        """
        return await self._answer_async(f"/games/{game_id}/bots", lambda: self._advance_bots_step(game_id))

    async def _advance_bots_step(self, game_id: str) -> Reply:
        # `Session.advance_lock`, the same lock `transport.advance_bots` holds for the HTTP transport
        # (MON-806). Held for *one* step here rather than for a whole run, because a page pumps step
        # by step and cannot wait for a bot's entire turn inside one call — but the invariant it buys
        # is identical: no two drivers of one game read the same position around the same await.
        async with transport.session(self.store, game_id).advance_lock:
            # The budget is read *inside* the lock, and that is not tidiness. Read outside it, six
            # pumps in flight all saw the same unspent budget before any of them had spent theirs,
            # so a cap of four allowed six moves — `test_pumping_concurrently_changes_nothing`
            # caught it. A counter checked outside the critical section it guards is not a counter.
            if self._budget.get(game_id, 0) <= 0:
                return self._bots_done(game_id)
            self._budget[game_id] -= 1
            try:
                entries = await transport.advance_bots_once(
                    self.store, game_id, think_seconds=self.config.bot_think_seconds
                )
            except UnknownGameError:
                # The game was deleted while a bot was thinking — a real sequence, because the
                # delay is measured in tenths of a second and "leave game" is one click. The HTTP
                # transport lets this escape into a background task's log; here the page is
                # waiting on an answer, so it gets the 404 it would have got from any other route.
                raise errors.game_not_found(game_id) from None
            if entries is None:
                self._budget[game_id] = 0
                return self._bots_done(game_id)
            session = transport.session(self.store, game_id)
            return Reply(OK, {"done": False, "events": _listed(list(entries)), "event_cursor": session.cursor})

    def _bots_done(self, game_id: str) -> Reply:
        session = transport.session(self.store, game_id)
        return Reply(OK, {"done": True, "events": [], "event_cursor": session.cursor})

    # --- Plumbing -----------------------------------------------------------

    def _command(self, request_json: str) -> CommandRequest:
        try:
            return CommandRequest.model_validate_json(request_json)
        except ValidationError as exc:
            raise errors.malformed_request(_fields(exc)) from None

    def _open_budget(self, game_id: str) -> None:
        self._budget[game_id] = self.config.bot_max_steps_per_call

    def _answer(self, route: str, work: Callable[[], Reply]) -> str:
        try:
            return work().to_json()
        except Exception as exc:
            return _failure(exc, route=route).to_json()

    async def _answer_async(self, route: str, work: Callable[[], Awaitable[Reply]]) -> str:
        try:
            reply = await work()
        except Exception as exc:
            return _failure(exc, route=route).to_json()
        return reply.to_json()


# --- The page's surface -----------------------------------------------------
#
# One host per page, created on first use. The functions below are what
# `packages/web/src/local/` calls; they exist so the JavaScript side names a function rather than
# reaching into an object graph across the language boundary, and so this module has one obvious
# public surface to read.

_host: BrowserHost | None = None


def host() -> BrowserHost:
    """The page's host, created on first use."""
    global _host
    if _host is None:
        _host = BrowserHost()
    return _host


def list_boards() -> str:
    return host().list_boards()


def list_rulesets() -> str:
    return host().list_rulesets()


def create_game(request_json: str) -> str:
    return host().create_game(request_json)


def list_games() -> str:
    return host().list_games()


def load_game(save_json: str, if_exists: str | None = None) -> str:
    return host().load_game(save_json, if_exists)


def get_game(game_id: str, since: str | int | None = None) -> str:
    return host().get_game(game_id, since)


def save_game(game_id: str) -> str:
    return host().save_game(game_id)


def submit_command(game_id: str, request_json: str) -> str:
    return host().submit_command(game_id, request_json)


def validate_command(game_id: str, request_json: str) -> str:
    return host().validate_command(game_id, request_json)


def delete_game(game_id: str) -> str:
    return host().delete_game(game_id)


def events_since(game_id: str, cursor: int = 0) -> str:
    return host().events_since(game_id, cursor)


async def advance_bots_step(game_id: str) -> str:
    return await host().advance_bots_step(game_id)
