"""MON-102/104 (M1 slice of MON-207/208) — debts, bankruptcy, and the winner."""

from __future__ import annotations

from helpers import make_player, make_state
from kesef_engine.commands import DeclareBankruptcy, MortgageProperty
from kesef_engine.events import (
    CashChanged,
    DebtSettled,
    GameEnded,
    PlayerBankrupted,
    TurnStarted,
)
from kesef_engine.phases import Phase
from kesef_engine.primitives import CashReason, Deck
from kesef_engine.state import DebtFrame, GameState, Obligation, PlayerState, PropertyState


def _indebted_state(
    *,
    cash: int = 10,
    amount: int = 100,
    creditor: int | str = 1,
    properties: dict[int, PropertyState] | None = None,
    seats: tuple[PlayerState, ...] | None = None,
) -> GameState:
    frame = DebtFrame(
        resume=Phase.AWAITING_END_TURN,
        debtor=0,
        obligations=(Obligation(creditor=creditor, amount=amount),),
        reason=CashReason.RENT,
        source_tile=1,
    )
    if seats is None:
        seats = (make_player(0, cash=cash), make_player(1))
    return make_state(seats=seats, properties=properties, phase=Phase.DEBT_SETTLEMENT, interrupts=(frame,), current=0)


def test_raising_enough_cash_settles_the_debt_automatically() -> None:
    from kesef_engine.reducer import apply

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
    from kesef_engine.reducer import apply

    state = _indebted_state(cash=10, amount=100, properties={1: PropertyState(owner=0), 3: PropertyState(owner=0)})
    new_state, _ = apply(state, MortgageProperty(player=0, tile=1))  # +30 -> 40 < 100
    assert new_state.phase is Phase.DEBT_SETTLEMENT
    assert isinstance(new_state.top_interrupt, DebtFrame)


def test_bankruptcy_to_a_player_transfers_the_whole_estate() -> None:
    from kesef_engine.reducer import apply

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
    assert new_state.player(1).cash == 1585
    assert all(new_state.properties[tile].owner == 1 for tile in (1, 3, 5))
    assert new_state.properties[1].houses == 0, "buildings liquidate to the bank first"
    assert new_state.properties[5].mortgaged, "a mortgaged tile transfers with its obligation"
    assert new_state.player(1).jail_cards == (Deck.CHANCE,)
    loser = new_state.player(0)
    assert loser.bankrupt and loser.cash == 0 and loser.jail_cards == ()
    assert new_state.elimination_order == (0,)


def test_bankruptcy_to_the_bank_returns_tiles_and_cards() -> None:
    from kesef_engine.reducer import apply

    seats = (make_player(0, cash=60, jail_cards=(Deck.COMMUNITY_CHEST,)), make_player(1), make_player(2))
    props = {1: PropertyState(owner=0), 5: PropertyState(owner=0, mortgaged=True)}
    state = _indebted_state(amount=500, creditor="bank", seats=seats, properties=props)
    new_state, events = apply(state, DeclareBankruptcy(player=0))
    # TODO(MON-207): the bank queues these tiles for auction; M1 returns them unowned.
    assert new_state.properties[1].owner is None
    assert new_state.properties[5].owner is None and not new_state.properties[5].mortgaged
    assert new_state.community_chest_deck[-1] == "card.community_chest.get_out_of_jail_free"
    bankrupted = next(e for e in events if isinstance(e, PlayerBankrupted))
    assert bankrupted.creditor == "bank"


def test_the_last_solvent_player_wins() -> None:
    from kesef_engine.reducer import apply

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
    from kesef_engine.reducer import apply

    seats = (make_player(0, cash=10), make_player(1), make_player(2))
    state = _indebted_state(amount=500, seats=seats)
    new_state, events = apply(state, DeclareBankruptcy(player=0))
    assert new_state.phase is Phase.AWAITING_ROLL
    assert new_state.current_player_id == 1
    assert [e for e in events if isinstance(e, TurnStarted)]


def test_money_is_conserved_through_a_bankruptcy() -> None:
    from kesef_engine.reducer import apply

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
