"""MON-101 / MON-209 — the three ADR-005 properties over the structural generator.

Two generators are required, and G-61 says why: the **unconstrained structural generator**
below builds arbitrary *valid* states directly, because both sides of every ADR-005
property see the same state, so reachability is irrelevant — and a generator that reached
states *via* ``legal_commands`` would be blind to exactly the omission class these
properties exist to catch. The reachable half — every invariant that is about a state a
real game can be in — is the replay machine in ``test_invariants.py``.

All three properties now run:

1. **Soundness** — everything ``legal_commands`` enumerates is approved by ``is_legal``
   *and* accepted by ``apply``, with a per-kind coverage floor.
2. **Completeness over the 15 enumerable kinds** — everything ``is_legal`` approves is
   enumerated, and every omitted one is rejected as ``IllegalCommandError`` with a
   populated snake_case ``reason_key``, never a crash.
3. **The oracle** — over the *whole* parameter space, including all ``PlaceBid`` amounts
   and all ``ProposeTrade`` drafts, ``is_legal`` and ``apply`` agree on both the verdict
   and the reason, with a floor that every Phase and all 17 command kinds were reached.

MON-209 also stocked the two card decks in the generator: they were empty, so every state
that landed on a card tile dealt nothing and thirty-one card effects had no property
coverage at all.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterator
from typing import get_args

import pytest
from hypothesis import event, given, settings
from hypothesis import strategies as st

from helpers import make_player
from kesef_engine.board.loader import load_board
from kesef_engine.board.models import BOARD_SIZE, ColorGroup, TileKind
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
from kesef_engine.decks import CHANCE_CARD_IDS, COMMUNITY_CHEST_CARD_IDS, GET_OUT_OF_JAIL_IDS
from kesef_engine.legality import is_legal, legal_commands, minimum_bid
from kesef_engine.phases import TRANSIENT_PHASES, Phase
from kesef_engine.primitives import AuctionReason, BuildingLot, CashReason, Deck, Lot, PlayerId, TileIndex, TileLot
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
CARD_TILES = tuple(tile.index for tile in BOARD.tiles if tile.kind in (TileKind.CHANCE, TileKind.COMMUNITY_CHEST))
COLOR_GROUPS = tuple(sorted(ColorGroup))
# A third ruleset with a nearly empty bank. Without it the finite-stock rules (32 houses,
# 12 hotels) are only ever exercised in states where the bank is comfortably full, and a
# build offered against an exhausted bank — the ADR-005 soundness hole this generator
# missed once already — cannot occur inside a run of a few hundred examples.
SCARCE_BANK = Ruleset(name=RulesetName.UNIVERSAL, houses_available=6, hotels_available=2)
# And a fourth with the Free Parking house rule on (MON-209): it is the only configuration
# in which ``CashReason.FREE_PARKING_POT`` — a third counterparty that is neither a player
# nor the bank, and therefore the one the money-supply invariant can get wrong — moves any
# money at all.
POTTED = Ruleset.universal().model_copy(update={"free_parking_pot_enabled": True})
RULESETS = (Ruleset.universal(), Ruleset.kids(), SCARCE_BANK, POTTED)
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
def game_states(draw: st.DrawFn, phase: Phase | None = None) -> GameState:
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

    ``phase`` pins the phase instead of drawing it, which the MON-209 oracle uses to ask
    for a state a given command kind could be legal in at all. Drawn freely, phase and
    command kind agree about one time in eight, and eight of the seventeen kinds went a
    900-example run without a single accepted example.
    """
    seat_count = draw(st.integers(min_value=2, max_value=4))
    ids = tuple(range(seat_count))
    ruleset = draw(st.sampled_from(RULESETS))
    if phase is None:
        phase = draw(st.sampled_from(RESTING_PHASES))
    # A trade review needs two solvent parties, so the bankruptcy draw leaves two seats
    # standing for it: with only one survivor the phase itself cannot exist.
    survivors = 2 if phase is Phase.TRADE_REVIEW else 1
    bankrupts = draw(st.sets(st.sampled_from(ids), max_size=seat_count - survivors))
    solvent = tuple(seat for seat in ids if seat not in bankrupts)
    # Drawn from the *solvent* seats since MON-209 (reason: reachability the invariants
    # depend on, not test weakening). A bankrupt current player is unreachable by
    # construction — G-14's fix put the skip at ``turns.advance_turn``, the single point
    # where the seat moves, and ``insolvency.resolve_after_command`` hands the seat on when
    # the holder goes under. Drawn from every seat it swamped the run: with 2-4 seats and up
    # to n-1 bankrupt, a large share of states offered no legal command *because the seat
    # was empty*, which is the one reason that teaches nothing. The bankrupt-actor rejection
    # is still covered — every other seat may be bankrupt, and
    # ``test_bankrupt_players_and_finished_games_are_offered_nothing`` asserts it directly.
    current = draw(st.sampled_from(solvent))
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
        if phase is Phase.AWAITING_ROLL and seat == current and draw(st.booleans()):
            # Half of the AWAITING_ROLL draws park the roller a *likely* throw short of a
            # card tile — 6, 7 or 8, which between them are 44% of two dice (MON-209). With
            # a free position draw a ``RollDice`` lands on one of the six card tiles about
            # once in seven, so stocking the decks alone still left the card path thinly
            # covered here. The replay machine in ``test_invariants.py`` is what covers the
            # card effects in bulk; this only has to make them *reachable* from the
            # structural generator, where the ADR-005 properties live.
            offset = draw(st.sampled_from((6, 7, 8)))
            position = (draw(st.sampled_from(CARD_TILES)) - offset) % BOARD_SIZE
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

    # Owners are drawn from the *solvent* seats since MON-209, for the same reason: a
    # bankrupt player holding a deed contradicts "bankrupt ⇒ holds nothing", which
    # ``handle_declare_bankruptcy`` enforces (step 7, every tile reassigned before the seat
    # is marked) and which is itself one of MON-209's invariants over reachable states. The
    # generator was manufacturing states the game can never be in and then spending most of
    # a run inside them.
    tiles = [PropertyState() for _ in range(len(BOARD.tiles))]
    for index in sorted(draw(st.sets(st.sampled_from(OWNABLE_TILES), max_size=8))):
        houses = draw(st.integers(min_value=0, max_value=5)) if index in PROPERTY_TILES else 0
        mortgaged = draw(st.booleans()) if houses == 0 else False
        tiles[index] = PropertyState(owner=draw(st.sampled_from(solvent)), houses=houses, mortgaged=mortgaged)
    if draw(st.integers(min_value=0, max_value=2)) == 0:
        # One hand holds a whole group, level even across it: the only shape in which
        # BuildHouse (and the group-doubled rent it feeds) can be legal at all.
        group = draw(st.sampled_from(COLOR_GROUPS))
        owner = draw(st.sampled_from(solvent))
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
        # Bidders, debtors and trade parties are all drawn from the solvent seats since
        # MON-209 (same reachability reason as the owners above): ``auction.open_auction``
        # filters bankrupts out of ``bidders``, a bankrupt player is never the debtor of a
        # live frame, and ``insolvency._void_claims_of`` cancels any trade a leaving player
        # was party to. Every such state was rejected on ``error.bankrupt`` before a single
        # rule was consulted.
        interrupts = (draw(auction_frames(solvent, cash_by_id)),)
    elif phase is Phase.DEBT_SETTLEMENT:
        interrupts = (draw(debt_frames(solvent, solvent)),)
    elif phase is Phase.TRADE_REVIEW:
        interrupts = (draw(trade_frames(solvent)),)

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
    held = {GET_OUT_OF_JAIL_IDS[deck] for deck, holder in holders.items() if holder is not None}
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
        chance_deck=draw(piles(CHANCE_CARD_IDS, held)),
        community_chest_deck=draw(piles(COMMUNITY_CHEST_CARD_IDS, held)),
        free_parking_pot=draw(st.integers(min_value=0, max_value=100)),
        elimination_order=tuple(sorted(bankrupts)),
        winner=winner,
    )


