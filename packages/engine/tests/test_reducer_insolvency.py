"""MON-207 — insolvency, bankruptcy and the chains it sets off.

The rules pinned here are the ones the printed rulebook leaves to a house convention and
GAP §7 gave an owner: a multi-creditor debt settles in turn order from the debtor and, on
bankruptcy, divides the estate **proportionally to claim** (G-7); the receiver of a
mortgaged property pays the official 10% at transfer, which can open a nested debt and so
bankrupt the *creditor* (G-13, owner decision 2); bankruptcy to the bank liquidates the
whole estate through a queued multi-lot auction, and endgame is only allowed to look once
that queue has drained (G-8).
"""

from __future__ import annotations

from collections import Counter

import pytest

from helpers import make_player, make_state
from kesef_engine.commands import (
    BuildHouse,
    Command,
    DeclareBankruptcy,
    EndTurn,
    MortgageProperty,
    RollDice,
    SellHouse,
    TradeOffer,
    TradeSide,
    UnmortgageProperty,
    WithdrawFromAuction,
)
from kesef_engine.decks import GET_OUT_OF_JAIL_IDS
from kesef_engine.errors import IllegalCommandError
from kesef_engine.events import (
    AuctionStarted,
    BuildingChanged,
    CashChanged,
    DebtIncurred,
    DebtSettled,
    Event,
    GameEnded,
    PlayerBankrupted,
    TradeCancelled,
    TurnStarted,
)
from kesef_engine.legality import is_legal, legal_commands
from kesef_engine.phases import Phase
from kesef_engine.primitives import AuctionReason, CashReason, Deck, TileLot
from kesef_engine.reducer import apply
from kesef_engine.rules.insolvency import mortgage_transfer_fee
from kesef_engine.state import (
    AuctionFrame,
    DebtFrame,
    GameState,
    Obligation,
    PlayerState,
    PropertyState,
    TradeFrame,
)

JAIL_CARD_IDS = frozenset(GET_OUT_OF_JAIL_IDS.values())


def _indebted_state(
    *,
    cash: int = 10,
    amount: int = 100,
    creditor: int | str = 1,
    obligations: tuple[Obligation, ...] | None = None,
    properties: dict[int, PropertyState] | None = None,
    seats: tuple[PlayerState, ...] | None = None,
    interrupts_below: tuple[TradeFrame, ...] = (),
) -> GameState:
    frame = DebtFrame(
        resume=Phase.TRADE_REVIEW if interrupts_below else Phase.AWAITING_END_TURN,
        debtor=0,
        obligations=obligations or (Obligation(creditor=creditor, amount=amount),),
        reason=CashReason.RENT,
        source_tile=1,
    )
    if seats is None:
        seats = (make_player(0, cash=cash), make_player(1))
    return make_state(
        seats=seats,
        properties=properties,
        phase=Phase.DEBT_SETTLEMENT,
        interrupts=(*interrupts_below, frame),
        current=0,
    )


def _jail_card_census(state: GameState) -> Counter[str]:
    """Every get-out-of-jail card in the game, wherever it is sitting."""
    census: Counter[str] = Counter()
    for player in state.players:
        for deck in player.jail_cards:
            census[GET_OUT_OF_JAIL_IDS[deck]] += 1
    for card_id in (*state.chance_deck, *state.community_chest_deck):
        if card_id in JAIL_CARD_IDS:
            census[card_id] += 1
    return census


def _assert_ledger_reconciles(before: GameState, after: GameState, events: tuple[Event, ...]) -> None:
    """The ledger is the whole truth about money: every balance non-negative, every
    player's closing cash exactly their opening cash plus their ``CashChanged`` deltas,
    and every player-to-player movement present as a matched pair."""
    deltas: Counter[int] = Counter()
    pairs: Counter[tuple[int, int, int]] = Counter()
    for event in events:
        if not isinstance(event, CashChanged):
            continue
        assert event.balance >= 0, "cash never goes negative — the shortfall lives in the frame"
        deltas[event.player] += event.delta
        if isinstance(event.counterparty, int):
            payer, payee = (event.player, event.counterparty) if event.delta < 0 else (event.counterparty, event.player)
            pairs[(payer, payee, abs(event.delta))] += 1
    for player in after.players:
        opening = before.player(player.id).cash
        assert player.cash == opening + deltas[player.id], f"player {player.id} moved money outside the ledger"
    for key, count in pairs.items():
        assert count == 2, f"unpaired player-to-player movement {key}"


