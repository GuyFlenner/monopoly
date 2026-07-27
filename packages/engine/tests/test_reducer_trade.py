"""MON-204 — trading, end to end.

The legality matrix is pinned in ``test_legality.py`` (``_propose_trade`` / ``_trade_side``
are the oracle, and this module never re-states a predicate); the M1 happy paths stay in
``test_reducer_portfolio.py``. What lives here is the part a legality test cannot see: the
atomicity of the swap, the official dual mortgage fee and the debt it can open, the
deck-identified jail cards, and the two places where a *pending* offer stops being
deliverable and the engine voids it as an **effect** rather than rejecting the response.
"""

from __future__ import annotations

from collections import Counter

import pytest

from helpers import make_player, make_state
from kesef_engine.commands import (
    BuildHouse,
    CancelTrade,
    Command,
    MortgageProperty,
    ProposeTrade,
    RespondToTrade,
    RollDice,
    TradeOffer,
    TradeSide,
    UnmortgageProperty,
)
from kesef_engine.decks import GET_OUT_OF_JAIL_IDS
from kesef_engine.errors import IllegalCommandError
from kesef_engine.events import CashChanged, DebtIncurred, TradeCancelled, TradeDeclined, TradeExecuted
from kesef_engine.legality import is_legal, legal_commands, unmortgage_cost
from kesef_engine.phases import Phase
from kesef_engine.primitives import CashReason, Deck
from kesef_engine.reducer import apply
from kesef_engine.ruleset import Ruleset, RulesetName
from kesef_engine.state import DebtFrame, GameState, PropertyState, TradeFrame

BROWN_A, BROWN_B = 1, 3
"""The brown pair: price 60, mortgage 30, house_cost 50."""
RAILROAD = 5
"""price 200, mortgage 100 — so its transfer fee is 10."""
UTILITY = 12
"""price 150, mortgage 75 — an odd half, so its fee rounds *up* to 8."""

RAILROAD_FEE = 10
UTILITY_FEE = 8


def offer(**overrides: object) -> TradeOffer:
    fields: dict[str, object] = {
        "proposer": 0,
        "recipient": 1,
        "give": TradeSide(cash=100, tiles=(BROWN_A,)),
        "receive": TradeSide(tiles=(RAILROAD,)),
    }
    return TradeOffer.model_validate(fields | overrides)


def table(
    *,
    seats: tuple[int, ...] = (0, 1),
    cash: dict[int, int] | None = None,
    jail_cards: dict[int, tuple[Deck, ...]] | None = None,
    properties: dict[int, PropertyState] | None = None,
    ruleset: Ruleset | None = None,
    pending: TradeOffer | None = None,
) -> GameState:
    """A quiet portfolio phase with player 0 owning BROWN_A and player 1 the RAILROAD.

    ``pending`` puts the offer straight into a ``TradeFrame`` without going through
    ``ProposeTrade``, which is the only way to reach a *stale* pending offer: TRADE_REVIEW
    admits nothing but respond/cancel, so nothing the reducer accepts can move a named
    holding while an offer waits. The stale offer is reachable in play through MON-207
    (a party goes bankrupt) and through save/load, so it is the reducer's problem, not a
    hypothetical.
    """
    cash = cash or {}
    jail_cards = jail_cards or {}
    return make_state(
        seats=tuple(
            make_player(seat, cash=cash.get(seat, 1500), jail_cards=jail_cards.get(seat, ())) for seat in seats
        ),
        properties={BROWN_A: PropertyState(owner=0), RAILROAD: PropertyState(owner=1), **(properties or {})},
        ruleset=ruleset,
        phase=Phase.TRADE_REVIEW if pending else Phase.AWAITING_ROLL,
        interrupts=(TradeFrame(resume=Phase.AWAITING_ROLL, offer=pending),) if pending else (),
    )


def holdings(state: GameState) -> tuple[object, ...]:
    """Everything a trade can move, as one comparable value."""
    return (
        tuple((player.id, player.cash, player.jail_cards) for player in state.players),
        state.properties,
        state.chance_deck,
        state.community_chest_deck,
    )


