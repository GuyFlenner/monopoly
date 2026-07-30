"""Round-trips.

The engine's save/load story, its wire format and its golden-game format are all the same
thing: pydantic serialization. So the union members are tested exhaustively rather than by
sample, and the completeness tests fail when someone adds a member without a sample.
"""

from __future__ import annotations

from types import UnionType
from typing import Annotated, Any, get_args, get_origin

import pytest
from pydantic import BaseModel, TypeAdapter, ValidationError

from helpers import make_maximal_state, make_state
from kesef_engine.board.models import ColorGroup
from kesef_engine.commands import (
    BuildHouse,
    BuyProperty,
    CancelTrade,
    Command,
    DeclareBankruptcy,
    DeclinePurchase,
    EndTurn,
    MortgageProperty,
    PayJailFine,
    PlaceBid,
    ProposeTrade,
    RespondToTrade,
    RollDice,
    RollForJail,
    SellHouse,
    TradeOffer,
    TradeSide,
    UnmortgageProperty,
    UseJailCard,
    WithdrawFromAuction,
)
from kesef_engine.events import (
    AuctionEnded,
    AuctionStarted,
    BidderWithdrew,
    BidPlaced,
    BuildingChanged,
    CardDrawn,
    CashChanged,
    DebtIncurred,
    DebtSettled,
    DiceRolled,
    Event,
    GameEnded,
    LeftJail,
    MortgageChanged,
    PhaseChanged,
    PlayerBankrupted,
    PlayerStanding,
    PropertyAcquired,
    RentCharged,
    SentToJail,
    TokenMoved,
    TradeCancelled,
    TradeDeclined,
    TradeExecuted,
    TradeProposed,
    TurnStarted,
)
from kesef_engine.phases import Phase
from kesef_engine.primitives import AuctionReason, CashReason, Deck, TileLot
from kesef_engine.state import GameState

_OFFER = TradeOffer(proposer=0, recipient=1, give=TradeSide(cash=50, tiles=(1,)), receive=TradeSide(tiles=(3,)))

COMMAND_SAMPLES: tuple[Command, ...] = (
    RollDice(player=0),
    EndTurn(player=0),
    EndTurn(player=0, elapsed_seconds=42),
    BuyProperty(player=0),
    DeclinePurchase(player=0),
    PlaceBid(player=1, amount=120),
    WithdrawFromAuction(player=1),
    BuildHouse(player=0, tile=1),
    SellHouse(player=0, tile=1),
    MortgageProperty(player=0, tile=3),
    UnmortgageProperty(player=0, tile=3),
    ProposeTrade(player=0, offer=_OFFER),
    RespondToTrade(player=1, accept=True),
    CancelTrade(player=0),
    PayJailFine(player=0),
    UseJailCard(player=0),
    RollForJail(player=0),
    DeclareBankruptcy(player=0),
)

EVENT_SAMPLES: tuple[Event, ...] = (
    TurnStarted(player=0, turn_number=3),
    DiceRolled(player=0, first=4, second=4, total=8, doubles_streak=1, purpose="move"),
    TokenMoved(player=0, from_tile=38, to_tile=2, forward=True, passed_go=True),
    CashChanged(player=0, delta=-150, reason=CashReason.RENT, balance=350, counterparty=1),
    CashChanged(player=0, delta=200, reason=CashReason.GO_SALARY, balance=550, counterparty="bank"),
    CashChanged(
        player=0,
        delta=-100,
        reason=CashReason.FREE_PARKING_POT,
        balance=450,
        counterparty="free_parking_pot",
    ),
    RentCharged(
        payer=0,
        owner=1,
        tile=39,
        amount=100,
        base_rent=50,
        houses=0,
        multiplier=2,
        dice_total=None,
        group=ColorGroup.DARK_BLUE,
        note_keys=("rent.note.full_group_doubled",),
        note_params={"base": 50, "group_key": "group.dark_blue"},
    ),
    PropertyAcquired(player=0, tile=1, price=60, via="purchase"),
    AuctionStarted(lot=TileLot(tile=1), reason=AuctionReason.DECLINED_PURCHASE, eligible=(0, 1)),
    BidPlaced(player=1, amount=70),
    BidderWithdrew(player=0),
    AuctionEnded(lot=TileLot(tile=1), winner=1, price=70),
    CardDrawn(player=0, deck=Deck.CHANCE, card_id="card.chance.advance_to_go"),
    SentToJail(player=0, via="three_doubles"),
    LeftJail(player=0, via="card"),
    BuildingChanged(tile=1, houses=2, delta=1, level="house"),
    BuildingChanged(tile=1, houses=5, delta=1, level="hotel"),
    MortgageChanged(player=0, tile=1, mortgaged=True),
    TradeProposed(offer=_OFFER),
    TradeExecuted(offer=_OFFER),
    TradeDeclined(offer=_OFFER),
    TradeCancelled(offer=_OFFER, by="system"),
    DebtIncurred(debtor=0, creditor="bank", amount=200),
    DebtSettled(debtor=0, creditor=1, amount=200),
    PlayerBankrupted(
        player=0,
        creditor=1,
        tiles_transferred=(1, 3),
        cash_transferred=17,
        jail_cards_transferred=(Deck.CHANCE,),
    ),
    PhaseChanged(previous=Phase.AWAITING_ROLL, current=Phase.MOVING),
    GameEnded(
        winner=1,
        reason="last_solvent",
        final_standings=(
            PlayerStanding(player=1, net_worth=4200, rank=1),
            PlayerStanding(player=0, net_worth=0, rank=2),
        ),
    ),
)