# --- Automatic settlement ---------------------------------------------------


def test_raising_enough_cash_settles_the_debt_automatically() -> None:
    state = _indebted_state(cash=80, amount=100, properties={1: PropertyState(owner=0), 3: PropertyState(owner=0)})
    new_state, events = apply(state, MortgageProperty(player=0, tile=1))  # +30 -> 110 >= 100
    assert new_state.phase is Phase.AWAITING_END_TURN
    assert new_state.interrupts == ()
    assert new_state.player(0).cash == 10
    assert new_state.player(1).cash == 1600
    settled = next(e for e in events if isinstance(e, DebtSettled))
    assert (settled.debtor, settled.creditor, settled.amount) == (0, 1, 100)
    rent_moves = [e for e in events if isinstance(e, CashChanged) and e.reason is CashReason.RENT]
    assert [(e.player, e.delta, e.counterparty) for e in rent_moves] == [(0, -100, 1), (1, 100, 0)]


def test_raising_too_little_leaves_the_debt_open() -> None:
    state = _indebted_state(cash=10, amount=100, properties={1: PropertyState(owner=0), 3: PropertyState(owner=0)})
    new_state, _ = apply(state, MortgageProperty(player=0, tile=1))  # +30 -> 40 < 100
    assert new_state.phase is Phase.DEBT_SETTLEMENT
    assert isinstance(new_state.top_interrupt, DebtFrame)


def test_multi_creditor_obligations_settle_in_turn_order_from_the_debtor() -> None:
    """G-7: "pay each player" is one debt with N creditors, paid clockwise from the
    debtor — not in whatever order the frame happened to record them."""
    seats = (make_player(0), make_player(1, cash=120), make_player(2), make_player(3))
    frame = DebtFrame(
        resume=Phase.AWAITING_END_TURN,
        debtor=1,
        obligations=(
            Obligation(creditor=3, amount=50),
            Obligation(creditor=0, amount=50),
            Obligation(creditor=2, amount=50),
        ),
        reason=CashReason.CARD,
    )
    state = make_state(
        seats=seats,
        properties={1: PropertyState(owner=1)},
        phase=Phase.DEBT_SETTLEMENT,
        interrupts=(frame,),
        current=1,
    )
    new_state, events = apply(state, MortgageProperty(player=1, tile=1))  # +30 -> 150 == total
    assert new_state.interrupts == ()
    assert [e.creditor for e in events if isinstance(e, DebtSettled)] == [2, 3, 0]
    assert new_state.player(1).cash == 0


def test_a_settled_jail_fine_opens_the_cell_even_with_no_roll_on_record() -> None:
    """Found by the ADR-005 soundness property while MON-207 was being written: nothing
    ties a JAIL_FINE debt to a jail roll, so a loaded position can settle one with no dice.
    ``apply`` used to assert and die on that valid state; the fine is paid, so the cell
    opens — there is simply no total to walk."""
    seats = (make_player(0, cash=30, in_jail=True, jail_turns=3), make_player(1))
    frame = DebtFrame(
        resume=Phase.AWAITING_END_TURN,
        debtor=0,
        obligations=(Obligation(creditor="bank", amount=50),),
        reason=CashReason.JAIL_FINE,
    )
    state = make_state(
        seats=seats,
        properties={1: PropertyState(owner=0)},
        phase=Phase.DEBT_SETTLEMENT,
        interrupts=(frame,),
        current=0,
    )
    assert state.dice is None
    new_state, _ = apply(state, MortgageProperty(player=0, tile=1))  # +30 -> 60 >= 50
    assert new_state.interrupts == ()
    assert not new_state.player(0).in_jail
    assert new_state.player(0).position == 0, "no roll on record, so nothing to walk"


# --- Bankruptcy to a player -------------------------------------------------


