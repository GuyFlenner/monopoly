"""MON-203 — the full auction rules.

The single-lot mechanics (no reserve, the decliner bids first, the high bidder is skipped,
the last bidder wins) are pinned in ``test_reducer_purchase.py`` where they were born.
What lives here is what MON-203 added: the ordering rule per ``reason``, the multi-lot
estate queue, the void rule for a lot nobody can bid on (GAP G-8), and the raising
permission that keeps no-reserve honest (G-B1a).
"""

from __future__ import annotations

from helpers import make_player, make_state
from kesef_engine.commands import PlaceBid, SellHouse, WithdrawFromAuction
from kesef_engine.events import AuctionEnded, AuctionStarted, CashChanged, PropertyAcquired
from kesef_engine.legality import legal_commands
from kesef_engine.phases import Phase
from kesef_engine.primitives import AuctionReason, BuildingLot, CashReason, Lot, TileLot
from kesef_engine.reducer import apply
from kesef_engine.rules import auction
from kesef_engine.state import AuctionFrame, GameState, PropertyState

BROWN_A, BROWN_B, RAILROAD, ORIENTAL = 1, 3, 5, 6


def _estate(state: GameState, lots: tuple[Lot, ...], *, debtor: int) -> tuple[GameState, tuple[object, ...]]:
    """Open a bank-triggered estate auction the way MON-207's bank path will."""
    return auction.open_auction(
        state,
        lots=lots,
        reason=AuctionReason.BANKRUPTCY_TO_BANK,
        eligible=auction.bidding_order(state, start_from=debtor, include_start=False),
    )


# --- Ordering per reason (G-15) ------------------------------------------------


def test_a_declined_purchase_orders_from_the_decliner_who_may_bid() -> None:
    order = auction.bidding_order(make_state(players=4), start_from=2, include_start=True)
    assert order == (2, 3, 0, 1), "trap 5: the decliner bids, and bids first"


def test_a_bank_triggered_auction_orders_clockwise_from_the_debtors_left() -> None:
    """G-15: an estate auction has no decliner, so the debtor is not in the order at all."""
    order = auction.bidding_order(make_state(players=4), start_from=2, include_start=False)
    assert order == (3, 0, 1)


def test_a_bankrupt_seat_is_never_an_eligible_bidder() -> None:
    seats = (make_player(0), make_player(1, cash=0, bankrupt=True), make_player(2), make_player(3))
    state = make_state(seats=seats)
    assert auction.bidding_order(state, start_from=0, include_start=True) == (0, 2, 3)


# --- The void rule (G-8) -------------------------------------------------------


def test_a_lot_with_only_one_eligible_bidder_is_voided_and_pushes_no_frame() -> None:
    """The two-player bankruptcy deadlock: the survivor cannot bid against themselves, so
    the estate cannot be sold and endgame must be allowed to reach a decision."""
    seats = (make_player(0, cash=0, bankrupt=True), make_player(1))
    state = make_state(seats=seats, phase=Phase.AWAITING_END_TURN, current=1)
    voided, events = _estate(state, (TileLot(tile=BROWN_A),), debtor=0)
    assert voided.interrupts == (), "no live interrupt, so endgame may decide"
    assert voided.phase is Phase.AWAITING_END_TURN
    started = next(event for event in events if isinstance(event, AuctionStarted))
    assert started.eligible == (1,)
    ended = next(event for event in events if isinstance(event, AuctionEnded))
    assert (ended.winner, ended.price) == (None, 0)
    assert voided.properties[BROWN_A].owner is None, "the lot stayed with the bank"


def test_every_lot_of_an_unsellable_estate_is_accounted_for() -> None:
    seats = (make_player(0, cash=0, bankrupt=True), make_player(1))
    state = make_state(seats=seats, phase=Phase.AWAITING_END_TURN, current=1)
    lots: tuple[Lot, ...] = (TileLot(tile=BROWN_A), TileLot(tile=RAILROAD), TileLot(tile=ORIENTAL))
    voided, events = _estate(state, lots, debtor=0)
    assert voided.interrupts == ()
    ended = [event for event in events if isinstance(event, AuctionEnded)]
    assert [event.lot for event in ended] == list(lots), "one closing event per property"


def test_an_empty_estate_opens_nothing() -> None:
    state = make_state(players=3, phase=Phase.AWAITING_END_TURN)
    same, events = _estate(state, (), debtor=0)
    assert same.interrupts == ()
    assert events == ()


# --- The multi-lot estate queue (ADR-007, G-3) --------------------------------


def _three_lot_estate() -> tuple[GameState, tuple[Lot, ...]]:
    seats = (make_player(0, cash=0, bankrupt=True), make_player(1, cash=500), make_player(2, cash=500))
    state = make_state(seats=seats, phase=Phase.AWAITING_END_TURN, current=1)
    lots: tuple[Lot, ...] = (TileLot(tile=BROWN_A), TileLot(tile=RAILROAD), TileLot(tile=ORIENTAL))
    opened, _ = _estate(state, lots, debtor=0)
    return opened, lots


def test_an_estate_opens_its_first_lot_and_queues_the_rest() -> None:
    state, lots = _three_lot_estate()
    frame = state.top_interrupt
    assert isinstance(frame, AuctionFrame)
    assert frame.lot == lots[0]
    assert frame.queue == lots[1:]
    assert frame.reason is AuctionReason.BANKRUPTCY_TO_BANK
    assert frame.eligible == (1, 2), "clockwise from the bankrupt player's left"
    assert frame.turn == 1


