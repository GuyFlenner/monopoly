"""MON-101 — ``legal_commands`` and ``is_legal``.

Every phase gets a representative state and an **exact** expected command set — set
equality, never subset, because omissions are the bug class ADR-005 exists to catch.
Rejections are pinned to their ``reason_key`` one rule at a time: each test builds a state
in which exactly one rule fails, so a passing suite localises a regression to a rule.

Board facts used throughout (classic): tiles 1 and 3 are the brown group (price 60,
house cost 50, mortgage 30); tiles 6/8/9 are light blue; tile 5 is a railroad
(mortgage 100); tile 0 is GO.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from helpers import make_player, make_state
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
from kesef_engine.legality import LegalityResult, is_legal, legal_commands, unmortgage_cost
from kesef_engine.phases import Phase
from kesef_engine.primitives import AuctionReason, CashReason, Deck, TileLot
from kesef_engine.ruleset import Ruleset, RulesetName
from kesef_engine.state import (
    AuctionFrame,
    CardFrame,
    DebtFrame,
    GameState,
    Obligation,
    PropertyState,
    TradeFrame,
)

BROWN_A = 1
BROWN_B = 3
RAILROAD = 5
LIGHT_BLUE = (6, 8, 9)
PINK = (11, 13, 14)
ORANGE = (16, 18, 19)
JAIL_FINE = Ruleset.universal().jail_fine


def owned(player: int, *, houses: int = 0, mortgaged: bool = False) -> PropertyState:
    return PropertyState(owner=player, houses=houses, mortgaged=mortgaged)


def brown_pair(player: int, houses_a: int, houses_b: int) -> dict[int, PropertyState]:
    return {BROWN_A: owned(player, houses=houses_a), BROWN_B: owned(player, houses=houses_b)}


def auction_state(
    *,
    turn: int | None = 1,
    eligible: tuple[int, ...] = (0, 1),
    active: tuple[int, ...] | None = None,
    high_bid: int = 50,
    high_bidder: int | None = 0,
    min_bid: int = 1,
    max_bid: int | None = None,
    bidder_cash: int = 1500,
    properties: dict[int, PropertyState] | None = None,
) -> GameState:
    seats = (make_player(0), make_player(1, cash=bidder_cash))
    frame = AuctionFrame(
        resume=Phase.AWAITING_END_TURN,
        lot=TileLot(tile=BROWN_A),
        reason=AuctionReason.DECLINED_PURCHASE,
        eligible=eligible,
        active=eligible if active is None else active,
        turn=turn,
        high_bid=high_bid,
        high_bidder=high_bidder,
        min_bid=min_bid,
        max_bid=max_bid,
    )
    return make_state(seats=seats, phase=Phase.AUCTION, interrupts=(frame,), properties=properties)


def debt_state(
    *,
    debtor_cash: int = 0,
    properties: dict[int, PropertyState] | None = None,
    ruleset: Ruleset | None = None,
) -> GameState:
    seats = (make_player(0, cash=debtor_cash), make_player(1))
    frame = DebtFrame(
        resume=Phase.AWAITING_END_TURN,
        debtor=0,
        obligations=(Obligation(creditor=1, amount=100),),
        reason=CashReason.RENT,
        source_tile=BROWN_A,
    )
    return make_state(
        seats=seats, phase=Phase.DEBT_SETTLEMENT, interrupts=(frame,), properties=properties, ruleset=ruleset
    )


def trade_state(offer: TradeOffer | None = None, *, players: int = 2) -> GameState:
    offer = offer or TradeOffer(proposer=0, recipient=1, give=TradeSide(cash=10), receive=TradeSide())
    frame = TradeFrame(resume=Phase.AWAITING_END_TURN, offer=offer)
    return make_state(players=players, phase=Phase.TRADE_REVIEW, interrupts=(frame,))


def jail_state(
    *, cash: int = 1500, jail_cards: tuple[Deck, ...] = (), properties: dict[int, PropertyState] | None = None
) -> GameState:
    seats = (make_player(0, cash=cash, in_jail=True, jail_turns=1, jail_cards=jail_cards), make_player(1))
    return make_state(seats=seats, phase=Phase.JAIL_DECISION, properties=properties)


def purchase_state(
    *, cash: int = 1500, position: int = BROWN_A, properties: dict[int, PropertyState] | None = None
) -> GameState:
    seats = (make_player(0, cash=cash, position=position), make_player(1))
    return make_state(seats=seats, phase=Phase.AWAITING_PURCHASE_DECISION, properties=properties)


def rejected(state: GameState, command: Command) -> str:
    """The reason key for a command that must be illegal — asserting along the way."""
    verdict = is_legal(state, command)
    assert not verdict.legal, f"{command!r} was unexpectedly legal"
    assert verdict.reason_key is not None
    return verdict.reason_key


def approved(state: GameState, command: Command) -> LegalityResult:
    verdict = is_legal(state, command)
    assert verdict.legal, f"{command!r} rejected: {verdict.reason_key}"
    assert verdict.reason_key is None
    return verdict


# --- Per-phase exact command sets --------------------------------------------


def test_awaiting_roll_offers_only_the_roll_when_nobody_owns_anything() -> None:
    assert set(legal_commands(make_state())) == {RollDice(player=0)}


def test_awaiting_roll_opens_every_solvent_players_portfolio() -> None:
    """MON-204 amendment (G-B4b): ANY solvent player manages their estate in a portfolio
    phase — not only the player whose turn it is."""
    state = make_state(properties=brown_pair(1, 0, 0))
    assert set(legal_commands(state)) == {
        RollDice(player=0),
        BuildHouse(player=1, tile=BROWN_A),
        BuildHouse(player=1, tile=BROWN_B),
        MortgageProperty(player=1, tile=BROWN_A),
        MortgageProperty(player=1, tile=BROWN_B),
    }


def test_awaiting_end_turn_offers_end_turn_plus_portfolio() -> None:
    state = make_state(phase=Phase.AWAITING_END_TURN, properties={RAILROAD: owned(0)})
    assert set(legal_commands(state)) == {
        EndTurn(player=0),
        MortgageProperty(player=0, tile=RAILROAD),
    }


def test_jail_decision_offers_all_three_exits_and_the_portfolio() -> None:
    """Trap #8: jail is not a pause — JAIL_DECISION is a portfolio phase."""
    state = jail_state(jail_cards=(Deck.CHANCE,), properties={RAILROAD: owned(1)})
    assert set(legal_commands(state)) == {
        PayJailFine(player=0),
        UseJailCard(player=0),
        RollForJail(player=0),
        MortgageProperty(player=1, tile=RAILROAD),
    }


