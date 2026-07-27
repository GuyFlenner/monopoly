"""Purchase and decline (MON-103).

Buying is atomic: ownership and cash change in the same ``apply``. Declining opens the
official no-reserve auction — the decliner may bid, and bids first — unless the ruleset
disables auctions, in which case the tile simply stays with the bank.
"""

from __future__ import annotations

from kesef_engine.commands import BuyProperty, Command, DeclinePurchase
from kesef_engine.events import Event, PropertyAcquired
from kesef_engine.primitives import AuctionReason, CashReason, TileLot
from kesef_engine.rules import auction
from kesef_engine.rules.cash import move_cash
from kesef_engine.rules.common import post_move_phase, update_property
from kesef_engine.state import GameState


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
    # Ordering and the void rule both live in the auction module, so the two openers
    # (this one and MON-207's estate liquidation) cannot drift apart.
    return auction.open_auction(
        state,
        lots=(TileLot(tile=state.player(player_id).position),),
        reason=AuctionReason.DECLINED_PURCHASE,
        eligible=auction.bidding_order(state, start_from=player_id, include_start=True),
    )