@st.composite
def piles(draw: st.DrawFn, card_ids: tuple[str, ...], held: set[str]) -> tuple[str, ...]:
    """A deck, rotated so that any card can be the next one dealt.

    Added at MON-209: the generator left both decks **empty**, so every state it produced
    landed on a card tile and dealt nothing — thirty-one card effects with zero coverage
    from the property tests, which is exactly where the ADR-005 soundness holes had been
    hiding before. Rotation rather than a free shuffle keeps the pile a real deck (each id
    present once, minus a card already in somebody's hand) while still putting every card
    on top across a run.

    One draw in eight is empty, because ``cards.draw_and_resolve`` has a branch for a deck
    that cannot deal and a hand-built save can arrive that way. The weighting is a
    ``sampled_from`` rather than ``integers(0, 7) == 0``: hypothesis biases integer draws
    hard towards their boundaries, which made "one in eight" nearer two in five.
    """
    if draw(st.sampled_from((True, False, False, False, False, False, False, False))):
        return ()
    pile = tuple(card_id for card_id in card_ids if card_id not in held)
    offset = draw(st.integers(min_value=0, max_value=len(pile) - 1))
    return pile[offset:] + pile[:offset]


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
    debtor = draw(st.sampled_from(ids))  # ``ids`` is the solvent set since MON-209
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


