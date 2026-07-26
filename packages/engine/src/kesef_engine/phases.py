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

Where control returns to is **not** stored here. Per ADR-007 an interrupt is a frame on
:attr:`kesef_engine.state.GameState.interrupts`, and the frame carries its own resume
phase — a scalar phase has nowhere to record a continuation, so a game saved mid-interrupt
could not be resumed. ``phase`` remains the single "what is happening now" signal, and a
validator on ``GameState`` keeps it in step with the live frame.
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
"""Phases whose *primary* actor may not be the player whose turn it is.

Not the only place a non-current player can act: portfolio phases open portfolio
actions to every solvent player (MON-204). What makes these three special is that the
phase itself exists *for* another actor — a bidder, a debtor, a trade recipient — and
carries an interrupt frame naming them.
"""

PORTFOLIO_PHASES = frozenset({Phase.AWAITING_ROLL, Phase.JAIL_DECISION, Phase.AWAITING_END_TURN})
"""Phases in which the full portfolio is open: build, sell, mortgage, unmortgage, trade.

``JAIL_DECISION`` belongs here because a jailed player still owns an estate and still
takes a turn — the rules let them collect rent, build and trade from the cell (GAP G-5).
"""

RAISING_PHASES = frozenset({Phase.DEBT_SETTLEMENT, Phase.AUCTION})
"""Phases in which a player may *raise cash but not spend it*: sell buildings, mortgage.
Building and unmortgaging are not offered here — a player who owes money may not tie
more of it up (GAP G-5, as corrected). Trading is allowed only in ``DEBT_SETTLEMENT``:
a live auction cannot be paused by a trade review, so the bidder raises cash by sale
and mortgage alone. ``AUCTION`` is included for the bidder who needs to fund a bid;
MON-101 additionally restricts it to a player still active in the auction.
"""
