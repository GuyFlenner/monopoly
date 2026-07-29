"""The normal bot's opinions (MON-602).

The bot is a ranking, so every test here is of the form "given this position, does it prefer the right
thing". That is testable directly and cheaply, which matters: the *contest* against the easy bot takes
about 145 seconds and is not run in the PR gate (see the module docstring in `tournament.py` and the
backlog entry for where that number stands).

What is deliberately **not** here is an assertion that the bot wins 60 of 100. It currently wins 69 and
fails the harness's separate capped-game gate for a structural reason — no bot can propose a trade, so
split colour groups are permanent — and asserting only the half that passes would be choosing the
flattering number. The figure lives in the backlog with the decision it is waiting on.
"""

from __future__ import annotations

from helpers import make_player, make_state
from kesef_engine.bots import NormalBot
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
from kesef_engine.phases import Phase
from kesef_engine.primitives import AuctionReason, BotLevel, CashReason, TileLot
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

    Only *responding*: `Bot.choose` returns a command from the `legal` tuple and `ProposeTrade` is never
    enumerated (ADR-005's exception for an unbounded offer space), so no bot can open a trade. That is
    the limitation behind the harness's capped-game gate — see the backlog entry.
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