def test_jail_decision_without_cash_or_card_offers_only_the_roll() -> None:
    state = jail_state(cash=JAIL_FINE - 1)
    assert set(legal_commands(state)) == {RollForJail(player=0)}


def test_purchase_decision_offers_buy_and_decline() -> None:
    assert set(legal_commands(purchase_state())) == {BuyProperty(player=0), DeclinePurchase(player=0)}


def test_purchase_decision_without_funds_offers_only_decline() -> None:
    """MON-103: an unaffordable purchase is not a legal purchase, so it is never offered."""
    state = purchase_state(cash=59)
    assert set(legal_commands(state)) == {DeclinePurchase(player=0)}
    verdict = is_legal(state, BuyProperty(player=0))
    assert verdict.reason_key == "error.insufficient_funds"
    assert verdict.params == {"required": 60, "available": 59}


def test_auction_offers_the_minimum_bid_and_withdrawal_to_the_bidding_turn() -> None:
    state = auction_state()
    assert set(legal_commands(state)) == {
        PlaceBid(player=1, amount=51),
        WithdrawFromAuction(player=1),
    }


def test_auction_offers_no_bid_to_a_broke_bidder() -> None:
    """MON-203: zero-cash players are eligible but may only withdraw."""
    state = auction_state(bidder_cash=50)
    assert set(legal_commands(state)) == {WithdrawFromAuction(player=1)}


def test_auction_lets_the_bidder_raise_cash_but_not_build() -> None:
    """G-B1a: the bidding player may sell or mortgage on their bid turn — RAISING, not
    the full portfolio."""
    state = auction_state(properties=brown_pair(1, 1, 1) | {RAILROAD: owned(1)})
    assert set(legal_commands(state)) == {
        PlaceBid(player=1, amount=51),
        WithdrawFromAuction(player=1),
        SellHouse(player=1, tile=BROWN_A),
        SellHouse(player=1, tile=BROWN_B),
        MortgageProperty(player=1, tile=RAILROAD),
    }
    assert rejected(state, BuildHouse(player=1, tile=BROWN_A)) == "error.wrong_phase"


def test_auction_offers_nothing_to_players_who_are_not_the_bidding_turn() -> None:
    state = auction_state(properties={RAILROAD: owned(0)})
    assert rejected(state, MortgageProperty(player=0, tile=RAILROAD)) == "error.not_your_bid_turn"
    assert all(command.player == 1 for command in legal_commands(state))


def test_debt_settlement_offers_raising_commands_and_bankruptcy_to_the_debtor_only() -> None:
    """MON-207 / G-5: sell and mortgage to raise the debt — build and unmortgage stay
    forbidden while insolvent. There is no Pay command: settlement is automatic in apply."""
    state = debt_state(properties=brown_pair(0, 1, 1) | {RAILROAD: owned(0)})
    assert set(legal_commands(state)) == {
        DeclareBankruptcy(player=0),
        SellHouse(player=0, tile=BROWN_A),
        SellHouse(player=0, tile=BROWN_B),
        MortgageProperty(player=0, tile=RAILROAD),
    }


