"""The bot interface.

``BotLevel`` is re-exported here for the callers that think in terms of bots, but it is
defined in :mod:`kesef_engine.primitives`: the engine's ``PlayerKind`` and the server's
seat configuration both need it, and neither should have to import the bot package to
name a difficulty (GAP G-19).
"""

from __future__ import annotations

from typing import Protocol

from kesef_engine.commands import Command
from kesef_engine.primitives import BotLevel as BotLevel
from kesef_engine.primitives import PlayerId
from kesef_engine.state import GameState


class Bot(Protocol):
    """Chooses a move. Deterministic given the state it is handed.

    Determinism matters here as much as in the engine: a bot that consulted a global RNG
    would make the golden-game tests non-reproducible. Bots that need randomness draw it
    from ``state.rng.fork(...)``.
    """

    level: BotLevel

    def choose(
        self,
        state: GameState,
        player: PlayerId,
        legal: tuple[Command, ...],
        *,
        may_trade: bool = True,
    ) -> Command:
        """Pick one of ``legal``, or construct a :class:`~kesef_engine.commands.ProposeTrade`.

        The second half is ADR-009 and it is the one loosening of this contract. Every other
        command kind is enumerated by :func:`~kesef_engine.legality.legal_commands`, so
        "return a member of ``legal``" says everything; ``ProposeTrade`` is never enumerated
        (ADR-005's exception — the offer space is unbounded), so a bot that could only return
        a member of ``legal`` could never open a trade, and a two-player game whose colour
        groups are all split has no other way out of a stalemate.

        A constructed offer earns no privilege: it goes through
        :func:`~kesef_engine.legality.is_legal` and then through ``apply``, which validate it
        exactly as they validate a human's draft. A bot must **not** return a constructed
        command of any other kind.

        ``may_trade=False`` withdraws the permission for this call, and the caller — the
        driver, not the bot — is what decides when. A bot is a pure function of
        ``(state, player, legal)`` and a declined trade returns the position to essentially
        what it was, so a bot asked twice from the same position would re-propose the same
        offer forever. Drivers therefore allow one proposal per seat per turn. See ADR-009.
        """
        ...
