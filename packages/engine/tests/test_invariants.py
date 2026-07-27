"""MON-209 — the invariant suite: spec §6's restated list, one named check each.

This is the **replay** half of the pair G-61 asks for. Every state it examines is reached by
folding ``legal_commands`` through ``apply`` from ``new_game``, so every state is one a real
game can be in — which is the only way to state the invariants that are *about* reachable
states, and in particular the deadlock catcher:

    legal_commands(state) is non-empty unless the phase is GAME_OVER

That one is meaningless over the structural generator, where most states offer nothing at
all because they were assembled rather than played into. The other half — ADR-005 soundness,
completeness and the ``is_legal`` oracle over an unconstrained structural generator — lives
in ``test_legality_properties.py``. The two are complementary, not redundant: a too-narrow
``legal_commands`` hides states from this file, and this file cannot see a state no policy
reaches. Neither generator alone is enough.

**Every invariant is a separate named function**, so a failure says which one broke. That is
the point of the item: a failing invariant here means a rule or the state model is wrong, and
the answer is to fix the rule, never to narrow the generator.

**Two drivers over the same checks**, because they answer different questions:

* :class:`ReplayedGame` — a hypothesis ``RuleBasedStateMachine``. It *hunts*: five policies
  with different appetites, shrinking any violation to a minimal command sequence.
* :func:`test_seeded_games_meet_the_coverage_floor` — a fixed list of seeds and policies. It
  *guarantees*: a green property test that never entered an auction proves nothing (spec §6),
  and hypothesis's stateful exploration is far too variable to hang a floor on. Two probe
  runs of 12,000 steps each differed by four ``CashReason`` values and one whole phase. So
  the floor is asserted over committed seeds, the same discipline the goldens use, and a
  regression names exactly what stopped being reached.

The four money invariants split the way GAP G-60 asked for, because "money is conserved" on
its own had no oracle — no bank is modelled, GO mints and taxes burn:

1. **ledger consistency** — every ``CashChanged.balance`` is that player's previous balance
   plus that event's ``delta``, in order;
2. **paired transfers** — a movement whose counterparty is a *player* has its mirror entry
   in the same command's batch: equal and opposite, same reason;
3. **per-player reconciliation** — cash is always opening cash plus the sum of that player's
   ledger deltas, so nothing moved money without emitting the one event allowed to;
4. **money-supply accounting** — the change in (all player cash + the Free Parking pot)
   equals the net of the entries whose counterparty is the *bank*. The bank is the only mint
   and the only furnace; the pot merely holds money, which is exactly why it is a named
   counterparty rather than a bank alias.
"""

from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass, field

from hypothesis import HealthCheck, event, settings
from hypothesis import strategies as st
from hypothesis.stateful import (
    RuleBasedStateMachine,
    initialize,
    invariant,
    precondition,
    rule,
    run_state_machine_as_test,
)
from test_legality_properties import trade_sides

from kesef_engine.board.models import ColorGroup
from kesef_engine.commands import Command, ProposeTrade, RespondToTrade, SellHouse, TradeOffer, TradeSide
from kesef_engine.decks import CHANCE_CARD_IDS, COMMUNITY_CHEST_CARD_IDS, GET_OUT_OF_JAIL_IDS
from kesef_engine.events import BuildingChanged, CardDrawn, CashChanged, Event, GameEnded
from kesef_engine.factory import Seat, new_game
from kesef_engine.legality import is_legal, legal_commands
from kesef_engine.phases import TRANSIENT_PHASES, Phase
from kesef_engine.primitives import CashReason, Deck, PlayerId, TileIndex
from kesef_engine.reducer import apply
from kesef_engine.ruleset import Ruleset, RulesetName
from kesef_engine.state import HOTEL_LEVEL, DebtFrame, GameState, PropertyState

SEATS = (Seat(name="Ada"), Seat(name="Boaz"), Seat(name="Carmel"), Seat(name="Dana"))

SCARCE_BANK = Ruleset(name=RulesetName.UNIVERSAL, houses_available=6, hotels_available=2)
"""A bank that runs out. The building-stock invariants are about an *exhausted* bank, and a
32-house bank is never exhausted inside a game a test has time to play."""
POTTED = Ruleset.universal().model_copy(update={"free_parking_pot_enabled": True})
"""The house rule that makes the Free Parking pot a live counterparty — the third party the
money-supply invariant has to keep apart from the bank (G-60)."""
BRISK = Ruleset.universal().model_copy(update={"starting_cash": 250})
"""The universal rules on a short bankroll: the same reducer with one constant changed.

Not a weakening — it is what makes ``DEBT_SETTLEMENT``, ``declare_bankruptcy``,
``BANKRUPTCY_TRANSFER``, the estate auction and ``GAME_OVER`` reachable inside a step budget.
At ₪1500 a game takes several hundred commands to produce its first unpayable rent, and a
5000-step probe run across 25 games reached none of those five."""
TIMED = Ruleset.kids().model_copy(update={"target_duration_minutes": 1})
"""Kids Mode on a one-minute clock, so MON-208's time ending is reachable from real play."""

MAX_INTERRUPT_DEPTH = 4
"""The deepest interrupt stack the specced rules can build.

ADR-007's worked example is card → unpayable rent → debt → trade to raise the cash (three),
and an accepted trade carrying a mortgaged deed can open a fee debt over a suspended debt
(two). Four is a bound with a frame of headroom, and it is a *bound*: if it ever trips, a
rule failed to pop a frame — it is not a constant that wants raising."""

NON_ESCALATING = frozenset(
    {
        "build_house",
        "buy_property",
        "cancel_trade",
        "mortgage_property",
        "pay_jail_fine",
        "respond_to_trade",
        "sell_house",
        "unmortgage_property",
        "use_jail_card",
        "withdraw_from_auction",
    }
)
"""Commands that can never *deepen* the interrupt stack.

Each is either gated on cash by legality, so it cannot open a debt, or purely closing. The
four escalating kinds are left out, and named here so the omission reads as deliberate:
``roll_dice`` (a card, or a rent nobody can pay), ``decline_purchase`` (an auction),
``propose_trade`` (a review) and ``declare_bankruptcy`` (an estate auction, plus a transfer
fee debt on the receiver)."""