def test_debt_settlement_forbids_the_debtor_to_spend() -> None:
    state = debt_state(debtor_cash=1000, properties={RAILROAD: owned(0, mortgaged=True), BROWN_A: owned(0)})
    assert rejected(state, UnmortgageProperty(player=0, tile=RAILROAD)) == "error.wrong_phase"
    assert rejected(state, BuildHouse(player=0, tile=BROWN_A)) == "error.wrong_phase"


def test_trade_review_offers_response_and_cancellation() -> None:
    assert set(legal_commands(trade_state())) == {
        RespondToTrade(player=1, accept=True),
        RespondToTrade(player=1, accept=False),
        CancelTrade(player=0),
    }


def test_game_over_offers_nothing() -> None:
    assert legal_commands(make_state(phase=Phase.GAME_OVER, winner=0)) == ()


def test_transient_phases_offer_nothing() -> None:
    """A caller never observes MOVING / RESOLVING_TILE / CARD_RESOLUTION at rest, but
    legal_commands is total over Phase: nothing may be commanded mid-resolution."""
    assert legal_commands(make_state(phase=Phase.MOVING)) == ()
    assert legal_commands(make_state(phase=Phase.RESOLVING_TILE)) == ()
    card = CardFrame(resume=Phase.RESOLVING_TILE, card_id="card.chance.test", deck=Deck.CHANCE)
    assert legal_commands(make_state(phase=Phase.CARD_RESOLUTION, interrupts=(card,))) == ()


# --- Even-build (spec trap #3) -----------------------------------------------


def test_build_is_offered_only_at_the_group_minimum() -> None:
    state = make_state(phase=Phase.AWAITING_END_TURN, properties=brown_pair(0, 1, 0))
    offers = {command for command in legal_commands(state) if isinstance(command, BuildHouse)}
    assert offers == {BuildHouse(player=0, tile=BROWN_B)}
    assert rejected(state, BuildHouse(player=0, tile=BROWN_A)) == "error.uneven_build"


def test_sell_is_offered_only_at_the_group_maximum() -> None:
    """The sell direction is the half implementations get wrong (spec §6)."""
    state = make_state(phase=Phase.AWAITING_END_TURN, properties=brown_pair(0, 1, 0))
    offers = {command for command in legal_commands(state) if isinstance(command, SellHouse)}
    assert offers == {SellHouse(player=0, tile=BROWN_A)}
    assert rejected(state, SellHouse(player=0, tile=BROWN_B)) == "error.no_buildings"
    state = make_state(phase=Phase.AWAITING_END_TURN, properties=brown_pair(0, 2, 1))
    assert rejected(state, SellHouse(player=0, tile=BROWN_B)) == "error.uneven_build"


def test_a_hotel_counts_as_five_for_even_build() -> None:
    # Updated by MON-201: ``SellHouse.demolish_hotel`` is a second, explicit sale of the
    # same tile (the official whole-group clause), so a hotel now offers two ways down.
    state = make_state(phase=Phase.AWAITING_END_TURN, properties=brown_pair(0, 5, 4))
    build_and_sell = {c for c in legal_commands(state) if isinstance(c, BuildHouse | SellHouse)}
    assert build_and_sell == {
        BuildHouse(player=0, tile=BROWN_B),
        SellHouse(player=0, tile=BROWN_A),
        SellHouse(player=0, tile=BROWN_A, demolish_hotel=True),
    }


def test_even_build_is_relaxed_when_the_ruleset_disables_it() -> None:
    ruleset = Ruleset(name=RulesetName.UNIVERSAL, even_build_enforced=False)
    state = make_state(phase=Phase.AWAITING_END_TURN, properties=brown_pair(0, 1, 0), ruleset=ruleset)
    build_and_sell = {c for c in legal_commands(state) if isinstance(c, BuildHouse | SellHouse)}
    assert build_and_sell == {
        BuildHouse(player=0, tile=BROWN_A),
        BuildHouse(player=0, tile=BROWN_B),
        SellHouse(player=0, tile=BROWN_A),
    }


def test_build_requires_the_whole_group() -> None:
    state = make_state(phase=Phase.AWAITING_END_TURN, properties={BROWN_A: owned(0)})
    assert rejected(state, BuildHouse(player=0, tile=BROWN_A)) == "error.group_incomplete"


def test_build_is_blocked_while_any_group_member_is_mortgaged() -> None:
    state = make_state(
        phase=Phase.AWAITING_END_TURN,
        properties={BROWN_A: owned(0), BROWN_B: owned(0, mortgaged=True)},
    )
    assert rejected(state, BuildHouse(player=0, tile=BROWN_A)) == "error.group_mortgaged"


