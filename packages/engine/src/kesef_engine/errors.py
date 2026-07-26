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


class BoardDataError(EngineError):
    """A board JSON file is structurally invalid. Raised at load time, loudly."""