STRICTLY_CLOSING = frozenset({"cancel_trade"})
"""...and the one that must leave the stack strictly shallower: the proposer withdrawing pops
the review and can push nothing in its place.

``respond_to_trade`` was in this set until the machine found otherwise, and the *assertion*
was wrong, not the rule: accepting a swap that moves a mortgaged deed charges the receiver
the official 10% at transfer, and a receiver who cannot pay opens a nested ``DebtFrame``
(MON-204, owner decision 2). The frame count then comes out level — one popped, one pushed —
which is precisely the escalation ADR-007 exists to express. Non-escalating, yes; strictly
closing, no."""


# --- The tally: what a run reached ------------------------------------------------


@dataclass
class Tally:
    """What a driver managed to reach, so a floor can be asserted over it."""

    phases: set[Phase] = field(default_factory=set)
    reasons: set[CashReason] = field(default_factory=set)
    kinds: set[str] = field(default_factory=set)
    cards: set[str] = field(default_factory=set)
    endings: set[str] = field(default_factory=set)
    max_depth: int = 0
    steps: int = 0

    def record(self, command: Command, after: GameState, events: tuple[Event, ...]) -> None:
        self.steps += 1
        self.kinds.add(command.kind)
        self.phases.add(after.phase)
        self.max_depth = max(self.max_depth, len(after.interrupts))
        for entry in events:
            if isinstance(entry, CashChanged):
                self.reasons.add(entry.reason)
            elif isinstance(entry, CardDrawn):
                self.cards.add(entry.card_id)
            elif isinstance(entry, GameEnded):
                self.endings.add(entry.reason)


# --- The invariants, one named function each --------------------------------------


def check_legal_commands_is_non_empty_unless_the_game_is_over(state: GameState) -> None:
    """The single invariant that catches every deadlock (G-14). A UI driven entirely by
    ``legal_commands`` has nothing whatever to render when this breaks."""
    offered = legal_commands(state)
    if state.phase is Phase.GAME_OVER:
        assert offered == (), "a finished game still offers commands"
    else:
        assert offered, f"deadlock: no legal command in {state.phase.value} with {len(state.interrupts)} frame(s)"


def check_no_state_rests_in_a_transient_phase(state: GameState) -> None:
    """The reducer's contract asserted from outside it: ``MOVING``, ``RESOLVING_TILE`` and
    ``CARD_RESOLUTION`` are passed through, never rested in — which is why they are the three
    phases the structural generator cannot draw, and why this is where the other eleven-way
    half of the Phase floor is discharged."""
    assert state.phase not in TRANSIENT_PHASES


def check_cash_is_never_negative(state: GameState) -> None:
    """Shortfall-as-data (G-18): what a player cannot pay lives in the ``DebtFrame``."""
    for player in state.players:
        assert player.cash >= 0, f"player {player.id} holds {player.cash}"


def check_building_stock_is_conserved(state: GameState) -> None:
    """Every house and hotel is either on the board or in the bank, and never both.

    The equality is arithmetic, because ``houses_remaining`` is a *derived* field and so
    cannot drift the way a stored counter could — that design is what this line documents
    (GAP G-19). Being honest about it: the first two assertions are therefore definitional,
    and the bounds below them cannot fire either, because ``GameState._check_properties``
    refuses an over-built board before this function is ever reached. What is left is
    documentation of a design, which is worth having and is not a test.

    The falsifiable half is :func:`check_the_building_ledger_accounts_for_every_level`, and
    the hotel exchange — four houses back to the bank for one hotel — is where implementations
    go wrong, so it is the half that matters. It went uncovered for a while: the sweep never
    built a hotel, so no ``SellHouse(demolish_hotel=True)`` was ever applied and a
    ``BuildingChanged`` whose ``delta`` was hardcoded to ``-1`` survived the whole run. See
    ``Scenario.demolish`` and the light-blue scenario, which exist to close that.
    """
    houses = sum(prop.houses for prop in state.properties if 0 < prop.houses < HOTEL_LEVEL)
    hotels = sum(1 for prop in state.properties if prop.houses == HOTEL_LEVEL)
    assert state.houses_remaining + houses == state.ruleset.houses_available
    assert state.hotels_remaining + hotels == state.ruleset.hotels_available
    assert 0 <= houses <= state.ruleset.houses_available, f"{houses} houses outside the bank's stock"
    assert 0 <= hotels <= state.ruleset.hotels_available, f"{hotels} hotels outside the bank's stock"


def check_even_build_holds_across_every_group(state: GameState) -> None:
    """Spec §3.6 trap 3 as a state predicate: within a colour group the levels never differ
    by more than one, and a hotel counts as five.

    Coming *down* is the half implementations get wrong, so the predicate deliberately does
    not care which way the last change went. A built group is necessarily whole as well — you
    cannot build without owning it, and a group carrying buildings can be neither traded nor
    mortgaged — so the single-owner check belongs here too.
    """
    if not state.ruleset.even_build_enforced:
        return
    for group in ColorGroup:
        members = state.board.group_members(group)
        levels = [state.properties[index].houses for index in members]
        if not any(levels):
            continue
        assert max(levels) - min(levels) <= 1, f"{group.value} stands at {levels}"
        owners = {state.properties[index].owner for index in members}
        assert len(owners) == 1, f"{group.value} carries buildings but is split between {owners}"


def check_a_debt_frame_is_live_exactly_in_debt_settlement(state: GameState) -> None:
    """Both directions. A live ``DebtFrame`` under any other phase offers the wrong commands;
    ``DEBT_SETTLEMENT`` without one has no debt to settle."""
    assert isinstance(state.top_interrupt, DebtFrame) == (state.phase is Phase.DEBT_SETTLEMENT)


def check_game_over_means_no_live_interrupts(state: GameState) -> None:
    """G-8: a winner declared over a live estate auction is a frozen game."""
    if state.phase is Phase.GAME_OVER:
        assert state.interrupts == (), "GAME_OVER with a live interrupt frame"


def check_the_interrupt_stack_is_bounded(state: GameState) -> None:
    depth = len(state.interrupts)
    assert depth <= MAX_INTERRUPT_DEPTH, f"interrupt stack {depth} deep: {[frame.kind for frame in state.interrupts]}"


def check_a_bankrupt_player_holds_nothing(state: GameState) -> None:
    """G-12: no deeds, no jail cards, not in the cell. The model enforces the last two; the
    deeds are checked here, and they are the ones a bankruptcy reassigns one by one."""
    for player in state.players:
        if not player.bankrupt:
            continue
        assert state.tiles_owned_by(player.id) == (), f"bankrupt player {player.id} still holds deeds"
        assert player.jail_cards == ()
        assert not player.in_jail