def test_build_requires_cash_for_the_house() -> None:
    seats = (make_player(0, cash=49), make_player(1))
    state = make_state(seats=seats, phase=Phase.AWAITING_END_TURN, properties=brown_pair(0, 0, 0))
    verdict = is_legal(state, BuildHouse(player=0, tile=BROWN_A))
    assert verdict.reason_key == "error.insufficient_funds"
    assert verdict.params == {"required": 50, "available": 49}


def test_build_needs_a_property_not_a_railroad() -> None:
    state = make_state(phase=Phase.AWAITING_END_TURN, properties={RAILROAD: owned(0)})
    assert rejected(state, BuildHouse(player=0, tile=RAILROAD)) == "error.not_buildable"
    assert rejected(state, SellHouse(player=0, tile=RAILROAD)) == "error.not_buildable"


def test_build_requires_owning_the_tile() -> None:
    state = make_state(phase=Phase.AWAITING_END_TURN, properties=brown_pair(1, 0, 0))
    assert rejected(state, BuildHouse(player=0, tile=BROWN_A)) == "error.not_owner"


# --- Building stock (spec trap #4) -------------------------------------------


def test_build_is_not_offered_when_the_houses_run_out() -> None:
    ruleset = Ruleset(name=RulesetName.UNIVERSAL, houses_available=6)
    properties = {tile: owned(0, houses=2) for tile in LIGHT_BLUE}
    state = make_state(phase=Phase.AWAITING_END_TURN, properties=properties, ruleset=ruleset)
    assert not any(isinstance(c, BuildHouse) for c in legal_commands(state))
    assert rejected(state, BuildHouse(player=0, tile=LIGHT_BLUE[0])) == "error.no_houses_left"


def test_the_hotel_build_needs_a_hotel_not_a_house() -> None:
    """Four houses -> hotel consumes hotel stock only; the four houses go back to the bank."""
    exhausted_houses = Ruleset(name=RulesetName.UNIVERSAL, houses_available=8)
    state = make_state(phase=Phase.AWAITING_END_TURN, properties=brown_pair(0, 4, 4), ruleset=exhausted_houses)
    builds = {c for c in legal_commands(state) if isinstance(c, BuildHouse)}
    assert builds == {BuildHouse(player=0, tile=BROWN_A), BuildHouse(player=0, tile=BROWN_B)}

    no_hotels = Ruleset(name=RulesetName.UNIVERSAL, hotels_available=0)
    state = make_state(phase=Phase.AWAITING_END_TURN, properties=brown_pair(0, 4, 4), ruleset=no_hotels)
    assert rejected(state, BuildHouse(player=0, tile=BROWN_A)) == "error.no_hotels_left"


def test_selling_a_hotel_with_no_houses_in_the_bank_is_the_demolition_only() -> None:
    """MON-201 (G-B3b) rewrote this from "the empty-bank drop is an *effect*": an implicit
    branch inside ``apply`` could not be rendered as a button, and a lone hotel dropping to
    zero broke even-build coming down. The way out is now an explicit whole-group sale, so
    the one-level sale is what the empty bank vetoes."""
    ruleset = Ruleset(name=RulesetName.UNIVERSAL, houses_available=0)
    state = make_state(phase=Phase.AWAITING_END_TURN, properties=brown_pair(0, 5, 5), ruleset=ruleset)
    assert rejected(state, SellHouse(player=0, tile=BROWN_A)) == "error.no_houses_left"
    approved(state, SellHouse(player=0, tile=BROWN_A, demolish_hotel=True))


def test_the_finite_bank_vetoes_the_build_in_every_ruleset() -> None:
    """The soundness hole that ADR-005 exists to prevent: the stock check used to sit behind
    a ``building_shortage_enforced`` flag while ``GameState`` enforced the same 32/12 limit
    unconditionally, so with the flag off ``legal_commands`` offered a build that ``apply``
    could only answer with a ValidationError. The flag is gone; the veto is not."""
    from kesef_engine.errors import IllegalCommandError
    from kesef_engine.reducer import apply

    # All 32 of the bank's houses are standing (brown 4+4, light blue and pink 4+4+4 each),
    # and player 0 also holds the orange group unbuilt — so the next orange build needs a
    # house the bank does not have.
    exhausted = {tile: owned(0, houses=4) for tile in (BROWN_A, BROWN_B, *LIGHT_BLUE, *PINK)}
    properties = exhausted | {tile: owned(0) for tile in ORANGE}
    state = make_state(phase=Phase.AWAITING_END_TURN, properties=properties)
    assert state.houses_remaining == 0
    build = BuildHouse(player=0, tile=ORANGE[0])
    assert build not in legal_commands(state)
    assert rejected(state, build) == "error.no_houses_left"
    with pytest.raises(IllegalCommandError) as excinfo:
        apply(state, build)
    assert excinfo.value.reason_key == "error.no_houses_left"
    # Kids Mode has the same bank; a custom ruleset only resizes it.
    kids = make_state(phase=Phase.AWAITING_END_TURN, properties=properties, ruleset=Ruleset.kids())
    assert rejected(kids, build) == "error.no_houses_left"
    assert "building_shortage_enforced" not in Ruleset.model_fields


