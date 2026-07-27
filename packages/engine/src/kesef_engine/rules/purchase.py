"""Purchase and decline (MON-103).

Buying is atomic: ownership and cash change in the same ``apply``. Declining opens the
official no-reserve auction — the decliner may bid, and bids first — unless the ruleset
disables auctions, in which case the tile simply stays with the bank.
"""

from __future__ import annotations

from kesef_engine.commands import BuyProperty, Command, DeclinePurchase
from kesef_engine.events import AuctionStarted, Event, PropertyAcquired
from kesef_engine.primitives import AuctionReason, CashReason, TileLot
from kesef_engine.rules.cash import move_cash
from kesef_engine.rules.common import post_move_phase, update_property
from kesef_engine.state import AuctionFrame, GameState


def decide(state: GameState, command: Command) -> tuple[GameState, tuple[Event, ...]]:
    match command:
        case BuyProperty():
            return _buy(state, command.player)
        case DeclinePurchase():
            return _decline(state, command.player)
        case _:  # pragma: no cover - is_legal admits nothing else in AWAITING_PURCHASE_DECISION
            raise AssertionError(f"is_legal admitted {command.kind!r} in AWAITING_PURCHASE_DECISION")


def _buy(state: GameState, player_id: int) -> tuple[GameState, tuple[Event, ...]]:
    tile = state.board.tile(state.player(player_id).position)
    price = tile.price or 0
    state = update_property(state, tile.index, owner=player_id)
    state, paid = move_cash(state, source=player_id, dest="bank", amount=price, reason=CashReason.PURCHASE)
    acquired = PropertyAcquired(player=player_id, tile=tile.index, price=price, via="purchase")
    return state._replace(phase=post_move_phase(state, player_id)), (*paid, acquired)


def _decline(state: GameState, player_id: int) -> tuple[GameState, tuple[Event, ...]]:
    state = state._replace(phase=post_move_phase(state, player_id))
    if not state.ruleset.auctions_enabled:
        return state, ()
    tile_index = state.player(player_id).position
    eligible = _bidding_order(state, player_id)
    frame = AuctionFrame(
        resume=state.phase,  # push_interrupt overwrites this with the suspended phase
        lot=TileLot(tile=tile_index),
        reason=AuctionReason.DECLINED_PURCHASE,
        eligible=eligible,
        active=eligible,
        turn=eligible[0],
        min_bid=1,  # no reserve (spec §3.6 trap 5)
    )
    state = state.push_interrupt(frame)
    return state, (AuctionStarted(lot=frame.lot, reason=frame.reason, eligible=eligible),)


def _bidding_order(state: GameState, decliner: int) -> tuple[int, ...]:
    """Solvent players in seat order starting from the decliner, who may bid (trap 5)."""
    seat_count = len(state.players)
    start = next(index for index, player in enumerate(state.players) if player.id == decliner)
    ordered = (state.players[(start + offset) % seat_count] for offset in range(seat_count))
    return tuple(player.id for player in ordered if not player.bankrupt)