def check_the_jail_card_multiset_is_conserved(state: GameState) -> None:
    """Exactly two get-out-of-jail cards exist, one per deck, wherever they sit — a hand, or
    the bottom of their own pile (G-11). A count could not say which deck a spent card
    belongs to, which is why a held card is a ``Deck`` and not a number."""
    for deck in Deck:
        card_id = GET_OUT_OF_JAIL_IDS[deck]
        in_hands = sum(1 for player in state.players if deck in player.jail_cards)
        in_pile = state.deck(deck).count(card_id)
        assert in_hands + in_pile == 1, f"{card_id} exists {in_hands + in_pile} times"


def check_the_state_round_trips_through_json(state: GameState) -> None:
    """The save file *is* the state (ADR-002), so every reachable state has to survive the
    trip — not only the hand-built maximal one in ``test_serialization.py``."""
    restored = GameState.model_validate_json(state.model_dump_json())
    assert restored == state
    assert json.loads(restored.model_dump_json()) == json.loads(state.model_dump_json())


STATE_INVARIANTS = (
    check_legal_commands_is_non_empty_unless_the_game_is_over,
    check_no_state_rests_in_a_transient_phase,
    check_cash_is_never_negative,
    check_building_stock_is_conserved,
    check_even_build_holds_across_every_group,
    check_a_debt_frame_is_live_exactly_in_debt_settlement,
    check_game_over_means_no_live_interrupts,
    check_the_interrupt_stack_is_bounded,
    check_a_bankrupt_player_holds_nothing,
    check_the_jail_card_multiset_is_conserved,
    check_the_state_round_trips_through_json,
)
"""Everything that must be true of a state on its own. The machine also declares each as its
own ``@invariant`` method so hypothesis names the failing one; the seeded sweep walks this
tuple. ``check_money_reconciles_per_player`` is not here — it needs the running ledger."""


# --- The transition checks: the ones that need before, after and the events -------


def check_the_cash_ledger(
    before: GameState,
    after: GameState,
    events: tuple[Event, ...],
    balances: dict[PlayerId, int],
    deltas: Counter[int],
) -> None:
    """Money invariants 1, 2 and 4 — the three that are about a batch of events.

    ``balances`` and ``deltas`` are carried across the whole game and mutated here, which is
    what lets invariant 3 (:func:`check_money_reconciles_per_player`) be a statement about
    the state rather than about one command.
    """
    entries = [entry for entry in events if isinstance(entry, CashChanged)]
    for entry in entries:
        expected = balances[entry.player] + entry.delta
        assert entry.balance == expected, (
            f"ledger consistency: a {entry.reason.value} entry claims balance {entry.balance} for player "
            f"{entry.player}, but their previous balance plus this delta is {expected}"
        )
        balances[entry.player] = entry.balance
        deltas[entry.player] += entry.delta

    transfers: Counter[tuple[int, int, int, CashReason]] = Counter(
        (entry.player, entry.counterparty, entry.delta, entry.reason)
        for entry in entries
        if isinstance(entry.counterparty, int)
    )
    for key, count in transfers.items():
        player, counterparty, delta, reason = key
        mirror = (counterparty, player, -delta, reason)
        assert transfers[mirror] == count, (
            f"paired transfers: {abs(delta)} moved between players {player} and {counterparty} for "
            f"{reason.value}, but the mirror entry is not in the same command's batch"
        )

    from_the_bank = sum(entry.delta for entry in entries if entry.counterparty == "bank")
    moved = _money_on_the_table(after) - _money_on_the_table(before)
    assert moved == from_the_bank, (
        f"money-supply accounting: cash held by players and the pot moved by {moved}, but the entries "
        f"naming the bank net to {from_the_bank} — money was minted or burned outside the bank"
    )


def check_money_reconciles_per_player(state: GameState, opening: dict[PlayerId, int], deltas: Counter[int]) -> None:
    """Money invariant 3: cash equals opening cash plus that player's ledger deltas, so no
    rule moved money without emitting the one event that is allowed to (G-60)."""
    for player in state.players:
        expected = opening[player.id] + deltas[player.id]
        assert player.cash == expected, (
            f"per-player reconciliation: player {player.id} holds {player.cash} but the ledger accounts for {expected}"
        )


def check_the_building_ledger_accounts_for_every_level(
    before: GameState, after: GameState, events: tuple[Event, ...]
) -> None:
    """The buildings' answer to the cash ledger: ``BuildingChanged`` accounts for every level
    that appeared or vanished, so no rule can move a house without saying so. This is the
    falsifiable half of building-stock conservation."""
    narrated = sum(entry.delta for entry in events if isinstance(entry, BuildingChanged))
    actual = _levels_on_the_board(after) - _levels_on_the_board(before)
    assert narrated == actual, (
        f"the building ledger: BuildingChanged events account for {narrated} levels, but the board moved by {actual}"
    )


def check_the_interrupt_depth_moves_the_right_way(before: GameState, after: GameState, command: Command) -> None:
    """Depth is bounded (see :func:`check_the_interrupt_stack_is_bounded`) *and* monotone on
    the commands that cannot escalate — which is what makes the nesting terminate rather than
    merely stay small (G-2)."""
    was, now = len(before.interrupts), len(after.interrupts)
    if command.kind in NON_ESCALATING:
        assert now <= was, f"{command.kind} deepened the interrupt stack from {was} to {now}"
    if command.kind in STRICTLY_CLOSING and was:
        assert now < was, f"{command.kind} left the stack at {now} without closing the frame it answers"


def _money_on_the_table(state: GameState) -> int:
    """Everything the bank does not hold: player cash plus the Free Parking pot."""
    return sum(player.cash for player in state.players) + state.free_parking_pot


def _levels_on_the_board(state: GameState) -> int:
    """Total building levels, a hotel counting as five — what ``BuildingChanged`` narrates."""
    return sum(prop.houses for prop in state.properties)


# --- Driver 1: the hypothesis machine, which hunts --------------------------------

FLOW = ("roll_dice", "roll_for_jail", "pay_jail_fine", "use_jail_card", "respond_to_trade", "end_turn")
BUYING = ("buy_property", "decline_purchase", "place_bid", "withdraw_from_auction")
PORTFOLIO = ("build_house", "sell_house", "mortgage_property", "unmortgage_property")
RAISING = ("sell_house", "mortgage_property", "declare_bankruptcy")


