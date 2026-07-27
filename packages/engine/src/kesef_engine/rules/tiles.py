"""What landing on a tile does (MON-108 owns the cashflow tiles; the router lands with
MON-102 because movement cannot exist without it).

The Free Parking pot's inputs are named here, in one place: directly paid taxes and jail
fines feed it when ``free_parking_pot_enabled`` — never anything else. A debt-settled tax
or fine goes to the bank as recorded in its :class:`~kesef_engine.state.Obligation`.
"""

from __future__ import annotations

from kesef_engine.board.models import TileKind
from kesef_engine.events import Event
from kesef_engine.phases import Phase
from kesef_engine.primitives import CashReason, PlayerId
from kesef_engine.rules.cash import Party, move_cash
from kesef_engine.rules.common import post_move_phase, send_to_jail
from kesef_engine.rules.insolvency import open_debt
from kesef_engine.ruleset import Ruleset
from kesef_engine.state import GameState


def pot_or_bank(ruleset: Ruleset) -> Party:
    """Where a directly paid tax or jail fine goes — the pot's single naming point."""
    return "free_parking_pot" if ruleset.free_parking_pot_enabled else "bank"


def resolve_landing(state: GameState, player_id: PlayerId) -> tuple[GameState, tuple[Event, ...]]:
    """Apply the landed-on tile's consequence and leave the state in a resting phase.

    This is the body of the transient ``RESOLVING_TILE`` phase: callers never see it,
    because this function always returns a state resting in a non-transient phase.
    """
    tile = state.board.tile(state.player(player_id).position)
    events: list[Event] = []
    if tile.is_ownable:
        prop = state.properties[tile.index]
        if prop.owner is None:
            return state._replace(phase=Phase.AWAITING_PURCHASE_DECISION), ()
        if prop.owner != player_id:
            state, rent_events = _charge_rent(state, player_id, tile.index)
            return state, tuple(rent_events)
    elif tile.kind is TileKind.TAX:
        return _charge_tax(state, player_id, tile.index)
    elif tile.kind is TileKind.GO_TO_JAIL:
        state, jailed = send_to_jail(state, player_id, via="tile")
        events.extend(jailed)
    elif tile.kind is TileKind.FREE_PARKING:
        state, collected = _collect_pot(state, player_id)
        events.extend(collected)
    elif tile.kind in (TileKind.CHANCE, TileKind.COMMUNITY_CHEST):
        pass  # TODO(MON-206): draw and resolve a card. Card tiles are inert in M1.
    # GO and JAIL ("just visiting") are inert; GO's salary was paid by the mover.
    return state._replace(phase=post_move_phase(state, player_id)), tuple(events)


def _charge_rent(state: GameState, player_id: PlayerId, tile_index: int) -> tuple[GameState, list[Event]]:
    from kesef_engine.rules import rent  # local import: rent needs movement's dice helpers

    state, events = rent.charge(state, player_id, tile_index)
    return state, list(events)


def _charge_tax(state: GameState, player_id: PlayerId, tile_index: int) -> tuple[GameState, tuple[Event, ...]]:
    """Flat amounts only in v1 — the 10% income-tax option is owner decision 3 (GAP §7)."""
    tile = state.board.tile(tile_index)
    amount = tile.tax or 0
    payer = state.player(player_id)
    if payer.cash < amount:
        return open_debt(
            state,
            debtor=player_id,
            creditor="bank",
            amount=amount,
            reason=CashReason.TAX,
            source_tile=tile_index,
            resume=post_move_phase(state, player_id),
        )
    state, events = move_cash(
        state, source=player_id, dest=pot_or_bank(state.ruleset), amount=amount, reason=CashReason.TAX
    )
    return state._replace(phase=post_move_phase(state, player_id)), events


def _collect_pot(state: GameState, player_id: PlayerId) -> tuple[GameState, tuple[Event, ...]]:
    if not state.ruleset.free_parking_pot_enabled or state.free_parking_pot == 0:
        return state, ()
    return move_cash(
        state,
        source="free_parking_pot",
        dest=player_id,
        amount=state.free_parking_pot,
        reason=CashReason.FREE_PARKING_POT,
    )
