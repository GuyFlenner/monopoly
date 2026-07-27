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
from collections import Counter
from collections.abc import Iterator

import pytest
from hypothesis import event, given, settings
from hypothesis import strategies as st

from helpers import make_player
from kesef_engine.board.loader import load_board
from kesef_engine.board.models import ColorGroup, TileKind
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
from kesef_engine.phases import TRANSIENT_PHASES, Phase
from kesef_engine.primitives import AuctionReason, BuildingLot, CashReason, Deck, Lot, TileLot
from kesef_engine.rng import Rng
from kesef_engine.ruleset import Ruleset, RulesetName
from kesef_engine.state import (
    HOTEL_LEVEL,
    AuctionFrame,
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
COLOR_GROUPS = tuple(sorted(ColorGroup))
# A third ruleset with a nearly empty bank. Without it the finite-stock rules (32 houses,
# 12 hotels) are only ever exercised in states where the bank is comfortably full, and a
# build offered against an exhausted bank — the ADR-005 soundness hole this generator
# missed once already — cannot occur inside a run of a few hundred examples.
SCARCE_BANK = Ruleset(name=RulesetName.UNIVERSAL, houses_available=6, hotels_available=2)
RULESETS = (Ruleset.universal(), Ruleset.kids(), SCARCE_BANK)
# ``apply`` asserts that a returned state never rests in a transient phase (reducer.py), so
# a *drawn* transient phase is an invalid state rather than a hard one: it is excluded here
# rather than filtered later. CardFrame shapes therefore leave this generator with
# CARD_RESOLUTION; they stay covered by the serialization round-trips (helpers.
# maximal_interrupts) and by test_interrupts.py's push/pop nesting.
RESTING_PHASES = tuple(phase for phase in sorted(Phase) if phase not in TRANSIENT_PHASES)
# Refined at MON-102/104 (reason: reachability invariants apply depends on, not test
# weakening): the engine only ever suspends a *resting* phase into a frame — open_debt,
# decline and propose all record post-move/portfolio phases — so a frame resuming a
# transient phase is invalid, not merely unreachable. Transient resumes stay covered by
# the serialization round-trips (helpers.maximal_interrupts).
RESUME_PHASES = (
    Phase.AWAITING_ROLL,
    Phase.JAIL_DECISION,
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

    Unconstrained is not the same as unweighted. Three draws are biased, because uniform
    draws made ~70% of states offer *no* legal command at all and left five command kinds
    never applied even once across a run (the coverage floor below is what noticed):
    a complete colour group is drawn one time in three, an auction always has an active
    bidder and almost always a bidding turn, and a jailed current player is the norm in
    ``JAIL_DECISION``. Every shape reachable before remains reachable.
    """
    seat_count = draw(st.integers(min_value=2, max_value=4))
    ids = tuple(range(seat_count))
    ruleset = draw(st.sampled_from(RULESETS))
    phase = draw(st.sampled_from(RESTING_PHASES))
    current = draw(st.sampled_from(ids))
    bankrupts = draw(st.sets(st.sampled_from(ids), max_size=seat_count - 1))
    solvent = tuple(seat for seat in ids if seat not in bankrupts)
    holders = {deck: draw(st.sampled_from((None, *solvent))) for deck in Deck}
    if phase is Phase.JAIL_DECISION and current in solvent and draw(st.booleans()):
        # Leaving jail on a card is one of the three offers the phase exists to present,
        # so half of the JAIL_DECISION draws put a card in the jailed player's hand.
        holders[draw(st.sampled_from(sorted(Deck)))] = current

    players: list[PlayerState] = []
    for seat in ids:
        bankrupt = seat in bankrupts
        jailed = draw(st.booleans())
        position = draw(st.integers(min_value=0, max_value=39))
        if phase is Phase.JAIL_DECISION and seat == current:
            jailed = draw(st.integers(min_value=0, max_value=4)) != 0
        if phase is Phase.AWAITING_PURCHASE_DECISION and seat == current and draw(st.booleans()):
            # The phase exists *because* the current player stands on an ownable tile;
            # off-tile draws stay reachable, they simply stop being the common case.
            position = draw(st.sampled_from(OWNABLE_TILES))
        players.append(
            make_player(
                seat,
                cash=0 if bankrupt else draw(st.integers(min_value=0, max_value=1500)),
                position=position,
                in_jail=False if bankrupt else jailed,
                jail_cards=tuple(deck for deck in Deck if holders[deck] == seat),
                bankrupt=bankrupt,
            )
        )

    tiles = [PropertyState() for _ in range(len(BOARD.tiles))]
    for index in sorted(draw(st.sets(st.sampled_from(OWNABLE_TILES), max_size=8))):
        houses = draw(st.integers(min_value=0, max_value=5)) if index in PROPERTY_TILES else 0
        mortgaged = draw(st.booleans()) if houses == 0 else False
        tiles[index] = PropertyState(owner=draw(st.sampled_from(ids)), houses=houses, mortgaged=mortgaged)
    if draw(st.integers(min_value=0, max_value=2)) == 0:
        # One hand holds a whole group, level even across it: the only shape in which
        # BuildHouse (and the group-doubled rent it feeds) can be legal at all.
        group = draw(st.sampled_from(COLOR_GROUPS))
        owner = draw(st.sampled_from(ids))
        level = draw(st.integers(min_value=0, max_value=4))
        for index in BOARD.group_members(group):
            tiles[index] = PropertyState(owner=owner, houses=level)
    _fit_building_stock(tiles, ruleset)

    cash_by_id = {player.id: player.cash for player in players}
    interrupts: tuple[InterruptFrame, ...] = ()
    winner: int | None = None
    if phase is Phase.GAME_OVER:
        winner = solvent[0]
    elif phase is Phase.AUCTION:
        interrupts = (draw(auction_frames(ids, cash_by_id)),)
    elif phase is Phase.DEBT_SETTLEMENT:
        interrupts = (draw(debt_frames(ids, solvent)),)
    elif phase is Phase.TRADE_REVIEW:
        interrupts = (draw(trade_frames(ids)),)

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
        ruleset=ruleset,
        rng=Rng(seed=draw(st.integers(min_value=0, max_value=2**16))),
        players=tuple(players),
        properties=tuple(tiles),
        phase=phase,
        current_player_id=current,
        dice=dice,
        doubles_streak=draw(st.integers(min_value=0, max_value=2)),
        turn_number=draw(st.integers(min_value=1, max_value=200)),
        interrupts=interrupts,
        free_parking_pot=draw(st.integers(min_value=0, max_value=100)),
        elimination_order=tuple(sorted(bankrupts)),
        winner=winner,
    )


def _fit_building_stock(tiles: list[PropertyState], ruleset: Ruleset) -> None:
    """Trim buildings, in board order, to what the bank actually owns.

    ``GameState`` refuses a board holding more than ``houses_available`` houses or
    ``hotels_available`` hotels, so an over-built draw is an invalid state rather than an
    interesting one. Trimming (rather than shrinking the per-tile draw) keeps a *full* bank
    reachable, which is the state the stock rules are about.
    """
    houses = hotels = 0
    for index, prop in enumerate(tiles):
        if prop.houses == HOTEL_LEVEL and hotels < ruleset.hotels_available:
            hotels += 1
        elif 0 < prop.houses < HOTEL_LEVEL and houses + prop.houses <= ruleset.houses_available:
            houses += prop.houses
        elif prop.houses:
            tiles[index] = PropertyState(owner=prop.owner, mortgaged=prop.mortgaged)


@st.composite
def auction_frames(draw: st.DrawFn, ids: tuple[int, ...], cash_by_id: dict[int, int]) -> AuctionFrame:
    eligible = tuple(sorted(draw(st.sets(st.sampled_from(ids), min_size=1))))
    # ``active`` and ``turn``: an auction with nobody left to bid is a state the reducer
    # resolves rather than rests in, and it offers no PlaceBid or WithdrawFromAuction at
    # all — with both drawn freely, 124 of 134 generated auctions had ``turn is None`` and
    # the two auction commands were never applied. One bid turn in ten is still empty, for
    # the between-lots shape.
    active = tuple(sorted(draw(st.sets(st.sampled_from(eligible), min_size=1))))
    turn = None if draw(st.integers(min_value=0, max_value=9)) == 0 else draw(st.sampled_from(active))
    high_bid = draw(st.integers(min_value=0, max_value=300))
    # Enforced by ``GameState._check_interrupts`` since 2026-07-27: a standing high bid the
    # bidder cannot afford is an invalid state, not merely an unreachable one. Kept here so
    # the generator produces valid states rather than discarding them.
    solvent_for_bid = tuple(player for player in eligible if cash_by_id[player] >= high_bid)
    if high_bid and not solvent_for_bid:
        high_bid = 0
    high_bidder = draw(st.sampled_from(solvent_for_bid)) if high_bid else None
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
def debt_frames(draw: st.DrawFn, ids: tuple[int, ...], solvent: tuple[int, ...]) -> DebtFrame:
    debtor = draw(st.sampled_from(ids))
    # Enforced by ``GameState._check_interrupts`` since 2026-07-27: a bankrupt creditor is an
    # invalid state (MON-207 settles or voids a leaving player's claims), so drawing one
    # would only produce states the model refuses.
    candidates: tuple[int | str, ...] = tuple(seat for seat in solvent if seat != debtor) + ("bank",)
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


# --- ADR-005 against apply: soundness + completeness live (MON-102/104); the oracle
# --- with its coverage floor stays with MON-209 ---------------------------------


SOUNDNESS_COVERAGE_FLOOR = frozenset(
    {
        "roll_dice",
        "end_turn",
        "buy_property",
        "decline_purchase",
        "build_house",
        "place_bid",
        "withdraw_from_auction",
        "use_jail_card",
        "declare_bankruptcy",
    }
)
"""Command kinds the soundness property must actually have pushed through ``apply``.

MON-209 owns the full "every Phase and every CashReason" floor; this narrower one arrives
early because it is load-bearing *now*: with a uniform generator this property called
``apply`` 54 times over 75 examples and never once on roll_dice, place_bid,
withdraw_from_auction, build_house or use_jail_card — so the ADR-005 soundness hole in
BuildHouse's stock check (the flag-gated check against an unconditional state validator)
sailed through a green property test. A property that never reaches a command kind is not
covering it, and only a floor says so out loud.
"""


def test_soundness_every_enumerated_command_is_accepted_by_apply() -> None:
    """ADR-005 property 1 over the structural generator (the replay generator's half
    lives in MON-107's goldens): apply accepts everything legal_commands offers.

    The ``@given`` body is nested so the run can be *counted*: hypothesis calls the body
    once per example, and the floor is an assertion about the run as a whole.
    """
    from kesef_engine.reducer import apply

    applied: Counter[str] = Counter()

    # 600 examples: the rarest floor kind lands 5-25 times per run (measured over repeated
    # runs), and the whole property costs ~2.5s — the suite stays inside its budget.
    @given(state=game_states())
    @settings(max_examples=600, deadline=None)
    def check(state: GameState) -> None:
        for command in legal_commands(state):
            apply(state, command)  # a raise here is the property's failure
            applied[command.kind] += 1
            event(f"applied {command.kind}")

    check()
    missing = sorted(SOUNDNESS_COVERAGE_FLOOR - set(applied))
    assert not missing, f"the property never applied {missing}; it is not covering those kinds"
    assert sum(applied.values()) >= 500, f"only {sum(applied.values())} commands applied across the run"


@given(state=game_states())
@settings(max_examples=50, deadline=None)
def test_completeness_omitted_enumerable_commands_raise_illegal_command_error(state: GameState) -> None:
    """ADR-005 property 2: the rejection must be IllegalCommandError with a populated
    reason_key — a crash does not count as a rejection."""
    from kesef_engine.errors import IllegalCommandError
    from kesef_engine.reducer import apply

    enumerated = set(legal_commands(state))
    for command in enumerable_universe(state):
        is_end_turn = isinstance(command, EndTurn)
        canonical = command.model_copy(update={"elapsed_seconds": None}) if is_end_turn else command
        if canonical in enumerated:
            continue
        with pytest.raises(IllegalCommandError) as excinfo:
            apply(state, command)
        assert excinfo.value.reason_key, f"{command!r} was rejected without a reason key"
        assert REASON_KEY.fullmatch(excinfo.value.reason_key)


@pytest.mark.skip(reason="MON-209: the is_legal <=> apply oracle with the Phase/CashReason coverage floor")
def test_is_legal_agrees_with_apply_over_the_full_parameter_space() -> None:
    """ADR-005 property 3 (the oracle), with the MON-209 coverage floor: every Phase and
    every CashReason observed via hypothesis.event(), or the run fails."""
    raise AssertionError("unskipped without being implemented — MON-209 owns this body")