class ReplayedGame(RuleBasedStateMachine):
    """A game played from ``new_game`` by choosing among ``legal_commands``.

    Five rules with different appetites rather than one uniform pick. Uniformly, the
    portfolio commands — one per owned tile per kind — swamp the menu as soon as anyone holds
    four deeds, and the game stops advancing: ``roll_dice`` becomes one option in forty, so a
    long run never reaches a bankruptcy, an auction or a card. Each rule prefers its own
    kinds and falls back to any legal command, so no rule is ever a no-op.
    """

    def __init__(self) -> None:
        super().__init__()
        self.game: GameState | None = None
        self.opening: dict[PlayerId, int] = {}
        self.balances: dict[PlayerId, int] = {}
        self.deltas: Counter[int] = Counter()

    @initialize(
        seed=st.integers(min_value=0, max_value=2**20),
        seat_count=st.integers(min_value=2, max_value=4),
        ruleset=st.sampled_from((Ruleset.universal(), BRISK, BRISK, POTTED, SCARCE_BANK, Ruleset.kids(), TIMED)),
    )
    def open_the_game(self, seed: int, seat_count: int, ruleset: Ruleset) -> None:
        self._open(seed, seat_count, ruleset)

    @rule(
        seed=st.integers(min_value=0, max_value=2**20),
        seat_count=st.integers(min_value=2, max_value=4),
        ruleset=st.sampled_from((Ruleset.universal(), BRISK, POTTED, SCARCE_BANK)),
    )
    @precondition(lambda self: not self._live())
    def open_the_next_game(self, seed: int, seat_count: int, ruleset: Ruleset) -> None:
        """Deal again once a game is over rather than idling out the step budget.

        Hypothesis refuses a state in which no rule has a true precondition, and a finished
        game is exactly that — so the machine has to be able to move. Re-dealing is the
        useful way to move: a long example plays several games to their end, and the endgame
        states the invariants care about are then visited many times per run.
        """
        self._open(seed, seat_count, ruleset)

    def _open(self, seed: int, seat_count: int, ruleset: Ruleset) -> None:
        game = new_game(SEATS[:seat_count], seed=seed, ruleset=ruleset)
        self.game = game
        # The ledger accumulators belong to *this* game, so they are reset with it.
        self.opening = {player.id: player.cash for player in game.players}
        self.balances = dict(self.opening)
        self.deltas = Counter()

    def _live(self) -> bool:
        return self.game is not None and self.game.phase is not Phase.GAME_OVER

    @rule(pick=st.integers(min_value=0, max_value=999))
    @precondition(lambda self: self._live())
    def take_the_turn(self, pick: int) -> None:
        self._play(FLOW, pick)

    @rule(pick=st.integers(min_value=0, max_value=999))
    @precondition(lambda self: self._live())
    def buy_or_bid(self, pick: int) -> None:
        self._play(BUYING, pick)

    @rule(pick=st.integers(min_value=0, max_value=999))
    @precondition(lambda self: self._live())
    def work_the_portfolio(self, pick: int) -> None:
        self._play(PORTFOLIO, pick)

    @rule(pick=st.integers(min_value=0, max_value=999))
    @precondition(lambda self: self._live())
    def raise_cash_or_concede(self, pick: int) -> None:
        self._play(RAISING, pick)

    @rule(data=st.data())
    @precondition(lambda self: self._live())
    def propose_a_trade(self, data: st.DataObject) -> None:
        """``ProposeTrade`` is never enumerated (ADR-005), so a replay driver has to build
        one. Without this rule the whole trade module is unreachable from a replayed game —
        the same blind spot as the unstocked decks the structural generator had.

        In ``DEBT_SETTLEMENT`` the proposer is the debtor, because they are the only player
        allowed to trade there (G-5 as corrected) — and that is also the one path to a
        ``[debt, trade]`` stack, the depth-2 nesting ADR-007 was written for.
        """
        state = self._state()
        frame = state.top_interrupt
        parties = [player.id for player in state.solvent_players]
        if len(parties) < 2:
            return
        proposer = frame.debtor if isinstance(frame, DebtFrame) else data.draw(st.sampled_from(parties))
        others = [party for party in parties if party != proposer]
        if not others:
            return
        offer = TradeOffer(
            proposer=proposer,
            recipient=data.draw(st.sampled_from(others)),
            give=data.draw(trade_sides(state, proposer)),
            receive=data.draw(trade_sides(state, data.draw(st.sampled_from(others)))),
        )
        command = ProposeTrade(player=proposer, offer=offer)
        if is_legal(state, command):
            self._step(command)

    def _play(self, preferred: tuple[str, ...], pick: int) -> None:
        state = self._state()
        offered = legal_commands(state)
        assert offered, "the deadlock catcher: a live game must offer a move"
        shortlist = [command for command in offered if command.kind in preferred] or list(offered)
        self._step(shortlist[pick % len(shortlist)])

    def _state(self) -> GameState:
        assert self.game is not None, "@initialize runs before every rule"
        return self.game

    def _step(self, command: Command) -> None:
        before = self._state()
        after, events = apply(before, command)
        event(f"applied {command.kind}")
        check_the_cash_ledger(before, after, events, self.balances, self.deltas)
        check_the_building_ledger_accounts_for_every_level(before, after, events)
        check_the_interrupt_depth_moves_the_right_way(before, after, command)
        self.game = after

    # Each invariant is its own method so hypothesis names the one that broke.

    @invariant()
    @precondition(lambda self: self.game is not None)
    def legal_commands_is_non_empty_unless_the_game_is_over(self) -> None:
        check_legal_commands_is_non_empty_unless_the_game_is_over(self._state())

    @invariant()
    @precondition(lambda self: self.game is not None)
    def no_state_rests_in_a_transient_phase(self) -> None:
        check_no_state_rests_in_a_transient_phase(self._state())

    @invariant()
    @precondition(lambda self: self.game is not None)
    def cash_is_never_negative(self) -> None:
        check_cash_is_never_negative(self._state())

    @invariant()
    @precondition(lambda self: self.game is not None)
    def money_reconciles_per_player(self) -> None:
        check_money_reconciles_per_player(self._state(), self.opening, self.deltas)

    @invariant()
    @precondition(lambda self: self.game is not None)
    def building_stock_is_conserved(self) -> None:
        check_building_stock_is_conserved(self._state())

    @invariant()
    @precondition(lambda self: self.game is not None)
    def even_build_holds_across_every_group(self) -> None:
        check_even_build_holds_across_every_group(self._state())

    @invariant()
    @precondition(lambda self: self.game is not None)
    def a_debt_frame_is_live_exactly_in_debt_settlement(self) -> None:
        check_a_debt_frame_is_live_exactly_in_debt_settlement(self._state())

    @invariant()
    @precondition(lambda self: self.game is not None)
    def game_over_means_no_live_interrupts(self) -> None:
        check_game_over_means_no_live_interrupts(self._state())

    @invariant()
    @precondition(lambda self: self.game is not None)
    def the_interrupt_stack_is_bounded(self) -> None:
        check_the_interrupt_stack_is_bounded(self._state())

    @invariant()
    @precondition(lambda self: self.game is not None)
    def a_bankrupt_player_holds_nothing(self) -> None:
        check_a_bankrupt_player_holds_nothing(self._state())

    @invariant()
    @precondition(lambda self: self.game is not None)
    def the_jail_card_multiset_is_conserved(self) -> None:
        check_the_jail_card_multiset_is_conserved(self._state())

    @invariant()
    @precondition(lambda self: self.game is not None)
    def the_state_round_trips_through_json(self) -> None:
        check_the_state_round_trips_through_json(self._state())


