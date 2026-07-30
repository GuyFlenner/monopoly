"""Playing bots against each other, and scoring it honestly (MON-602).

Not a test — the instrument the tests use. `test_bot_normal.py` and, later, MON-603's suite both
measure against this, so the rules of the contest live in one place.

## The threshold was fixed before the contest existed

The backlog states it, and it is worth repeating here because a strength claim whose bar moves after
the results are in is worthless (G-62):

* **100 games, seeds 1–100.** Fixed, so a run is reproducible and nobody re-rolls a bad set.
* **The challenger must win ≥ 60.** The binomial critical value at α = 0.05 for 100 fair trials is 59,
  so 60 is the smallest number that is not luck.
* **A draw counts against the challenger.** "Did not beat it" is the claim being tested.
* **500 turns, then score by net worth.** A capped game still has a result.
* **At most 5 games may be capped.** A bot that cannot close out a game is itself a failure, so this
  is a second, independent gate — a challenger could clear 60 wins while being unable to finish, and
  that must not pass.

## Both seats are swapped

Every seed is played **twice**, once with the challenger in seat 0 and once in seat 1, and both count.
Seat order is not neutral: seat 0 rolls first, and on a board where the first player to reach a
colour group tends to keep it, moving first is worth something. A hundred games all played from seat 0
would measure "is the challenger better *and* does it like going first", which is two questions. So
"100 games" is 50 seeds × 2 orders.
"""

from __future__ import annotations

from dataclasses import dataclass

from kesef_engine.bots.base import Bot
from kesef_engine.factory import Seat, new_game
from kesef_engine.legality import legal_commands
from kesef_engine.phases import Phase
from kesef_engine.primitives import BotLevel, PlayerId
from kesef_engine.reducer import apply
from kesef_engine.ruleset import Ruleset, RulesetName
from kesef_engine.state import GameState

TURN_CAP = 500
"""Turns before a game is scored on net worth instead of played out."""

WINS_REQUIRED = 60
"""Of 100. The binomial critical value at α=0.05 is 59, so this is the smallest non-lucky number."""

MAX_CAPPED = 5
"""How many of the 100 may hit the turn cap. A bot that cannot finish a game is a failure."""

STEP_CAP_PER_GAME = 40_000
"""A bound on commands per game, so a defect cannot hang the suite.

Distinct from `TURN_CAP`: turns are the *game's* clock, and this is a guard on the loop itself. Reached
only if a bot and the engine conspire to make progress impossible, which is a bug worth failing on
rather than waiting out.
"""


@dataclass(frozen=True)
class Outcome:
    """One game's result."""

    seed: int
    challenger_seat: PlayerId
    winner: PlayerId | None
    """`None` is a draw — equal net worth at the cap. Counts against the challenger."""
    turns: int
    capped: bool

    @property
    def challenger_won(self) -> bool:
        return self.winner == self.challenger_seat


@dataclass(frozen=True)
class Result:
    """A whole contest."""

    outcomes: tuple[Outcome, ...]

    @property
    def wins(self) -> int:
        return sum(1 for outcome in self.outcomes if outcome.challenger_won)

    @property
    def capped(self) -> int:
        return sum(1 for outcome in self.outcomes if outcome.capped)

    @property
    def draws(self) -> int:
        return sum(1 for outcome in self.outcomes if outcome.winner is None)

    def summary(self) -> str:
        """One line, for a failing assertion's message. A bare `59 != 60` teaches nothing."""
        turns = [outcome.turns for outcome in self.outcomes]
        return (
            f"{self.wins}/{len(self.outcomes)} wins "
            f"(needed {WINS_REQUIRED}), {self.draws} draws, {self.capped} capped "
            f"(max {MAX_CAPPED}), turns min/median/max "
            f"{min(turns)}/{sorted(turns)[len(turns) // 2]}/{max(turns)}"
        )


