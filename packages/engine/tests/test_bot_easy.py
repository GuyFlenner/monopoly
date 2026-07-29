"""The easy bot (MON-601).

Four properties, in the order a defect would hurt:

1. **It only ever returns a legal command.** Everything downstream trusts this.
2. **It always buys what it can afford**, which is its one preference.
3. **It is deterministic** — the same position gives the same choice, or a bot game does not replay
   from its seed.
4. **Its randomness does not collapse.** This is the one that needed a design decision rather than a
   line of code, so it gets the most testing: a naive `state.rng.fork(stream)` returns the same index
   for every position in which the dice have not moved, which makes the bot a fixed preference
   wearing a random coat. See `bots/easy.py`.
"""

from __future__ import annotations

from collections import Counter

from helpers import make_player, make_state
from kesef_engine.bots import EasyBot
from kesef_engine.bots.base import Bot
from kesef_engine.commands import BuyProperty, Command, EndTurn, RollDice
from kesef_engine.legality import legal_commands
from kesef_engine.primitives import BotLevel
from kesef_engine.reducer import apply
from kesef_engine.state import GameState, PropertyState


def _two_seats() -> GameState:
    return make_state(seats=(make_player(0, cash=1500), make_player(1, cash=1500)))


def _legal_for(state: GameState, player: int) -> tuple[Command, ...]:
    """`legal_commands(state)` answers for *every* seat that may act, including during an interrupt.

    Narrowing to one seat is the caller's job — the server's turn driver does it before consulting a
    bot, and so does this file, rather than handing a bot a tuple containing another player's moves.
    """
    return tuple(command for command in legal_commands(state) if command.player == player)


class TestTheProtocol:
    def test_satisfies_the_bot_protocol(self) -> None:
        # A structural check, so a signature change is a type error here rather than a runtime
        # surprise in the server's turn driver.
        bot: Bot = EasyBot()
        assert bot.level is BotLevel.EASY

    def test_never_returns_a_command_outside_the_legal_tuple(self) -> None:
        bot = EasyBot()
        state = _two_seats()
        for _ in range(200):
            legal = _legal_for(state, state.current_player_id)
            if not legal:
                break
            chosen = bot.choose(state, state.current_player_id, legal)
            assert chosen in legal
            state, _ = apply(state, chosen)

    def test_refuses_an_empty_choice_rather_than_inventing_one(self) -> None:
        # The reducer always offers the waiting seat something, so an empty tuple is the caller's
        # bug. Raising names it; returning a guess would put an illegal command on the wire.
        bot = EasyBot()
        try:
            bot.choose(_two_seats(), 0, ())
        except ValueError:
            return
        raise AssertionError("an empty legal tuple should raise")


class TestItAlwaysBuys:
    def test_takes_a_purchase_over_every_other_option(self) -> None:
        bot = EasyBot()
        state = _two_seats()
        # A position where buying is one of several options. Constructed rather than played to, so
        # the assertion does not depend on which square a seed happens to reach.
        legal: tuple[Command, ...] = (
            EndTurn(player=0, elapsed_seconds=None),
            BuyProperty(player=0),
        )
        for _ in range(50):
            # Fifty draws: if the preference were merely likely rather than certain, this fails.
            assert bot.choose(state, 0, legal).kind == "buy_property"

    def test_does_not_second_guess_affordability(self) -> None:
        """`BuyProperty` in `legal` *is* the engine saying it is affordable.

        A bot that re-checked cash against price would be a second implementation of
        `error.insufficient_funds`, and the one that disagreed would be this one. So the bot buys on a
        seat with almost nothing, because the engine offered it.
        """
        bot = EasyBot()
        state = make_state(seats=(make_player(0, cash=1), make_player(1)))
        legal: tuple[Command, ...] = (EndTurn(player=0, elapsed_seconds=None), BuyProperty(player=0))
        assert bot.choose(state, 0, legal).kind == "buy_property"