def test_build_is_capped_at_the_hotel() -> None:
    state = make_state(phase=Phase.AWAITING_END_TURN, properties=brown_pair(0, 5, 5))
    assert rejected(state, BuildHouse(player=0, tile=BROWN_A)) == "error.at_maximum_development"


# --- Mortgages ----------------------------------------------------------------


def test_mortgage_is_offered_only_for_unbuilt_groups() -> None:
    """MON-202: buildings must be sold off the whole group first."""
    state = make_state(phase=Phase.AWAITING_END_TURN, properties=brown_pair(0, 1, 0))
    assert rejected(state, MortgageProperty(player=0, tile=BROWN_B)) == "error.group_has_buildings"


def test_unmortgage_costs_the_value_plus_ten_percent() -> None:
    board_tile = make_state().board.tile(BROWN_A)
    assert unmortgage_cost(board_tile) == 33  # mortgage 30 + 10%

    seats = (make_player(0, cash=33), make_player(1))
    state = make_state(seats=seats, phase=Phase.AWAITING_END_TURN, properties={BROWN_A: owned(0, mortgaged=True)})
    assert UnmortgageProperty(player=0, tile=BROWN_A) in legal_commands(state)

    seats = (make_player(0, cash=32), make_player(1))
    state = make_state(seats=seats, phase=Phase.AWAITING_END_TURN, properties={BROWN_A: owned(0, mortgaged=True)})
    verdict = is_legal(state, UnmortgageProperty(player=0, tile=BROWN_A))
    assert verdict.reason_key == "error.insufficient_funds"
    assert verdict.params == {"required": 33, "available": 32}


def test_mortgage_commands_vanish_when_the_ruleset_disables_them() -> None:
    state = make_state(phase=Phase.AWAITING_END_TURN, properties={RAILROAD: owned(0)}, ruleset=Ruleset.kids())
    assert set(legal_commands(state)) == {EndTurn(player=0)}
    assert rejected(state, MortgageProperty(player=0, tile=RAILROAD)) == "error.mortgages_disabled"


def test_a_mortgaged_tile_cannot_be_mortgaged_again() -> None:
    state = make_state(phase=Phase.AWAITING_END_TURN, properties={RAILROAD: owned(0, mortgaged=True)})
    assert rejected(state, MortgageProperty(player=0, tile=RAILROAD)) == "error.already_mortgaged"
    assert rejected(state, UnmortgageProperty(player=0, tile=BROWN_A)) == "error.not_owner"


def test_unmortgaging_an_unmortgaged_tile_is_rejected() -> None:
    state = make_state(phase=Phase.AWAITING_END_TURN, properties={RAILROAD: owned(0)})
    assert rejected(state, UnmortgageProperty(player=0, tile=RAILROAD)) == "error.not_mortgaged"


def test_unmortgage_is_not_offered_while_raising_cash() -> None:
    """G-5: a player who owes money may not tie more of it up."""
    state = debt_state(debtor_cash=500, properties={RAILROAD: owned(0, mortgaged=True)})
    assert rejected(state, UnmortgageProperty(player=0, tile=RAILROAD)) == "error.wrong_phase"


# --- Auction arithmetic --------------------------------------------------------


def test_the_minimum_bid_is_one_over_the_high_bid() -> None:
    state = auction_state(high_bid=50, high_bidder=0, min_bid=1)
    assert PlaceBid(player=1, amount=51) in legal_commands(state)


def test_the_minimum_bid_respects_the_frame_floor() -> None:
    state = auction_state(high_bid=0, high_bidder=None, min_bid=10)
    assert PlaceBid(player=1, amount=10) in legal_commands(state)


def test_a_low_bid_is_rejected_with_the_minimum_attached() -> None:
    state = auction_state()
    verdict = is_legal(state, PlaceBid(player=1, amount=50))
    assert verdict.reason_key == "error.bid_too_low"
    assert verdict.params == {"minimum": 51}


def test_a_bid_above_the_ceiling_is_rejected() -> None:
    state = auction_state(max_bid=60)
    verdict = is_legal(state, PlaceBid(player=1, amount=61))
    assert verdict.reason_key == "error.bid_above_ceiling"
    assert verdict.params == {"maximum": 60}