# --- ADR-005 property 3: the oracle over the *full* parameter space (MON-209) ---------


ALL_COMMAND_KINDS = (
    "build_house",
    "buy_property",
    "cancel_trade",
    "declare_bankruptcy",
    "decline_purchase",
    "end_turn",
    "mortgage_property",
    "pay_jail_fine",
    "place_bid",
    "propose_trade",
    "respond_to_trade",
    "roll_dice",
    "roll_for_jail",
    "sell_house",
    "unmortgage_property",
    "use_jail_card",
    "withdraw_from_auction",
)
"""All 17 kinds in the ``Command`` union. Pinned by a test against the union itself, so a
new command cannot join the game and skip the oracle."""


@st.composite
def commands_of_kind(draw: st.DrawFn, state: GameState, kind: str) -> Command:
    """One command of ``kind``, half plausible for ``state`` and half nonsense.

    The kind is drawn *first* and the parameters second, which is what gives the oracle a
    per-kind coverage floor it can actually meet. Sampling uniformly from the whole
    parameter space instead left twelve of the seventeen kinds with no accepted example in
    a 900-example run: the space is overwhelmingly illegal, so an unweighted draw tests the
    rejection path a thousand times and the acceptance path never.

    "Plausible" means: the actor the phase is *for* (the current player, the bidding turn,
    the debtor, the trade's two parties, a tile's owner), a bid at the legal floor or one
    either side of it, and trade sides drawn from what the parties actually hold. Every
    plausible draw is paired with an arbitrary one, so both verdicts stay reachable for
    every kind. ``PlaceBid`` and ``ProposeTrade`` matter most: they are the two ADR-005
    exceptions, so ``is_legal`` is the *only* statement of what they permit and this
    property is the only thing holding that statement to what ``apply`` does.
    """
    seated = tuple(player.id for player in state.players)
    frame = state.top_interrupt
    stranger = draw(st.sampled_from((*seated, 99)))

    def actor(plausible: PlayerId | None) -> PlayerId:
        """The actor the phase is *for*, three times in four; a stranger otherwise.

        Weighted rather than a coin flip: a stranger is rejected on ``error.bankrupt``,
        ``error.unknown_player`` or ``error.not_your_turn`` before a single rule is read, so
        an even split spent half the run re-proving the actor gate.
        """
        if plausible is None:
            return stranger
        return draw(st.sampled_from((plausible, plausible, plausible, stranger)))

    turn_actor = actor(state.current_player_id)
    match kind:
        case "roll_dice":
            return RollDice(player=turn_actor)
        case "end_turn":
            stamp = draw(st.one_of(st.none(), st.integers(min_value=0, max_value=10**6)))
            return EndTurn(player=turn_actor, elapsed_seconds=stamp)
        case "buy_property":
            return BuyProperty(player=turn_actor)
        case "decline_purchase":
            return DeclinePurchase(player=turn_actor)
        case "pay_jail_fine":
            return PayJailFine(player=turn_actor)
        case "use_jail_card":
            return UseJailCard(player=turn_actor)
        case "roll_for_jail":
            return RollForJail(player=turn_actor)
        case "withdraw_from_auction":
            return WithdrawFromAuction(player=actor(frame.turn if isinstance(frame, AuctionFrame) else None))
        case "place_bid":
            amounts: list[st.SearchStrategy[int]] = [st.integers(min_value=1, max_value=2000)]
            if isinstance(frame, AuctionFrame):
                floor = minimum_bid(frame)
                amounts.append(st.sampled_from((floor, max(1, floor - 1), floor + 1, floor * 2)))
            bidder = actor(frame.turn if isinstance(frame, AuctionFrame) else None)
            return PlaceBid(player=bidder, amount=draw(st.one_of(*amounts)))
        case "respond_to_trade":
            recipient = actor(frame.offer.recipient if isinstance(frame, TradeFrame) else None)
            return RespondToTrade(player=recipient, accept=draw(st.booleans()))
        case "cancel_trade":
            return CancelTrade(player=actor(frame.offer.proposer if isinstance(frame, TradeFrame) else None))
        case "declare_bankruptcy":
            return DeclareBankruptcy(player=actor(frame.debtor if isinstance(frame, DebtFrame) else None))
        case "propose_trade":
            proposer = draw(st.sampled_from(seated))
            recipient = draw(st.sampled_from(tuple(seat for seat in seated if seat != proposer)))
            offer = TradeOffer(
                proposer=proposer,
                recipient=recipient,
                give=draw(trade_sides(state, proposer)),
                receive=draw(trade_sides(state, recipient)),
            )
            return ProposeTrade(player=draw(st.sampled_from((proposer, stranger))), offer=offer)
        case _:
            # Plausible per kind, not merely "some owned tile": an unmortgage aimed at an
            # unmortgaged deed is always illegal, and with a shared owned-tile pool the
            # oracle went a whole run without one legal ``unmortgage_property``.
            plausible = _plausible_tiles(state, kind)
            # The coin is drawn into a name of its own: inside the conditional expression mypy
            # binds ``DrawFn``'s type variable to bool and then rejects the tile draw.
            prefer_plausible = draw(st.booleans())
            pool = plausible if plausible and prefer_plausible else TILE_PROBES
            tile = draw(st.sampled_from(pool))
            owner = state.properties[tile].owner
            holder = actor(owner)
            if kind == "build_house":
                return BuildHouse(player=holder, tile=tile)
            if kind == "sell_house":
                return SellHouse(player=holder, tile=tile, demolish_hotel=draw(st.booleans()))
            if kind == "mortgage_property":
                return MortgageProperty(player=holder, tile=tile)
            assert kind == "unmortgage_property", f"commands_of_kind has no branch for {kind!r}"
            return UnmortgageProperty(player=holder, tile=tile)


