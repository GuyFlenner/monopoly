"""Auction bidding and resolution (M1 slice with MON-103; MON-203 owns the full rules).

What lands now, because MON-101 already offers the commands: bids at or above the floor,
final withdrawals, rotation that skips the standing high bidder, the last active bidder
winning at their standing bid, and everyone-withdrew leaving the lot with the bank.

TODO(MON-203): multi-lot estate queues, the void rule for lots with fewer than two
eligible bidders, and awarding a ``BuildingLot`` (voided here — the engine never opens
one while ``building_shortage_auction`` is off, so only a hand-built state reaches it).
"""

from __future__ import annotations

from kesef_engine.commands import PlaceBid, WithdrawFromAuction
from kesef_engine.events import AuctionEnded, BidderWithdrew, BidPlaced, Event, PropertyAcquired
from kesef_engine.primitives import CashReason, PlayerId, TileLot
from kesef_engine.rules.cash import move_cash
from kesef_engine.rules.common import update_property
from kesef_engine.state import AuctionFrame, GameState


def handle_bid(state: GameState, command: PlaceBid) -> tuple[GameState, tuple[Event, ...]]:
    frame = _updated(_live_frame(state), high_bid=command.amount, high_bidder=command.player, turn=None)
    frame = _updated(frame, turn=_next_turn(frame, after=command.player))
    state = _swap_frame(state, frame)
    events: list[Event] = [BidPlaced(player=command.player, amount=command.amount)]
    return _conclude_if_over(state, frame, events)


def handle_withdraw(state: GameState, command: WithdrawFromAuction) -> tuple[GameState, tuple[Event, ...]]:
    frame = _live_frame(state)
    remaining = tuple(bidder for bidder in frame.active if bidder != command.player)
    frame = _updated(frame, active=remaining, turn=None)
    frame = _updated(frame, turn=_next_turn(frame, after=command.player))
    state = _swap_frame(state, frame)
    events: list[Event] = [BidderWithdrew(player=command.player)]
    return _conclude_if_over(state, frame, events)


def _next_turn(frame: AuctionFrame, *, after: PlayerId) -> PlayerId | None:
    """The next active bidder in the stored order, skipping the standing high bidder
    (MON-203: the high bid stands until somebody outbids it)."""
    order = frame.eligible
    start = order.index(after) if after in order else -1
    for offset in range(1, len(order) + 1):
        candidate = order[(start + offset) % len(order)]
        if candidate in frame.active and candidate != frame.high_bidder:
            return candidate
    return None


def _conclude_if_over(
    state: GameState, frame: AuctionFrame, events: list[Event]
) -> tuple[GameState, tuple[Event, ...]]:
    contenders = tuple(bidder for bidder in frame.active if bidder != frame.high_bidder)
    if frame.high_bidder is not None and not contenders:
        return _award(state, frame, events)
    if frame.high_bidder is None and not frame.active:
        # Everyone withdrew without a bid: the lot stays with the bank.
        state = state.pop_interrupt()
        events.append(AuctionEnded(lot=frame.lot, winner=None, price=0))
        return state, tuple(events)
    return state, tuple(events)


def _award(state: GameState, frame: AuctionFrame, events: list[Event]) -> tuple[GameState, tuple[Event, ...]]:
    winner, price = frame.high_bidder, frame.high_bid
    assert winner is not None
    state = state.pop_interrupt()
    if isinstance(frame.lot, TileLot):
        state = update_property(state, frame.lot.tile, owner=winner)
        state, paid = move_cash(state, source=winner, dest="bank", amount=price, reason=CashReason.AUCTION_WIN)
        events.extend(paid)
        events.append(AuctionEnded(lot=frame.lot, winner=winner, price=price))
        events.append(PropertyAcquired(player=winner, tile=frame.lot.tile, price=price, via="auction"))
    else:
        # TODO(MON-203): awarding a BuildingLot. Unreachable through play in v1
        # (building_shortage_auction is off); a hand-built frame resolves as void.
        events.append(AuctionEnded(lot=frame.lot, winner=None, price=0))
    return state, tuple(events)


def _live_frame(state: GameState) -> AuctionFrame:
    frame = state.top_interrupt
    assert isinstance(frame, AuctionFrame)  # is_legal proved it
    return frame


def _updated(frame: AuctionFrame, **changes: object) -> AuctionFrame:
    """A *validated* copy -- ``model_copy`` would skip the frame's invariants."""
    return AuctionFrame(**{**dict(frame), **changes})


def _swap_frame(state: GameState, frame: AuctionFrame) -> GameState:
    return state._replace(interrupts=(*state.interrupts[:-1], frame))
