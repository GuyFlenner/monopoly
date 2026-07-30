"""One error shape for the whole API (ADR-008 §4, GAP G-33).

Every failure a client can cause leaves this server as ``{reason_key, params}``, including the
ones starlette raises before any route is reached — ``api._http_exception_handler`` covers the
404 for an unrouted path and the 405 for a wrong method, which used to escape as
``{"detail": ...}``. Two reasons that is worth a module of its own:

* **No prose crosses the wire.** The engine's rule is that it returns i18n keys, never
  sentences; a transport that answers ``{"detail": "Value error, a bot seat needs a
  bot_level"}`` has re-introduced hardcoded English one layer up, and a Hebrew-speaking
  child sees it.
* **The context survives.** ``IllegalCommandError`` carries the params its catalogue
  sentence interpolates. A bare string body drops them, so ``error.insufficient_funds``
  could never say how much short.
"""

from __future__ import annotations

from fastapi import status

UNPROCESSABLE = 422
"""Spelled as a number, like ``test_api.py``: starlette has renamed this constant twice
already (``HTTP_422_UNPROCESSABLE_ENTITY`` -> ``HTTP_422_UNPROCESSABLE_CONTENT``), and a
status code is not the sort of thing that needs a name to be readable."""

CONTENT_TOO_LARGE = 413
"""Renamed for the same reason. See ``UNPROCESSABLE``."""

MAX_REFLECTED_CHARS = 64
"""Ceiling on any caller-supplied string echoed back in ``params``.

Two of the keys below reflect an id the caller chose. Unbounded, a 5000-character ``board_id``
came back inside a 5061-byte error body — an amplifier, and a needless one, since no catalogue
sentence is improved by more than a glance at the id (MON-303 security review).

**``error.*`` params are untrusted at interpolation time.** They are truncated here, and they
are not sanitised, because escaping depends on where they land. MON-402 and MON-501 must route
them through i18next's default (escaping) interpolation and never through raw HTML —
``dangerouslySetInnerHTML`` or i18next's ``{{- value}}`` on an ``error.*`` param is a stored
XSS with an attacker-chosen ``game_id`` as the payload.
"""


def _reflected(value: str) -> str:
    """Truncate a caller-supplied string to something a catalogue sentence can carry."""
    return value if len(value) <= MAX_REFLECTED_CHARS else value[:MAX_REFLECTED_CHARS] + "..."


class ApiError(Exception):
    """A failure to report to the client, already in wire shape.

    Deliberately not ``HTTPException``: that class's ``detail`` is a free-form string and
    FastAPI's default handler renders it as ``{"detail": ...}``, which is the shape this
    module exists to replace.
    """

    def __init__(self, status_code: int, reason_key: str, **params: int | str) -> None:
        self.status_code = status_code
        self.reason_key = reason_key
        self.params = params
        super().__init__(reason_key)


def game_not_found(game_id: str) -> ApiError:
    return ApiError(status.HTTP_404_NOT_FOUND, "error.game_not_found", game_id=_reflected(game_id))


def game_already_exists(game_id: str) -> ApiError:
    """409 rather than an overwrite: the store is keyed by ``game_id``, so accepting a
    duplicate would end whatever game is already under that key."""
    return ApiError(status.HTTP_409_CONFLICT, "error.game_already_exists", game_id=_reflected(game_id))


def server_at_capacity(limit: int) -> ApiError:
    return ApiError(status.HTTP_503_SERVICE_UNAVAILABLE, "error.server_at_capacity", limit=limit)


def malformed_request(fields: str) -> ApiError:
    """A body pydantic refused. ``fields`` names the offending paths — no prose, and no
    pydantic message, which would be English.

    Truncated like the reflected ids: with ``extra="forbid"`` on the command models, a path can
    be a key the caller invented."""
    return ApiError(UNPROCESSABLE, "error.malformed_request", fields=_reflected(fields))


def save_schema_mismatch() -> ApiError:
    """Any failure to read a save file, whatever the underlying exception.

    The engine reports a stale ``schema_version`` with this key already. A save naming an
    unknown board raises ``BoardDataError`` instead — which is not a ``ValueError``, so
    pydantic does not wrap it, and before MON-301 it escaped as a 500 with a traceback
    (carried forward from the MON-100 security review). One key covers both: from the
    player's side, the file does not load.
    """
    return ApiError(UNPROCESSABLE, "error.save_schema_mismatch")


def save_too_large(limit_bytes: int) -> ApiError:
    return ApiError(CONTENT_TOO_LARGE, "error.save_too_large", limit_bytes=limit_bytes)


def invalid_seating(reason_key: str, params: dict[str, int | str]) -> ApiError:
    """The engine's keyed refusal of a seating arrangement, forwarded (MON-418).

    The M3 note that used to sit under :func:`invalid_new_game` said a precise key "needs
    ``kesef_engine.factory`` to raise a *keyed* error rather than a bare ``ValueError``; that is an
    engine change, noted here rather than worked around here." That change is
    :class:`~kesef_engine.errors.InvalidSeatingError`, and this is the forwarding.

    Nothing is inspected or re-decided: the key and its params arrive from the factory, and the
    only judgement here is the status code, which is transport. A caller-supplied name reaches
    ``params`` through the ``error.duplicate_names`` key — capped at 24 characters by ``Seat.name``
    long before it gets here, and subject to the interpolation warning on
    :data:`MAX_REFLECTED_CHARS` like every other reflected value.
    """
    return ApiError(UNPROCESSABLE, reason_key, **params)


def invalid_new_game() -> ApiError:
    """The factory refused the seats for a reason it did not name.

    The three refusals a *player* can cause — too few seats, too many, duplicate names — are keyed
    at source now and forwarded by :func:`invalid_seating`. This stays as the floor under anything
    else that raises ``ValueError`` while an opening state is assembled (a ``PlayerState`` field
    constraint, say), which is a defect rather than a mistake a parent made: one coarse key beats
    guessing, and guessing precisely would put a copy of a rule in the transport.
    """
    return ApiError(UNPROCESSABLE, "error.invalid_new_game")


def unknown_board(board_id: str) -> ApiError:
    return ApiError(UNPROCESSABLE, "error.unknown_board", board_id=_reflected(board_id))


def invalid_game_id() -> ApiError:
    """A save whose ``game_id`` could not be addressed once the game existed.

    See ``schemas.GAME_ID_PATTERN``: an id carrying a path separator produced a game that
    occupied a session slot and could not be fetched or deleted. Deliberately without params —
    the offending id arrives from inside an attacker-supplied body and may be as long as the
    body allows, so it is not echoed at all rather than echoed truncated.
    """
    return ApiError(UNPROCESSABLE, "error.invalid_game_id")
