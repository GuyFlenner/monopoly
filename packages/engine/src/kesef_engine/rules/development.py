"""Building and selling houses (M1 slice; MON-201 owns even-build's full test surface,
the hotel/stock accounting edge cases and the shortage variant).

Legality — even-build, group completion, stock, funds — is entirely
:mod:`kesef_engine.legality`'s: these handlers only enact an approved command.
"""

from __future__ import annotations

from kesef_engine.commands import BuildHouse, SellHouse
from kesef_engine.events import BuildingChanged, Event
from kesef_engine.primitives import CashReason
from kesef_engine.rules.cash import move_cash
from kesef_engine.rules.common import update_property
from kesef_engine.state import HOTEL_LEVEL, GameState


def handle_build(state: GameState, command: BuildHouse) -> tuple[GameState, tuple[Event, ...]]:
    tile = state.board.tile(command.tile)
    houses = state.properties[command.tile].houses + 1
    state = update_property(state, command.tile, houses=houses)
    state, paid = move_cash(
        state, source=command.player, dest="bank", amount=tile.house_cost or 0, reason=CashReason.BUILD
    )
    return state, (*paid, BuildingChanged(tile=command.tile, houses=houses, delta=1))


def handle_sell(state: GameState, command: SellHouse) -> tuple[GameState, tuple[Event, ...]]:
    """Sell one level back at half price. Demolishing a hotel needs four houses in the
    bank; when they are not there, the whole tile drops to zero at half price for all
    five levels — exactly what a debtor hits during a shortage (GAP G-B3b)."""
    tile = state.board.tile(command.tile)
    before = state.properties[command.tile].houses
    half_price = (tile.house_cost or 0) // 2
    if before == HOTEL_LEVEL and state.houses_remaining < HOTEL_LEVEL - 1:
        after, refund = 0, HOTEL_LEVEL * half_price
    else:
        after, refund = before - 1, half_price
    state = update_property(state, command.tile, houses=after)
    state, paid = move_cash(state, source="bank", dest=command.player, amount=refund, reason=CashReason.SELL_BUILDING)
    return state, (*paid, BuildingChanged(tile=command.tile, houses=after, delta=after - before))