def test_bankruptcy_to_a_player_transfers_the_whole_estate() -> None:
    seats = (make_player(0, cash=60, jail_cards=(Deck.CHANCE,)), make_player(1), make_player(2))
    props = {1: PropertyState(owner=0, houses=1), 3: PropertyState(owner=0), 5: PropertyState(owner=0, mortgaged=True)}
    state = _indebted_state(amount=500, seats=seats, properties=props)
    new_state, events = apply(state, DeclareBankruptcy(player=0))
    # The house liquidates for 25 to the estate; estate cash 60+25=85 goes to the creditor.
    bankrupted = next(e for e in events if isinstance(e, PlayerBankrupted))
    assert bankrupted.creditor == 1
    assert bankrupted.cash_transferred == 85
    assert set(bankrupted.tiles_transferred) == {1, 3, 5}
    assert bankrupted.jail_cards_transferred == (Deck.CHANCE,)
    # Updated at MON-207 (reason: owner decision 2 now charges the official 10% at
    # transfer, so tile 5's mortgage costs the receiver 10 of the 1585 they took on).
    assert new_state.player(1).cash == 1575
    assert all(new_state.properties[tile].owner == 1 for tile in (1, 3, 5))
    assert new_state.properties[1].houses == 0, "buildings liquidate to the bank first"
    assert new_state.properties[5].mortgaged, "a mortgaged tile transfers with its obligation"
    assert new_state.player(1).jail_cards == (Deck.CHANCE,)
    loser = new_state.player(0)
    assert loser.bankrupt and loser.cash == 0 and loser.jail_cards == ()
    assert new_state.elimination_order == (0,)
    assert bankrupted.shares == (), "a single creditor took the estate whole"


def test_the_receiver_of_a_mortgaged_tile_pays_the_official_ten_percent_at_transfer() -> None:
    """Owner decision 2 / G-13: 10% of the mortgage value, per tile, rounded up."""
    seats = (make_player(0, cash=0), make_player(1), make_player(2))
    props = {37: PropertyState(owner=0, mortgaged=True), 39: PropertyState(owner=0, mortgaged=True)}
    state = _indebted_state(amount=500, seats=seats, properties=props)
    new_state, events = apply(state, DeclareBankruptcy(player=0))
    fee = [e for e in events if isinstance(e, CashChanged) and e.reason is CashReason.MORTGAGE_TRANSFER_FEE]
    assert [(e.player, e.delta, e.counterparty) for e in fee] == [(1, -38, "bank")]  # 18 (175) + 20 (200)
    assert new_state.player(1).cash == 1462
    assert new_state.properties[37].mortgaged and new_state.properties[39].mortgaged
    assert new_state.interrupts == (), "the receiver could afford the fee, so no debt opened"


def test_the_transfer_fee_the_receiver_cannot_pay_opens_a_debt_on_the_creditor() -> None:
    seats = (make_player(0, cash=0), make_player(1, cash=10), make_player(2), make_player(3))
    props = {37: PropertyState(owner=0, mortgaged=True), 39: PropertyState(owner=0, mortgaged=True)}
    state = _indebted_state(amount=500, seats=seats, properties=props)
    new_state, events = apply(state, DeclareBankruptcy(player=0))
    frame = new_state.top_interrupt
    assert new_state.phase is Phase.DEBT_SETTLEMENT
    assert isinstance(frame, DebtFrame)
    assert (frame.debtor, frame.reason, frame.total) == (1, CashReason.MORTGAGE_TRANSFER_FEE, 38)
    assert frame.creditors == ("bank",)
    assert new_state.player(1).cash == 10, "cash never goes negative — the shortfall is in the frame"
    incurred = [e for e in events if isinstance(e, DebtIncurred)]
    assert [(e.debtor, e.creditor, e.amount) for e in incurred] == [(1, "bank", 38)]