def test_replayed_games_hold_every_invariant() -> None:
    """The hunting driver. 25 examples x 60 steps is ~1500 applied commands per run, which is
    where the runtime budget lands it; the *coverage* claim is the seeded sweep's job."""
    run_state_machine_as_test(  # type: ignore[no-untyped-call]  # hypothesis.stateful is unannotated
        ReplayedGame,
        settings=settings(
            max_examples=25,
            stateful_step_count=60,
            deadline=None,
            suppress_health_check=[HealthCheck.too_slow, HealthCheck.filter_too_much],
        ),
    )


# --- Driver 2: the seeded sweep, which guarantees ---------------------------------

FLOW_FIRST = (
    "roll_dice",
    "roll_for_jail",
    "buy_property",
    "place_bid",
    "end_turn",
    "withdraw_from_auction",
    "decline_purchase",
    "declare_bankruptcy",
)
"""Move the game along: roll, buy, bid, end the turn — and concede when there is nothing else.
Every cycling policy below ends its rotation on this, so no policy can stall the table."""

POLICIES: dict[str, tuple[tuple[str, ...], ...]] = {
    # Concedes the moment it owes more than it holds: the fastest route to a bankruptcy, an
    # estate auction and GAME_OVER.
    "conceder": (("declare_bankruptcy", *FLOW_FIRST),),
    # Fights: raises cash by sale and mortgage before conceding, and opens every auction at
    # the minimum bid, which is how AUCTION_WIN and SELL_BUILDING enter the stream.
    "fighter": (("sell_house", "mortgage_property", "declare_bankruptcy", *FLOW_FIRST),),
    # Develops, and takes the cell's paid exits: builds whenever a group completes.
    "builder": (("build_house", "buy_property", "pay_jail_fine", "use_jail_card", *FLOW_FIRST),),
    # Works the estate on a rotation: build, sell, mortgage, lift, then two plain turns.
    #
    # The rotation is the point. A portfolio command is legal in *every* portfolio phase, so a
    # single priority list with ``mortgage_property`` at the front mortgages, unmortgages and
    # re-mortgages for ever and the table never advances — the game would never reach a card,
    # a rent or an ending. Cycling guarantees that two steps in six move the game on, and it
    # is the only way this sweep reaches ``unmortgage_property``, ``CashReason.UNMORTGAGE``
    # and a ``sell_house`` outside a debt.
    "churner": (
        ("build_house", *FLOW_FIRST),
        ("sell_house", *FLOW_FIRST),
        ("mortgage_property", *FLOW_FIRST),
        ("unmortgage_property", *FLOW_FIRST),
        FLOW_FIRST,
        FLOW_FIRST,
    ),
    # Builds up and sells down. Separate from the churner because a single mortgaged member
    # blocks every build in its colour group, so mortgaging and building cannot share one
    # rotation: with both in the cycle the group was mortgaged first and never built on.
    "developer": (
        ("build_house", *FLOW_FIRST),
        ("build_house", *FLOW_FIRST),
        ("sell_house", *FLOW_FIRST),
        FLOW_FIRST,
    ),
    # Spends its card, then buys its way out: the only policy that reaches ``use_jail_card``,
    # because ``roll_for_jail`` comes first in every other list and a paid exit would come
    # before the card in this one.
    "jailbird": (("use_jail_card", "pay_jail_fine", "buy_property", "roll_dice", "end_turn", *FLOW_FIRST),),
    # Withdraws every offer it is shown, and mortgages so that there is something to offer:
    # the one policy that reaches ``cancel_trade``.
    "canceller": (
        ("cancel_trade", "mortgage_property", *FLOW_FIRST),
        ("cancel_trade", *FLOW_FIRST),
    ),
}
"""Kind priorities, walked in order over ``legal_commands``, rotated per step.

Deliberately the same shape the golden regenerator's policies use: a policy that is a fixed
priority list is reproducible, reviewable, and cannot quietly stop reaching something."""