def test_a_bid_above_the_bidders_cash_is_rejected() -> None:
    state = auction_state(bidder_cash=55)
    verdict = is_legal(state, PlaceBid(player=1, amount=56))
    assert verdict.reason_key == "error.insufficient_funds"
    assert verdict.params == {"required": 56, "available": 55}


def test_a_mid_range_bid_is_legal_but_not_enumerated() -> None:
    """ADR-005's explicit exception: legal_commands returns the minimum only; the full
    range is validated through is_legal."""
    state = auction_state()
    approved(state, PlaceBid(player=1, amount=200))
    assert PlaceBid(player=1, amount=200) not in legal_commands(state)


def test_only_the_bidding_turn_may_bid_or_withdraw() -> None:
    state = auction_state(turn=1)
    assert rejected(state, PlaceBid(player=0, amount=51)) == "error.not_your_bid_turn"
    assert rejected(state, WithdrawFromAuction(player=0)) == "error.not_your_bid_turn"


# --- Jail ----------------------------------------------------------------------


def test_the_jail_fine_requires_cash() -> None:
    state = jail_state(cash=JAIL_FINE - 1)
    verdict = is_legal(state, PayJailFine(player=0))
    assert verdict.reason_key == "error.insufficient_funds"
    assert verdict.params == {"required": JAIL_FINE, "available": JAIL_FINE - 1}


def test_the_jail_card_requires_holding_one() -> None:
    assert rejected(jail_state(), UseJailCard(player=0)) == "error.no_jail_card"


def test_jail_commands_require_actually_being_in_jail() -> None:
    seats = (make_player(0), make_player(1))
    state = make_state(seats=seats, phase=Phase.JAIL_DECISION)
    assert rejected(state, RollForJail(player=0)) == "error.not_in_jail"


def test_jail_commands_are_wrong_phase_elsewhere() -> None:
    assert rejected(make_state(), PayJailFine(player=0)) == "error.wrong_phase"


# --- Trades: the is_legal matrix ------------------------------------------------


def simple_offer(**overrides: object) -> TradeOffer:
    fields: dict[str, object] = {
        "proposer": 0,
        "recipient": 1,
        "give": TradeSide(cash=100),
        "receive": TradeSide(),
    }
    return TradeOffer.model_validate(fields | overrides)


def test_a_simple_trade_is_legal_in_a_portfolio_phase() -> None:
    approved(make_state(), ProposeTrade(player=0, offer=simple_offer()))


def test_propose_trade_is_never_enumerated() -> None:
    """ADR-005: the parameter space is unbounded, so the trade builder validates its
    draft through is_legal instead."""
    state = make_state(properties={RAILROAD: owned(0)})
    approved(state, ProposeTrade(player=0, offer=simple_offer(give=TradeSide(tiles=(RAILROAD,)))))
    assert not any(isinstance(command, ProposeTrade) for command in legal_commands(state))


def test_trading_can_be_disabled_by_the_ruleset() -> None:
    ruleset = Ruleset(name=RulesetName.UNIVERSAL, trading_enabled=False)
    state = make_state(ruleset=ruleset)
    assert rejected(state, ProposeTrade(player=0, offer=simple_offer())) == "error.trading_disabled"


def test_the_command_actor_must_be_the_proposer() -> None:
    state = make_state()
    assert rejected(state, ProposeTrade(player=1, offer=simple_offer())) == "error.not_your_offer"


def test_trades_are_wrong_phase_at_a_purchase_decision() -> None:
    state = purchase_state()
    assert rejected(state, ProposeTrade(player=0, offer=simple_offer())) == "error.wrong_phase"


def test_a_debtor_may_trade_to_raise_cash_but_a_creditor_may_not() -> None:
    """MON-207: trading is part of the RAISING set for the debtor alone."""
    state = debt_state(debtor_cash=100)
    approved(state, ProposeTrade(player=0, offer=simple_offer()))
    counter = ProposeTrade(player=1, offer=simple_offer(proposer=1, recipient=0))
    assert rejected(state, counter) == "error.not_the_debtor"


def test_a_bidder_may_not_trade_mid_auction() -> None:
    state = auction_state()
    offer = simple_offer(proposer=1, recipient=0)
    assert rejected(state, ProposeTrade(player=1, offer=offer)) == "error.wrong_phase"


def test_the_recipient_must_be_seated() -> None:
    state = make_state()
    verdict = is_legal(state, ProposeTrade(player=0, offer=simple_offer(recipient=99)))
    assert verdict.reason_key == "error.unknown_player"
    assert verdict.params == {"player": 99}


def test_the_recipient_must_be_solvent() -> None:
    seats = (make_player(0), make_player(1), make_player(2, cash=0, bankrupt=True))
    state = make_state(seats=seats)
    assert rejected(state, ProposeTrade(player=0, offer=simple_offer(recipient=2))) == "error.recipient_bankrupt"


