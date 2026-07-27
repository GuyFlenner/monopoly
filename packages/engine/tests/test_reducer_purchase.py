"""MON-103 — buy at list price, or decline into a no-reserve auction."""

from __future__ import annotations

import pytest

from helpers import make_player, make_state
from kesef_engine.commands import BuyProperty, DeclinePurchase, PlaceBid, RollDice, WithdrawFromAuction
from kesef_engine.errors import IllegalCommandError
from kesef_engine.events import (
    AuctionEnded,
    AuctionStarted,
    BidderWithdrew,
    BidPlaced,
    CashChanged,
    Event,
    PropertyAcquired,
)
from kesef_engine.phases import Phase
from kesef_engine.primitives import CashReason, TileLot
from kesef_engine.reducer import apply
from kesef_engine.rng import Rng
from kesef_engine.ruleset import Ruleset
from kesef_engine.state import AuctionFrame, GameState, PlayerState

_PLAIN_SEED = next(seed for seed in range(1000) if (r := Rng(seed=seed).roll_dice())[0] != r[1])
_DOUBLES_SEED = next(seed for seed in range(1000) if (r := Rng(seed=seed).roll_dice())[0] == r[1])
ST_JAMES = 16  # orange, price 180


def _decision_state(
    *, seed: int = _PLAIN_SEED, cash: int = 1500, players: int = 2, ruleset: Ruleset | None = None
) -> GameState:
    """Roll onto the unowned ST_JAMES so the purchase decision is live."""
    total = sum(Rng(seed=seed).roll_dice()[:2])
    seats: tuple[PlayerState, ...] = tuple(
        make_player(n, position=(ST_JAMES - total) % 40 if n == 0 else 0, cash=cash) for n in range(players)
    )
    state = make_state(seats=seats, seed=seed, ruleset=ruleset)
    state, _ = apply(state, RollDice(player=0))
    assert state.phase is Phase.AWAITING_PURCHASE_DECISION
    return state


def test_buying_transfers_ownership_and_cash_atomically() -> None:
    state = _decision_state()
    new_state, events = apply(state, BuyProperty(player=0))
    assert new_state.properties[ST_JAMES].owner == 0
    paid = next(e for e in events if isinstance(e, CashChanged))
    assert (paid.delta, paid.reason, paid.counterparty) == (-180, CashReason.PURCHASE, "bank")
    assert new_state.player(0).cash == 1320
    acquired = next(e for e in events if isinstance(e, PropertyAcquired))
    assert (acquired.tile, acquired.price, acquired.via) == (ST_JAMES, 180, "purchase")
    assert new_state.phase is Phase.AWAITING_END_TURN


def test_buying_after_doubles_still_grants_the_extra_roll() -> None:
    state = _decision_state(seed=_DOUBLES_SEED)
    new_state, _ = apply(state, BuyProperty(player=0))
    assert new_state.phase is Phase.AWAITING_ROLL
    assert new_state.current_player_id == 0


def test_an_unaffordable_purchase_is_never_legal() -> None:
    state = _decision_state(cash=100)
    with pytest.raises(IllegalCommandError) as excinfo:
        apply(state, BuyProperty(player=0))
    assert excinfo.value.reason_key == "error.insufficient_funds"


def test_declining_without_auctions_leaves_the_tile_with_the_bank() -> None:
    state = _decision_state(cash=2000, ruleset=Ruleset.kids())
    new_state, events = apply(state, DeclinePurchase(player=0))
    assert new_state.properties[ST_JAMES].owner is None
    assert new_state.phase is Phase.AWAITING_END_TURN
    assert not [e for e in events if isinstance(e, AuctionStarted)]


def test_declining_opens_a_no_reserve_auction_ordered_from_the_decliner() -> None:
    state = _decision_state(players=3)
    new_state, events = apply(state, DeclinePurchase(player=0))
    assert new_state.phase is Phase.AUCTION
    frame = new_state.top_interrupt
    assert isinstance(frame, AuctionFrame)
    assert frame.lot == TileLot(tile=ST_JAMES)
    assert frame.eligible == (0, 1, 2), "the decliner may bid, and bids first"
    assert frame.active == (0, 1, 2)
    assert frame.turn == 0
    assert frame.min_bid == 1, "no reserve - the tile can go for 1"
    started = next(e for e in events if isinstance(e, AuctionStarted))
    assert started.eligible == (0, 1, 2)
    assert started.reason.value == "declined_purchase"


