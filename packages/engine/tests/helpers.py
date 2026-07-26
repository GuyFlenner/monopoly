"""Test factories.

A plain module rather than a conftest: pytest puts the test directory on ``sys.path``
(there is no ``__init__.py`` here), so ``from helpers import make_state`` works, and
mypy sees one unambiguous module name instead of two files both called ``tests``.
"""

from __future__ import annotations

from typing import Literal

from kesef_engine.board.models import BOARD_SIZE
from kesef_engine.commands import TradeOffer, TradeSide
from kesef_engine.phases import Phase
from kesef_engine.primitives import (
    AuctionReason,
    BotLevel,
    BuildingLot,
    CashReason,
    Deck,
    TileLot,
)
from kesef_engine.rng import Rng
from kesef_engine.ruleset import Ruleset
from kesef_engine.state import (
    AuctionFrame,
    CardFrame,
    DebtFrame,
    DiceState,
    GameState,
    InterruptFrame,
    Obligation,
    PlayerKind,
    PlayerState,
    PropertyState,
    TradeFrame,
)


def make_player(
    player_id: int,
    name: str = "",
    *,
    cash: int = 1500,
    bot: bool = False,
    gender: Literal["m", "f", "n"] = "n",
    position: int = 0,
    in_jail: bool = False,
    jail_turns: int = 0,
    jail_cards: tuple[Deck, ...] = (),
    bankrupt: bool = False,
) -> PlayerState:
    return PlayerState(
        id=player_id,
        name=name or f"P{player_id}",
        kind=PlayerKind(bot_level=BotLevel.EASY if bot else None),
        token=f"token.{player_id}",
        cash=cash,
        grammatical_gender=gender,
        position=position,
        in_jail=in_jail,
        jail_turns=jail_turns,
        jail_cards=jail_cards,
        bankrupt=bankrupt,
    )


def make_state(
    *,
    board_id: str = "classic",
    players: int = 2,
    ids: tuple[int, ...] | None = None,
    seed: int = 42,
    ruleset: Ruleset | None = None,
    properties: dict[int, PropertyState] | None = None,
    seats: tuple[PlayerState, ...] | None = None,
    phase: Phase = Phase.AWAITING_ROLL,
    interrupts: tuple[InterruptFrame, ...] = (),
    current: int | None = None,
    winner: int | None = None,
) -> GameState:
    """A minimal, valid game state.

    ``properties`` patches individual tiles; ``ids`` supplies non-contiguous player ids,
    which the state model must tolerate (seat order and player identity are separate).
    ``seats`` takes full ``PlayerState`` values when a test needs jail flags, cash or
    positions; ``phase`` + ``interrupts`` must agree (the state validator enforces it).
    """
    if seats is None:
        seat_ids = ids if ids is not None else tuple(range(players))
        seats = tuple(make_player(seat) for seat in seat_ids)
    tiles = [PropertyState() for _ in range(BOARD_SIZE)]
    for index, prop in (properties or {}).items():
        tiles[index] = prop
    return GameState(
        game_id="test",
        board_id=board_id,
        ruleset=ruleset or Ruleset.universal(),
        rng=Rng(seed=seed),
        players=seats,
        properties=tuple(tiles),
        phase=phase,
        interrupts=interrupts,
        current_player_id=current if current is not None else seats[0].id,
        winner=winner,
    )


def maximal_interrupts() -> tuple[InterruptFrame, ...]:
    """A four-deep interrupt stack, bottom first, with every frame kind populated.

    Deliberately *not* a reachable position: its job is to touch every field of every
    frame so the round-trip test cannot pass by accident. ``test_interrupts.py`` covers
    the reachable nesting (card -> debt -> trade) through the push/pop helpers.
    """
    card = CardFrame(
        resume=Phase.RESOLVING_TILE,
        card_id="card.chance.advance_to_boardwalk",
        deck=Deck.CHANCE,
        step=1,
    )
    debt = DebtFrame(
        resume=Phase.CARD_RESOLUTION,
        debtor=0,
        obligations=(
            Obligation(creditor=2, amount=250),
            Obligation(creditor=3, amount=50),
            Obligation(creditor="bank", amount=100),
        ),
        reason=CashReason.RENT,
        source_tile=39,
    )
    trade = TradeFrame(
        resume=Phase.DEBT_SETTLEMENT,
        offer=TradeOffer(
            proposer=0,
            recipient=3,
            give=TradeSide(tiles=(1,)),
            receive=TradeSide(cash=300, jail_cards=(Deck.CHANCE,)),
        ),
    )
    auction = AuctionFrame(
        resume=Phase.TRADE_REVIEW,
        lot=BuildingLot(building="house"),
        reason=AuctionReason.BUILDING_SHORTAGE,
        eligible=(0, 2, 3),
        active=(0, 2),
        turn=2,
        high_bid=75,
        high_bidder=0,
        min_bid=76,
        max_bid=1500,
        queue=(TileLot(tile=8), BuildingLot(building="hotel")),
    )
    return (card, debt, trade, auction)


def make_maximal_state() -> GameState:
    """A state with every optional field populated — the round-trip torture test.

    Four non-contiguous player ids, one bot, one bankrupt seat, a hotel, a mortgage,
    a rent-purpose dice roll, populated decks and a four-deep interrupt stack.
    """
    tiles = [PropertyState() for _ in range(BOARD_SIZE)]
    tiles[1] = PropertyState(owner=0, houses=3)
    tiles[3] = PropertyState(owner=0, houses=2)
    tiles[39] = PropertyState(owner=2, houses=5)
    tiles[37] = PropertyState(owner=2, mortgaged=True)
    tiles[5] = PropertyState(owner=3)
    tiles[12] = PropertyState(owner=3)
    players = (
        # The debtor: cash is zero, never negative — the shortfall lives in the DebtFrame.
        make_player(0, "Ada", cash=0, gender="f", jail_cards=(Deck.COMMUNITY_CHEST,)),
        make_player(2, "Boaz", cash=740, gender="m", in_jail=True, jail_turns=1),
        make_player(3, "Carmel", cash=310, bot=True, jail_cards=(Deck.CHANCE,)),
        make_player(7, "Dana", cash=0, bankrupt=True),
    )
    return GameState(
        schema_version=2,
        game_id="maximal",
        board_id="israel",
        ruleset=Ruleset.universal(),
        locale="he",
        rng=Rng(seed=99, counter=17, stream=3),
        players=players,
        properties=tuple(tiles),
        phase=Phase.AUCTION,
        current_player_id=2,
        dice=DiceState(first=3, second=3, purpose="rent"),
        doubles_streak=2,
        turn_number=17,
        interrupts=maximal_interrupts(),
        chance_deck=("card.chance.advance_to_go", "card.chance.get_out_of_jail_free"),
        community_chest_deck=("card.community_chest.bank_error", "card.community_chest.doctor_fee"),
        free_parking_pot=150,
        elapsed_seconds=1234,
        elimination_order=(7,),
        winner=None,
    )
