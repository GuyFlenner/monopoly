"""The hard bot's opinions, its budget, and its two contests (MON-603).

Three kinds of test, and the split matters:

* **Opinions.** The five amendments to the normal bot's ranking, each asserted in a position built for
  it — the same shape `test_bot_normal.py` uses, for the same reason: a ranking is testable directly and
  cheaply, and "it won more games" is not a diagnosis.
* **The budget.** The acceptance criterion is that the per-move budget is *deterministic*, so it is
  asserted on the counters :func:`kesef_engine.bots.search.search` reports. Wall-clock appears nowhere in
  an assertion (G-F30) — a time-based gate would fail on a busy runner and pass on a quiet one, and the
  bot's own choices would depend on the machine.
* **The contests**, under the `slow` marker: ≥ 60 of 100 against the normal bot *and* ≥ 60 against the
  easy one. Transitivity asserted rather than assumed, which is the backlog's wording and the right
  standard — "it beats the bot that beats easy" is a claim about two bots, not proof about the third.

## The one test that would notice the rollouts being deleted

`TestTheRolloutsDecideSomething` is the test that makes the rest of this file honest. Every other
assertion here is about a heuristic, and a heuristic is what the *normal* bot already is; if the rollouts
were commented out, everything above would still be green and the file would be documentation with a
misleading name. So one test pins a position where the ranking and the rollout disagree, and asserts the
bot plays the rollout's answer.

The measured ablation is the same claim at scale, and it is recorded here because it is the reason the
rollouts are worth their wall-clock: with ``ROLLOUT_CANDIDATES`` set to 1, so that no decision ever has
two candidates to compare, the same bot wins **15 of 30** against the normal bot. With the rollouts on it
wins 24. The heuristics alone are a coin flip.

## What the contests came out at

    hard vs normal:  80/100 wins (needed 60), 0 draws, 0 capped (max 5), turns 35/104/309
    hard vs easy:    89/100 wins (needed 60), 0 draws, 0 capped (max 5), turns 16/71/250

`uv run pytest -m slow` is both of those: 800 s on a developer machine with other work on it. The
numbers are reproducible rather than merely repeatable — the seeds are fixed and every bot in the
contest is a pure function of the position, so a second run deals the identical two hundred games.
"""

from __future__ import annotations

import json
import time
from collections import Counter
from pathlib import Path

import pytest
import tournament
from pydantic import TypeAdapter

from helpers import make_player, make_state
from kesef_engine.bots import EasyBot, HardBot, NormalBot, valuation
from kesef_engine.bots import search as search_module
from kesef_engine.bots.base import Bot
from kesef_engine.bots.hard import BUILD_RESERVE, _swap_gain
from kesef_engine.bots.normal import CASH_BUFFER
from kesef_engine.bots.search import (
    CLOSE_ENOUGH,
    MAX_APPLY_CALLS_PER_MOVE,
    ROLLOUT_CANDIDATES,
    ROLLOUTS_PER_CANDIDATE,
    ROLLOUTS_PER_MOVE,
    WIN_VALUE,
    Budget,
    _evaluate,
    search,
)
from kesef_engine.bots.valuation import MAX_RESERVE, MIN_RESERVE, estimated_rent, reserve
from kesef_engine.commands import (
    BuildHouse,
    BuyProperty,
    Command,
    DeclinePurchase,
    EndTurn,
    PlaceBid,
    ProposeTrade,
    RespondToTrade,
    RollDice,
    TradeOffer,
    TradeSide,
    WithdrawFromAuction,
)
from kesef_engine.events import RentCharged
from kesef_engine.factory import Seat, new_game
from kesef_engine.legality import is_legal, legal_commands
from kesef_engine.phases import Phase
from kesef_engine.primitives import AuctionReason, BotLevel, CashReason, PlayerId, TileLot
from kesef_engine.reducer import apply
from kesef_engine.rules.rent import charge
from kesef_engine.ruleset import Ruleset, RulesetName
from kesef_engine.state import (
    HOTEL_LEVEL,
    AuctionFrame,
    DebtFrame,
    GameState,
    Obligation,
    PropertyState,
    TradeFrame,
)

END = EndTurn(player=0, elapsed_seconds=None)
ROLL = RollDice(player=0)

BOARDWALK = 39
"""The dearest square on the classic board, and the one the normal bot is too thrifty to buy."""


def _state(
    *,
    cash: int = 1500,
    position: int = 0,
    properties: dict[int, PropertyState] | None = None,
    other_cash: int = 1500,
    phase: Phase = Phase.AWAITING_ROLL,
) -> GameState:
    state = make_state(
        seats=(make_player(0, cash=cash, position=position), make_player(1, cash=other_cash)), phase=phase
    )
    if properties is None:
        return state
    return _patched(state, properties)


def _deciding_a_purchase(*, cash: int, position: int) -> tuple[GameState, tuple[Command, ...]]:
    """A seat standing on an unowned square with the engine waiting for yes or no.

    The phase matters more here than it does in `test_bot_normal.py`, and that is a fact about this bot
    rather than about the fixture: a rollout **applies** the candidate, so a `legal` tuple assembled by
    hand out of commands that are not actually legal in the position gets no rollout at all (see
    `search` on the `is_legal` filter). Hand-built tuples are fine for scoring tests and useless for
    testing the search, so the fixtures that need the search build a real position and ask the engine
    what is legal in it.
    """
    state = _state(cash=cash, position=position, phase=Phase.AWAITING_PURCHASE_DECISION)
    legal = tuple(command for command in legal_commands(state) if command.player == 0)
    kinds = {command.kind for command in legal}
    assert {"buy_property", "decline_purchase"} <= kinds, f"the fixture is not a purchase decision: {kinds}"
    return state, legal