def test_a_depth_two_cascade_carries_the_estate_on_to_the_bank() -> None:
    """The transfer itself bankrupts the recipient: A -> B on the fee, then B -> bank.
    Depth 2 has to work, and the chain has to stop."""
    seats = (make_player(0, cash=0), make_player(1, cash=10), make_player(2), make_player(3))
    props = {37: PropertyState(owner=0, mortgaged=True), 39: PropertyState(owner=0, mortgaged=True)}
    state = _indebted_state(amount=500, seats=seats, properties=props)
    after_first, _ = apply(state, DeclareBankruptcy(player=0))
    new_state, events = apply(after_first, DeclareBankruptcy(player=1))

    assert new_state.elimination_order == (0, 1)
    assert new_state.player(1).bankrupt
    frame = new_state.top_interrupt
    assert new_state.phase is Phase.AUCTION
    assert isinstance(frame, AuctionFrame)
    assert frame.reason is AuctionReason.BANKRUPTCY_TO_BANK
    assert frame.lot == TileLot(tile=37), "lots are offered in board order"
    assert frame.queue == (TileLot(tile=39),)
    assert frame.eligible == (2, 3), "clockwise from the seat to the debtor's left, debtor excluded"
    assert all(new_state.properties[tile].owner is None for tile in (37, 39))
    assert not any(new_state.properties[tile].mortgaged for tile in (37, 39))
    bankrupted = next(e for e in events if isinstance(e, PlayerBankrupted))
    assert bankrupted.creditor == "bank"
    assert bankrupted.tiles_transferred == (37, 39)


def test_money_is_conserved_through_a_whole_cascade() -> None:
    """Building refunds in, a transfer across the table, a fee out to the bank, then the
    same estate again — the ledger has to reconcile at every step of the chain."""
    seats = (
        make_player(0, cash=0, jail_cards=(Deck.CHANCE,)),
        make_player(1, cash=0),
        make_player(2),
        make_player(3),
    )
    props: dict[int, PropertyState] = {index: PropertyState(owner=0, houses=1) for index in (6, 8, 9)}
    props |= {index: PropertyState(owner=0, mortgaged=True) for index in (5, 15, 25, 35, 37, 39)}
    state = _indebted_state(amount=900, seats=seats, properties=props)

    after_first, first_events = apply(state, DeclareBankruptcy(player=0))
    _assert_ledger_reconciles(state, after_first, first_events)
    # 3 x 25 of building refund is the whole estate's cash; the fees are 4 x 10 + 18 + 20.
    assert after_first.player(1).cash == 75
    frame = after_first.top_interrupt
    assert isinstance(frame, DebtFrame) and (frame.debtor, frame.total) == (1, 78)

    new_state, second_events = apply(after_first, DeclareBankruptcy(player=1))
    _assert_ledger_reconciles(after_first, new_state, second_events)
    assert new_state.elimination_order == (0, 1)
    assert new_state.phase is Phase.AUCTION
    assert _jail_card_census(new_state) == _jail_card_census(state)


def test_buildings_return_to_the_banks_stock_on_bankruptcy() -> None:
    """Half price back, and — the part a refund alone would not prove — the buildings
    themselves rejoin the bank's finite stock."""
    seats = (make_player(0, cash=0), make_player(1), make_player(2))
    props = {index: PropertyState(owner=0, houses=5) for index in (6, 8, 9)}
    state = _indebted_state(amount=5000, seats=seats, properties=props)
    assert state.hotels_remaining == 9 and state.houses_remaining == 32
    new_state, events = apply(state, DeclareBankruptcy(player=0))
    assert new_state.hotels_remaining == state.ruleset.hotels_available
    assert new_state.houses_remaining == state.ruleset.houses_available
    assert new_state.houses_on_board == 0 and new_state.hotels_on_board == 0
    demolitions = [e for e in events if isinstance(e, BuildingChanged)]
    assert [(e.tile, e.houses, e.delta) for e in demolitions] == [(6, 0, -5), (8, 0, -5), (9, 0, -5)]
    # 5 * 50 // 2 = 125 per hotel; the whole refund joins the estate and moves on.
    assert new_state.player(1).cash == 1500 + 375