def _net_worth(state: GameState, player: PlayerId) -> int:
    """The projection's own figure, never a sum computed here.

    `GameState.net_worth` is the engine's own answer, and a mortgaged deed counting zero is a *rule*
    it enforces (MON-208) — the same figure `rules/endgame.py` ranks the final standings by. A harness
    that added up prices itself would be scoring a different game from the one the engine played, and
    would disagree with the winner the engine declared.
    """
    return state.net_worth(player)


def play(
    challenger: Bot,
    defender: Bot,
    *,
    seed: int,
    challenger_seat: PlayerId = 0,
    turn_cap: int = TURN_CAP,
) -> Outcome:
    """Play one game to a result.

    Both bots are driven through `legal_commands` and `apply`, exactly as the server drives them, and
    the seat asked is `state.seat_to_act` — the seat the game is *blocked on*, not merely one with a
    legal move. Getting that wrong is what made a bot mortgage its own property for two hundred moves
    while its opponent never played; see the property's docstring.

    **One trade proposal per seat per turn.** ADR-009 lets a bot return a constructed `ProposeTrade`,
    and the loop that has to be broken is not in the engine but here: a bot is a pure function of the
    position, and declining an offer puts the position back to essentially what it was, so a bot asked
    again would offer the identical swap forever. Bot state is not the answer — a bot with memory is a
    second place the game's history lives, and it would break replay-from-seed. So the *driver* spends
    the permission, and a new turn is what refills it. `kesef_server.bots.drive` does the same thing
    for the same reason, differently expressed: it is re-entered once per move and reads the fact off
    the event log, where this loop can simply remember it.
    """
    bots: dict[PlayerId, Bot] = {
        challenger_seat: challenger,
        1 - challenger_seat: defender,
    }
    seats = [Seat(name=f"seat{index}", bot_level=BotLevel(bots[index].level)) for index in (0, 1)]
    state = new_game(
        seats, seed=seed, game_id=f"t{seed}", board_id="classic", ruleset=Ruleset.by_name(RulesetName.UNIVERSAL)
    )

    proposed_this_turn: set[PlayerId] = set()
    turn = state.turn_number

    for _ in range(STEP_CAP_PER_GAME):
        if state.turn_number != turn:
            turn = state.turn_number
            proposed_this_turn.clear()
        if state.phase is Phase.GAME_OVER:
            return Outcome(
                seed=seed,
                challenger_seat=challenger_seat,
                winner=state.winner,
                turns=state.turn_number,
                capped=False,
            )
        if state.turn_number > turn_cap:
            break

        seat = state.seat_to_act
        if seat is None:
            # Blocked on nobody and not over: the engine is mid-resolution. Nothing for a bot to do,
            # and nothing that will change without a command — so this is a defect, not a position.
            raise AssertionError(f"seed {seed}: no seat to act in phase {state.phase.value}")
        mine = tuple(command for command in legal_commands(state) if command.player == seat)
        if not mine:
            raise AssertionError(f"seed {seed}: seat {seat} is being waited on with nothing legal")
        command = bots[seat].choose(state, seat, mine, may_trade=seat not in proposed_this_turn)
        if command.kind == "propose_trade":
            proposed_this_turn.add(seat)
        state, _ = apply(state, command)
    else:
        raise AssertionError(f"seed {seed}: {STEP_CAP_PER_GAME} commands without finishing")

    # Capped. Scored on net worth, which is the closest thing to "who was winning".
    ours = _net_worth(state, challenger_seat)
    theirs = _net_worth(state, 1 - challenger_seat)
    # A draw is a real outcome at the cap, and it counts against the challenger — see the module
    # docstring on why "did not beat it" is the claim under test.
    winner: PlayerId | None = None if ours == theirs else (challenger_seat if ours > theirs else 1 - challenger_seat)
    return Outcome(
        seed=seed,
        challenger_seat=challenger_seat,
        winner=winner,
        turns=state.turn_number,
        capped=True,
    )


def contest(challenger: Bot, defender: Bot, *, seeds: range = range(1, 51)) -> Result:
    """Every seed twice, once from each seat. See the module docstring on why both orders."""
    return Result(
        outcomes=tuple(play(challenger, defender, seed=seed, challenger_seat=seat) for seed in seeds for seat in (0, 1))
    )
