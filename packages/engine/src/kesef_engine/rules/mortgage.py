"""Mortgaging (M1 slice; MON-202 owns the full acceptance surface).

Half the printed price out, mortgage value plus 10% back in — the lift fee is computed
by :func:`kesef_engine.legality.unmortgage_cost` so the two can never disagree.
"""

from __future__ import annotations

from kesef_engine.commands import MortgageProperty, UnmortgageProperty
from kesef_engine.events import Event, MortgageChanged
from kesef_engine.legality import unmortgage_cost
from kesef_engine.primitives import CashReason
from kesef_engine.rules.cash import move_cash
from kesef_engine.rules.common import update_property
from kesef_engine.state import GameState


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
