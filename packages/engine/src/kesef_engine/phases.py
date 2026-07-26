"""The turn state machine.

Every legal action in the game is a function of ``(phase, current_player)``. Making the
phase explicit — rather than inferring it from a scatter of booleans — is what lets
:func:`kesef_engine.legality.legal_commands` be exhaustive, and therefore lets the UI
render buttons instead of guessing at them.

Normal flow::

    AWAITING_ROLL → MOVING → RESOLVING_TILE → ... → AWAITING_END_TURN → (next player)

``RESOLVING_TILE`` branches by tile kind into ``AWAITING_PURCHASE_DECISION``,
``CARD_RESOLUTION`` or straight to rent settlement.

Three phases are *interrupts*: they can be entered from several places and, when they
finish, return control to where the game was. ``DEBT_SETTLEMENT`` (you owe more than you
hold in cash and must raise it or go bankrupt), ``AUCTION``, and ``TRADE_REVIEW``.
"""

from __future__ import annotations

from enum import StrEnum


class Phase(StrEnum):
    AWAITING_ROLL = "awaiting_roll"
    """Current player must roll, or act on their portfolio first (build/mortgage/trade)."""

    JAIL_DECISION = "jail_decision"
    """In jail: pay the fine, use a card, or roll for doubles."""

    MOVING = "moving"
    """Transient: the token is animating. The engine passes through; the UI dwells here."""

    RESOLVING_TILE = "resolving_tile"
    """Transient: apply the landed-on tile's consequence."""

    AWAITING_PURCHASE_DECISION = "awaiting_purchase_decision"
    """Landed on an unowned ownable tile: buy at list price, or decline."""

    AUCTION = "auction"
    """Interrupt: a declined property is auctioned to all solvent players."""

    CARD_RESOLUTION = "card_resolution"
    """Transient: a Chance / Community Chest card has been drawn and is being applied."""

    DEBT_SETTLEMENT = "debt_settlement"
    """Interrupt: the player owes more than they hold. Raise cash or declare bankruptcy."""

    TRADE_REVIEW = "trade_review"
    """Interrupt: a trade has been proposed and the recipient must respond."""

    AWAITING_END_TURN = "awaiting_end_turn"
    """Turn is resolved. Player may still build/mortgage/trade before ending it."""

    GAME_OVER = "game_over"
    """A winner exists. No command is legal."""


TRANSIENT_PHASES = frozenset({Phase.MOVING, Phase.RESOLVING_TILE, Phase.CARD_RESOLUTION})
"""Phases the engine passes straight through — a returned state should never rest here."""

INTERRUPT_PHASES = frozenset({Phase.AUCTION, Phase.DEBT_SETTLEMENT, Phase.TRADE_REVIEW})
"""Phases in which the acting player may not be the player whose turn it is."""

PORTFOLIO_PHASES = frozenset({Phase.AWAITING_ROLL, Phase.AWAITING_END_TURN})
"""Phases in which building, mortgaging and trading are permitted."""
