"""Structured logging.

``structlog`` has been a declared dependency since the server's first commit and was called
by nothing, and ``Settings.log_level`` was read by nothing either — the same defect as the
``session_ttl_minutes`` that claimed to evict games (MON-303 review). One small module closes
both: the level setting now decides something, and there is one obvious place to add a field.

**What is logged, and what is deliberately not.** Two events only, on the surface this review
touched: a request refused with a key, and a WebSocket opening or closing. Neither carries a
request body, a ``game_id``, a ``board_id`` or any other caller-supplied string. A log line is
an untrusted-input sink like any other — an id may be thousands of characters long, may contain
newlines, and ends up in whatever aggregator reads these — so the events carry the *route
template* (``/games/{game_id}``, which the router owns) and never the interpolated path.
"""

from __future__ import annotations

import logging

import structlog

from kesef_server.config import settings


def configure_logging(level: str | None = None) -> None:
    """Point structlog at stdout at the configured level. Idempotent.

    Called once when :mod:`kesef_server.api` is imported, so a process that imports the app
    logs consistently whether it was started by uvicorn or by a test.
    """
    threshold = logging.getLevelNamesMapping().get((level or settings.log_level).upper(), logging.INFO)
    structlog.configure(
        wrapper_class=structlog.make_filtering_bound_logger(threshold),
        processors=[
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.JSONRenderer(),
        ],
        cache_logger_on_first_use=True,
    )


def get_logger() -> structlog.stdlib.BoundLogger:
    logger: structlog.stdlib.BoundLogger = structlog.get_logger("kesef_server")
    return logger