TILE_PROBES = (*OWNABLE_TILES, 0, 10, 20, 30)
"""Every ownable tile plus the four corners — the tiles nothing may ever be built on."""


def _plausible_tiles(state: GameState, kind: str) -> tuple[TileIndex, ...]:
    """Tiles that could plausibly be the subject of ``kind`` in ``state``. Sampling only.

    Kind-specific rather than "any owned tile": an unmortgage aimed at an unmortgaged deed
    and a build aimed at an incomplete group are *always* illegal, so a shared pool spent a
    whole 60-example run without one legal ``build_house`` or ``unmortgage_property``.
    """
    plausible: list[TileIndex] = []
    for index, prop in enumerate(state.properties):
        match kind:
            case "build_house":
                group = BOARD.tile(index).group
                if prop.owner is None or prop.mortgaged or prop.houses >= HOTEL_LEVEL or group is None:
                    continue
                if state.owns_whole_group(prop.owner, group):
                    plausible.append(index)
            case "sell_house":
                if prop.houses:
                    plausible.append(index)
            case "mortgage_property":
                if prop.owner is not None and not prop.mortgaged:
                    plausible.append(index)
            case _:
                if prop.mortgaged:
                    plausible.append(index)
    return tuple(plausible)


@st.composite
def trade_sides(draw: st.DrawFn, state: GameState, party: PlayerId) -> TradeSide:
    """One half of an offer: half drawn from what ``party`` actually holds, half arbitrary."""
    held = state.tiles_owned_by(party)
    prefer_held = draw(st.booleans())  # named, for the same mypy reason as above
    tile_pool = held if held and prefer_held else OWNABLE_TILES
    return TradeSide(
        cash=draw(st.sampled_from((0, 0, 1, 50, state.player(party).cash))),
        tiles=tuple(sorted(draw(st.sets(st.sampled_from(tile_pool), max_size=2)))),
        jail_cards=tuple(sorted(draw(st.sets(st.sampled_from(sorted(Deck)), max_size=1)))),
    )