@dataclass(frozen=True)
class Scenario:
    """One committed game: a seed, a table, a ruleset, a policy and a step budget."""

    seed: int
    seats: int
    ruleset: Ruleset
    policy: str
    steps: int = 400
    trades: bool = False
    """Whether to inject ``ProposeTrade`` — never enumerated (ADR-005), so a replay driver
    that does not build one itself cannot reach the trade module or ``CashReason.TRADE``."""
    clock: bool = False
    """Whether to stamp ``EndTurn.elapsed_seconds``, the only route to MON-208's ``time_limit``
    ending from real play (G-6)."""
    demolish: bool = True
    """Whether to prefer the whole-group demolition when a hotel can be sold that way.

    On by default, and it needs saying why a *preference* is required at all.
    ``legal_commands`` offers ``SellHouse(demolish_hotel=False)`` before the ``True`` variant,
    so every policy that walks the offered list by kind takes the one-level sale and the
    exchange — four houses back to the bank for one hotel, the place the building-stock
    docstring names as where implementations go wrong — was never applied by this sweep at
    all. It is only ever legal on a tile carrying a hotel, so preferring it costs the
    one-level sale nothing: the ordinary sell direction of even-build is untouched on every
    other tile."""
    stake: tuple[tuple[TileIndex, PlayerId], ...] = ()
    """Deeds handed out before the first roll: ``(tile, owner)`` pairs.

    A *stipulated opening position*, not a hand-built mid-game state — every command from
    there is still chosen from ``legal_commands`` and applied through ``apply``. It exists
    because the rules that matter most only switch on over a **developed** board: nothing can
    be built until somebody owns a whole colour group, and random buying takes well over a
    thousand commands to complete one. Without a stake the sweep reached no ``build_house``,
    no ``sell_house``, no ``CashReason.BUILD``, and — because unimproved rent never outruns
    the GO salary — no unpayable rent, no bankruptcy and no ``last_solvent`` ending either.
    """
    mortgaged: tuple[TileIndex, ...] = ()
    """Staked deeds that start out **mortgaged**, as tile indices (each must appear in ``stake``).

    Part of the same stipulated opening, and it exists for one shape only: the debtor
    *receiving* a mortgaged deed (:func:`_offer_to`). That needs a mortgaged deed in somebody
    *else's* hand at the moment a debt is live, and the two facts never coincided — a policy
    only mortgages when it is itself short of cash, by which point it is the debtor. Mortgaged
    at the deal, no money moves for it, exactly as the unmortgaged stake moves none.
    """
    jail_cards: tuple[tuple[PlayerId, Deck], ...] = ()
    """Get-out-of-jail cards dealt into a hand, as ``(player, deck)`` pairs.

    Taken *out of the pile*, so the jail-card multiset invariant still holds from the first
    state onwards. Part of the same stipulated opening as ``stake``, and for the same reason:
    ``use_jail_card`` needs a player who holds one *and* is in the cell, and 600 commands of
    real play across four seats drew only half of one deck — the card came up in none of them.
    """
    must_finish: bool = False
    """Whether the game has to reach ``GAME_OVER`` inside ``steps``.

    Off by default, and that is a statement about the rules rather than a shortcut: the
    universal ruleset has **no turn cap**, so a stable table need never end and a harness-level
    cap is the documented answer (GAP G-62). The two scenarios that carry the endings floor set
    it, and for them termination is asserted."""


UNIVERSAL = Ruleset.universal()

LIGHT_BLUE = ((6, 0), (8, 0), (9, 0))
ORANGE = ((16, 1), (18, 1), (19, 1))
DARK_BLUE = ((37, 1), (39, 1))
RAILROADS = ((5, 0), (15, 0), (25, 0), (35, 0))
SPLIT_RAILROADS = ((5, 0), (15, 0), (25, 1), (35, 1))
"""Whole colour groups, handed out at the deal. Two groups facing each other is what turns a
sweep into a game with rent worth going bankrupt over.

``SPLIT_RAILROADS`` puts two in each hand so that whichever seat ends up the debtor, the
*other* one still holds a deed the debtor can be made to receive. Railroads because they carry
no colour group: a mortgaged deed in a built group cannot be traded at all
(``error.group_has_buildings``), and a mortgaged member blocks every build in its group — so a
mortgaged *property* would either be untradeable or would stop the board developing."""

SWEEP = (
    # The deal, played straight: buying, auctions, rent, the salary, the four quiet phases.
    Scenario(seed=7, seats=2, ruleset=UNIVERSAL, policy="conceder"),
    # A short bankroll and a policy that fights: jail rolls, withdrawals, AUCTION_WIN.
    Scenario(seed=7, seats=3, ruleset=BRISK, policy="fighter"),
    # A developed board on a short bankroll: houses go up, rent outruns the salary, and the
    # debt that follows ends the game. Trades are injected, so the debtor also trades to raise
    # cash — the ``[debt, trade]`` stack ADR-007 was written for.
    Scenario(
        seed=7,
        seats=2,
        ruleset=BRISK,
        policy="builder",
        stake=LIGHT_BLUE + ORANGE + DARK_BLUE,
        steps=900,
        trades=True,
        must_finish=True,
    ),
    # The same board, with a mortgaged railroad already in each hand: the one opening from
    # which the *debtor* can be made to **receive** a mortgaged deed, so the official 10%
    # lands on a player who already owes money and opens a second debt beneath the first.
    # That ``[debt, debt]`` stack is the shape ``handle_declare_bankruptcy`` half-popped.
    Scenario(
        seed=7,
        seats=2,
        ruleset=BRISK,
        policy="builder",
        stake=LIGHT_BLUE + ORANGE + DARK_BLUE + SPLIT_RAILROADS,
        mortgaged=(5, 15, 25, 35),
        steps=900,
        trades=True,
    ),
    # A full table developing from the deal: cards, tax, jail fines, debt, bankruptcy.
    Scenario(seed=7, seats=4, ruleset=UNIVERSAL, policy="builder"),
    # The one ruleset in which the Free Parking pot holds money.
    Scenario(seed=7, seats=2, ruleset=POTTED, policy="fighter"),
    # A building bank of six houses and two hotels against two staked groups: the stock runs
    # out, and the developer then sells back down (trap 4's aftermath, and the sell direction
    # of even-build).
    Scenario(seed=7, seats=3, ruleset=SCARCE_BANK, policy="developer", stake=LIGHT_BLUE + ORANGE, steps=600),
    # A full bank against the *cheapest* colour group, which is the only way this sweep ever
    # reaches a hotel at all. SCARCE_BANK cannot: a hotel needs its whole group standing at
    # four first, so a three-member group holds twelve houses at the moment the fifth goes up
    # and a six-house bank tops out at level two. Light blue at ₪50 a house costs ₪650 to take
    # to a hotel, which a ₪1500 bankroll can do inside a few dozen commands — and once it is
    # there, ``Scenario.demolish`` sells it back as one lot, so ``BuildingChanged`` finally has
    # to narrate a five-level exchange rather than a string of single steps.
    # The policy is the pure builder, which never sells: it does not need to. ``_pick``'s
    # demolition preference is consulted *before* the priority list, and a whole-group
    # demolition is legal only on a tile carrying a hotel — so the group climbs to a hotel
    # unopposed and is then sold back the instant one stands. A rotation that also sold
    # single levels could not get there: it knocked the group back down faster than the
    # even-build ladder let it climb, and topped out at level three over 300 commands.
    Scenario(seed=7, seats=2, ruleset=UNIVERSAL, policy="builder", stake=LIGHT_BLUE, steps=300),
    # Mortgage, lift, build, sell — on a rotation, so the table still advances.
    Scenario(seed=7, seats=3, ruleset=UNIVERSAL, policy="churner", stake=RAILROADS, trades=True),
    # Pays and cards its way out of the cell instead of rolling for it, holding both decks'
    # jail cards from the deal so that ``use_jail_card`` is reached rather than hoped for.
    Scenario(
        seed=7,
        seats=2,
        ruleset=UNIVERSAL,
        policy="jailbird",
        jail_cards=((0, Deck.CHANCE), (1, Deck.COMMUNITY_CHEST)),
        steps=600,
    ),
    # Withdraws every offer it is shown.
    Scenario(seed=7, seats=3, ruleset=UNIVERSAL, policy="canceller", trades=True),
    # Kids Mode on a one-minute clock: MON-208's time ending, through real play.
    Scenario(seed=7, seats=3, ruleset=TIMED, policy="builder", clock=True, steps=60, must_finish=True),
)
"""The committed sweep. Each scenario is here because it reaches something the others do not,
and the list as a whole is asserted to reach *everything* — see the floor at the foot of this
file, which names whatever stops being reached.

Committed rather than sampled: a floor that has to be re-lucky on every CI run is not a floor.
Seed 7 throughout — varying it bought nothing the policies did not already buy, and one seed is
one fewer number for a reader to wonder about."""

