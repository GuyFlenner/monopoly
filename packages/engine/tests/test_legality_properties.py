"""MON-101 — the ADR-005 properties, as far as they can run before ``apply`` exists.

Two generators are eventually required (G-61): a replay generator (MON-107 goldens) and
the **unconstrained structural generator** below, which builds arbitrary *valid* states
directly — reachability is irrelevant because both sides of every property see the same
state. The internal-consistency half runs now:

* everything ``legal_commands`` enumerates is approved by ``is_legal`` (one source of
  truth — the enumeration is a filter over ``is_legal``, and this proves it stayed one);
* for the 15 enumerable command kinds, everything ``is_legal`` approves is enumerated,
  and every rejection carries a populated snake_case ``reason_key`` — never a crash.

The apply-facing halves (soundness against ``apply``, rejection specifically as
``IllegalCommandError``, the ``is_legal ⇔ apply`` oracle with the Phase/CashReason
coverage floor) are scaffolded and skipped below: MON-102 and MON-209 own their
un-skipping, per the repo's tripwire convention.
"""

from __future__ import annotations

import re
from collections.abc import Iterator

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from helpers import make_player
from kesef_engine.board.loader import load_board
from kesef_engine.board.models import TileKind
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
from kesef_engine.legality import is_legal, legal_commands
from kesef_engine.phases import Phase
from kesef_engine.primitives import AuctionReason, BuildingLot, CashReason, Deck, Lot, TileLot
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
    PlayerState,
    PropertyState,
    TradeFrame,
)

BOARD = load_board("classic")
OWNABLE_TILES = tuple(tile.index for tile in BOARD.tiles if tile.is_ownable)
PROPERTY_TILES = tuple(tile.index for tile in BOARD.tiles if tile.kind is TileKind.PROPERTY)
RESUME_PHASES = (
    Phase.AWAITING_ROLL,
    Phase.JAIL_DECISION,
    Phase.MOVING,
    Phase.RESOLVING_TILE,
    Phase.AWAITING_PURCHASE_DECISION,
    Phase.AWAITING_END_TURN,
)
REASON_KEY = re.compile(r"error\.[a-z0-9_]+")


@st.composite
def game_states(draw: st.DrawFn) -> GameState:
    """Any *valid* GameState — arbitrary phase, frames, holdings and solvency.

    Deliberately unconstrained by reachability (G-61): a generator that walks
    ``legal_commands`` to reach states is blind to exactly the omission class these
    properties exist to catch.
    """
    seat_count = draw(st.integers(min_value=2, max_value=4))
    ids = tuple(range(seat_count))
    bankrupts = draw(st.sets(st.sampled_from(ids), max_size=seat_count - 1))
    solvent = tuple(seat for seat in ids if seat not in bankrupts)
    holders = {deck: draw(st.one_of(st.none(), st.sampled_from(solvent))) for deck in Deck}

    players: list[PlayerState] = []
    for seat in ids:
        bankrupt = seat in bankrupts
        players.append(
            make_player(
                seat,
                cash=0 if bankrupt else draw(st.integers(min_value=0, max_value=600)),
                position=draw(st.integers(min_value=0, max_value=39)),
                in_jail=False if bankrupt else draw(st.booleans()),
                jail_cards=tuple(deck for deck in Deck if holders[deck] == seat),
                bankrupt=bankrupt,
            )
        )

    tiles = [PropertyState() for _ in range(len(BOARD.tiles))]
    for index in sorted(draw(st.sets(st.sampled_from(OWNABLE_TILES), max_size=8))):
        houses = draw(st.integers(min_value=0, max_value=5)) if index in PROPERTY_TILES else 0
        mortgaged = draw(st.booleans()) if houses == 0 else False
        tiles[index] = PropertyState(owner=draw(st.sampled_from(ids)), houses=houses, mortgaged=mortgaged)

    phase = draw(st.sampled_from(sorted(Phase)))
    interrupts: tuple[InterruptFrame, ...] = ()
    winner: int | None = None
    if phase is Phase.GAME_OVER:
        winner = solvent[0]
    elif phase is Phase.AUCTION:
        interrupts = (draw(auction_frames(ids)),)
    elif phase is Phase.DEBT_SETTLEMENT:
        interrupts = (draw(debt_frames(ids)),)
    elif phase is Phase.TRADE_REVIEW:
        interrupts = (draw(trade_frames(ids)),)
    elif phase is Phase.CARD_RESOLUTION:
        step = draw(st.integers(min_value=0, max_value=2))
        interrupts = (
            CardFrame(
                resume=draw(st.sampled_from(RESUME_PHASES)),
                card_id="card.chance.property_test",
                deck=draw(st.sampled_from(sorted(Deck))),
                step=step,
            ),
        )

    dice = draw(
        st.one_of(
            st.none(),
            st.builds(
                DiceState,
                first=st.integers(min_value=1, max_value=6),
                second=st.integers(min_value=1, max_value=6),
                purpose=st.sampled_from(("move", "jail", "rent")),
            ),
        )
    )
    return GameState(
        game_id="hypothesis",
        board_id="classic",
        ruleset=draw(st.sampled_from((Ruleset.universal(), Ruleset.kids()))),
        rng=Rng(seed=draw(st.integers(min_value=0, max_value=2**16))),
        players=tuple(players),
        properties=tuple(tiles),
        phase=phase,
        current_player_id=draw(st.sampled_from(ids)),
        dice=dice,
        doubles_streak=draw(st.integers(min_value=0, max_value=2)),
        turn_number=draw(st.integers(min_value=1, max_value=200)),
        interrupts=interrupts,
        free_parking_pot=draw(st.integers(min_value=0, max_value=100)),
        elimination_order=tuple(sorted(bankrupts)),
        winner=winner,
    )