_PORTFOLIO = (Phase.AWAITING_ROLL, Phase.JAIL_DECISION, Phase.AWAITING_END_TURN)
PHASES_FOR_KIND: dict[str, tuple[Phase, ...]] = {
    "roll_dice": (Phase.AWAITING_ROLL,),
    "end_turn": (Phase.AWAITING_END_TURN,),
    "buy_property": (Phase.AWAITING_PURCHASE_DECISION,),
    "decline_purchase": (Phase.AWAITING_PURCHASE_DECISION,),
    "pay_jail_fine": (Phase.JAIL_DECISION,),
    "use_jail_card": (Phase.JAIL_DECISION,),
    "roll_for_jail": (Phase.JAIL_DECISION,),
    "place_bid": (Phase.AUCTION,),
    "withdraw_from_auction": (Phase.AUCTION,),
    "respond_to_trade": (Phase.TRADE_REVIEW,),
    "cancel_trade": (Phase.TRADE_REVIEW,),
    "declare_bankruptcy": (Phase.DEBT_SETTLEMENT,),
    "build_house": _PORTFOLIO,
    "unmortgage_property": _PORTFOLIO,
    "sell_house": (*_PORTFOLIO, Phase.DEBT_SETTLEMENT, Phase.AUCTION),
    "mortgage_property": (*_PORTFOLIO, Phase.DEBT_SETTLEMENT, Phase.AUCTION),
    "propose_trade": (*_PORTFOLIO, Phase.DEBT_SETTLEMENT),
}
"""The phases in which each kind *could* be legal — ``PORTFOLIO_PHASES`` and
``RAISING_PHASES`` as ``legality.py`` applies them.

Only a sampling hint, never an assertion: the oracle asks for one of these phases half the
time so that the acceptance branch is reached, and draws freely the other half so that a
kind offered in a phase this table forgot is still caught by the property itself.
"""


@st.composite
def states_with_command_of_kind(draw: st.DrawFn, kind: str) -> tuple[GameState, Command]:
    """A state paired with a command of exactly ``kind``.

    The phase is pinned to one the kind could be legal in three times in four, and drawn
    freely otherwise — so the acceptance branch is reached often, and a phase that offers
    the kind but is missing from ``PHASES_FOR_KIND`` is still caught by the property.
    """
    wanted = draw(st.sampled_from((None, *PHASES_FOR_KIND[kind] * 3)))
    state = draw(game_states(phase=wanted))
    return state, draw(commands_of_kind(state, kind))


def test_the_oracle_covers_every_command_kind_in_the_union() -> None:
    """Guards the floor below: a kind added to ``Command`` and not to ``ALL_COMMAND_KINDS``
    would leave the oracle silently narrower than the game."""
    from kesef_engine.commands import Command as CommandUnion

    members = get_args(get_args(CommandUnion)[0])
    assert {member.model_fields["kind"].default for member in members} == set(ALL_COMMAND_KINDS)