ROUND_TRIP_EVERY = 8
"""The JSON round-trip is the expensive invariant, and the hypothesis machine already runs it
on every state it visits. Sampling it here keeps the sweep inside the suite's time budget while
still exercising it on every kind of state a long game passes through."""


def _pick(state: GameState, priority: tuple[str, ...], scenario: Scenario) -> Command:
    """The first legal command matching ``priority``, else the first legal command.

    Two preferences override the priority list, and both exist because ``legal_commands``
    happens to sort the *uninteresting* variant of a command first, so a policy that walks the
    list by kind alone would never reach the other one:

    * a hotel is **demolished** whole where that is legal (``Scenario.demolish``);
    * a pending offer is *accepted* rather than merely answered, unless the policy is the one
      that cancels — ``accept=False`` sorts first, so taking the first match by kind would
      decline every offer and the swap, with the transfer fee that follows it, would never
      execute.
    """
    offered = legal_commands(state)
    assert offered, f"deadlock in {state.phase.value}"
    if scenario.demolish:
        demolitions = [command for command in offered if isinstance(command, SellHouse) and command.demolish_hotel]
        if demolitions:
            return demolitions[0]
    if scenario.trades and "cancel_trade" not in priority:
        accepts = [command for command in offered if isinstance(command, RespondToTrade) and command.accept]
        if accepts:
            return accepts[0]
    for kind in priority:
        for command in offered:
            if command.kind == kind:
                return _stamped(command, state, scenario)
    return _stamped(offered[0], state, scenario)


def _stamped(command: Command, state: GameState, scenario: Scenario) -> Command:
    """Caller-stamped wall clock on ``EndTurn`` (G-6) — twenty seconds a turn, so a one-minute
    Kids game ends on the clock after three of them."""
    if not scenario.clock or command.kind != "end_turn":
        return command
    return command.model_copy(update={"elapsed_seconds": state.turn_number * 20})


FREE_OFFER_BUDGET = 8
"""How much of a scenario's 12-offer budget the *undirected* shape may spend.

The reserve exists because the shapes are not equally available. A mortgaged deed lying in
anybody's hand makes the third shape below legal from the first step onwards, whereas the two
debt shapes need a live ``DebtFrame`` — which a game reaches after a hundred-odd commands, if
at all. With one shared budget the undirected shape spent all twelve offers before the first
debt opened, and the debt shapes were injected **zero** times in the whole sweep. A reserve is
the smallest fix that keeps the cheap shape from starving the interesting ones.
"""


def _inject_a_trade(state: GameState, offers: int) -> ProposeTrade | None:
    """A legal ``ProposeTrade`` for this state, or None. ``offers`` is the budget spent so far.

    Three shapes, and each exists for a specific invariant:

    * **during a debt, the debtor *receiving*** somebody else's mortgaged deed — tried first,
      because it is the one shape the other two cannot produce and the one that nests a
      *second* debt under the debtor's own. See :func:`_offer_to`.
    * **during a debt, the debtor giving** a deed for a shekel. The debtor is the only player
      who may trade in ``DEBT_SETTLEMENT`` (G-5 as corrected), and this is one route to a
      ``[debt, trade]`` stack — the nested interrupt ADR-007 was written for, and the only way
      the depth bound and its descent are exercised at all.
    * **otherwise**, the owner of a *mortgaged* deed offers it for a shekel. Mortgaged on
      purpose: it is the one offer that charges the official 10% transfer fee, so it reaches
      ``CashReason.MORTGAGE_TRANSFER_FEE`` and, when the receiver cannot pay, the nested debt
      that fee opens (MON-204, owner decision 2). Capped at :data:`FREE_OFFER_BUDGET` so it
      cannot spend the whole budget before a debt exists to offer into.
    """
    frame = state.top_interrupt
    if isinstance(frame, DebtFrame):
        received = _offer_to(state, frame.debtor)
        if received is not None:
            return received
        return _offer_from(state, frame.debtor, state.tiles_owned_by(frame.debtor))
    if offers >= FREE_OFFER_BUDGET:
        return None
    for index, prop in enumerate(state.properties):
        if prop.mortgaged and prop.owner is not None:
            offer = _offer_from(state, prop.owner, (index,))
            if offer is not None:
                return offer
    return None