def test_jail_cards_are_conserved_through_a_bankruptcy_to_a_player() -> None:
    seats = (
        make_player(0, cash=0, jail_cards=(Deck.CHANCE, Deck.COMMUNITY_CHEST)),
        make_player(1),
        make_player(2),
    )
    state = _indebted_state(amount=500, seats=seats)
    before = _jail_card_census(state)
    new_state, events = apply(state, DeclareBankruptcy(player=0))
    assert _jail_card_census(new_state) == before
    assert set(new_state.player(1).jail_cards) == {Deck.CHANCE, Deck.COMMUNITY_CHEST}
    bankrupted = next(e for e in events if isinstance(e, PlayerBankrupted))
    assert set(bankrupted.jail_cards_transferred) == {Deck.CHANCE, Deck.COMMUNITY_CHEST}


# --- Multi-creditor division ------------------------------------------------


def test_a_multi_creditor_estate_divides_proportionally_to_claim() -> None:
    """G-7. Cash divides exactly — 101 against claims of 300 and 100 is 76 / 25, the
    rounding unit going to the larger claim. Tiles, which cannot be cut in half, go to
    whichever creditor is furthest below their proportional entitlement."""
    seats = (make_player(0, cash=101), make_player(1), make_player(2))
    props = {index: PropertyState(owner=0) for index in (1, 3, 6, 8)}
    obligations = (Obligation(creditor=1, amount=300), Obligation(creditor=2, amount=100))
    state = _indebted_state(obligations=obligations, seats=seats, properties=props)
    new_state, events = apply(state, DeclareBankruptcy(player=0))

    assert new_state.player(1).cash == 1576
    assert new_state.player(2).cash == 1525
    assert new_state.tiles_owned_by(1) == (1, 3, 6)  # 220 of 320 against an entitlement of 240
    assert new_state.tiles_owned_by(2) == (8,)  # 100 against an entitlement of 80
    bankrupted = next(e for e in events if isinstance(e, PlayerBankrupted))
    assert bankrupted.creditor == 1, "the principal creditor is the largest claim"
    assert [(s.creditor, s.claim, s.cash, s.tiles) for s in bankrupted.shares] == [
        (1, 300, 76, (1, 3, 6)),
        (2, 100, 25, (8,)),
    ]
    _assert_ledger_reconciles(state, new_state, events)


def test_a_bank_claim_beside_a_players_takes_its_share_in_cash_only() -> None:
    """The bank has no use for a deed except to re-sell it, so when a player creditor is
    standing there the property is already back in play: the bank's proportional share
    comes out of the cash, and no estate auction opens. That also keeps a bank auction and
    a player transfer mutually exclusive, which is what stops a transfer fee from ever
    opening a debt on a bidder in a live auction."""
    seats = (make_player(0, cash=100), make_player(1), make_player(2))
    props = {index: PropertyState(owner=0) for index in (1, 3)}
    obligations = (Obligation(creditor=1, amount=100), Obligation(creditor="bank", amount=100))
    state = _indebted_state(obligations=obligations, seats=seats, properties=props)
    new_state, events = apply(state, DeclareBankruptcy(player=0))

    assert new_state.player(1).cash == 1550, "half the cash estate, proportional to claim"
    assert new_state.tiles_owned_by(1) == (1, 3)
    assert not any(isinstance(e, AuctionStarted) for e in events)
    bankrupted = next(e for e in events if isinstance(e, PlayerBankrupted))
    assert [(s.creditor, s.cash, s.tiles) for s in bankrupted.shares] == [(1, 50, (1, 3)), ("bank", 50, ())]
    _assert_ledger_reconciles(state, new_state, events)


# --- Bankruptcy to the bank -------------------------------------------------