def fee_of(state: GameState, tile_index: int) -> int:
    tile = state.board.tile(tile_index)
    return unmortgage_cost(tile) - (tile.mortgage or 0)


# --- Accept, reject, cancel ------------------------------------------------------


def test_the_recipient_accepts_and_every_named_item_changes_hands() -> None:
    state = table(jail_cards={1: (Deck.CHANCE,)})
    full = offer(receive=TradeSide(tiles=(RAILROAD,), jail_cards=(Deck.CHANCE,)))
    accepted, events = apply(*_propose(state, full))
    assert accepted.phase is Phase.AWAITING_ROLL, "play resumes where the review suspended it"
    assert accepted.properties[BROWN_A].owner == 1
    assert accepted.properties[RAILROAD].owner == 0
    assert (accepted.player(0).cash, accepted.player(1).cash) == (1400, 1600)
    assert accepted.player(0).jail_cards == (Deck.CHANCE,)
    assert accepted.player(1).jail_cards == ()
    assert [e for e in events if isinstance(e, TradeExecuted)]
    assert sum(e.delta for e in events if isinstance(e, CashChanged)) == 0, "player-to-player money conserves"


def test_the_recipient_rejects_and_nothing_moves() -> None:
    state = table()
    proposed, _ = apply(state, ProposeTrade(player=0, offer=offer()))
    declined, events = apply(proposed, RespondToTrade(player=1, accept=False))
    assert declined.phase is Phase.AWAITING_ROLL
    assert declined.interrupts == ()
    assert holdings(declined) == holdings(state)
    assert [e for e in events if isinstance(e, TradeDeclined)]
    assert not [e for e in events if isinstance(e, TradeExecuted)]


def test_the_proposer_cancels_while_the_offer_is_pending() -> None:
    state = table()
    proposed, _ = apply(state, ProposeTrade(player=0, offer=offer()))
    cancelled, events = apply(proposed, CancelTrade(player=0))
    assert cancelled.phase is Phase.AWAITING_ROLL
    assert holdings(cancelled) == holdings(state)
    voided = next(e for e in events if isinstance(e, TradeCancelled))
    assert voided.by == "proposer"


# --- Atomicity ----------------------------------------------------------------------


def test_a_trade_executes_atomically_or_not_at_all() -> None:
    """One undeliverable leg voids the whole swap — the *other* leg must not have run.

    Player 1 no longer owns the railroad the offer asks for, so the give leg (100 in cash
    and a brown tile, both perfectly deliverable) is the one that would leak if the
    handler transferred side by side and checked as it went.
    """
    state = table(properties={RAILROAD: PropertyState(owner=None)}, pending=offer())
    before = holdings(state)
    voided, events = apply(state, RespondToTrade(player=1, accept=True))
    assert holdings(voided) == before, "no half-swap: cash, tiles and cards are untouched"
    assert voided.interrupts == ()
    assert next(e for e in events if isinstance(e, TradeCancelled)).by == "system"
    assert not [e for e in events if isinstance(e, TradeExecuted)]
    assert not [e for e in events if isinstance(e, CashChanged)]


def test_a_stale_offer_voids_as_an_effect_and_not_as_a_legality_rejection() -> None:
    """The distinction the UI depends on: the Accept button stays live and *pressing* it
    tells the players the offer expired. If this were a legality rejection the recipient
    would face a phase with no legal answer."""
    state = table(properties={RAILROAD: PropertyState(owner=None)}, pending=offer())
    response = RespondToTrade(player=1, accept=True)
    assert is_legal(state, response).legal, "legality does not re-validate deliverability"
    assert response in legal_commands(state)
    _, events = apply(state, response)
    assert next(e for e in events if isinstance(e, TradeCancelled)).by == "system"