_COMMAND_ADAPTER = TypeAdapter[Command](Command)
_EVENT_ADAPTER = TypeAdapter[Event](Event)


def _union_members(annotated: Any) -> set[type[BaseModel]]:
    """The concrete models inside ``Annotated[A | B | ..., Field(discriminator=...)]``."""
    assert get_origin(annotated) is Annotated
    union = get_args(annotated)[0]
    assert isinstance(union, UnionType)
    return set(get_args(union))


# --- The state --------------------------------------------------------------


def test_a_maximal_state_round_trips_through_json() -> None:
    """Every optional field, a four-deep interrupt stack and a rent-purpose dice roll."""
    state = make_maximal_state()
    restored = GameState.model_validate_json(state.model_dump_json())
    assert restored == state
    assert restored.interrupts == state.interrupts
    assert restored.rng == state.rng


def test_a_maximal_state_round_trips_through_python() -> None:
    state = make_maximal_state()
    assert GameState.model_validate(state.model_dump()) == state


def test_the_maximal_state_really_is_populated() -> None:
    """Guards the round-trip above: an empty maximal state would pass it vacuously."""
    state = make_maximal_state()
    assert len(state.interrupts) == 4
    assert {frame.kind for frame in state.interrupts} == {"auction", "debt", "trade", "card"}
    assert state.pending_debt is not None
    assert len(state.pending_debt.obligations) == 3
    assert state.auction is not None
    assert state.auction.queue != ()
    assert state.dice is not None and state.dice.purpose == "rent"
    assert state.chance_deck and state.community_chest_deck
    assert state.elimination_order == (7,)
    assert state.free_parking_pot == 150
    assert state.elapsed_seconds == 1234


def test_the_state_is_frozen() -> None:
    # Called through __setattr__ on purpose: mypy knows a frozen model's fields are
    # read-only, so the plain assignment would be a type error rather than a test.
    with pytest.raises(ValidationError):
        make_state().__setattr__("phase", Phase.GAME_OVER)


# --- Commands ---------------------------------------------------------------


def test_every_command_kind_has_a_sample() -> None:
    assert {type(sample) for sample in COMMAND_SAMPLES} == _union_members(Command)


@pytest.mark.parametrize("command", COMMAND_SAMPLES, ids=lambda c: f"{c.kind}")
def test_every_command_round_trips(command: Command) -> None:
    assert _COMMAND_ADAPTER.validate_json(_COMMAND_ADAPTER.dump_json(command)) == command


def test_commands_are_discriminated_by_kind() -> None:
    assert _COMMAND_ADAPTER.validate_python({"kind": "roll_dice", "player": 0}) == RollDice(player=0)
    with pytest.raises(ValidationError):
        _COMMAND_ADAPTER.validate_python({"kind": "steal_the_bank", "player": 0})


