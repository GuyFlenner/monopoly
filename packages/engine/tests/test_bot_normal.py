"""The normal bot's opinions (MON-602).

The bot is a ranking, so most tests here are of the form "given this position, does it prefer the right
thing". That is testable directly and cheaply, which is why the shape is worth keeping even now that
the *contest* against the easy bot is fast enough to assert directly — see `TestTheStrengthGate` at the
bottom, and the module docstring in `tournament.py` for the rules of that contest.

The contest assertion was deliberately absent until ADR-009 landed. The bot won 69/100 (needed 60) and
failed the harness's separate capped-game gate — 12 games unfinishable at 500 turns against a limit of
5, because no bot could propose a trade and so split colour groups were permanent. Asserting only the
half that passed would have been choosing the flattering number. Both halves pass now.
"""

from __future__ import annotations

import tournament

from helpers import make_player, make_state
from kesef_engine.bots import EasyBot, NormalBot
from kesef_engine.bots.base import Bot
from kesef_engine.bots.normal import BUILD_TARGET, CASH_BUFFER, _completion_value
from kesef_engine.commands import (
    BuildHouse,
    BuyProperty,
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
from kesef_engine.events import TradeProposed
from kesef_engine.legality import is_legal
from kesef_engine.phases import PORTFOLIO_PHASES, Phase
from kesef_engine.primitives import AuctionReason, BotLevel, CashReason, PlayerId, TileLot
from kesef_engine.reducer import apply
from kesef_engine.ruleset import Ruleset
from kesef_engine.state import AuctionFrame, DebtFrame, GameState, Obligation, PropertyState, TradeFrame

END = EndTurn(player=0, elapsed_seconds=None)
ROLL = RollDice(player=0)


def _state(*, cash: int = 1500, position: int = 0, properties: dict[int, PropertyState] | None = None) -> GameState:
    state = make_state(seats=(make_player(0, cash=cash, position=position), make_player(1)))
    if properties is None:
        return state
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


class TestTheProtocol:
    def test_satisfies_the_bot_protocol(self) -> None:
        bot: Bot = NormalBot()
        assert bot.level is BotLevel.NORMAL

    def test_never_returns_a_command_outside_the_tuple(self) -> None:
        bot = NormalBot()
        legal: tuple[Command, ...] = (END, ROLL, BuyProperty(player=0))
        assert bot.choose(_state(), 0, legal) in legal

    def test_refuses_an_empty_choice(self) -> None:
        try:
            NormalBot().choose(_state(), 0, ())
        except ValueError:
            return
        raise AssertionError("an empty legal tuple should raise")

    def test_is_deterministic_without_any_rng(self) -> None:
        # No stream, no fingerprint, no draw — unlike the easy bot, which needs all three. The same
        # position must give the same answer, and two instances must agree, because the tournament
        # harness builds one per game.
        state = _state()
        legal: tuple[Command, ...] = (END, ROLL)
        first = NormalBot().choose(state, 0, legal)
        assert all(NormalBot().choose(state, 0, legal) == first for _ in range(10))


class TestOpinionOneTheCashBuffer:
    def test_buys_when_the_purchase_leaves_a_reserve(self) -> None:
        # Standing on a buyable square with plenty of cash: buying is the point of the game.
        state = _state(cash=1500, position=1)
        legal: tuple[Command, ...] = (BuyProperty(player=0), DeclinePurchase(player=0))
        assert NormalBot().choose(state, 0, legal).kind == "buy_property"

    def test_declines_when_the_purchase_would_leave_it_thin(self) -> None:
        # The single biggest difference from the easy bot, which buys until it cannot pay. `position=39`
        # is Boardwalk on the classic board — the most expensive square, so the thinness penalty bites.
        state = _state(cash=410, position=39)
        legal: tuple[Command, ...] = (BuyProperty(player=0), DeclinePurchase(player=0))
        assert NormalBot().choose(state, 0, legal).kind == "decline_purchase"

    def test_never_buys_what_it_cannot_afford(self) -> None:
        # Belt and braces: the engine would not offer this, and the bot still scores it below anything.
        state = _state(cash=5, position=39)
        legal: tuple[Command, ...] = (BuyProperty(player=0), DeclinePurchase(player=0))
        assert NormalBot().choose(state, 0, legal).kind == "decline_purchase"

    def test_will_not_spend_its_reserve_on_houses(self) -> None:
        state = _state(cash=CASH_BUFFER, properties={1: PropertyState(owner=0)})
        legal: tuple[Command, ...] = (BuildHouse(player=0, tile=1), END)
        assert NormalBot().choose(state, 0, legal).kind == "end_turn"


class TestOpinionTwoGroupCompletion:
    def test_completing_a_group_beats_a_lone_square(self) -> None:
        # The valuation function directly, because the ordering it encodes is the opinion.
        assert _completion_value(mine=2, theirs=0, total=3) > _completion_value(mine=0, theirs=0, total=3)

    def test_a_group_the_opponent_has_broken_is_worth_almost_nothing(self) -> None:
        """The correction that turned a bot which led games into one that finishes them.

        A group somebody else holds a piece of can never be completed, so it can never be built on. The
        first version ignored the opponent and spread cash evenly across broken groups, which in a
        two-player game leaves *neither* side able to build — 16 of 100 games ran to the 500-turn cap
        with the bot ahead and no way to convert it.
        """
        broken = _completion_value(mine=1, theirs=1, total=3)
        open_group = _completion_value(mine=1, theirs=0, total=3)
        assert broken < open_group
        assert broken < _completion_value(mine=0, theirs=0, total=3)

    def test_prefers_the_square_that_completes_its_own_group(self) -> None:
        # Two buyable positions are not offerable at once — `BuyProperty` carries no tile — so this is
        # asserted the way the bot experiences it: the same command scores higher when the seat is
        # standing on a square that completes a group it already part-owns.
        bot = NormalBot()
        group = _group_of(make_state(), 1)
        nearly = {index: PropertyState(owner=0) for index in group[:-1]}
        completing = _state(cash=1500, position=group[-1], properties=nearly)
        indifferent = _state(cash=1500, position=group[-1])
        buy = BuyProperty(player=0)
        assert bot._score(completing, 0, buy) > bot._score(indifferent, 0, buy)


class TestOpinionThreeBuildToThree:
    def test_prefers_building_over_ending_the_turn(self) -> None:
        state = _state(cash=3000, properties={1: PropertyState(owner=0)})
        legal: tuple[Command, ...] = (END, BuildHouse(player=0, tile=1))
        assert NormalBot().choose(state, 0, legal).kind == "build_house"

    def test_the_first_houses_matter_most(self) -> None:
        bot = NormalBot()
        build = BuildHouse(player=0, tile=1)
        low = _state(cash=3000, properties={1: PropertyState(owner=0, houses=0)})
        high = _state(cash=3000, properties={1: PropertyState(owner=0, houses=BUILD_TARGET - 1)})
        assert bot._score(low, 0, build) > bot._score(high, 0, build)

    def test_still_builds_past_three_when_cash_is_spare(self) -> None:
        """ "Builds to three" is what it does *first*, not a ceiling.

        The first version scored building past the target at 10, below `end_turn`'s 20 — so the bot
        never built a fourth house or a hotel at all. It won anyway and could not finish games: without
        hotels there is no rent big enough to bankrupt anybody.
        """
        state = _state(cash=10_000, properties={1: PropertyState(owner=0, houses=BUILD_TARGET)})
        legal: tuple[Command, ...] = (END, BuildHouse(player=0, tile=1))
        assert NormalBot().choose(state, 0, legal).kind == "build_house"

    def test_but_not_past_three_on_a_thin_reserve(self) -> None:
        state = _state(cash=CASH_BUFFER + 60, properties={1: PropertyState(owner=0, houses=BUILD_TARGET)})
        legal: tuple[Command, ...] = (END, BuildHouse(player=0, tile=1))
        assert NormalBot().choose(state, 0, legal).kind == "end_turn"


class TestItNeverWorksAgainstItself:
    """The same rule the easy bot learned the hard way, scored rather than filtered."""

    def test_does_not_sell_or_mortgage_while_solvent(self) -> None:
        state = _state(cash=1500, properties={1: PropertyState(owner=0, houses=1)})
        legal: tuple[Command, ...] = (
            END,
            SellHouse(player=0, tile=1, demolish_hotel=False),
            MortgageProperty(player=0, tile=1),
        )
        assert NormalBot().choose(state, 0, legal).kind == "end_turn"

    def test_raises_cash_when_settling_a_debt(self) -> None:
        state = _in_debt(cash=50)
        legal: tuple[Command, ...] = (
            SellHouse(player=0, tile=1, demolish_hotel=False),
            UnmortgageProperty(player=0, tile=3),
            DeclareBankruptcy(player=0),
        )
        # Selling raises money; paying a mortgage off spends it; bankruptcy is the last resort.
        assert NormalBot().choose(state, 0, legal).kind == "sell_house"

    def test_bankruptcy_is_the_last_resort(self) -> None:
        state = _in_debt(cash=0)
        legal: tuple[Command, ...] = (DeclareBankruptcy(player=0),)
        assert NormalBot().choose(state, 0, legal).kind == "declare_bankruptcy"


def _in_debt(*, cash: int) -> GameState:
    state = _state(
        cash=cash, properties={1: PropertyState(owner=0, houses=1), 3: PropertyState(owner=0, mortgaged=True)}
    )
    frame = DebtFrame(
        debtor=0,
        reason=CashReason.RENT,
        total=cash + 800,
        obligations=(Obligation(creditor=1, amount=cash + 800),),
        resume=Phase.AWAITING_END_TURN,
    )
    return GameState(**{**dict(state), "phase": Phase.DEBT_SETTLEMENT, "interrupts": (frame,)})


class TestOpinionFourTradeEvaluation:
    """Responding to an offer (MON-602's fourth criterion).

    `respond_to_trade` *is* enumerated, so this half needed no protocol change and predates ADR-009.
    Opening a trade is the other half, in `TestOpinionFourProposingATrade` below.
    """

    def _reviewing(
        self,
        *,
        give: tuple[int, ...],
        receive: tuple[int, ...],
        give_cash: int = 0,
        receive_cash: int = 0,
        cash: int = 1500,
    ) -> GameState:
        """Seat 0 is the *recipient*, so it receives `give` and hands over `receive`."""
        state = _state(cash=cash, properties={index: PropertyState(owner=1) for index in give})
        frame = TradeFrame(
            offer=TradeOffer(
                proposer=1,
                recipient=0,
                give=TradeSide(cash=give_cash, tiles=give),
                receive=TradeSide(cash=receive_cash, tiles=receive),
            ),
            resume=Phase.AWAITING_END_TURN,
        )
        return GameState(**{**dict(state), "phase": Phase.TRADE_REVIEW, "interrupts": (frame,)})

    def _answers(self) -> tuple[Command, ...]:
        return (RespondToTrade(player=0, accept=True), RespondToTrade(player=0, accept=False))

    def test_accepts_an_offer_that_completes_a_group(self) -> None:
        # Seat 0 already holds all but one of a group; the missing square is on the table for nothing.
        group = _group_of(make_state(), 1)
        state = self._reviewing(give=(group[-1],), receive=())
        held = {index: PropertyState(owner=0) for index in group[:-1]}
        held[group[-1]] = PropertyState(owner=1)
        state = GameState(
            **{
                **dict(state),
                "properties": tuple(
                    held.get(tile.index, prop) for tile, prop in zip(state.board.tiles, state.properties, strict=True)
                ),
            }
        )
        chosen = NormalBot().choose(state, 0, self._answers())
        assert isinstance(chosen, RespondToTrade)
        assert chosen.accept is True

    def test_declines_an_offer_that_gives_more_than_it_gets(self) -> None:
        group = _group_of(make_state(), 1)
        # Asked for a square and a pile of cash, offered nothing.
        state = self._reviewing(give=(), receive=(group[0],), receive_cash=900)
        state = GameState(
            **{
                **dict(state),
                "properties": tuple(
                    PropertyState(owner=0) if tile.index == group[0] else prop
                    for tile, prop in zip(state.board.tiles, state.properties, strict=True)
                ),
            }
        )
        chosen = NormalBot().choose(state, 0, self._answers())
        assert isinstance(chosen, RespondToTrade)
        assert chosen.accept is False

    def test_declines_when_it_cannot_afford_the_cash_side(self) -> None:
        # However good the squares are, the reserve comes first — opinion 1 outranks opinion 4.
        group = _group_of(make_state(), 1)
        state = self._reviewing(give=(group[-1],), receive=(), receive_cash=1400, cash=1500)
        chosen = NormalBot().choose(state, 0, self._answers())
        assert isinstance(chosen, RespondToTrade)
        assert chosen.accept is False

    def test_declines_when_there_is_no_frame_to_read(self) -> None:
        # Defensive: a review answer offered with no trade on the stack is a position that should not
        # happen, and saying no is the safe reading of it.
        chosen = NormalBot().choose(_state(), 0, self._answers())
        assert isinstance(chosen, RespondToTrade)
        assert chosen.accept is False


class TestAuctionsAndJail:
    def test_bids_for_a_square_it_wants(self) -> None:
        group = _group_of(make_state(), 1)
        held = {index: PropertyState(owner=0) for index in group[:-1]}
        state = _state(cash=2000, properties=held)
        frame = AuctionFrame(
            lot=TileLot(tile=group[-1]),
            reason=AuctionReason.DECLINED_PURCHASE,
            eligible=(0, 1),
            active=(0, 1),
            turn=0,
            resume=Phase.AWAITING_END_TURN,
        )
        state = GameState(**{**dict(state), "phase": Phase.AUCTION, "interrupts": (frame,)})
        legal: tuple[Command, ...] = (
            PlaceBid(player=0, amount=10),
            WithdrawFromAuction(player=0),
        )
        assert NormalBot().choose(state, 0, legal).kind == "place_bid"

    def test_withdraws_rather_than_bid_its_reserve_away(self) -> None:
        group = _group_of(make_state(), 1)
        state = _state(cash=CASH_BUFFER, properties={index: PropertyState(owner=0) for index in group[:-1]})
        frame = AuctionFrame(
            lot=TileLot(tile=group[-1]),
            reason=AuctionReason.DECLINED_PURCHASE,
            eligible=(0, 1),
            active=(0, 1),
            turn=0,
            resume=Phase.AWAITING_END_TURN,
        )
        state = GameState(**{**dict(state), "phase": Phase.AUCTION, "interrupts": (frame,)})
        legal: tuple[Command, ...] = (
            PlaceBid(player=0, amount=CASH_BUFFER),
            WithdrawFromAuction(player=0),
        )
        assert NormalBot().choose(state, 0, legal).kind == "withdraw_from_auction"

    def test_uses_a_free_card_before_paying_bail(self) -> None:
        state = _state(cash=1500)
        legal: tuple[Command, ...] = (
            PayJailFine(player=0),
            UseJailCard(player=0),
            RollForJail(player=0),
        )
        assert NormalBot().choose(state, 0, legal).kind == "use_jail_card"

    def test_sits_out_rather_than_spend_its_last_cash_on_bail(self) -> None:
        state = _state(cash=CASH_BUFFER)
        legal: tuple[Command, ...] = (PayJailFine(player=0), RollForJail(player=0))
        assert NormalBot().choose(state, 0, legal).kind == "roll_for_jail"

    def test_the_bail_it_weighs_is_the_rule_sets_fine_not_the_printed_one(self) -> None:
        """MON-736. One seat, one pile of cash, two rule sets — and two different answers.

        `jail_fine` is a setting (MON-712), so "can I afford to leave" is only a real question if the
        bot reads it. The fixture straddles the buffer deliberately: after the classic fine this seat
        still clears `CASH_BUFFER`, after the expensive one it does not, and a bot that had memorised
        50 would pay 400 while believing its reserve was intact. Both tiers inherit this scorer, so
        this one assertion covers the hard bot too.
        """
        cash = CASH_BUFFER + 150
        cheap, dear = 50, 400
        assert cash - cheap >= CASH_BUFFER > cash - dear, "the fixture stopped straddling the buffer"
        legal: tuple[Command, ...] = (PayJailFine(player=0), RollForJail(player=0))

        def choice(fine: int) -> str:
            state = make_state(
                seats=(make_player(0, cash=cash), make_player(1)),
                ruleset=Ruleset.universal().model_copy(update={"jail_fine": fine}),
            )
            return NormalBot().choose(state, 0, legal).kind

        assert choice(cheap) == "pay_jail_fine"
        assert choice(dear) == "roll_for_jail"


def _owned(state: GameState, owners: dict[int, int]) -> GameState:
    """`state` with `owners` applied as `{tile_index: player_id}`."""
    return GameState(
        **{
            **dict(state),
            "properties": tuple(
                PropertyState(owner=owners[tile.index]) if tile.index in owners else prop
                for tile, prop in zip(state.board.tiles, state.properties, strict=True)
            ),
        }
    )


class TestOpinionFourProposingATrade:
    """Opening a trade — ADR-009, and the reason MON-602 could not pass its own gate before it.

    `ProposeTrade` is never enumerated in `legal_commands` (ADR-005's exception, the offer space being
    unbounded), so these tests are about a command the bot *constructs*. The one that matters most is
    `test_the_offer_it_builds_is_one_the_engine_accepts`: a constructed command earns no privilege, and
    if the bot could hand `apply` something illegal the whole arrangement would be a hole in ADR-005
    rather than a documented exception to it.
    """

    def _split(self, *, cash: int = 1500) -> tuple[GameState, list[int], list[int]]:
        """The stalemate this whole feature exists for, in its smallest form.

        Seat 0 holds all of light blue but one; seat 1 holds that one. Seat 1 holds all of pink but one;
        seat 0 holds that one. Neither can build, and one swap fixes it for both — which is the point
        rather than a concession: a board where both sides can build is a board somebody loses.
        """
        base = _state(cash=cash)
        ours = _group_of(base, 6)
        theirs = _group_of(base, 11)
        owners = dict.fromkeys(ours[:-1], 0) | {ours[-1]: 1}
        owners |= dict.fromkeys(theirs[:-1], 1) | {theirs[-1]: 0}
        return _owned(base, owners), ours, theirs

    def _rolling(self) -> tuple[Command, ...]:
        """What a portfolio phase offers when there is nothing worth building: roll, or end."""
        return (ROLL, END)

    def test_proposes_the_swap_that_un_splits_both_groups(self) -> None:
        state, ours, theirs = self._split()
        chosen = NormalBot().choose(state, 0, self._rolling())
        assert isinstance(chosen, ProposeTrade), f"expected an offer, got {chosen.kind}"
        assert chosen.offer.receive.tiles == (ours[-1],), "it did not ask for the square completing its group"
        assert chosen.offer.give.tiles == (theirs[-1],), "it did not hand over the square blocking theirs"
        assert chosen.offer.give.cash == 0, "a reciprocal swap needs no sweetener"

    def test_the_offer_it_builds_is_one_the_engine_accepts(self) -> None:
        # The load-bearing claim of ADR-009. `is_legal` first, because that is what the bot itself
        # checked; then `apply`, because agreement between the two is what makes the exception safe.
        state, _ours, _theirs = self._split()
        chosen = NormalBot().choose(state, 0, self._rolling())
        assert is_legal(state, chosen), "the bot proposed something the engine rejects"
        _after, events = apply(state, chosen)
        assert any(isinstance(event, TradeProposed) for event in events)

    def test_may_trade_false_holds_it_to_the_enumerated_commands(self) -> None:
        # The driver's permission, and the only thing standing between a stateless bot and an identical
        # offer every time it is asked. See ADR-009.
        state, _ours, _theirs = self._split()
        legal = self._rolling()
        assert NormalBot().choose(state, 0, legal, may_trade=False) in legal

    def test_two_instances_build_the_same_offer(self) -> None:
        # Still no RNG. The tournament harness builds a bot per game and the server shares one across
        # every game, so the two must not be able to disagree.
        state, _ours, _theirs = self._split()
        first = NormalBot().choose(state, 0, self._rolling())
        assert all(NormalBot().choose(state, 0, self._rolling()) == first for _ in range(5))

    def test_builds_what_it_owns_before_going_looking_for_a_swap(self) -> None:
        # `PROPOSE_SCORE` sits below `build_house`, so a bot with a house worth building does that
        # first. It also keeps the offer search off the hot path — it runs only when rolling and ending
        # are all that is left.
        state, _ours, theirs = self._split(cash=3000)
        legal: tuple[Command, ...] = (ROLL, BuildHouse(player=0, tile=theirs[-1]))
        assert NormalBot().choose(state, 0, legal).kind == "build_house"

    def test_does_not_propose_when_no_swap_completes_a_group(self) -> None:
        legal = self._rolling()
        assert NormalBot().choose(_state(), 0, legal) in legal

    def test_does_not_propose_while_settling_a_debt(self) -> None:
        # `is_legal` would allow a debtor to trade, but these offers swap squares rather than raise
        # cash, so proposing one would spend a turn not solving the problem in front of it.
        state, _ours, _theirs = self._split()
        frame = DebtFrame(
            debtor=0,
            reason=CashReason.RENT,
            total=900,
            obligations=(Obligation(creditor=1, amount=900),),
            resume=Phase.AWAITING_END_TURN,
        )
        state = GameState(**{**dict(state), "phase": Phase.DEBT_SETTLEMENT, "interrupts": (frame,)})
        legal: tuple[Command, ...] = (MortgageProperty(player=0, tile=6), DeclareBankruptcy(player=0))
        assert NormalBot().choose(state, 0, legal).kind == "mortgage_property"

    def test_never_swaps_one_half_of_a_split_two_square_group_for_the_other(self) -> None:
        """The defect this test exists for was legal, deterministic, and completely pointless.

        Brown and dark blue have two members each. With one apiece, *each* square completes the group
        for whoever does not hold it — so the bot's qualified as something to give away and the
        opponent's qualified as something to want, and pairing them produced an offer that swapped a
        split group for the same split group. Every turn, forever.
        """
        base = _state()
        brown = _group_of(base, 1)
        state = _owned(base, {brown[0]: 0, brown[1]: 1})
        chosen = NormalBot().choose(state, 0, self._rolling())
        assert isinstance(chosen, ProposeTrade)
        assert chosen.offer.receive.tiles == (brown[1],)
        assert chosen.offer.give.tiles == (), f"it offered a square from the group it wants to complete: {chosen}"

    def _sweetened(self, *, cash: int) -> tuple[GameState, int, int]:
        """Seat 0 wants a dark blue square and holds nothing seat 1 needs — only a dead light blue.

        The light blue group has an unsold member, so handing seat 1 the bot's share completes nothing;
        it is a blocker being given up, and the price gap is what makes the offer worth answering.
        """
        base = _state(cash=cash)
        dark_blue = _group_of(base, 39)
        light_blue = _group_of(base, 6)
        owners = {dark_blue[0]: 0, dark_blue[1]: 1, light_blue[0]: 0, light_blue[1]: 1}
        return _owned(base, owners), dark_blue[1], light_blue[0]

    def test_pays_a_sweetener_when_it_has_nothing_the_other_side_needs(self) -> None:
        state, want, give = self._sweetened(cash=1500)
        chosen = NormalBot().choose(state, 0, self._rolling())
        assert isinstance(chosen, ProposeTrade)
        assert chosen.offer.receive.tiles == (want,)
        assert chosen.offer.give.tiles == (give,)
        gap = (state.board.tile(want).price or 0) - (state.board.tile(give).price or 0)
        assert gap > 0, "the fixture stopped exercising the sweetener"
        assert chosen.offer.give.cash == gap, "the sweetener should close the gap in printed prices"

    def test_the_sweetener_never_dips_into_the_reserve(self) -> None:
        # Opinion 1 outranks opinion 4 when proposing, exactly as it does when responding.
        state, _want, _give = self._sweetened(cash=CASH_BUFFER + 40)
        chosen = NormalBot().choose(state, 0, self._rolling())
        assert isinstance(chosen, ProposeTrade)
        assert chosen.offer.give.cash == 40
        assert state.player(0).cash - chosen.offer.give.cash == CASH_BUFFER

    def test_offers_cash_alone_when_it_has_no_square_to_spare(self) -> None:
        base = _state()
        group = _group_of(base, 6)
        state = _owned(base, {group[0]: 0, group[1]: 0, group[2]: 1})
        chosen = NormalBot().choose(state, 0, self._rolling())
        assert isinstance(chosen, ProposeTrade)
        assert chosen.offer.give.tiles == ()
        # Twice the printed price: dear for one square, and the right price for the one that makes a
        # whole group, because building is not legal without one.
        assert chosen.offer.give.cash == (state.board.tile(group[2]).price or 0) * 2

    def test_says_nothing_when_it_cannot_afford_to_say_anything(self) -> None:
        # No reciprocal square, nothing spare, and no cash above the reserve: the honest answer is to
        # roll rather than to open a trade it cannot fund.
        base = _state(cash=CASH_BUFFER)
        group = _group_of(base, 6)
        state = _owned(base, {group[0]: 0, group[1]: 0, group[2]: 1})
        legal = self._rolling()
        assert NormalBot().choose(state, 0, legal) in legal


class _Proposes:
    """A bot that opens an empty trade whenever the driver allows it, and records both facts.

    Empty on purpose: `TradeSide()` moves nothing, so it is legal between any two solvent players in a
    portfolio phase and needs no position set up for it. What is under test is the *driver's* budget,
    not the offer.
    """

    level: BotLevel = BotLevel.NORMAL

    def __init__(self, *, propose: bool = True) -> None:
        self.propose = propose
        self.permitted: list[tuple[int, PlayerId]] = []
        self.proposals: list[tuple[int, PlayerId]] = []

    def choose(
        self,
        state: GameState,
        player: PlayerId,
        legal: tuple[Command, ...],
        *,
        may_trade: bool = True,
    ) -> Command:
        if may_trade:
            self.permitted.append((state.turn_number, player))
        if self.propose and may_trade and state.phase in PORTFOLIO_PHASES:
            other = next(seat.id for seat in state.solvent_players if seat.id != player)
            offer = TradeOffer(proposer=player, recipient=other, give=TradeSide(), receive=TradeSide())
            command = ProposeTrade(player=player, offer=offer)
            if is_legal(state, command):
                self.proposals.append((state.turn_number, player))
                return command
        return NormalBot().choose(state, player, legal, may_trade=False)


class TestTheDriverSpendsTheTradePermission:
    """The loop ADR-009 has to break, and where it is broken.

    A bot is a pure function of the position, and declining an offer puts the position back to
    essentially what it was — so a bot asked twice would offer the identical swap forever. The fix is
    the driver's, not the engine's and not the bot's: one proposal per seat per turn, spent whether the
    answer is yes or no. `kesef_server/bots.py` enforces the same rule for the server.
    """

    def test_one_proposal_per_seat_per_turn(self) -> None:
        bot = _Proposes()
        tournament.play(bot, EasyBot(), seed=3, turn_cap=12)
        assert bot.proposals, "the stub never got to propose, so this proves nothing"
        duplicated = [key for key in bot.proposals if bot.proposals.count(key) > 1]
        assert not duplicated, f"a seat proposed more than once in a turn: {duplicated}"

    def test_the_game_still_reaches_a_result(self) -> None:
        """Without the guard this is not a failed assertion, it is a game that never ends.

        The stub proposes, the offer is answered, the position is back where it was, and the seat is
        asked again — so the turn never advances and `play` runs into `STEP_CAP_PER_GAME`.
        """
        outcome = tournament.play(_Proposes(), EasyBot(), seed=3, turn_cap=12)
        assert outcome.turns >= 1

    def test_a_bot_that_never_proposes_keeps_its_permission_all_turn(self) -> None:
        # The other half of the rule: the budget is spent by *proposing*, not merely by being asked. A
        # driver that withdrew the permission after any move at all would silence a bot that had not
        # used it — so a seat that declines to propose must still be asked with the permission open on
        # its later moves in the same turn.
        bot = _Proposes(propose=False)
        tournament.play(bot, EasyBot(), seed=3, turn_cap=6)
        assert not bot.proposals
        asked_twice = [key for key in set(bot.permitted) if bot.permitted.count(key) > 1]
        assert asked_twice, f"no seat was offered the permission twice in one turn: {bot.permitted}"


class TestTheStrengthGate:
    """MON-602's headline acceptance criterion, asserted rather than reported.

    Roughly 25 seconds, which is why it was worth waiting for the capped-game gate to pass before
    adding it: an assertion nobody dares run is documentation. The thresholds are `tournament.py`'s,
    fixed before the contest existed (G-62), and nothing here may move them — if this fails, the bot is
    what changes.
    """

    def test_beats_the_easy_bot_and_finishes_its_games(self) -> None:
        result = tournament.contest(NormalBot(), EasyBot())
        assert result.wins >= tournament.WINS_REQUIRED, result.summary()
        assert result.capped <= tournament.MAX_CAPPED, result.summary()