@pytest.mark.parametrize("kind", ALL_COMMAND_KINDS)
def test_is_legal_agrees_with_apply_over_the_full_parameter_space(kind: str) -> None:
    """ADR-005 property 3 — the oracle — with MON-209's coverage floor, per command kind.

    ``is_legal`` says yes ⇒ ``apply`` accepts. ``is_legal`` says no ⇒ ``apply`` raises
    ``IllegalCommandError`` specifically, **for the same reason key**: a ``ValidationError``,
    an ``AssertionError`` or a ``KeyError`` is a bug wearing a rejection's clothes, and
    ``pytest.raises`` on the concrete type is what tells the two apart (G-61).

    Runs over the unconstrained structural generator on purpose: both sides see the same
    state, so reachability is irrelevant, and a property that could only reach states a
    buggy ``legal_commands`` admits would be blind to exactly the omission class ADR-005 is
    about. The reachable half is the replay machine in ``test_invariants.py``.

    **Parametrized per kind rather than pooled**, which is what makes the coverage floor
    below hold by construction. Pooled over one 900-example run, hypothesis's exploration is
    nothing like uniform — it drew ``sell_house`` 82 times and ``end_turn`` 20 — and eight of
    the seventeen kinds finished a green run without one accepted example. A floor that
    depends on a distribution is a floor that flaps.
    """
    from kesef_engine.errors import IllegalCommandError
    from kesef_engine.reducer import apply

    accepted: Counter[str] = Counter()
    rejected: Counter[str] = Counter()

    @given(pair=states_with_command_of_kind(kind))
    @settings(max_examples=60, deadline=None)
    def check(pair: tuple[GameState, Command]) -> None:
        state, command = pair
        assert command.kind == kind
        verdict = is_legal(state, command)
        event(f"{'legal' if verdict.legal else 'illegal'} {kind} in {state.phase.value}")
        if verdict.legal:
            apply(state, command)  # any raise at all is the property's failure
            accepted[state.phase.value] += 1
            return
        assert verdict.reason_key is not None
        with pytest.raises(IllegalCommandError) as excinfo:
            apply(state, command)
        assert excinfo.value.reason_key == verdict.reason_key, "apply rejected for a reason is_legal did not give"
        rejected[verdict.reason_key] += 1

    check()
    # Both branches, for this kind, or the run proved nothing about it. The acceptance floor
    # is the one that needs stating: a rejection is almost free — any command sent into the
    # wrong phase is one — so a green oracle that never approved a ``place_bid`` or a
    # ``propose_trade`` would have tested nothing about the two kinds ADR-005 exempts.
    assert accepted, f"is_legal never approved a {kind}, so apply's acceptance of it is untested"
    assert rejected, f"is_legal never rejected a {kind}, so apply's rejection of it is untested"


@pytest.mark.parametrize("phase", RESTING_PHASES, ids=lambda phase: phase.value)
def test_the_structural_generator_can_produce_every_phase_a_caller_can_hold(phase: Phase) -> None:
    """The Phase half of MON-209's floor over the structural generator, stated as
    realizability rather than as a hoped-for distribution.

    Asking the generator for each phase in turn is deterministic; sweeping 200 free draws
    and asserting all eight turned up was not — hypothesis's exploration is nowhere near
    uniform, and that version passed alone and failed inside the full suite.

    The remaining three phases are ``TRANSIENT_PHASES``, and their absence is not an
    oversight: ``apply`` asserts that a returned state never rests in one (reducer.py), so
    they are not states a caller can hold. The replay machine asserts that exclusion as a
    live invariant, and the partition is pinned below.
    """

    @given(state=game_states(phase=phase))
    @settings(max_examples=8, deadline=None)
    def produce(state: GameState) -> None:
        assert state.phase is phase
        event(f"phase {phase.value}")

    produce()


def test_the_phases_split_cleanly_into_restable_and_transient() -> None:
    """So that a new ``Phase`` cannot join neither half and go uncovered."""
    assert set(RESTING_PHASES) | TRANSIENT_PHASES == set(Phase)
    assert not set(RESTING_PHASES) & TRANSIENT_PHASES