@st.composite
def auction_frames(draw: st.DrawFn, ids: tuple[int, ...]) -> AuctionFrame:
    eligible = tuple(sorted(draw(st.sets(st.sampled_from(ids), min_size=1))))
    active = tuple(sorted(draw(st.sets(st.sampled_from(eligible)))))
    turn = draw(st.one_of(st.none(), st.sampled_from(active))) if active else None
    high_bid = draw(st.integers(min_value=0, max_value=300))
    high_bidder = draw(st.sampled_from(eligible)) if high_bid else None
    min_bid = draw(st.integers(min_value=1, max_value=350))
    max_bid = draw(st.one_of(st.none(), st.integers(min_value=min_bid, max_value=800)))
    lot: Lot = draw(
        st.one_of(
            st.builds(TileLot, tile=st.sampled_from(OWNABLE_TILES)),
            st.builds(BuildingLot, building=st.sampled_from(("house", "hotel"))),
        )
    )
    return AuctionFrame(
        resume=draw(st.sampled_from(RESUME_PHASES)),
        lot=lot,
        reason=draw(st.sampled_from(sorted(AuctionReason))),
        eligible=eligible,
        active=active,
        turn=turn,
        high_bid=high_bid,
        high_bidder=high_bidder,
        min_bid=min_bid,
        max_bid=max_bid,
    )


@st.composite
def debt_frames(draw: st.DrawFn, ids: tuple[int, ...]) -> DebtFrame:
    debtor = draw(st.sampled_from(ids))
    candidates: tuple[int | str, ...] = tuple(seat for seat in ids if seat != debtor) + ("bank",)
    creditors = sorted(draw(st.sets(st.sampled_from(candidates), min_size=1, max_size=2)), key=str)
    obligations = tuple(
        Obligation(creditor=creditor, amount=draw(st.integers(min_value=1, max_value=200))) for creditor in creditors
    )
    return DebtFrame(
        resume=draw(st.sampled_from(RESUME_PHASES)),
        debtor=debtor,
        obligations=obligations,
        reason=draw(st.sampled_from(sorted(CashReason))),
        source_tile=draw(st.one_of(st.none(), st.sampled_from(OWNABLE_TILES))),
    )


@st.composite
def trade_frames(draw: st.DrawFn, ids: tuple[int, ...]) -> TradeFrame:
    proposer = draw(st.sampled_from(ids))
    recipient = draw(st.sampled_from(tuple(seat for seat in ids if seat != proposer)))
    sides = st.builds(
        TradeSide,
        cash=st.integers(min_value=0, max_value=100),
        tiles=st.sets(st.sampled_from(OWNABLE_TILES), max_size=2).map(lambda s: tuple(sorted(s))),
    )
    offer = TradeOffer(proposer=proposer, recipient=recipient, give=draw(sides), receive=draw(sides))
    return TradeFrame(resume=draw(st.sampled_from(RESUME_PHASES)), offer=offer)