def test_a_bankrupted_party_voids_a_pending_offer() -> None:
    """MON-207 hands the engine this shape: the estate left the table under the offer."""
    state = make_state(
        seats=(make_player(0), make_player(1), make_player(2, cash=0, bankrupt=True)),
        properties={BROWN_A: PropertyState(owner=0)},
        phase=Phase.TRADE_REVIEW,
        interrupts=(
            TradeFrame(
                resume=Phase.AWAITING_ROLL,
                offer=TradeOffer(proposer=2, recipient=1, give=TradeSide(), receive=TradeSide(cash=50)),
            ),
        ),
    )
    before = holdings(state)
    voided, events = apply(state, RespondToTrade(player=1, accept=True))
    assert holdings(voided) == before
    assert next(e for e in events if isinstance(e, TradeCancelled)).by == "system"


# --- Buildings on the group ----------------------------------------------------------


def test_a_group_carrying_buildings_blocks_the_trade_and_voids_a_pending_one() -> None:
    """MON-204: no member of a built group may be traded, built on or not — and legality
    and the effect must agree about it, or the veto is decorative."""
    built = {BROWN_A: PropertyState(owner=0), BROWN_B: PropertyState(owner=0, houses=1)}
    unbuilt = offer(give=TradeSide(tiles=(BROWN_A,)), receive=TradeSide())

    rejected = table(properties=built)
    with pytest.raises(IllegalCommandError) as excinfo:
        apply(rejected, ProposeTrade(player=0, offer=unbuilt))
    assert excinfo.value.reason_key == "error.group_has_buildings"

    # The same offer, already pending when the house went up (MON-207 order of events, or
    # a save file): the effect layer reaches the identical verdict through ``_trade_side``.
    pending = table(properties=built, pending=unbuilt)
    before = holdings(pending)
    voided, events = apply(pending, RespondToTrade(player=1, accept=True))
    assert holdings(voided) == before
    assert next(e for e in events if isinstance(e, TradeCancelled)).by == "system"


# --- The official dual mortgage fee (owner decision 2, GAP §7) ------------------------


def test_a_mortgaged_tile_transfers_with_its_obligation_and_the_receiver_pays_the_fee() -> None:
    state = table(properties={RAILROAD: PropertyState(owner=1, mortgaged=True)})
    accepted, events = apply(*_propose(state, offer(give=TradeSide(), receive=TradeSide(tiles=(RAILROAD,)))))
    assert accepted.properties[RAILROAD].owner == 0
    assert accepted.properties[RAILROAD].mortgaged, "the obligation travels with the tile"
    charged = next(e for e in events if isinstance(e, CashChanged) and e.reason is CashReason.MORTGAGE_TRANSFER_FEE)
    assert (charged.player, charged.delta, charged.counterparty) == (0, -RAILROAD_FEE, "bank")
    assert accepted.player(0).cash == 1500 - RAILROAD_FEE
    assert accepted.player(1).cash == 1500, "the fee is the bank's, not the giver's"


def test_an_unmortgaged_tile_carries_no_transfer_fee() -> None:
    """The negative control: without it a handler that charged 10% on every tile passes."""
    state = table()
    accepted, events = apply(*_propose(state, offer(give=TradeSide(), receive=TradeSide(tiles=(RAILROAD,)))))
    assert accepted.player(0).cash == 1500
    assert not [e for e in events if isinstance(e, CashChanged)], "no ledger entry at all, let alone a fee"


def test_the_fee_rounds_up_and_is_charged_per_mortgaged_tile_received() -> None:
    state = table(
        properties={
            RAILROAD: PropertyState(owner=1, mortgaged=True),
            UTILITY: PropertyState(owner=1, mortgaged=True),
        },
    )
    assert fee_of(state, UTILITY) == UTILITY_FEE, "75 / 10 rounds up to 8"
    both = offer(give=TradeSide(), receive=TradeSide(tiles=(RAILROAD, UTILITY)))
    accepted, _ = apply(*_propose(state, both))
    assert accepted.player(0).cash == 1500 - RAILROAD_FEE - UTILITY_FEE