def _offer_to(state: GameState, debtor: PlayerId) -> ProposeTrade | None:
    """``debtor`` offers every coin they hold for somebody else's *mortgaged* deed.

    The mirror of :func:`_offer_from`, and the direction no other injected offer produced: in
    every other shape the debtor *gives*, so the official 10% transfer fee always landed on
    the other party. Here the debtor is the **receiver**, and because the offer hands over
    their whole balance the fee cannot be paid — it opens a *second* ``DebtFrame`` on a player
    who already owes one, which is the ``[debt, debt]`` stack a conceding debtor used to leave
    half-popped (MON-207: ``handle_declare_bankruptcy`` pops only the top frame).

    Offered only onto a stack exactly one frame deep. A fee debt nested on a fee debt is the
    same shape again, one level lower, and injecting it repeatedly would climb towards
    ``MAX_INTERRUPT_DEPTH`` while testing nothing the first nesting does not already cover.
    """
    if len(state.interrupts) != 1:
        return None
    for other in state.solvent_players:
        if other.id == debtor:
            continue
        for tile in state.tiles_owned_by(other.id):
            if not state.properties[tile].mortgaged:
                continue
            command = ProposeTrade(
                player=debtor,
                offer=TradeOffer(
                    proposer=debtor,
                    recipient=other.id,
                    give=TradeSide(cash=state.player(debtor).cash),
                    receive=TradeSide(tiles=(tile,)),
                ),
            )
            if is_legal(state, command):
                return command
    return None


def _offer_from(state: GameState, proposer: PlayerId, tiles: tuple[TileIndex, ...]) -> ProposeTrade | None:
    """``proposer`` offers one of ``tiles`` for a shekel, to whoever can take it legally."""
    for tile in tiles:
        for other in state.solvent_players:
            if other.id == proposer or not other.cash:
                continue
            command = ProposeTrade(
                player=proposer,
                offer=TradeOffer(
                    proposer=proposer,
                    recipient=other.id,
                    give=TradeSide(tiles=(tile,)),
                    receive=TradeSide(cash=1),
                ),
            )
            if is_legal(state, command):
                return command
    return None


def _deal(scenario: Scenario) -> GameState:
    """The opening state, with ``Scenario.stake`` applied."""
    state = new_game(SEATS[: scenario.seats], seed=scenario.seed, ruleset=scenario.ruleset)
    if scenario.jail_cards:
        state = _hand_out_jail_cards(state, scenario.jail_cards)
    if not scenario.stake:
        return state
    properties = list(state.properties)
    for tile, owner in scenario.stake:
        properties[tile] = PropertyState(owner=owner, mortgaged=tile in scenario.mortgaged)
    return state._replace(properties=tuple(properties))


def _hand_out_jail_cards(state: GameState, dealt: tuple[tuple[PlayerId, Deck], ...]) -> GameState:
    """Move each named card from its pile into the named hand, conserving the multiset."""
    players = list(state.players)
    for player_id, deck in dealt:
        card_id = GET_OUT_OF_JAIL_IDS[deck]
        pile = tuple(entry for entry in state.deck(deck) if entry != card_id)
        field_name = "chance_deck" if deck is Deck.CHANCE else "community_chest_deck"
        state = state._replace(**{field_name: pile})
        seat = next(index for index, player in enumerate(players) if player.id == player_id)
        held = players[seat].jail_cards
        players[seat] = players[seat].model_copy(update={"jail_cards": (*held, deck)})
        state = state._replace(players=tuple(players))
    return state


def play_out(scenario: Scenario, tally: Tally) -> GameState:
    """Play one committed scenario, checking every invariant on the way."""
    state = _deal(scenario)
    opening = {player.id: player.cash for player in state.players}
    balances = dict(opening)
    deltas: Counter[int] = Counter()
    for check in STATE_INVARIANTS:
        check(state)
    cycle = POLICIES[scenario.policy]
    offers = 0
    for step in range(scenario.steps):
        if state.phase is Phase.GAME_OVER:
            return state
        command: Command | None = None
        if scenario.trades and offers < 12 and state.pending_trade is None:
            command = _inject_a_trade(state, offers)
            offers += command is not None
        if command is None:
            command = _pick(state, cycle[step % len(cycle)], scenario)
        before = state
        state, events = apply(state, command)
        check_the_cash_ledger(before, state, events, balances, deltas)
        check_the_building_ledger_accounts_for_every_level(before, state, events)
        check_the_interrupt_depth_moves_the_right_way(before, state, command)
        check_money_reconciles_per_player(state, opening, deltas)
        for check in STATE_INVARIANTS:
            if check is check_the_state_round_trips_through_json and step % ROUND_TRIP_EVERY:
                continue
            check(state)
        tally.record(command, state, events)
    if scenario.must_finish:
        raise AssertionError(
            f"{scenario.policy} at seed {scenario.seed} did not finish inside {scenario.steps} commands"
        )
    return state


KIND_FLOOR = frozenset(
    {
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
    }
)
"""All seventeen command kinds. The union itself is pinned in ``test_legality_properties``."""

PHASE_FLOOR = frozenset(Phase) - TRANSIENT_PHASES
"""The eight phases a played game rests in. The other three are ``TRANSIENT_PHASES``, and
:func:`check_no_state_rests_in_a_transient_phase` asserts their *absence* on every state both
drivers visit — between them the two account for all eleven."""


def test_seeded_games_meet_the_coverage_floor() -> None:
    """The sweep, and the assertion that it went everywhere.

    A green invariant suite that never entered an auction proves nothing (spec §6), so the
    floor is stated out loud and names whatever went unreached: every ``Phase``, every
    ``CashReason``, every command kind, both endings a solvent table can produce, all
    thirty-one card effects, and a nested interrupt stack.
    """
    tally = Tally()
    for scenario in SWEEP:
        final = play_out(scenario, tally)
        if scenario.must_finish:
            assert final.phase is Phase.GAME_OVER, f"{scenario.policy} at seed {scenario.seed} never finished"

    missing_phases = sorted(phase.value for phase in PHASE_FLOOR - tally.phases)
    assert not missing_phases, f"no scenario ever rested in {missing_phases}"
    missing_kinds = sorted(KIND_FLOOR - tally.kinds)
    assert not missing_kinds, f"no scenario ever applied {missing_kinds}"
    missing_reasons = sorted(reason.value for reason in frozenset(CashReason) - tally.reasons)
    assert not missing_reasons, f"no scenario ever moved money for {missing_reasons}"
    assert {"last_solvent", "time_limit"} <= tally.endings, f"endings reached: {sorted(tally.endings)}"
    assert tally.max_depth >= 2, "the interrupt stack never nested, so its bound and its descent are untested"
    every_card = set(CHANCE_CARD_IDS) | set(COMMUNITY_CHEST_CARD_IDS)
    missing_cards = sorted(every_card - tally.cards)
    assert not missing_cards, f"the sweep never dealt {missing_cards}"
