"""Building and selling houses (MON-201).

Legality — even-build both ways, group completion, the bank's stock, funds — is entirely
:mod:`kesef_engine.legality`'s: these handlers only enact an approved command. What lives
here is the *arithmetic*, and the two places it is easy to get wrong:

* the fifth house **is** the hotel, and the four houses it replaces go back to the bank.
  Nothing decrements a counter to make that happen — ``GameState.houses_on_board`` counts
  only tiles standing at 1-4, so the stock is conserved by construction rather than by
  bookkeeping that can drift.
* a hotel comes down by *becoming* four houses, which the bank has to have. When it does
  not, the official "all buildings on one colour-group may be sold at once" clause is the
  only way down, and it takes the whole *group* to zero — a lone hotel dropped to zero
  would leave its siblings five levels above it, breaking even-build on the way down
  (GAP G-B3b, spec §3.6 trap 3).

There is no shortage-auction path here: who gets a contested last house is first-come-
first-served in v1 (``Ruleset.building_shortage_auction`` is off — owner decision 1,
GAP §7), a documented divergence from the printed rule recorded there and in spec §3.6
trap 4. ``BuildingLot`` exists so switching it on later is a rule change, not a rework.
"""

from __future__ import annotations

from kesef_engine.commands import BuildHouse, SellHouse
from kesef_engine.events import BuildingChanged, Event
from kesef_engine.primitives import BuildingLevel, CashReason, TileIndex
from kesef_engine.rules.cash import move_cash
from kesef_engine.rules.common import update_property
from kesef_engine.state import HOTEL_LEVEL, GameState


def level_reached(houses: int) -> BuildingLevel:
    """Which building the tile arrived at, or came down from, at ``houses``.

    "The fifth house *is* the hotel" is the rule this function is, and it lives here so that
    ``BuildingChanged.level`` is the engine's answer rather than a ``houses === 5`` in the client
    (MON-413). Read twice — once for a build, where ``houses`` is the level after the money moved,
    and once for a sale, where it is the level the building came *off*.
    """
    return "hotel" if houses >= HOTEL_LEVEL else "house"


def handle_build(state: GameState, command: BuildHouse) -> tuple[GameState, tuple[Event, ...]]:
    tile = state.board.tile(command.tile)
    houses = state.properties[command.tile].houses + 1
    state = update_property(state, command.tile, houses=houses)
    state, paid = move_cash(
        state, source=command.player, dest="bank", amount=tile.house_cost or 0, reason=CashReason.BUILD
    )
    return state, (
        *paid,
        BuildingChanged(tile=command.tile, houses=houses, delta=1, level=level_reached(houses)),
    )


def handle_sell(state: GameState, command: SellHouse) -> tuple[GameState, tuple[Event, ...]]:
    """Sell back at half the build cost: one level, or the whole group under
    ``demolish_hotel``. One ledger entry either way — the refund is a single payment."""
    group = state.board.tile(command.tile).group
    assert group is not None  # is_legal proved the tile is a PROPERTY
    targets: tuple[TileIndex, ...] = state.board.group_members(group) if command.demolish_hotel else (command.tile,)
    events: list[Event] = []
    refund = 0
    for target in targets:
        before = state.properties[target].houses
        if before == 0:
            continue
        after = 0 if command.demolish_hotel else before - 1
        half_price = (state.board.tile(target).house_cost or 0) // 2
        refund += (before - after) * half_price
        state = update_property(state, target, houses=after)
        # ``before``, not ``after``: what came *down* is whatever stood there, so a demolished
        # hotel says "hotel" while the tile it left behind is bare.
        events.append(BuildingChanged(tile=target, houses=after, delta=after - before, level=level_reached(before)))
    state, paid = move_cash(state, source="bank", dest=command.player, amount=refund, reason=CashReason.SELL_BUILDING)
    return state, (*paid, *events)