def test_the_fee_is_the_same_ten_percent_that_lifting_charges_again() -> None:
    """Owner decision 2 is the *dual* fee: 10% now, and the full 10% again on unmortgage.
    Both numbers come from one place, so this pins them as literally the same figure."""
    state = table(properties={RAILROAD: PropertyState(owner=1, mortgaged=True)})
    accepted, transfer = apply(*_propose(state, offer(give=TradeSide(), receive=TradeSide(tiles=(RAILROAD,)))))
    lifted, lift_events = apply(accepted, UnmortgageProperty(player=0, tile=RAILROAD))
    tile = state.board.tile(RAILROAD)
    interest = unmortgage_cost(tile) - (tile.mortgage or 0)

    at_transfer = next(e for e in transfer if isinstance(e, CashChanged))
    assert (at_transfer.reason, -at_transfer.delta) == (CashReason.MORTGAGE_TRANSFER_FEE, interest)
    at_lift = next(e for e in lift_events if isinstance(e, CashChanged))
    assert (at_lift.reason, -at_lift.delta) == (CashReason.UNMORTGAGE, (tile.mortgage or 0) + interest)
    spent = state.player(0).cash - lifted.player(0).cash
    assert spent == (tile.mortgage or 0) + interest * 2, "the principal once, the same 10% twice over"


def test_both_sides_pay_their_own_fees_on_a_mortgage_for_mortgage_swap() -> None:
    state = table(
        properties={
            BROWN_A: PropertyState(owner=0, mortgaged=True),
            RAILROAD: PropertyState(owner=1, mortgaged=True),
        },
    )
    swap = offer(give=TradeSide(tiles=(BROWN_A,)), receive=TradeSide(tiles=(RAILROAD,)))
    accepted, events = apply(*_propose(state, swap))
    assert accepted.player(0).cash == 1500 - RAILROAD_FEE
    assert accepted.player(1).cash == 1500 - fee_of(state, BROWN_A)
    fees = [e for e in events if isinstance(e, CashChanged) and e.reason is CashReason.MORTGAGE_TRANSFER_FEE]
    assert {e.player for e in fees} == {0, 1}


def test_the_transfer_fee_opens_a_debt_when_the_receiver_cannot_pay_it() -> None:
    """G-13 / ADR-007: the fee is a nested interrupt on the *receiver*. Settlement is
    MON-207's; what MON-204 owes is a correctly shaped frame."""
    state = table(cash={0: 4}, properties={RAILROAD: PropertyState(owner=1, mortgaged=True)})
    accepted, events = apply(*_propose(state, offer(give=TradeSide(), receive=TradeSide(tiles=(RAILROAD,)))))
    assert accepted.phase is Phase.DEBT_SETTLEMENT
    frame = accepted.top_interrupt
    assert isinstance(frame, DebtFrame)
    assert frame.debtor == 0
    assert frame.total == RAILROAD_FEE
    assert frame.creditors == ("bank",)
    assert frame.reason is CashReason.MORTGAGE_TRANSFER_FEE
    assert frame.source_tile == RAILROAD
    assert frame.resume is Phase.AWAITING_ROLL, "the fee suspends the phase the trade resumed into"
    assert accepted.player(0).cash == 4, "shortfall-as-data: cash never goes negative"
    assert accepted.properties[RAILROAD].owner == 0, "the tile still moved; only the fee is outstanding"
    incurred = next(e for e in events if isinstance(e, DebtIncurred))
    assert (incurred.debtor, incurred.creditor, incurred.amount) == (0, "bank", RAILROAD_FEE)
    assert [e.type for e in events].index("trade_executed") < [e.type for e in events].index("debt_incurred")


# --- Jail cards --------------------------------------------------------------------


def test_jail_cards_transfer_as_deck_identified_cards_and_conserve_the_multiset() -> None:
    """G-11: a traded card is *which* card, so it can still find its own deck's bottom."""
    state = table(jail_cards={0: (Deck.CHANCE,), 1: (Deck.COMMUNITY_CHEST,)})
    state = state._replace(
        chance_deck=(GET_OUT_OF_JAIL_IDS[Deck.CHANCE],),
        community_chest_deck=(GET_OUT_OF_JAIL_IDS[Deck.COMMUNITY_CHEST],),
    )
    swap = offer(
        give=TradeSide(jail_cards=(Deck.CHANCE,)),
        receive=TradeSide(jail_cards=(Deck.COMMUNITY_CHEST,)),
    )
    accepted, _ = apply(*_propose(state, swap))
    assert accepted.player(0).jail_cards == (Deck.COMMUNITY_CHEST,)
    assert accepted.player(1).jail_cards == (Deck.CHANCE,)
    assert _jail_card_multiset(accepted) == _jail_card_multiset(state)
    assert _jail_card_multiset(accepted) == Counter({Deck.CHANCE: 2, Deck.COMMUNITY_CHEST: 2})