def test_you_can_only_give_tiles_you_own() -> None:
    state = make_state(properties={RAILROAD: owned(1)})
    offer = simple_offer(give=TradeSide(tiles=(RAILROAD,)))
    assert rejected(state, ProposeTrade(player=0, offer=offer)) == "error.not_owner"


def test_you_can_only_ask_for_tiles_they_own() -> None:
    state = make_state()
    offer = simple_offer(receive=TradeSide(tiles=(RAILROAD,)))
    assert rejected(state, ProposeTrade(player=0, offer=offer)) == "error.not_owner"


def test_cash_offered_must_exist() -> None:
    seats = (make_player(0, cash=50), make_player(1))
    state = make_state(seats=seats)
    assert rejected(state, ProposeTrade(player=0, offer=simple_offer())) == "error.insufficient_funds"


def test_cash_requested_must_exist() -> None:
    seats = (make_player(0), make_player(1, cash=50))
    state = make_state(seats=seats)
    offer = simple_offer(give=TradeSide(), receive=TradeSide(cash=51))
    assert rejected(state, ProposeTrade(player=0, offer=offer)) == "error.insufficient_funds"


def test_a_tile_from_a_built_group_cannot_be_traded() -> None:
    """MON-204: no property whose GROUP carries buildings — even the unbuilt member."""
    state = make_state(properties=brown_pair(0, 1, 0))
    offer = simple_offer(give=TradeSide(tiles=(BROWN_B,)))
    assert rejected(state, ProposeTrade(player=0, offer=offer)) == "error.group_has_buildings"


def test_a_mortgaged_tile_can_be_traded() -> None:
    """MON-204: mortgaged properties transfer with their obligation."""
    state = make_state(properties={RAILROAD: owned(0, mortgaged=True)})
    approved(state, ProposeTrade(player=0, offer=simple_offer(give=TradeSide(tiles=(RAILROAD,)))))


def test_jail_cards_must_be_held_to_be_traded() -> None:
    state = make_state()
    offer = simple_offer(give=TradeSide(jail_cards=(Deck.CHANCE,)))
    assert rejected(state, ProposeTrade(player=0, offer=offer)) == "error.jail_card_not_held"


def test_simplified_trades_limit_each_side_to_one_item() -> None:
    state = make_state(properties={RAILROAD: owned(0), BROWN_A: owned(0)}, ruleset=Ruleset.kids())
    two_tiles = simple_offer(give=TradeSide(tiles=(RAILROAD, BROWN_A)))
    assert rejected(state, ProposeTrade(player=0, offer=two_tiles)) == "error.trade_too_complex"
    tile_and_cash = simple_offer(give=TradeSide(cash=10, tiles=(RAILROAD,)))
    assert rejected(state, ProposeTrade(player=0, offer=tile_and_cash)) == "error.trade_too_complex"
    tile_for_cash = simple_offer(give=TradeSide(tiles=(RAILROAD,)), receive=TradeSide(cash=100))
    approved(state, ProposeTrade(player=0, offer=tile_for_cash))


# --- Generic gates ---------------------------------------------------------------


def test_it_must_be_your_turn_to_roll() -> None:
    assert rejected(make_state(), RollDice(player=1)) == "error.not_your_turn"


def test_rolling_is_wrong_phase_once_the_turn_is_resolved() -> None:
    state = make_state(phase=Phase.AWAITING_END_TURN)
    assert rejected(state, RollDice(player=0)) == "error.wrong_phase"


def test_a_bankrupt_player_may_do_nothing() -> None:
    seats = (make_player(0), make_player(1, cash=0, bankrupt=True))
    state = make_state(seats=seats, properties={RAILROAD: owned(1)})
    assert rejected(state, MortgageProperty(player=1, tile=RAILROAD)) == "error.bankrupt"
    assert all(command.player != 1 for command in legal_commands(state))


def test_an_unseated_player_may_do_nothing() -> None:
    verdict = is_legal(make_state(), RollDice(player=99))
    assert verdict.reason_key == "error.unknown_player"
    assert verdict.params == {"player": 99}


def test_game_over_rejects_every_command() -> None:
    state = make_state(phase=Phase.GAME_OVER, winner=0)
    assert rejected(state, RollDice(player=0)) == "error.game_over"
    assert rejected(state, EndTurn(player=0)) == "error.game_over"


def test_trade_review_actor_gates() -> None:
    state = trade_state()
    assert rejected(state, RespondToTrade(player=0, accept=True)) == "error.not_trade_recipient"
    assert rejected(state, CancelTrade(player=1)) == "error.not_trade_proposer"


def test_only_the_debtor_may_declare_bankruptcy() -> None:
    state = debt_state()
    assert rejected(state, DeclareBankruptcy(player=1)) == "error.not_the_debtor"
    assert rejected(make_state(), DeclareBankruptcy(player=0)) == "error.wrong_phase"