def test_bankrupt_players_are_not_eligible_bidders() -> None:
    total = sum(Rng(seed=_PLAIN_SEED).roll_dice()[:2])
    seats = (
        make_player(0, position=(ST_JAMES - total) % 40),
        make_player(1, cash=0, bankrupt=True),
        make_player(2),
    )
    state = make_state(seats=seats, seed=_PLAIN_SEED)
    state = GameState(**{**dict(state), "elimination_order": (1,)})
    state, _ = apply(state, RollDice(player=0))
    state, _ = apply(state, DeclinePurchase(player=0))
    frame = state.top_interrupt
    assert isinstance(frame, AuctionFrame)
    assert frame.eligible == (0, 2)


def _bid(state: GameState, player: int, amount: int) -> tuple[GameState, tuple[Event, ...]]:
    return apply(state, PlaceBid(player=player, amount=amount))


def test_bidding_rotates_past_the_standing_high_bidder() -> None:
    state = _decision_state(players=3)
    state, _ = apply(state, DeclinePurchase(player=0))
    state, events = _bid(state, 0, 1)
    frame = state.top_interrupt
    assert isinstance(frame, AuctionFrame)
    assert (frame.high_bid, frame.high_bidder, frame.turn) == (1, 0, 1)
    assert next(e for e in events if isinstance(e, BidPlaced)).amount == 1
    state, _ = _bid(state, 1, 50)
    frame = state.top_interrupt
    assert isinstance(frame, AuctionFrame)
    assert (frame.high_bidder, frame.turn) == (1, 2)
    state, _ = apply(state, WithdrawFromAuction(player=2))
    frame = state.top_interrupt
    assert isinstance(frame, AuctionFrame)
    assert frame.turn == 0, "back past the high bidder to the remaining rival"


def test_a_bid_below_the_standing_high_plus_one_is_illegal() -> None:
    state = _decision_state(players=3)
    state, _ = apply(state, DeclinePurchase(player=0))
    state, _ = _bid(state, 0, 40)
    with pytest.raises(IllegalCommandError) as excinfo:
        _bid(state, 1, 40)
    assert excinfo.value.reason_key == "error.bid_too_low"


def test_the_last_active_bidder_wins_at_their_standing_bid() -> None:
    state = _decision_state()
    state, _ = apply(state, DeclinePurchase(player=0))
    state, _ = _bid(state, 0, 1)
    new_state, events = apply(state, WithdrawFromAuction(player=1))
    assert next(e for e in events if isinstance(e, BidderWithdrew)).player == 1
    ended = next(e for e in events if isinstance(e, AuctionEnded))
    assert (ended.winner, ended.price) == (0, 1)
    assert new_state.properties[ST_JAMES].owner == 0
    paid = next(e for e in events if isinstance(e, CashChanged))
    assert (paid.delta, paid.reason) == (-1, CashReason.AUCTION_WIN)
    acquired = next(e for e in events if isinstance(e, PropertyAcquired))
    assert acquired.via == "auction"
    assert new_state.interrupts == ()
    assert new_state.phase is Phase.AWAITING_END_TURN


def test_everyone_withdrawing_leaves_the_tile_with_the_bank() -> None:
    state = _decision_state()
    state, _ = apply(state, DeclinePurchase(player=0))
    state, _ = apply(state, WithdrawFromAuction(player=0))
    new_state, events = apply(state, WithdrawFromAuction(player=1))
    ended = next(e for e in events if isinstance(e, AuctionEnded))
    assert ended.winner is None
    assert new_state.properties[ST_JAMES].owner is None
    assert new_state.phase is Phase.AWAITING_END_TURN
    assert not [e for e in events if isinstance(e, CashChanged)]


def test_a_bid_beyond_the_bidders_cash_is_never_legal() -> None:
    state = _decision_state()
    state, _ = apply(state, DeclinePurchase(player=0))
    with pytest.raises(IllegalCommandError) as excinfo:
        _bid(state, 0, 5000)
    assert excinfo.value.reason_key == "error.insufficient_funds"