def test_end_turn_carries_a_caller_stamped_clock() -> None:
    """G-6: the engine stays clock-free, so the caller supplies the elapsed time."""
    assert EndTurn(player=0).elapsed_seconds is None
    with pytest.raises(ValidationError):
        EndTurn(player=0, elapsed_seconds=-1)


def test_traded_jail_cards_are_deck_identified() -> None:
    """G-11: a count cannot be returned to the bottom of the right deck."""
    side = TradeSide(jail_cards=(Deck.COMMUNITY_CHEST,))
    assert side.jail_cards == (Deck.COMMUNITY_CHEST,)
    with pytest.raises(ValidationError):
        TradeSide(jail_cards=("two",))


# --- Events -----------------------------------------------------------------


def test_every_event_type_has_a_sample() -> None:
    assert {type(sample) for sample in EVENT_SAMPLES} == _union_members(Event)


@pytest.mark.parametrize("event", EVENT_SAMPLES, ids=lambda e: f"{e.type}")
def test_every_event_round_trips(event: Event) -> None:
    assert _EVENT_ADAPTER.validate_json(_EVENT_ADAPTER.dump_json(event)) == event


def test_events_are_discriminated_by_type() -> None:
    with pytest.raises(ValidationError):
        _EVENT_ADAPTER.validate_python({"type": "player_won_the_lottery", "player": 0})


def test_cash_changed_names_the_bank_and_the_pot_explicitly() -> None:
    """G-60: ``None``-as-bank could not distinguish the bank from the Free Parking pot."""
    assert CashChanged(player=0, delta=1, reason=CashReason.CARD, balance=1).counterparty == "bank"
    with pytest.raises(ValidationError):
        CashChanged(player=0, delta=1, reason=CashReason.CARD, balance=1, counterparty="the_mafia")


def test_dice_rolled_carries_a_total_that_cannot_lie() -> None:
    """ADR-008 §3: an event is self-contained, so its derived fields are validated."""
    assert DiceRolled(player=0, first=2, second=5, total=7).purpose == "move"
    with pytest.raises(ValidationError, match="total"):
        DiceRolled(player=0, first=2, second=5, total=8)


def test_rent_charged_explains_itself_without_the_state() -> None:
    """ADR-008 §3: a log line rendered from current state shows turn-20 numbers."""
    event = next(sample for sample in EVENT_SAMPLES if isinstance(sample, RentCharged))
    assert event.base_rent == 50
    assert event.multiplier == 2
    assert event.note_keys == ("rent.note.full_group_doubled",)
    assert event.note_params["base"] == 50
    assert "multiplier_note" not in RentCharged.model_fields


def test_a_game_can_end_without_a_winner() -> None:
    """G-13: the official transfer fee makes a creditor-side cascade reachable."""
    ended = GameEnded(winner=None, reason="no_survivors", final_standings=())
    assert ended.winner is None
    with pytest.raises(ValidationError, match="no_survivors"):
        GameEnded(winner=None, reason="last_solvent", final_standings=())
    with pytest.raises(ValidationError, match="no_survivors"):
        GameEnded(winner=0, reason="no_survivors", final_standings=())


def test_final_standings_replace_the_positional_net_worth_tuple() -> None:
    """GAP §1 minor: a positional tuple could not express who was eliminated when."""
    assert "final_net_worth" not in GameEnded.model_fields
    standing = PlayerStanding(player=0, net_worth=0, rank=2)
    assert standing.rank == 2
    with pytest.raises(ValidationError):
        PlayerStanding(player=0, net_worth=0, rank=0)


def test_debt_incurred_no_longer_carries_a_derivable_shortfall() -> None:
    """G-18: ``amount`` and ``shortfall`` implied two opposite debt models."""
    assert "shortfall" not in DebtIncurred.model_fields


def test_bankruptcy_transfers_cash_and_cards_explicitly() -> None:
    """G-11: who received the jail cards was owned by nobody."""
    event = next(sample for sample in EVENT_SAMPLES if isinstance(sample, PlayerBankrupted))
    assert event.cash_transferred == 17
    assert event.jail_cards_transferred == (Deck.CHANCE,)


def test_an_auction_event_carries_the_lot_not_a_tile_index() -> None:
    """G-3: a building-shortage auction has no tile to name."""
    assert "tile" not in AuctionStarted.model_fields
    assert "tile" not in AuctionEnded.model_fields