def _jail_card_multiset(state: GameState) -> Counter[Deck]:
    """Every get-out-of-jail card in the game, wherever it currently sits."""
    held = Counter(card for player in state.players for card in player.jail_cards)
    for deck in Deck:
        held[deck] += state.deck(deck).count(GET_OUT_OF_JAIL_IDS[deck])
    return held


# --- Ruleset flags -------------------------------------------------------------------


def test_trading_can_be_switched_off_entirely() -> None:
    state = table(ruleset=Ruleset(name=RulesetName.UNIVERSAL, trading_enabled=False))
    with pytest.raises(IllegalCommandError) as excinfo:
        apply(state, ProposeTrade(player=0, offer=offer()))
    assert excinfo.value.reason_key == "error.trading_disabled"
    assert state.pending_trade is None


def test_simplified_trades_limit_each_side_to_one_item() -> None:
    """Kids Mode: property-for-property or property-for-cash, nothing bigger — enforced on
    *both* sides, and cash counts as an item."""
    state = table(
        properties={BROWN_B: PropertyState(owner=0), UTILITY: PropertyState(owner=1)},
        ruleset=Ruleset.kids(),
    )
    too_much_given = offer(give=TradeSide(cash=100, tiles=(BROWN_A,)), receive=TradeSide(tiles=(RAILROAD,)))
    too_much_asked = offer(give=TradeSide(tiles=(BROWN_A,)), receive=TradeSide(tiles=(RAILROAD, UTILITY)))
    for rejected in (too_much_given, too_much_asked):
        with pytest.raises(IllegalCommandError) as excinfo:
            apply(state, ProposeTrade(player=0, offer=rejected))
        assert excinfo.value.reason_key == "error.trade_too_complex"

    one_each = offer(give=TradeSide(tiles=(BROWN_A,)), receive=TradeSide(tiles=(RAILROAD,)))
    accepted, _ = apply(*_propose(state, one_each))
    assert (accepted.properties[BROWN_A].owner, accepted.properties[RAILROAD].owner) == (1, 0)


# --- legal_commands <=> apply in TRADE_REVIEW -----------------------------------------


def test_legal_commands_and_apply_agree_in_trade_review() -> None:
    """ADR-005 both ways, over the whole of TRADE_REVIEW: the three offered commands are
    accepted, and every other command the phase could be sent is rejected with a key."""
    state = table(pending=offer())
    assert set(legal_commands(state)) == {
        RespondToTrade(player=1, accept=True),
        RespondToTrade(player=1, accept=False),
        CancelTrade(player=0),
    }
    for command in legal_commands(state):
        apply(state, command)  # a raise here is the failure

    omitted: tuple[Command, ...] = (
        RespondToTrade(player=0, accept=True),
        CancelTrade(player=1),
        RollDice(player=0),
        ProposeTrade(player=0, offer=offer(recipient=1, give=TradeSide(cash=1), receive=TradeSide())),
        BuildHouse(player=0, tile=BROWN_A),
        MortgageProperty(player=0, tile=BROWN_A),
    )
    for command in omitted:
        assert command not in legal_commands(state)
        with pytest.raises(IllegalCommandError) as excinfo:
            apply(state, command)
        assert excinfo.value.reason_key


# --- Shared helper ---------------------------------------------------------------------


def _propose(state: GameState, proposal: TradeOffer) -> tuple[GameState, RespondToTrade]:
    """Propose ``proposal`` and hand back the acceptance, so a test reads as one line."""
    proposed, _ = apply(state, ProposeTrade(player=proposal.proposer, offer=proposal))
    assert proposed.phase is Phase.TRADE_REVIEW
    return proposed, RespondToTrade(player=proposal.recipient, accept=True)
