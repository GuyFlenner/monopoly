"""The reducer — the engine's single entry point for change.

    state, events = apply(state, command)

Pure: no I/O, no mutation, no globals. Given the same state and command you get the same
result, every time, on every machine.

Implementation lands in M1/M2 (MON-102 onwards). The signature is fixed *now* because the
server, the CLI driver, the bots and the test harness are all written against it, and it
is cheaper to agree on the seam before four callers exist than after.
"""

from __future__ import annotations

from kesef_engine.commands import Command
from kesef_engine.events import Event
from kesef_engine.state import GameState


def apply(state: GameState, command: Command) -> tuple[GameState, tuple[Event, ...]]:
    """Apply one command, returning the resulting state and the events it produced.

    Raises:
        IllegalCommandError: if ``command`` is not in :func:`kesef_engine.legality.legal_commands`
            for ``state``. Callers that drive the UI from ``legal_commands`` never see this.

    The handler dispatches on ``state.phase`` first and ``command.kind`` second, because
    the phase decides which commands even exist. Transient phases
    (:data:`kesef_engine.phases.TRANSIENT_PHASES`) are resolved to completion before
    returning, so a caller never observes a state resting in one.
    """
    raise NotImplementedError("MON-102: reducer dispatch — see docs/BACKLOG.md")


def apply_all(state: GameState, commands: tuple[Command, ...]) -> tuple[GameState, tuple[Event, ...]]:
    """Fold a sequence of commands. The basis of the golden-game regression tests."""
    events: list[Event] = []
    for command in commands:
        state, produced = apply(state, command)
        events.extend(produced)
    return state, tuple(events)
