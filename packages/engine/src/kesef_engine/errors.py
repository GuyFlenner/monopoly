"""Engine errors.

Note the ``reason_key``: the engine reports *why* a command was rejected as an i18n
key, never as a sentence. The UI translates it. An engine that returns
``"It is not your turn"`` has quietly hardcoded English into the rules layer.
"""

from __future__ import annotations


class EngineError(Exception):
    """Base class for every error the engine raises."""


class IllegalCommandError(EngineError):
    """A command was not legal in the current state.

    Callers should never see this in normal operation: the UI renders buttons from
    :func:`kesef_engine.legality.legal_commands`, so an illegal command means a bug
    or a hand-crafted request, not a misclick.
    """

    def __init__(self, reason_key: str, **context: object) -> None:
        self.reason_key = reason_key
        self.context = context
        super().__init__(reason_key)


class InvalidSeatingError(EngineError, ValueError):
    """The seats handed to :func:`kesef_engine.factory.new_game` cannot start a game.

    A *keyed* refusal, which is the whole of MON-418. ``new_game`` used to raise a bare
    ``ValueError``, so the only thing the transport could honestly say was one coarse
    ``error.invalid_new_game`` ("every player needs a different name, and a game takes between two
    and six of them") — while "at least two players" did not even reach it: the constraint was a
    pydantic ``min_length`` on the request field, so a parent who removed a seat was told
    ``error.malformed_request`` and given a field path. The server could have looked for duplicate
    names itself, and ``kesef_server.errors`` says why it must not: a second copy of a rule in the
    transport is a defect even while it agrees.

    Also a ``ValueError`` so that callers who wrap ``new_game`` in the broad ``except ValueError``
    that predates this class keep working, and so the pydantic-driven paths that expect one still
    see one. Nothing relies on that ordering; it is a compatibility courtesy, not a design.
    """

    def __init__(self, reason_key: str, **context: object) -> None:
        self.reason_key = reason_key
        self.context = context
        super().__init__(reason_key)


class BoardDataError(EngineError):
    """A board JSON file is structurally invalid. Raised at load time, loudly."""