def test_selling_one_lot_opens_the_next_in_the_same_breath() -> None:
    state, lots = _three_lot_estate()
    state, _ = apply(state, PlaceBid(player=1, amount=10))
    state, events = apply(state, WithdrawFromAuction(player=2))
    assert state.properties[BROWN_A].owner == 1
    assert state.player(1).cash == 490
    frame = state.top_interrupt
    assert isinstance(frame, AuctionFrame), "the second lot is live without a further command"
    assert frame.lot == lots[1]
    assert frame.queue == lots[2:]
    assert frame.active == (1, 2), "withdrawal was final for the lot, not for the estate"
    assert [event.lot for event in events if isinstance(event, AuctionStarted)] == [lots[1]]


def test_the_queue_drains_to_the_phase_the_estate_suspended() -> None:
    state, lots = _three_lot_estate()
    for _ in lots:
        state, _ = apply(state, PlaceBid(player=1, amount=1))
        state, _ = apply(state, WithdrawFromAuction(player=2))
    assert state.interrupts == ()
    assert state.phase is Phase.AWAITING_END_TURN
    assert [state.properties[tile].owner for tile in (BROWN_A, RAILROAD, ORIENTAL)] == [1, 1, 1]
    assert state.player(1).cash == 497


def test_a_lot_nobody_bids_on_stays_with_the_bank_and_the_queue_continues() -> None:
    state, lots = _three_lot_estate()
    state, _ = apply(state, WithdrawFromAuction(player=1))
    state, events = apply(state, WithdrawFromAuction(player=2))
    assert state.properties[BROWN_A].owner is None
    ended = next(event for event in events if isinstance(event, AuctionEnded))
    assert (ended.lot, ended.winner) == (lots[0], None)
    frame = state.top_interrupt
    assert isinstance(frame, AuctionFrame)
    assert frame.lot == lots[1]


# --- Minimum increment and termination ---------------------------------------


def test_the_minimum_next_bid_is_one_over_the_standing_high_bid() -> None:
    state, _ = _three_lot_estate()
    state, _ = apply(state, PlaceBid(player=1, amount=40))
    offered = [command for command in legal_commands(state) if isinstance(command, PlaceBid)]
    assert [(command.player, command.amount) for command in offered] == [(2, 41)]


def test_the_standing_high_bidder_is_not_asked_again_until_outbid() -> None:
    state, _ = _three_lot_estate()
    state, _ = apply(state, PlaceBid(player=1, amount=40))
    frame = state.top_interrupt
    assert isinstance(frame, AuctionFrame)
    assert frame.turn == 2, "the high bidder does not bid against themselves"
    state, _ = apply(state, PlaceBid(player=2, amount=41))
    frame = state.top_interrupt
    assert isinstance(frame, AuctionFrame)
    assert frame.turn == 1, "outbid, so back in the rotation"


# --- Raising cash on a bid turn (G-B1a) --------------------------------------


def test_the_bidder_whose_turn_it_is_may_sell_buildings_to_fund_a_bid() -> None:
    seats = (make_player(0, cash=0, bankrupt=True), make_player(1, cash=0), make_player(2, cash=500))
    state = make_state(
        seats=seats,
        phase=Phase.AWAITING_END_TURN,
        current=1,
        properties={BROWN_A: PropertyState(owner=1, houses=1), BROWN_B: PropertyState(owner=1, houses=1)},
    )
    state, _ = _estate(state, (TileLot(tile=RAILROAD),), debtor=0)
    assert not [command for command in legal_commands(state) if isinstance(command, PlaceBid)], "no cash, no bid"
    state, events = apply(state, SellHouse(player=1, tile=BROWN_A))
    assert next(event for event in events if isinstance(event, CashChanged)).reason is CashReason.SELL_BUILDING
    assert state.phase is Phase.AUCTION, "the auction was not disturbed"
    assert [(command.player, command.amount) for command in legal_commands(state) if isinstance(command, PlaceBid)] == [
        (1, 1)
    ]


def test_a_bidder_who_is_not_on_turn_cannot_raise_cash() -> None:
    state, _ = _three_lot_estate()
    frame = state.top_interrupt
    assert isinstance(frame, AuctionFrame)
    assert frame.turn == 1
    assert all(command.player == 1 for command in legal_commands(state))


# --- A BuildingLot must not crash (owner decision 1) -------------------------


def test_awarding_a_building_lot_voids_instead_of_crashing() -> None:
    """``building_shortage_auction`` is off in v1, so only a hand-built frame gets here.
    It must resolve rather than raise, and it must charge nobody: there is no tile to
    award, because the lot deliberately names none (GAP G-3)."""
    seats = (make_player(0, cash=500), make_player(1, cash=500))
    frame = AuctionFrame(
        resume=Phase.AWAITING_END_TURN,
        lot=BuildingLot(building="house"),
        reason=AuctionReason.BUILDING_SHORTAGE,
        eligible=(0, 1),
        active=(0, 1),
        turn=0,
    )
    state = make_state(seats=seats, phase=Phase.AUCTION, interrupts=(frame,))
    state, _ = apply(state, PlaceBid(player=0, amount=25))
    state, events = apply(state, WithdrawFromAuction(player=1))
    assert state.interrupts == ()
    assert state.phase is Phase.AWAITING_END_TURN
    assert state.player(0).cash == 500, "nobody paid for a lot that cannot be delivered"
    ended = next(event for event in events if isinstance(event, AuctionEnded))
    assert (ended.winner, ended.price) == (None, 0)
    assert not [event for event in events if isinstance(event, PropertyAcquired)]
