"""Auctions (MON-203).

Opened from two places and one day a third, which is why opening is a function here rather
than logic repeated at each call site: a declined purchase (spec §3.6 trap 5 — no reserve,
the decliner may bid, the tile can go for ₪1) and a bankruptcy to the bank, which
liquidates a whole *estate* as an ordered queue of lots inside one frame (ADR-007, GAP
G-3). The third is the building shortage, off in v1 (owner decision 1) — a ``BuildingLot``
cannot be awarded to anything, since the lot names no tile, so it resolves as void rather
than crashing if a hand-built state reaches it.

Termination is specced, not implied, because "everyone keeps passing" is where naive
implementations hang:

* the minimum next bid is one over the standing high bid (:func:`~kesef_engine.legality.minimum_bid`);
* the standing high bidder is skipped in the rotation — their own bid stands until beaten;
* the last active bidder left wins at their standing bid, with no further round;
* everyone withdrawing without a bid leaves the lot with the bank;
* withdrawal is final **for the lot**, not for the estate: the next lot in the queue opens
  with the full eligible order again;
* **a lot with fewer than two eligible bidders is voided** (GAP G-8). That is the fix for
  the two-player bankruptcy deadlock: the survivor cannot bid against themselves, so the
  estate cannot be sold, and endgame — which only evaluates once the interrupts drain —
  would otherwise never be reached.

A bidder short of cash is not stuck: ``AUCTION`` is a RAISING phase, so the player whose
bid turn it is may sell buildings and mortgage to fund a bid (GAP G-B1a). Without that,
auction prices are systematically low and the no-reserve rule is exploitable.
"""

from __future__ import annotations

from collections.abc import Sequence

from kesef_engine.commands import PlaceBid, WithdrawFromAuction
from kesef_engine.events import AuctionEnded, AuctionStarted, BidderWithdrew, BidPlaced, Event, PropertyAcquired
from kesef_engine.primitives import AuctionReason, CashReason, Lot, PlayerId, TileLot
from kesef_engine.rules.cash import move_cash
from kesef_engine.rules.common import update_property
from kesef_engine.ruleset import AuctionMinimum
from kesef_engine.state import AuctionFrame, GameState

MIN_BIDDERS = 2
"""Fewer than this and the lot is voided — one player cannot bid against themselves."""


def bidding_order(state: GameState, *, start_from: PlayerId, include_start: bool) -> tuple[PlayerId, ...]:
    """Solvent players in seat order — the single naming point for who bids when.

    A declined purchase starts with the decliner, who may bid (trap 5). A bank-triggered
    estate auction has no decliner, so it starts clockwise from the seat to the debtor's
    left and leaves the debtor out of the order entirely (GAP G-15).
    """
    seat_count = len(state.players)
    start = next(index for index, player in enumerate(state.players) if player.id == start_from)
    offsets = range(seat_count) if include_start else range(1, seat_count)
    ordered = (state.players[(start + offset) % seat_count] for offset in offsets)
    return tuple(player.id for player in ordered if not player.bankrupt)


def opening_floor(state: GameState, lot: Lot) -> int:
    """The smallest first bid this lot may take (MON-712).

    One under the printed rule, where a square may go for ₪1; the deed's own price under
    ``AuctionMinimum.LIST_PRICE``, which the owner asked for after a game in which a child bid ₪1
    on every square the adult declined and won all of them. See :class:`~kesef_engine.ruleset.AuctionMinimum`.

    Read per lot rather than once per auction, because an estate queue is a queue of *different*
    squares: ``_open_next`` re-enters here for each one, so a ₪60 deed and a ₪400 deed in the same
    bankruptcy get their own floors rather than the first one's.

    Three edges, all decided here so that nothing downstream has to:

    * A ``BuildingLot`` names no tile and therefore no price — a shortage auction sells *a house*,
      not a square — so it keeps the ₪1 floor whatever the setting says.
    * A tile with no price (a corner, a card square) cannot reach an auction, since only an ownable
      square can be declined or liquidated; ``or 0`` and the ``max`` below mean a hand-built state
      that does reach it opens at ₪1 rather than at zero, which would be a bid of nothing winning.
    * The floor is a floor and nothing else. ``legality.minimum_bid`` still takes
      ``max(min_bid, high_bid + 1)``, so the increment above it is the ordinary one.
    """
    if state.ruleset.auction_minimum is not AuctionMinimum.LIST_PRICE:
        return 1
    if not isinstance(lot, TileLot):
        return 1
    return max(1, state.board.tile(lot.tile).price or 0)