def test_bankruptcy_to_the_bank_queues_a_multi_lot_auction_in_board_order() -> None:
    seats = (make_player(0, cash=60, jail_cards=(Deck.COMMUNITY_CHEST,)), make_player(1), make_player(2))
    props = {5: PropertyState(owner=0, mortgaged=True), 1: PropertyState(owner=0), 39: PropertyState(owner=0)}
    state = _indebted_state(amount=500, creditor="bank", seats=seats, properties=props)
    before_cards = _jail_card_census(state)
    new_state, events = apply(state, DeclareBankruptcy(player=0))

    frame = new_state.top_interrupt
    assert new_state.phase is Phase.AUCTION
    assert isinstance(frame, AuctionFrame)
    assert frame.reason is AuctionReason.BANKRUPTCY_TO_BANK
    assert frame.lot == TileLot(tile=1)
    assert frame.queue == (TileLot(tile=5), TileLot(tile=39))
    assert frame.eligible == (1, 2)
    assert all(new_state.properties[tile].owner is None for tile in (1, 5, 39))
    assert not new_state.properties[5].mortgaged
    started = next(e for e in events if isinstance(e, AuctionStarted))
    assert started.reason is AuctionReason.BANKRUPTCY_TO_BANK and started.eligible == (1, 2)
    # Jail cards go to the bottom of *their own* deck (G-11), and none is lost on the way.
    assert new_state.community_chest_deck[-1] == "card.community_chest.get_out_of_jail_free"
    assert _jail_card_census(new_state) == before_cards
    bankrupted = next(e for e in events if isinstance(e, PlayerBankrupted))
    assert bankrupted.creditor == "bank"
    assert bankrupted.cash_transferred == 60


def test_draining_the_estate_auction_hands_the_turn_on() -> None:
    """G-8's ordering, from the other side: the seat cannot move on, and no winner can
    be declared, until the estate's last lot has left the stack."""
    seats = (make_player(0, cash=0), make_player(1), make_player(2))
    state = _indebted_state(amount=500, creditor="bank", seats=seats, properties={1: PropertyState(owner=0)})
    mid, _ = apply(state, DeclareBankruptcy(player=0))
    assert mid.current_player_id == 0 and mid.player(0).bankrupt, "the seat waits for the auction"

    mid, _ = apply(mid, WithdrawFromAuction(player=1))
    final, events = apply(mid, WithdrawFromAuction(player=2))
    assert final.interrupts == ()
    assert final.phase is Phase.AWAITING_ROLL
    assert final.current_player_id == 1
    assert [e.player for e in events if isinstance(e, TurnStarted)] == [1]
    assert final.properties[1].owner is None, "nobody bid, so the lot stayed with the bank"


def test_a_two_player_estate_auction_voids_its_lots_and_the_game_ends() -> None:
    """G-8: the survivor cannot bid against themselves, so the lot is voided rather than
    leaving a live auction no command can finish."""
    state = _indebted_state(cash=0, amount=500, creditor="bank", properties={1: PropertyState(owner=0)})
    new_state, events = apply(state, DeclareBankruptcy(player=0))
    assert new_state.interrupts == ()
    assert new_state.phase is Phase.GAME_OVER
    assert new_state.winner == 1
    assert new_state.properties[1].owner is None
    assert [e.lot for e in events if isinstance(e, AuctionStarted)] == [TileLot(tile=1)]


# --- Pending trades ---------------------------------------------------------


def test_a_pending_trade_involving_the_bankrupt_is_voided_by_the_system() -> None:
    offer = TradeOffer(proposer=0, recipient=1, give=TradeSide(tiles=(1,)), receive=TradeSide(cash=50))
    trade = TradeFrame(resume=Phase.AWAITING_END_TURN, offer=offer)
    seats = (make_player(0, cash=0), make_player(1), make_player(2))
    state = _indebted_state(amount=500, seats=seats, properties={1: PropertyState(owner=0)}, interrupts_below=(trade,))
    new_state, events = apply(state, DeclareBankruptcy(player=0))
    cancelled = next(e for e in events if isinstance(e, TradeCancelled))
    assert cancelled.by == "system"
    assert cancelled.offer == offer
    assert new_state.interrupts == ()
    assert new_state.phase is Phase.AWAITING_ROLL and new_state.current_player_id == 1
    assert new_state.properties[1].owner == 1, "the tile went to the creditor, not the trade"


# --- Concession -------------------------------------------------------------


def test_the_debtor_may_concede_while_the_estate_could_still_raise_the_debt() -> None:
    """The documented "raise cash *or* declare bankruptcy" model: conceding is a move,
    not a last resort the engine forces."""
    seats = (make_player(0, cash=10), make_player(1), make_player(2))
    props = {6: PropertyState(owner=0), 8: PropertyState(owner=0)}  # 100 of mortgage value
    state = _indebted_state(amount=100, seats=seats, properties=props)
    assert is_legal(state, DeclareBankruptcy(player=0)).legal
    new_state, _ = apply(state, DeclareBankruptcy(player=0))
    assert new_state.player(0).bankrupt