def _patched(state: GameState, properties: dict[int, PropertyState]) -> GameState:
    return GameState(
        **{
            **dict(state),
            "properties": tuple(
                properties.get(tile.index, prop) for tile, prop in zip(state.board.tiles, state.properties, strict=True)
            ),
        }
    )


def _group_of(state: GameState, tile_index: int) -> list[int]:
    group = state.board.tile(tile_index).group
    assert group is not None
    return [tile.index for tile in state.board.tiles if tile.group is group]


def _settling_a_debt(*, owned: tuple[int, ...], cash: int = 0, owed: int = 900) -> GameState:
    """Seat 0 owes more than it holds, with several deeds it could raise the money against.

    Every one of those deeds is a way to pay, and the parent scores them all identically — which is what
    makes this the widest tie a real game produces, and the reason the budget is asserted here rather than
    only on a two-way purchase decision.
    """
    state = _state(cash=cash, properties={index: PropertyState(owner=0) for index in owned})
    frame = DebtFrame(
        debtor=0,
        reason=CashReason.RENT,
        total=owed,
        obligations=(Obligation(creditor=1, amount=owed),),
        resume=Phase.AWAITING_END_TURN,
    )
    return GameState(**{**dict(state), "phase": Phase.DEBT_SETTLEMENT, "interrupts": (frame,)})


GOLDENS_DIR = Path(__file__).parent / "goldens"
_COMMANDS: TypeAdapter[Command] = TypeAdapter(Command)