def enumerable_universe(state: GameState) -> Iterator[Command]:
    """Every enumerable-kind command worth probing: all seated actors plus an unseated
    one, over every owned tile plus a fixed unowned sample. PlaceBid and ProposeTrade
    are the two ADR-005 exceptions and are exercised by their own unit tests."""
    owned = {index for index, prop in enumerate(state.properties) if prop.owner is not None}
    tiles = sorted(owned | {0, 1, 5, 12, 39})
    for actor in [player.id for player in state.players] + [99]:
        yield RollDice(player=actor)
        yield EndTurn(player=actor)
        yield EndTurn(player=actor, elapsed_seconds=30)
        yield BuyProperty(player=actor)
        yield DeclinePurchase(player=actor)
        yield PayJailFine(player=actor)
        yield UseJailCard(player=actor)
        yield RollForJail(player=actor)
        yield WithdrawFromAuction(player=actor)
        yield DeclareBankruptcy(player=actor)
        yield RespondToTrade(player=actor, accept=True)
        yield RespondToTrade(player=actor, accept=False)
        yield CancelTrade(player=actor)
        for tile in tiles:
            yield BuildHouse(player=actor, tile=tile)
            yield SellHouse(player=actor, tile=tile)
            yield MortgageProperty(player=actor, tile=tile)
            yield UnmortgageProperty(player=actor, tile=tile)


# --- Internal consistency: runnable today -------------------------------------


@given(state=game_states())
@settings(max_examples=75, deadline=None)
def test_everything_enumerated_is_approved_by_is_legal(state: GameState) -> None:
    for command in legal_commands(state):
        verdict = is_legal(state, command)
        assert verdict.legal, f"enumerated {command!r} but is_legal says {verdict.reason_key}"


@given(state=game_states())
@settings(max_examples=75, deadline=None)
def test_every_approved_enumerable_command_is_enumerated(state: GameState) -> None:
    """The completeness half is_legal can already answer: an enumerable-kind command the
    enumeration omits must be rejected — with a key, never a crash. ``EndTurn`` is
    canonicalised because ``elapsed_seconds`` is caller metadata, not decision space."""
    enumerated = set(legal_commands(state))
    for command in enumerable_universe(state):
        verdict = is_legal(state, command)
        if verdict.legal:
            is_end_turn = isinstance(command, EndTurn)
            canonical = command.model_copy(update={"elapsed_seconds": None}) if is_end_turn else command
            assert canonical in enumerated, f"is_legal approves {command!r} but legal_commands omits it"
        else:
            assert verdict.reason_key is not None
            assert REASON_KEY.fullmatch(verdict.reason_key), f"malformed reason key {verdict.reason_key!r}"


@given(state=game_states())
@settings(max_examples=50, deadline=None)
def test_legal_commands_is_deterministic(state: GameState) -> None:
    first = legal_commands(state)
    assert legal_commands(state) == first
    clone = GameState.model_validate_json(state.model_dump_json())
    assert legal_commands(clone) == first


@given(state=game_states())
@settings(max_examples=50, deadline=None)
def test_bankrupt_players_and_finished_games_are_offered_nothing(state: GameState) -> None:
    commands = legal_commands(state)
    if state.phase is Phase.GAME_OVER:
        assert commands == ()
    bankrupt = {player.id for player in state.players if player.bankrupt}
    assert all(command.player not in bankrupt for command in commands)


# --- ADR-005 against apply: scaffolded, owned by MON-102 / MON-209 -------------


@pytest.mark.skip(reason="MON-102: apply() does not exist yet — this file is completed by MON-102/MON-209")
def test_soundness_every_enumerated_command_is_accepted_by_apply() -> None:
    """ADR-005 property 1 over both generators (structural above, replay from MON-107)."""
    raise AssertionError("unskipped without being implemented — MON-102 owns this body")


@pytest.mark.skip(reason="MON-102: apply() does not exist yet — this file is completed by MON-102/MON-209")
def test_completeness_omitted_enumerable_commands_raise_illegal_command_error() -> None:
    """ADR-005 property 2: the rejection must be IllegalCommandError with a populated
    reason_key — a crash does not count as a rejection."""
    raise AssertionError("unskipped without being implemented — MON-102 owns this body")


@pytest.mark.skip(reason="MON-102: apply() does not exist yet — this file is completed by MON-102/MON-209")
def test_is_legal_agrees_with_apply_over_the_full_parameter_space() -> None:
    """ADR-005 property 3 (the oracle), with the MON-209 coverage floor: every Phase and
    every CashReason observed via hypothesis.event(), or the run fails."""
    raise AssertionError("unskipped without being implemented — MON-209 owns this body")