# --- legal_commands / apply agreement --------------------------------------


def test_legal_commands_and_apply_agree_in_debt_settlement() -> None:
    """ADR-005 in the phase where the offered set is narrowest: the RAISING kinds for the
    debtor alone, plus the concession. Build and unmortgage are refused even when
    affordable — a player who owes money may not tie more of it up (G-5)."""
    seats = (make_player(0, cash=60), make_player(1), make_player(2))
    props = {index: PropertyState(owner=0, houses=1) for index in (6, 8, 9)}
    props[1] = PropertyState(owner=0)
    props[3] = PropertyState(owner=1)
    props[5] = PropertyState(owner=0, mortgaged=True)
    state = _indebted_state(cash=60, amount=200, seats=seats, properties=props)

    offered = legal_commands(state)
    assert DeclareBankruptcy(player=0) in offered
    assert all(command.player == 0 for command in offered), "only the debtor may act"
    for command in offered:
        apply(state, command)  # a raise here is the soundness half failing

    refused: tuple[Command, ...] = (
        BuildHouse(player=0, tile=6),
        UnmortgageProperty(player=0, tile=5),
        MortgageProperty(player=0, tile=6),
        SellHouse(player=1, tile=3),
        DeclareBankruptcy(player=1),
        RollDice(player=0),
        EndTurn(player=0),
    )
    for command in refused:
        assert command not in offered
        verdict = is_legal(state, command)
        assert not verdict.legal and verdict.reason_key
        with pytest.raises(IllegalCommandError):
            apply(state, command)


# --- Endgame hand-off (MON-208 owns the evaluation) ------------------------


def test_the_last_solvent_player_wins() -> None:
    state = _indebted_state(cash=60, amount=500, properties={1: PropertyState(owner=0)})
    new_state, events = apply(state, DeclareBankruptcy(player=0))
    assert new_state.phase is Phase.GAME_OVER
    assert new_state.winner == 1
    ended = next(e for e in events if isinstance(e, GameEnded))
    assert ended.winner == 1
    assert ended.reason == "last_solvent"
    assert [(s.player, s.rank) for s in ended.final_standings] == [(1, 1), (0, 2)]
    assert ended.final_standings[1].net_worth == 0


def test_bankruptcy_of_the_current_player_advances_the_turn_when_others_remain() -> None:
    seats = (make_player(0, cash=10), make_player(1), make_player(2))
    state = _indebted_state(amount=500, seats=seats)
    new_state, events = apply(state, DeclareBankruptcy(player=0))
    assert new_state.phase is Phase.AWAITING_ROLL
    assert new_state.current_player_id == 1
    assert [e for e in events if isinstance(e, TurnStarted)]


def test_money_is_conserved_through_a_bankruptcy() -> None:
    seats = (make_player(0, cash=60), make_player(1), make_player(2))
    props = {1: PropertyState(owner=0, houses=2), 3: PropertyState(owner=0, houses=2)}
    state = _indebted_state(amount=500, seats=seats, properties=props)
    new_state, events = apply(state, DeclareBankruptcy(player=0))
    for event in events:
        if isinstance(event, CashChanged):
            assert event.balance >= 0
    total_before = sum(p.cash for p in state.players)
    total_after = sum(p.cash for p in new_state.players)
    liquidation = sum(e.delta for e in events if isinstance(e, CashChanged) and e.reason is CashReason.SELL_BUILDING)
    assert total_after == total_before + liquidation, "only the bank's building refund entered the table"


# --- The fee helper MON-204 shares -----------------------------------------


def test_the_mortgage_transfer_fee_is_a_tenth_of_the_mortgage_rounded_up() -> None:
    board = make_state().board
    assert mortgage_transfer_fee(board.tile(39)) == 20  # mortgage 200
    assert mortgage_transfer_fee(board.tile(37)) == 18  # mortgage 175 -> 17.5, rounded up
    assert mortgage_transfer_fee(board.tile(1)) == 3  # mortgage 30