def _golden_midgames(*, per_golden: int = 3) -> tuple[GameState, ...]:
    """Positions from partway through every committed golden game.

    Recorded boards rather than built ones, because the property they serve has to hold over *every*
    ownable square and a hand-built fixture only ever carries the branches whoever wrote it had in
    mind. The goldens were recorded for spec §3.6's rent traps (`test_goldens.py`), so between them
    they put mortgaged deeds, part-built and whole groups, and stations and utilities in one hand onto
    the same board — which is the population a claim about rent wants to be sampled from.

    Two filters, each for a reason:

    * **Interrupt-free only**, because of what the sample is used for: the test splices a landing into
      each position to see what the engine really charges, and a state resting inside a card frame or
      an auction is not one a landing can be spliced into.
    * **The first four fifths of each game**, because a golden's closing commands are a bankruptcy
      settling, and once every deed has changed hands the squares stop being interesting.

    Replaying here rather than importing `test_goldens._replay` is deliberate in the same way that
    module's own duplication of `_project` is: the golden net must not share a code path with anything
    that could make it agree with a mistake.
    """
    boards: list[GameState] = []
    for path in sorted(GOLDENS_DIR.glob("*.json")):
        if path.name == "traps.json":
            continue
        golden = json.loads(path.read_text(encoding="ascii"))
        state = new_game(
            tuple(Seat.model_validate(seat) for seat in golden["seats"]),
            seed=golden["seed"],
            board_id=golden["board_id"],
            ruleset=Ruleset.model_validate(golden["ruleset"]),
        )
        settled: list[GameState] = []
        for command in golden["commands"][: len(golden["commands"]) * 4 // 5]:
            state, _events = apply(state, _COMMANDS.validate_python(command))
            if not state.interrupts:
                settled.append(state)
        stride = max(1, len(settled) // (per_golden + 1))
        boards.extend(settled[stride::stride][:per_golden])
    return tuple(boards)


class TestTheProtocol:
    def test_satisfies_the_bot_protocol(self) -> None:
        bot: Bot = HardBot()
        assert bot.level is BotLevel.HARD

    def test_never_returns_a_command_outside_the_tuple(self) -> None:
        state, legal = _deciding_a_purchase(cash=1500, position=BOARDWALK)
        assert HardBot().choose(state, 0, legal) in legal

    def test_refuses_an_empty_choice(self) -> None:
        with pytest.raises(ValueError, match="no legal commands"):
            HardBot().choose(_state(), 0, ())

    def test_two_instances_agree_from_the_same_position(self) -> None:
        """The property the whole design turns on: ``choose`` is a pure function of the position.

        The tournament harness builds a bot per game and the server shares one across every game, so
        the two must not be able to disagree — and *this* bot draws randomness, unlike its parent, so
        the claim needs asserting rather than reasoning about. A position with a marginal purchase in
        it, so that the rollouts actually run and the answer goes through the sampled part of the code.
        """
        state, legal = _deciding_a_purchase(cash=CASH_BUFFER + 160, position=BOARDWALK)
        first = HardBot().choose(state, 0, legal)
        assert all(HardBot().choose(state, 0, legal) == first for _ in range(5))

    def test_does_not_touch_the_dice_stream(self) -> None:
        """A bot that consumed the game's randomness would change the dice a human sees.

        Asserted on the state rather than argued from the code: ``choose`` is handed a state and must
        hand back nothing but a command, so the rng it was given is the rng the game still has. The
        rollouts fork their own streams (`hard.py` on why they must not read this one).
        """
        state, legal = _deciding_a_purchase(cash=CASH_BUFFER + 160, position=BOARDWALK)
        before = state.rng
        HardBot().choose(state, 0, legal)
        assert state.rng == before


class TestAmendmentOneTheReserveKnowsWhatItFears:
    def test_an_empty_board_is_not_frightening(self) -> None:
        # Nobody owns anything, so the worst landing is nothing and the reserve is its floor.
        assert reserve(_state(), 0) == MIN_RESERVE

    def test_a_hotel_on_the_dearest_group_is(self) -> None:
        group = _group_of(make_state(), BOARDWALK)
        state = _state(properties={index: PropertyState(owner=1, houses=HOTEL_LEVEL) for index in group})
        assert reserve(state, 0) == MAX_RESERVE

    def test_the_reserve_tracks_the_worst_square_somebody_else_owns(self) -> None:
        # A middling developed square: above the floor, below the ceiling, and equal to the rent.
        state = _state(properties={16: PropertyState(owner=1, houses=3)})
        rent = estimated_rent(state, 16)
        assert MIN_RESERVE < rent < MAX_RESERVE, "the fixture stopped exercising the middle of the clamp"
        assert reserve(state, 0) == rent

    def test_a_mortgaged_square_frightens_nobody(self) -> None:
        """A rule the estimate has to know about: a mortgaged deed charges nothing.

        Asserted on a whole group, because a lone deed's printed rent is under the floor anyway and the
        test would pass without the mortgage check. A whole *unimproved* group doubles its rent, which is
        comfortably above `MIN_RESERVE` — and mortgaging one member cancels the lot. (Buildings cannot be
        the lever here: `PropertyState` refuses to carry houses on a mortgaged deed at all.)
        """
        group = _group_of(make_state(), BOARDWALK)
        whole = _state(properties={index: PropertyState(owner=1) for index in group})
        assert reserve(whole, 0) > MIN_RESERVE, "the fixture stopped frightening anybody"

        # Pledging the dearest member is what has to move the reserve. Its *sibling* still doubles —
        # `owns_whole_group` reads ownership and not mortgage flags, which is the engine's rule and not
        # this estimate's business — so the exposure falls to the sibling's figure rather than to zero.
        pledged = _patched(whole, {BOARDWALK: PropertyState(owner=1, mortgaged=True)})
        assert estimated_rent(pledged, BOARDWALK) == 0
        assert MIN_RESERVE < reserve(pledged, 0) < reserve(whole, 0)

    def test_it_buys_the_square_the_normal_bot_is_too_thrifty_for(self) -> None:
        """The clearest single difference between the two bots, in the position that shows it.

        Boardwalk costs 400. Holding 410 on an undeveloped board, the normal bot's flat reserve of 250
        makes the purchase look thin and it declines — a square it will not be offered again, on the
        group with the highest rent ceiling in the game. The hard bot's reserve is what the board can
        actually charge, which early on is nearly nothing.
        """
        state, legal = _deciding_a_purchase(cash=410, position=BOARDWALK)
        assert NormalBot().choose(state, 0, legal).kind == "decline_purchase"
        assert HardBot().choose(state, 0, legal).kind == "buy_property"

    def test_and_still_will_not_buy_into_a_developed_board(self) -> None:
        # The other half. With a hotel out there the reserve is 900, so the same 410 is a purchase this
        # bot declines just as its parent would — the amendment is a scale, not a licence.
        group = _group_of(make_state(), BOARDWALK)
        state, legal = _deciding_a_purchase(cash=410, position=1)
        state = _patched(state, {index: PropertyState(owner=1, houses=HOTEL_LEVEL) for index in group})
        assert reserve(state, 0) == MAX_RESERVE, "the fixture stopped putting a hotel on the board"
        assert HardBot().choose(state, 0, legal).kind == "decline_purchase"


class TestTheRentEstimateAgreesWithTheEngine:
    """The estimate is a valuation and ``rules/rent.py`` is the authority — so they must not disagree.

    A threat estimate that budgeted for a different game would be worse than none at all, and nothing
    else in the suite would catch it: the bot would simply keep the wrong reserve and lose slightly more
    often. These tests charge the rent for real and compare.
    """

    def _rent_charged(self, state: GameState, payer: PlayerId, tile_index: int) -> int:
        """Walk ``payer`` onto ``tile_index`` and read the engine's own figure off the event."""
        walking = GameState(
            **{
                **dict(state),
                "players": tuple(
                    seat.model_copy(update={"position": tile_index}) if seat.id == payer else seat
                    for seat in state.players
                ),
                "phase": Phase.RESOLVING_TILE,
                "current_player_id": payer,
            }
        )
        _after, events = charge(walking, payer, tile_index)
        charged = next(event for event in events if isinstance(event, RentCharged))
        return charged.amount

    def test_a_built_square_charges_what_the_estimate_says(self) -> None:
        state = _state(properties={16: PropertyState(owner=1, houses=3)})
        assert estimated_rent(state, 16) == self._rent_charged(state, 0, 16)

    def test_a_whole_unimproved_group_charges_double_and_the_estimate_knows(self) -> None:
        group = _group_of(make_state(), 1)
        state = _state(properties={index: PropertyState(owner=1) for index in group})
        assert estimated_rent(state, group[0]) == self._rent_charged(state, 0, group[0])
        assert estimated_rent(state, group[0]) == state.board.tile(group[0]).rent[0] * 2

    def test_an_unowned_square_charges_nothing(self) -> None:
        assert estimated_rent(_state(), 16) == 0

    def test_it_is_the_engines_own_quote_on_every_square_of_a_real_board(self) -> None:
        """MON-737. The property that says the estimate has no rent ladder of its own.

        Two claims, and the second is what makes the first worth writing:

        1. **The estimate is the quote.** For every ownable square of every sampled board it equals
           ``rent_due``'s figure, with :data:`~kesef_engine.bots.valuation._AVERAGE_DICE_TOTAL` applied
           where the quote declines to name an amount — the one piece of arithmetic left on the bot's
           side of the boundary, and the only thing this file has to review.
        2. **The quote is what gets charged.** An equality against ``rent_due`` alone would say only
           that the bot asks the same function the test does, and would stay green if ``quote`` and
           ``charge`` had drifted apart. So every square that is not a utility is *charged*, for real,
           and the estimate is compared against money the engine actually moves. Utilities are exempt
           for the reason the stand-in exists: charging one rolls, and a roll is not a quote.

        The tally is the guard against the whole thing being vacuous — an assertion that holds for
        forty unowned squares holds for nothing. Each branch is identified by the note key the engine
        itself attached, so the coverage claim is the engine's word rather than the test's re-reading
        of the board, and every branch the ladder can take has to have been reached.
        """
        boards = _golden_midgames()
        assert len(boards) >= 3, "the sample stopped being a sample"
        reached: Counter[str] = Counter()

        for state in boards:
            for tile in state.board.tiles:
                if not tile.is_ownable:
                    continue
                estimate = estimated_rent(state, tile.index)
                owner = state.properties[tile.index].owner
                if owner is None:
                    reached["unowned"] += 1
                    assert estimate == 0
                    continue
                payer = next((seat.id for seat in state.solvent_players if seat.id != owner), None)
                assert payer is not None, "a golden with one solvent seat left is a finished game"
                quoted = state.rent_due(tile.index, payer_id=payer)
                if quoted is None:
                    # Mortgaged: the deed is dormant and the bot must not fear it (trap 2).
                    reached["mortgaged"] += 1
                    assert state.properties[tile.index].mortgaged
                    assert estimate == 0
                    continue

                reached[quoted.note_keys[0]] += 1
                if quoted.amount is None:
                    assert estimate == quoted.multiplier * valuation._AVERAGE_DICE_TOTAL
                    continue
                assert estimate == quoted.amount
                assert estimate == self._rent_charged(state, payer, tile.index), (
                    f"the estimate and the charge disagree on tile {tile.index}"
                )

        assert reached.keys() >= {
            "unowned",
            "mortgaged",
            "rent.note.base",
            "rent.note.full_group_doubled",
            "rent.note.with_houses",
            "rent.note.with_hotel",
            "rent.note.railroad_count",
            "rent.note.utility_quote",
        }, f"the sampled boards stopped reaching every rent branch: {sorted(reached)}"


class TestAmendmentTwoDenial:
    def _about_to_complete_theirs(self, *, cash: int) -> tuple[GameState, int]:
        """Seat 1 holds all of the orange group but one, and seat 0 is standing on that one.

        Orange, deliberately: three squares, so the group is completable in one purchase, and dear
        enough that letting it complete is expensive.
        """
        base = make_state(seats=(make_player(0, cash=cash), make_player(1)))
        group = _group_of(base, 16)
        state = _patched(base, {index: PropertyState(owner=1) for index in group[:-1]})
        state = GameState(
            **{
                **dict(state),
                "players": tuple(
                    seat.model_copy(update={"position": group[-1]}) if seat.id == 0 else seat for seat in state.players
                ),
            }
        )
        return state, group[-1]

    def test_buys_a_square_it_does_not_want_to_stop_a_group_it_fears(self) -> None:
        """The purchase the parent declines and this bot makes.

        The square does nothing for seat 0 — it is the only member of that group it would hold — so the
        parent prices it as a lone deed and, on a thin reserve, declines. Buying it caps what the
        opponent's whole set can ever charge, which is worth more than the deed.
        """
        state, _tile = self._about_to_complete_theirs(cash=CASH_BUFFER + 20)
        legal: tuple[Command, ...] = (BuyProperty(player=0), DeclinePurchase(player=0))
        assert NormalBot().choose(state, 0, legal).kind == "decline_purchase"
        assert HardBot().choose(state, 0, legal).kind == "buy_property"

    def test_denial_is_a_reason_to_want_a_square_never_to_go_broke_for_one(self) -> None:
        # The guard that keeps amendment 2 from overriding the parent's refusals. Cash below the price
        # is not a preference the bot gets to have.
        state, tile = self._about_to_complete_theirs(cash=10)
        assert state.board.tile(tile).price is not None
        legal: tuple[Command, ...] = (BuyProperty(player=0), DeclinePurchase(player=0))
        assert HardBot().choose(state, 0, legal).kind == "decline_purchase"

    def test_it_bids_in_an_auction_to_deny_as_well(self) -> None:
        # The other moment a deed leaves the table. The lot completes seat 1's group and does nothing
        # for seat 0, and the bid is at a price the parent would not pay for a lone square.
        state, tile = self._about_to_complete_theirs(cash=1500)
        frame = AuctionFrame(
            lot=TileLot(tile=tile),
            reason=AuctionReason.DECLINED_PURCHASE,
            eligible=(0, 1),
            active=(0, 1),
            turn=0,
            resume=Phase.AWAITING_END_TURN,
        )
        state = GameState(**{**dict(state), "phase": Phase.AUCTION, "interrupts": (frame,)})
        # Above the printed price, which is more than the parent will pay for a square in somebody
        # else's group — its whole valuation of one is the 4 points `_completion_value` gives a group it
        # cannot complete. The blocking value is what makes the same bid worth making.
        price = state.board.tile(tile).price or 0
        legal: tuple[Command, ...] = (PlaceBid(player=0, amount=price + 20), WithdrawFromAuction(player=0))
        assert NormalBot().choose(state, 0, legal).kind == "withdraw_from_auction"
        assert HardBot().choose(state, 0, legal).kind == "place_bid"

    def test_it_will_not_bid_its_reserve_away_to_deny(self) -> None:
        # The floor under amendment 2 in an auction: denial is a reason to want a square, never a reason
        # to be unable to pay the next rent.
        state, tile = self._about_to_complete_theirs(cash=MIN_RESERVE + 60)
        frame = AuctionFrame(
            lot=TileLot(tile=tile),
            reason=AuctionReason.DECLINED_PURCHASE,
            eligible=(0, 1),
            active=(0, 1),
            turn=0,
            resume=Phase.AWAITING_END_TURN,
        )
        state = GameState(**{**dict(state), "phase": Phase.AUCTION, "interrupts": (frame,)})
        # A bid that would leave less than the reserve behind, on a square worth denying.
        legal: tuple[Command, ...] = (PlaceBid(player=0, amount=MIN_RESERVE + 20), WithdrawFromAuction(player=0))
        assert HardBot().choose(state, 0, legal).kind == "withdraw_from_auction"


class TestAmendmentFiveHousesAreTheWeapon:
    def _whole_group(self, *, cash: int, houses: int) -> tuple[GameState, list[int]]:
        base = make_state(seats=(make_player(0, cash=cash), make_player(1)))
        group = _group_of(base, 1)
        return _patched(base, {index: PropertyState(owner=0, houses=houses) for index in group}), group

    def test_builds_past_three_where_the_parent_stops(self) -> None:
        """The hotel step, which the parent only takes when it is twice as rich as its reserve.

        A house shortage is a race, and the parent's caution is what lost it: with 32 houses spread one
        and two to a square, no square ever reaches the four that a hotel is built from, and the game
        cannot end. See `BUILD_RESERVE` for the position that produced this.
        """
        state, group = self._whole_group(cash=BUILD_RESERVE + 200, houses=3)
        legal: tuple[Command, ...] = (END, BuildHouse(player=0, tile=group[0]))
        assert NormalBot().choose(state, 0, legal).kind == "end_turn"
        assert HardBot().choose(state, 0, legal).kind == "build_house"

    def test_but_not_with_nothing_left_over(self) -> None:
        """The floor under amendment 5: a bot that builds to its last shekel loses to the first rent.

        `BUILD_RESERVE` is a *ceiling* on the threat-scaled reserve, so on an empty board the figure that
        binds is `MIN_RESERVE` — which is the right reading, because on an empty board there is nothing
        to be afraid of but a tax card.
        """
        state, group = self._whole_group(cash=MIN_RESERVE + 40, houses=1)
        cost = state.board.tile(group[0]).house_cost or 0
        assert cost > 40, "the fixture stopped being unaffordable"
        legal: tuple[Command, ...] = (END, BuildHouse(player=0, tile=group[0]))
        assert HardBot().choose(state, 0, legal).kind == "end_turn"

    def test_the_reserve_for_houses_is_the_smaller_of_the_two(self) -> None:
        """Amendment 5 is a *ceiling* on amendment 1, not a second figure — asserted, because getting
        this backwards would make the bot build hardest exactly when a hotel is out there waiting."""
        group = _group_of(make_state(), BOARDWALK)
        mine = _group_of(make_state(), 1)
        properties = {index: PropertyState(owner=1, houses=HOTEL_LEVEL) for index in group}
        properties |= {index: PropertyState(owner=0) for index in mine}
        state = _state(cash=BUILD_RESERVE + 200, properties=properties)
        assert reserve(state, 0) == MAX_RESERVE, "the fixture stopped putting a hotel on the board"
        legal: tuple[Command, ...] = (END, BuildHouse(player=0, tile=mine[0]))
        assert HardBot().choose(state, 0, legal).kind == "build_house"


class TestAmendmentFourTradeScepticism:
    """The reciprocal swap, priced in rent rather than in printed prices.

    The normal bot's favourite offer completes a group for each side. That is what stops games running
    forever, and it is *not* symmetric: dark blue with hotels charges several times what brown does. So
    the hard bot prices both halves and passes over the swap it is on the wrong end of.
    """

    def _mutually_blocking(self, *, mine: int, theirs: int) -> GameState:
        """Seat 0 holds all of the ``mine`` group but one and seat 1 holds that one, and vice versa."""
        base = _state()
        ours = _group_of(base, mine)
        thirs = _group_of(base, theirs)
        owners: dict[int, PropertyState] = {index: PropertyState(owner=0) for index in ours[:-1]}
        owners[ours[-1]] = PropertyState(owner=1)
        owners |= {index: PropertyState(owner=1) for index in thirs[:-1]}
        owners[thirs[-1]] = PropertyState(owner=0)
        return _patched(base, owners)

    def test_it_opens_the_swap_it_gains_more_from(self) -> None:
        # Seat 0 completes the dearer group (dark blue, tile 39); seat 1 completes brown. Both bots open
        # this one — the point is that scepticism is a filter, not a refusal to trade.
        state = self._mutually_blocking(mine=BOARDWALK, theirs=1)
        chosen = HardBot().choose(state, 0, (ROLL, END))
        assert isinstance(chosen, ProposeTrade), f"expected an offer, got {chosen.kind}"
        assert is_legal(state, chosen)
        assert _swap_gain(state, 0, chosen.offer) > 0

    def _lopsided(self) -> tuple[GameState, list[int], list[int]]:
        """Seat 0 can complete brown by handing seat 1 the last of green.

        Not the mirror of the fixture above, and it could not be: brown and dark blue have **two**
        members each, so with one apiece each square completes the group for whoever lacks it and every
        such swap is mutual. A three-square group is what makes the asymmetry reachable — seat 1 holds two
        of green and seat 0 holds the third, so seat 0's square completes green for seat 1 while nothing
        of seat 1's completes green for seat 0.

        The result is a swap that is legal, deterministic, and a gift: brown's two hotels charge a few
        hundred, green's three charge thousands.
        """
        base = _state()
        brown = _group_of(base, 1)
        green = _group_of(base, 31)
        owners = {brown[0]: PropertyState(owner=0), brown[1]: PropertyState(owner=1)}
        owners |= {green[0]: PropertyState(owner=1), green[1]: PropertyState(owner=1), green[2]: PropertyState(owner=0)}
        return _patched(base, owners), brown, green

    def test_it_declines_to_open_the_swap_the_other_side_gains_more_from(self) -> None:
        state, brown, green = self._lopsided()
        legal: tuple[Command, ...] = (ROLL, END)

        offered = NormalBot().choose(state, 0, legal)
        assert isinstance(offered, ProposeTrade), "the fixture stopped tempting the parent"
        assert offered.offer.give.tiles == (green[2],), f"the parent stopped offering the green square: {offered}"
        assert _swap_gain(state, 0, offered.offer) < 0, "the fixture stopped being a bad deal"

        chosen = HardBot().choose(state, 0, legal)
        assert chosen != offered, "it opened the very swap it should have passed over"
        if isinstance(chosen, ProposeTrade):
            # Passing over a draft is not a refusal to trade: further down the list is the same square
            # asked for with cash instead, and that one is worth making.
            assert green[2] not in chosen.offer.give.tiles
            assert chosen.offer.receive.tiles == (brown[1],)
            assert _swap_gain(state, 0, chosen.offer) >= 0

    def test_the_gain_is_read_the_same_way_from_either_seat(self) -> None:
        # A trade is symmetric, so the two sides' readings of one offer must be opposites in sign. If
        # they were not, a bot could think both halves of a swap were good and open a losing one.
        state = self._mutually_blocking(mine=BOARDWALK, theirs=1)
        chosen = HardBot().choose(state, 0, (ROLL, END))
        assert isinstance(chosen, ProposeTrade)
        assert _swap_gain(state, 0, chosen.offer) == pytest.approx(-_swap_gain(state, 1, chosen.offer))


class TestTheRolloutsDecideSomething:
    """The test that would fail if the rollouts were deleted — see the module docstring.

    Everything else in this file is a heuristic, and a heuristic is what the normal bot already is. This
    one pins a position where the ranking prefers one answer and the sampled futures prefer the other,
    and asserts the bot plays the sampled one.
    """

    def _offered_a_group_completing_gift(self) -> GameState:
        """Seat 1 offers seat 0 the square completing dark blue for most of seat 0's cash.

        A position the heuristic gets *wrong*: the parent's `_score_trade` compares printed prices plus
        group value, sees a completed group coming in, and accepts — while the cash going out leaves the
        bot unable to build on the group it has just completed or to pay the rent it then lands on. The
        rollouts play both answers out and prefer keeping the money.
        """
        base = _state(cash=760)
        group = _group_of(base, BOARDWALK)
        state = _patched(base, {group[0]: PropertyState(owner=0), group[1]: PropertyState(owner=1)})
        frame = TradeFrame(
            offer=TradeOffer(
                proposer=1,
                recipient=0,
                give=TradeSide(tiles=(group[1],)),
                receive=TradeSide(cash=700),
            ),
            resume=Phase.AWAITING_END_TURN,
        )
        return GameState(**{**dict(state), "phase": Phase.TRADE_REVIEW, "interrupts": (frame,)})

    def test_it_plays_the_line_the_rollouts_prefer_over_the_one_the_ranking_prefers(self) -> None:
        state = self._offered_a_group_completing_gift()
        answers: tuple[Command, ...] = (
            RespondToTrade(player=0, accept=True),
            RespondToTrade(player=0, accept=False),
        )

        # What the ranking alone would do, taken from the bot's own scorer rather than from a copy of it.
        bot = HardBot()
        ranked = max(answers, key=lambda answer: bot._score(state, 0, answer))
        chosen, budget = search(state, 0, answers)

        assert budget.rollouts > 0, "no rollout ran, so this position proves nothing about them"
        assert isinstance(ranked, RespondToTrade) and isinstance(chosen, RespondToTrade)
        assert ranked.accept is not chosen.accept, (
            "the ranking and the rollouts agree here, so the position no longer separates them — "
            "this test can only fail for the right reason if they disagree"
        )
        assert chosen.accept is False, "the rollouts should have preferred keeping the cash"

    def test_with_the_rollouts_switched_off_the_same_position_goes_the_other_way(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The ablation, in the suite rather than only in a commit message.

        `ROLLOUT_CANDIDATES = 1` leaves every decision with a single candidate, which is the branch
        `search` returns from without sampling anything — the bot becomes its own heuristics, and nothing
        else about it changes. If the search were deleted, *this* is the answer the file would get from
        the position above, and the test above would fail. Measured at scale, the same switch takes the
        bot from 24 wins in 30 against the normal bot down to 15.
        """
        monkeypatch.setattr(search_module, "ROLLOUT_CANDIDATES", 1)
        state = self._offered_a_group_completing_gift()
        answers: tuple[Command, ...] = (
            RespondToTrade(player=0, accept=True),
            RespondToTrade(player=0, accept=False),
        )
        chosen, budget = search(state, 0, answers)
        assert budget == Budget(rollouts=0, apply_calls=0), "the rollouts were supposed to be switched off"
        assert isinstance(chosen, RespondToTrade)
        assert chosen.accept is True, "the heuristics alone were supposed to take this deal"


class TestTheBudgetIsDeterministic:
    """MON-603's second acceptance criterion, asserted on counters rather than on a clock.

    `search` reports what it spent, and every assertion here is an integer comparison. The wall-clock
    test at the bottom of the class measures and prints; it cannot fail on a slow machine, because a
    flaky assertion in a bot's test suite is how a whole gate stops being trusted (G-F30).
    """

    def _marginal(self) -> tuple[GameState, tuple[Command, ...]]:
        """A purchase the ranking cannot separate from declining, so the rollouts run."""
        return _deciding_a_purchase(cash=CASH_BUFFER + 160, position=BOARDWALK)

    def test_the_worst_decision_on_the_board_still_stops_at_the_cap(self) -> None:
        """A position with more close options than the budget allows, which is where a cap earns its pay.

        Settling a debt offers a way to raise cash for every deed the seat owns, and the parent scores
        every one of them 70 — a dead heat as wide as the portfolio. An unbounded search would roll out
        all of them; this one takes the first :data:`ROLLOUT_CANDIDATES` and stops, so the count is the
        published cap exactly rather than merely under it.

        Asserting the equality rather than the inequality is deliberate. `ROLLOUTS_PER_MOVE` is *derived*
        from its two factors, so an assertion that it equals their product could never fail; what can fail
        is the claim that the loop actually honours it.
        """
        state = _settling_a_debt(owned=(6, 8, 9, 11, 13))
        legal = tuple(command for command in legal_commands(state) if command.player == 0)
        mortgages = [command for command in legal if command.kind == "mortgage_property"]
        assert len(mortgages) > ROLLOUT_CANDIDATES, f"the fixture stopped over-supplying options: {legal}"

        _chosen, budget = search(state, 0, legal)
        assert budget.rollouts == ROLLOUTS_PER_MOVE
        assert budget.apply_calls <= MAX_APPLY_CALLS_PER_MOVE

    def test_a_decision_that_needs_a_rollout_stays_inside_the_budget(self) -> None:
        state, legal = self._marginal()
        _chosen, budget = search(state, 0, legal)
        assert budget.rollouts > 0, "the fixture stopped being a position worth thinking about"
        assert budget.rollouts <= ROLLOUTS_PER_MOVE
        assert budget.apply_calls <= MAX_APPLY_CALLS_PER_MOVE

    def test_the_budget_actually_gets_spent(self) -> None:
        """A cap nothing approaches is a cap nobody is testing.

        Two candidates at two samples each is four rollouts, and each plays the candidate plus up to
        twelve more commands — so a healthy decision spends most of its allowance. If this drops to one
        or two, the rollouts have stopped running and only this assertion would say so.
        """
        state, legal = self._marginal()
        _chosen, budget = search(state, 0, legal)
        assert budget.rollouts == len(legal) * ROLLOUTS_PER_CANDIDATE
        assert budget.apply_calls > budget.rollouts, "no rollout played past its own candidate"

    def test_a_decision_with_one_sensible_answer_spends_nothing(self) -> None:
        # Rolling (60) against ending the turn (20) is not a decision, and this is the branch that keeps
        # two hundred games runnable.
        _chosen, budget = search(_state(), 0, (ROLL, END))
        assert budget == Budget(rollouts=0, apply_calls=0)

    def test_the_gap_that_opens_the_search_is_the_published_one(self) -> None:
        # `CLOSE_ENOUGH` is not decoration: the two options here are exactly that far apart, and one
        # point further apart would be decided by the ranking alone.
        state, legal = self._marginal()
        bot = HardBot()
        scores = sorted((bot._score(state, 0, command) for command in legal), reverse=True)
        assert scores[0] - scores[1] <= CLOSE_ENOUGH

    def test_the_budget_holds_for_every_decision_of_a_whole_game(self) -> None:
        """The cap over a game rather than over a fixture, which is where a real position would break it.

        A hand-built state exercises one shape of decision. A game exercises auctions, jail, debt
        settlement and trade review, and it is a debt-settlement position with nine ways to raise cash
        that would find a budget bounded only by the number of options.
        """
        spent: list[Budget] = []

        class _Probe:
            level: BotLevel = BotLevel.HARD

            def choose(
                self,
                state: GameState,
                player: PlayerId,
                legal: tuple[Command, ...],
                *,
                may_trade: bool = True,
            ) -> Command:
                command, budget = search(state, player, legal, may_trade=may_trade)
                spent.append(budget)
                return command

        tournament.play(_Probe(), NormalBot(), seed=7, turn_cap=40)
        assert spent, "the probe never got asked anything"
        assert max(budget.rollouts for budget in spent) <= ROLLOUTS_PER_MOVE
        assert max(budget.apply_calls for budget in spent) <= MAX_APPLY_CALLS_PER_MOVE
        assert any(budget.rollouts for budget in spent), "forty turns without one rollout is not a game"

    def test_wall_clock_is_reported_and_never_asserted(self) -> None:
        """G-F30, the canonical flaky test, deliberately not written.

        This measures a decision and prints it. There is no threshold, because the only honest threshold
        for "was that fast enough" on somebody else's CI runner is "yes". The *budget* is the gate, and
        the two tests above are it.
        """
        state, legal = self._marginal()
        started = time.perf_counter()
        _chosen, budget = search(state, 0, legal)
        elapsed = time.perf_counter() - started
        print(f"\none rolled-out decision: {budget.apply_calls} apply calls in {elapsed * 1000:.0f} ms")
        assert budget.apply_calls > 0


def _timed_contest(defender: Bot) -> tuple[tournament.Result, float]:
    """A hundred games and how long they took. The seconds are printed and never asserted (G-F30).

    Worth measuring anyway: a bot whose per-move budget was accidentally widened would still pass the
    win threshold and would show up here as a nightly job that suddenly takes an hour. That is a metric
    doing its job — a human reads it and decides — rather than a threshold failing a build on somebody
    else's busy runner.
    """
    started = time.perf_counter()
    result = tournament.contest(HardBot(), defender)
    return result, time.perf_counter() - started


@pytest.mark.slow
class TestTheStrengthGate:
    """MON-603's headline criterion: ≥ 60 of 100 against *both* weaker bots, on the fixed seeds.

    Marked `slow` and run in the nightly lane (`.github/workflows/nightly.yml`), not on the PR path:
    two hundred full games with a rollout search in half the seats is minutes, not seconds, and a PR gate
    nobody dares run is worse than a nightly one everybody does.

    The thresholds are `tournament.py`'s, fixed before any of these bots existed (G-62). Nothing here may
    move them: if one of these fails, the bot is what changes.
    """

    def test_beats_the_normal_bot_and_finishes_its_games(self) -> None:
        result, seconds = _timed_contest(NormalBot())
        print(f"\nhard vs normal: {result.summary()}  wall-clock {seconds:.0f}s")
        assert result.wins >= tournament.WINS_REQUIRED, result.summary()
        assert result.capped <= tournament.MAX_CAPPED, result.summary()

    def test_beats_the_easy_bot_too_rather_than_inheriting_the_claim(self) -> None:
        """Transitivity asserted, not assumed — the backlog's wording, and it is not pedantry.

        "Hard beats normal, normal beats easy, therefore hard beats easy" is an argument about a
        non-transitive relation. Strategies form rock-paper-scissors cycles readily, and this bot's
        amendments are aimed squarely at *the normal bot's* habits: it prices the reciprocal swap the
        normal bot likes to offer, and it races the normal bot for the house supply. None of that is
        aimed at an opponent that moves at random, so it has to be measured against one.
        """
        result, seconds = _timed_contest(EasyBot())
        print(f"\nhard vs easy: {result.summary()}  wall-clock {seconds:.0f}s")
        assert result.wins >= tournament.WINS_REQUIRED, result.summary()
        assert result.capped <= tournament.MAX_CAPPED, result.summary()


class TestWhatARolloutIsJudgingAtTheEnd:
    """The leaf evaluation, tested directly — it is the half of the search a contest cannot diagnose.

    A rollout is only as good as the position it hands back, and every rollout in the file above is
    judged by this one function. If it valued the wrong thing, the contests would simply be a bit worse
    and no assertion would say why.
    """

    def test_a_won_game_outranks_every_ordinary_position(self) -> None:
        rich = _state(cash=100_000)
        over = GameState(**{**dict(_state()), "phase": Phase.GAME_OVER, "winner": 0})
        assert _evaluate(over, 0) == WIN_VALUE
        assert _evaluate(over, 1) == -WIN_VALUE
        assert _evaluate(over, 0) > _evaluate(rich, 0)

    def test_being_bankrupt_is_the_worst_thing_there_is(self) -> None:
        state = make_state(seats=(make_player(0, cash=0, bankrupt=True), make_player(1)))
        assert _evaluate(state, 0) == -WIN_VALUE

    def test_a_developed_group_beats_the_same_money_in_cash(self) -> None:
        """The opinion `RENT_WEIGHT` exists to express, and the reason net worth alone is not enough.

        Net worth counts a house at what it cost, so a seat holding a built-up group and a seat holding
        the identical sum in cash are level on the engine's own figure — and they are not level in the
        game, because only one of them charges rent. Both sides are given the same money here, so the
        *only* thing that can separate them is the standing rent.
        """
        group = _group_of(make_state(), 1)
        cost = sum((make_state().board.tile(index).price or 0) for index in group)
        cost += sum(2 * (make_state().board.tile(index).house_cost or 0) for index in group)

        built = _state(
            cash=1500 - cost,
            other_cash=1500,
            properties={index: PropertyState(owner=0, houses=2) for index in group},
        )
        assert built.net_worth(0) == built.net_worth(1), "the fixture stopped holding net worth level"
        assert _evaluate(built, 0) > 0
        assert _evaluate(built, 1) < 0


class TestItStillPlaysALegalGame:
    """The floor under everything above: a search that returned something illegal would be a hole in
    ADR-005 rather than a bot with an opinion."""

    def test_every_move_of_a_short_game_is_one_the_engine_accepts(self) -> None:
        """Two hard bots, driven the way the server drives them, with `is_legal` checked at the door.

        `tournament.play` would already raise on an illegal command, because `apply` would — but it
        would raise from inside the reducer, and the claim worth pinning is about the *bot*: everything
        it returns, including the offers it constructs under ADR-009, is something the engine accepts
        before it is applied. Hard against hard, because that is the matchup no contest covers and the
        one where every constructed offer meets a bot sceptical enough to decline it.
        """
        bots = {0: HardBot(), 1: HardBot()}
        seats = [Seat(name=f"s{index}", bot_level=BotLevel.HARD) for index in (0, 1)]
        game = new_game(
            seats, seed=5, game_id="legality", board_id="classic", ruleset=Ruleset.by_name(RulesetName.UNIVERSAL)
        )
        proposed: set[PlayerId] = set()
        turn = game.turn_number
        for _ in range(400):
            if game.phase is Phase.GAME_OVER:
                break
            if game.turn_number != turn:
                turn = game.turn_number
                proposed.clear()
            seat = game.seat_to_act
            assert seat is not None
            mine = tuple(command for command in legal_commands(game) if command.player == seat)
            chosen = bots[seat].choose(game, seat, mine, may_trade=seat not in proposed)
            assert is_legal(game, chosen), f"the bot chose something the engine rejects: {chosen}"
            if chosen.kind == "propose_trade":
                proposed.add(seat)
            game, _events = apply(game, chosen)
        assert game.turn_number > 1, "the game never got going, so nothing was really exercised"
