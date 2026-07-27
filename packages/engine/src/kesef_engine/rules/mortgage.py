"""Mortgaging (MON-202).

Half the printed price out, mortgage value plus 10% back in — the lift fee is computed by
:func:`kesef_engine.legality.unmortgage_cost` so legality and the ledger can never
disagree about it, and it rounds *up*, which is why it is arithmetic in one place rather
than a literal in two.

The three conditions that make this rule more than a flag are all legality's, checked
against the group rather than the tile: every building in the colour group must be sold
before any member can be mortgaged, a mortgaged member blocks building anywhere in the
group, and lifting is not a cash-*raising* action so it is refused while insolvent (G-5).
The rule that surprises people is in :mod:`kesef_engine.rules.rent`, not here — a
mortgaged property charges no rent yet still completes its group (spec §3.6 trap 2).

Absent entirely when ``Ruleset.mortgages_enabled`` is off (Kids Mode): both commands are
rejected with ``error.mortgages_disabled`` and neither is ever enumerated.
"""

from __future__ import annotations

from kesef_engine.board.models import Tile
from kesef_engine.commands import MortgageProperty, UnmortgageProperty
from kesef_engine.events import Event, MortgageChanged
from kesef_engine.legality import unmortgage_cost
from kesef_engine.primitives import CashReason
from kesef_engine.rules.cash import move_cash
from kesef_engine.rules.common import update_property
from kesef_engine.state import GameState


def transfer_fee(tile: Tile) -> int:
    """The 10% a *mortgaged* tile's new owner owes the bank the moment it changes hands.

    Owner decision 2 (GAP §7) took the **full official rule**: the receiver pays 10% at
    transfer, and — if they leave the mortgage standing — the full 10% again when they
    later lift it. It is written as the interest *half* of :func:`unmortgage_cost` rather
    than as fresh arithmetic, so "the same 10% again" is provably the same figure and the
    round-up lives in exactly one place.

    Charged by trades (MON-204) and by bankruptcy transfers (MON-207); it is not a legality
    input, because a receiver who cannot pay it opens a debt rather than being refused.
    """
    return unmortgage_cost(tile) - (tile.mortgage or 0)


def handle_mortgage(state: GameState, command: MortgageProperty) -> tuple[GameState, tuple[Event, ...]]:
    tile = state.board.tile(command.tile)
    state = update_property(state, command.tile, mortgaged=True)
    state, paid = move_cash(
        state, source="bank", dest=command.player, amount=tile.mortgage or 0, reason=CashReason.MORTGAGE
    )
    return state, (*paid, MortgageChanged(tile=command.tile, mortgaged=True))


def handle_unmortgage(state: GameState, command: UnmortgageProperty) -> tuple[GameState, tuple[Event, ...]]:
    tile = state.board.tile(command.tile)
    state = update_property(state, command.tile, mortgaged=False)
    state, paid = move_cash(
        state, source=command.player, dest="bank", amount=unmortgage_cost(tile), reason=CashReason.UNMORTGAGE
    )
    return state, (*paid, MortgageChanged(tile=command.tile, mortgaged=False))