class TestDeterminism:
    def test_the_same_position_gives_the_same_choice(self) -> None:
        bot = EasyBot()
        state = _two_seats()
        legal = _legal_for(state, 0)
        first = bot.choose(state, 0, legal)
        assert all(bot.choose(state, 0, legal) == first for _ in range(20))

    def test_two_bots_of_the_same_level_agree(self) -> None:
        # The bot holds no state, so two instances are interchangeable — which is what lets the
        # tournament harness in MON-602 construct one per game without changing the outcome.
        state = _two_seats()
        legal = _legal_for(state, 0)
        assert EasyBot().choose(state, 0, legal) == EasyBot().choose(state, 0, legal)

    def test_it_does_not_consume_the_dice_stream(self) -> None:
        """The bot must not move `state.rng`, or a bot's presence would change a human's dice.

        `choose` is pure and cannot mutate anything, so what this really pins is that the bot draws
        from its own stream rather than being handed the dice one — checked by playing the same
        seeded game with and without asking the bot, and comparing the rolls.
        """
        bot = EasyBot()
        rolls: list[tuple[int, int]] = []
        for consult in (False, True):
            state = make_state(seats=(make_player(0), make_player(1)), seed=99)
            for _ in range(6):
                legal = _legal_for(state, state.current_player_id)
                if consult and legal:
                    bot.choose(state, state.current_player_id, legal)
                roll = RollDice(player=state.current_player_id)
                if not any(command == roll for command in legal):
                    break
                state, _ = apply(state, roll)
                assert state.dice is not None
                rolls.append((state.dice.first, state.dice.second))
                end = EndTurn(player=state.current_player_id, elapsed_seconds=None)
                if any(command == end for command in _legal_for(state, state.current_player_id)):
                    state, _ = apply(state, end)
        half = len(rolls) // 2
        assert rolls[:half] == rolls[half:], "consulting the bot changed the dice"


class TestTheRandomnessDoesNotCollapse:
    """The trap `bots/easy.py` was designed around, tested directly.

    With a plain `state.rng.fork(stream)`, every position in which the dice have not moved draws the
    same index — so a bot offered "build here / build there / end turn" builds on the same square
    until the even-build rule stops it, and calls that random.
    """

    def test_a_position_that_differs_only_in_cash_draws_differently(self) -> None:
        # Cash is what changes within a turn as the bot spends, and it is the field that makes the
        # repeated-build case draw a fresh index. Two otherwise identical seats must not be locked to
        # the same choice.
        bot = EasyBot()
        legal: tuple[Command, ...] = (
            EndTurn(player=0, elapsed_seconds=None),
            RollDice(player=0),
        )
        picks = set()
        for cash in range(200, 260):
            state = make_state(seats=(make_player(0, cash=cash), make_player(1)))
            picks.add(bot.choose(state, 0, legal).kind)
        assert len(picks) > 1, "the choice is locked regardless of position — the fork trap"

    def test_it_spreads_over_the_options_across_many_positions(self) -> None:
        """Roughly uniform, asserted loosely.

        A tight distribution test on a hash-derived stream would be a test of splitmix64, which is
        not this file's business. What matters is that no option is starved: an easy bot that never
        ends its turn, or never rolls, is not the opponent MON-602 is measured against.
        """
        bot = EasyBot()
        legal: tuple[Command, ...] = (
            EndTurn(player=0, elapsed_seconds=None),
            RollDice(player=0),
        )
        counts: Counter[str] = Counter()
        for turn in range(120):
            state = make_state(seats=(make_player(0, cash=1500 + turn), make_player(1)))
            counts[bot.choose(state, 0, legal).kind] += 1
        assert len(counts) == 2, f"an option was never chosen: {counts}"
        # Neither option below a fifth of the draws. Wide, because this is a smoke test on spread and
        # not a chi-squared test on the mixer.
        assert min(counts.values()) > 120 // 5, f"badly skewed: {counts}"

    def test_it_does_not_pour_every_house_onto_one_square(self) -> None:
        """The observable form of the collapse, end to end.

        Given a completed colour group and plenty of cash, a bot locked to one index builds the same
        square repeatedly until even-build refuses. A bot drawing per position spreads across the
        group. Asserted as "more than one square got a house", which is the weakest statement that
        still fails on the collapse.
        """
        bot = EasyBot()
        state = make_state(seats=(make_player(0, cash=10_000), make_player(1)))
        group = state.board.tile(1).group
        assert group is not None
        owned = {tile.index: PropertyState(owner=0) for tile in state.board.tiles if tile.group is group}
        state = GameState(
            **{
                **dict(state),
                "properties": tuple(
                    owned.get(tile.index, prop) for tile, prop in zip(state.board.tiles, state.properties, strict=True)
                ),
            }
        )

        for _ in range(40):
            legal = tuple(command for command in _legal_for(state, 0) if command.kind == "build_house")
            if not legal:
                break
            state, _ = apply(state, bot.choose(state, 0, legal))

        built = [index for index in owned if state.properties[index].houses > 0]
        assert len(built) > 1, f"every house went onto {built} — the randomness collapsed"