def test_buying_needs_an_unowned_ownable_tile_underfoot() -> None:
    state = purchase_state(properties={BROWN_A: owned(1)})
    assert rejected(state, BuyProperty(player=0)) == "error.tile_already_owned"
    state = purchase_state(position=0)  # standing on GO
    assert rejected(state, BuyProperty(player=0)) == "error.tile_not_ownable"


def test_end_turn_accepts_a_caller_stamped_clock() -> None:
    """G-6: elapsed_seconds is caller metadata, not part of the legality decision."""
    state = make_state(phase=Phase.AWAITING_END_TURN)
    approved(state, EndTurn(player=0, elapsed_seconds=90))
    assert set(legal_commands(state)) == {EndTurn(player=0)}


# --- Determinism and the result type ---------------------------------------------


def test_legal_commands_is_deterministic_and_stably_ordered() -> None:
    state = make_state(properties=brown_pair(0, 0, 0) | {RAILROAD: owned(1, mortgaged=True)})
    first = legal_commands(state)
    second = legal_commands(state)
    assert first == second
    clone = GameState.model_validate_json(state.model_dump_json())
    assert legal_commands(clone) == first


def test_the_order_groups_by_kind_across_seats_rather_than_by_seat() -> None:
    """``legal_commands`` promises *"sorted by kind, actor, then parameter"* — assert the first two.

    The determinism test above passes under **any** sort key, which is why MON-209's mutation gate
    found survivors in ``_sort_key`` (MON-722): each produced a different order that was still a
    *stable* one. And this order is not cosmetic — ``ActionBar`` renders ``legal_commands`` verbatim
    ("in the engine's order. Rendered as given"), so it is the order of the buttons on screen.

    **Two players is what makes this falsifiable.** Portfolio commands are legal for any solvent
    player in a portfolio phase (MON-204), so both seats have builds and mortgages here. Sorting by
    kind first interleaves the seats; sorting by seat first groups them. With one player the two are
    indistinguishable, which is exactly how the weaker version of this test passed while seeing
    nothing.
    """
    state = make_state(
        players=2,
        properties=brown_pair(0, 1, 1) | {index: owned(1) for index in LIGHT_BLUE},
        phase=Phase.AWAITING_END_TURN,
    )

    keys = [(command.kind, command.player) for command in legal_commands(state)]

    assert len({player for _, player in keys}) == 2, "this fixture was supposed to arm both seats"
    assert keys == sorted(keys), f"not ordered by kind then actor: {keys}"


def test_the_order_within_one_kind_and_seat_follows_the_parameter() -> None:
    """The third and fourth elements of the key — and the honest limit of what a test can see here.

    Both halves were checked by hand-mutating ``_sort_key`` and watching this test, rather than
    assumed, and the answer was not the one expected:

    * **Dropping ``detail`` is caught.** It looks equivalent — ``_candidates`` already yields holdings
      in ascending tile order and ``sorted`` is stable — but with ``detail`` gone the *variant*
      dominates, so every non-demolishing ``SellHouse`` sorts ahead of every demolishing one and the
      tiles come back ``6, 8, 9, 6, 8, 9`` instead of ``6, 6, 8, 8, 9, 9``. The first assertion below
      sees that.
    * **Dropping ``variant`` is genuinely equivalent.** The generator yields ``False`` then ``True``
      for one tile and the sort is stable, so the output is identical for every state this engine can
      build. That mutant cannot be killed by observing output, and MON-722 records it as equivalent
      rather than pretending an assertion could reach it.

    What is pinned either way is the contract a caller relies on: within one kind and one seat,
    commands arrive in ascending tile order, and the two demolish variants have a fixed order.
    """
    state = make_state(
        properties={index: owned(0, houses=5) for index in LIGHT_BLUE},
        phase=Phase.AWAITING_END_TURN,
    )
    commands = legal_commands(state)

    sells = [command for command in commands if command.kind == "sell_house"]
    assert [command.tile for command in sells] == sorted(command.tile for command in sells)

    on_one_tile = [command for command in sells if command.tile == LIGHT_BLUE[0]]
    assert len(on_one_tile) == 2, f"expected both demolish variants, got {on_one_tile}"
    assert [command.demolish_hotel for command in on_one_tile] == [False, True]


def test_a_legality_result_is_truthy_only_when_legal() -> None:
    assert LegalityResult(legal=True)
    assert not LegalityResult(legal=False, reason_key="error.wrong_phase")


def test_a_rejection_must_carry_a_reason_and_an_approval_must_not() -> None:
    with pytest.raises(ValidationError):
        LegalityResult(legal=False)
    with pytest.raises(ValidationError):
        LegalityResult(legal=True, reason_key="error.wrong_phase")