def open_auction(
    state: GameState, *, lots: Sequence[Lot], reason: AuctionReason, eligible: tuple[PlayerId, ...]
) -> tuple[GameState, tuple[Event, ...]]:
    """Offer ``lots`` in order, pushing a frame for the first one that can be auctioned.

    ``state.phase`` must already be the phase the whole queue should resume to —
    ``push_interrupt`` records it. Returns the state unchanged, with no frame, when every
    lot voids: that is precisely the shape endgame needs in order to be allowed to decide.
    """
    bidders = tuple(player for player in eligible if not state.player(player).bankrupt)
    if len(bidders) >= MIN_BIDDERS and lots:
        frame = AuctionFrame(
            resume=state.phase,  # push_interrupt overwrites this with the suspended phase
            lot=lots[0],
            reason=reason,
            eligible=bidders,
            active=bidders,
            turn=bidders[0],
            min_bid=opening_floor(state, lots[0]),
            queue=tuple(lots[1:]),
        )
        state = state.push_interrupt(frame)
        return state, (AuctionStarted(lot=frame.lot, reason=reason, eligible=bidders),)
    # Voided: one event pair per lot, so the log still accounts for every property that
    # was meant to be sold rather than silently leaving them with the bank.
    events: list[Event] = []
    for lot in lots:
        events.append(AuctionStarted(lot=lot, reason=reason, eligible=bidders))
        events.append(AuctionEnded(lot=lot, winner=None, price=0))
    return state, tuple(events)


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
        return _open_next(state, frame, events)
    return state, tuple(events)


def _award(state: GameState, frame: AuctionFrame, events: list[Event]) -> tuple[GameState, tuple[Event, ...]]:
    winner, price = frame.high_bidder, frame.high_bid
    assert winner is not None
    # Popped *before* the winner pays: while the frame is live ``GameState`` requires the
    # standing high bid to be affordable, and paying it makes it exactly unaffordable.
    state = state.pop_interrupt()
    if isinstance(frame.lot, TileLot):
        state = update_property(state, frame.lot.tile, owner=winner)
        state, paid = move_cash(state, source=winner, dest="bank", amount=price, reason=CashReason.AUCTION_WIN)
        events.extend(paid)
        events.append(AuctionEnded(lot=frame.lot, winner=winner, price=price))
        events.append(PropertyAcquired(player=winner, tile=frame.lot.tile, price=price, via="auction"))
    else:
        events.append(AuctionEnded(lot=frame.lot, winner=None, price=0))
    return _open_next(state, frame, events)


def _open_next(state: GameState, frame: AuctionFrame, events: list[Event]) -> tuple[GameState, tuple[Event, ...]]:
    """The finished lot's frame has popped; the next lot in its queue takes its place.

    The eligible order carries over whole, so withdrawing from one lot does not withdraw
    from the estate — and the void rule is re-checked, because a queue can outlive the
    solvency of the players who were meant to bid on it.
    """
    if not frame.queue:
        return state, tuple(events)
    state, opened = open_auction(state, lots=frame.queue, reason=frame.reason, eligible=frame.eligible)
    return state, (*events, *opened)


def _live_frame(state: GameState) -> AuctionFrame:
    frame = state.top_interrupt
    assert isinstance(frame, AuctionFrame)  # is_legal proved it
    return frame


def _updated(frame: AuctionFrame, **changes: object) -> AuctionFrame:
    """A *validated* copy -- ``model_copy`` would skip the frame's invariants."""
    return AuctionFrame(**{**dict(frame), **changes})


def _swap_frame(state: GameState, frame: AuctionFrame) -> GameState:
    return state._replace(interrupts=(*state.interrupts[:-1], frame))
