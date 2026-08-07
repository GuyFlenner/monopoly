"""Short Monte-Carlo rollouts, and the budget that bounds them (MON-603, split out at MON-742).

Amendment 3 of the five `hard.py` describes, extracted whole. The split is along the line between
*having an opinion* and *checking one*: the policy ranks the options and this module plays the top few
out, so a change to the bot's taste and a change to how much thinking it may do are now edits to
different files. The heuristics decide most moves outright; :func:`search` is what happens when they
cannot.

## Where the randomness comes from, and why the rollouts must *not* see the real dice

This is the subtlety the whole module turns on. ``apply`` is pure and the dice come from
``state.rng``, which is part of the state — so a rollout that cloned the state and played on would
draw **the dice the real game is about to deal**. That is not a Monte-Carlo sample of the future, it is
the future, and a bot that read it would be playing with the answers. It would also collapse the
sampling: every rollout of a given candidate would replay the same one line, so
:data:`ROLLOUTS_PER_CANDIDATE` would buy nothing but time.

So every rollout replaces the clone's stream with a fork of its own (:func:`_rollout_stream`), keyed on
a cheap fingerprint of the position. The fingerprint is `easy.py`'s technique used for a different
reason and it is worth being precise about the difference:

* In `easy.py` a naive ``fork`` **collapses** — it resets the counter, so a bot choosing twice from a
  position the dice have not moved makes the identical "random" choice, and its randomness is a fixed
  preference wearing a costume.
* Here, a repeated choice from an unchanged position is *correct*: ``choose`` is a pure function and
  must answer the same way twice. What the fingerprint buys is **independence between positions** —
  without it, every decision in a game would sample the same handful of dice sequences, and the bot's
  judgement would be systematically shaped by them rather than merely noisy.

Nothing is drawn from ``state.rng`` itself, so the dice a human sees are untouched and a replay from
the seed deals the same game whichever bots are seated.

## The budget is a constant, not a clock

:data:`ROLLOUTS_PER_MOVE` and :data:`MAX_APPLY_CALLS_PER_MOVE` bound every decision, and
:func:`search` reports what it actually spent so a test can assert on it. **Wall-clock is measured and
never asserted** (G-F30): a time-based budget would make the bot's *choices* depend on how busy the
machine was, which is the same defect as a global RNG — the golden games would stop replaying, and the
contest result would depend on the CI runner. The counter is the gate; the stopwatch is a metric.

## What this deliberately is not

No tree, no nested search, no opponent model beyond "the opponent plays like the normal bot". The
rollout policy *is* the normal bot, asked with ``may_trade=False`` so that a rollout cannot open a
search of its own. "Short rollouts" is a claim about depth, and :data:`ROLLOUT_DEPTH` is twelve
commands — roughly two turns each side, enough to see a rent collected or a group built on and not
enough to be a plan.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

from pydantic import BaseModel

from kesef_engine.bots.normal import PROPOSE_SCORE, NormalBot
from kesef_engine.bots.valuation import potential_rent
from kesef_engine.commands import Command
from kesef_engine.legality import is_legal, legal_commands
from kesef_engine.phases import Phase
from kesef_engine.primitives import PlayerId
from kesef_engine.reducer import apply
from kesef_engine.rng import Rng
from kesef_engine.state import GameState

if TYPE_CHECKING:
    from kesef_engine.bots.hard import HardBot

# --- The budget. Fixed constants, asserted on counters by `test_bot_hard.py`. ----------------------

ROLLOUT_CANDIDATES: Final = 3
"""How many of the ranked options a rollout is ever spent on.

Three, because the heuristic is a decent ranking and the fourth-best option is nearly never the right
move. Widening this is the first thing to try if the bot is ever too weak, and the last thing to try if
the contest is ever too slow.
"""

ROLLOUTS_PER_CANDIDATE: Final = 2
"""Sampled futures per candidate. Two, and the honest reason is the contest's wall-clock.

Two samples of a twelve-command line is a *noisy* estimate, which is why the heuristic score stays in
the comparison as the tie-break rather than being discarded once a rollout has run.
"""

ROLLOUT_DEPTH: Final = 12
"""Commands played after the candidate before the position is judged.

Twelve is about two turns each side on a two-seat board. Deep enough for a rent to be collected and for
a purchase to show up as a group, shallow enough that the noise from two samples does not swamp it.
"""

ROLLOUTS_PER_MOVE: Final = ROLLOUT_CANDIDATES * ROLLOUTS_PER_CANDIDATE
"""The hard cap on rollouts for one decision. Derived, so the two factors cannot disagree with it."""

MAX_APPLY_CALLS_PER_MOVE: Final = ROLLOUTS_PER_MOVE * (ROLLOUT_DEPTH + 1)
"""The hard cap on ``apply`` calls for one decision — the candidate itself, then the line after it.

Checked inside the rollout loop rather than merely computed here, so that the cap holds even if a future
edit makes the arithmetic above wrong. A budget that is only true by derivation is a budget nobody
notices breaking.
"""

CLOSE_ENOUGH: Final = 20.0
"""How near the best score another option must be for a rollout to be worth spending on it.

Calibrated against the normal bot's own ladder, and the width was measured rather than guessed. Twenty
makes the marginal purchase a decision worth playing out — `decline_purchase` is 45 and a comfortable
`buy_property` is 50 or more, so the gap closes exactly when the thinness penalty has eaten into the
purchase's value. It leaves `roll_dice` (60) against `end_turn` (20) alone, because that is not a
decision.

**Twenty-five was the first value, and it cost five times the wall-clock for nothing.** An auction offers
`place_bid` at 55 and `withdraw_from_auction` at 30 — a gap of exactly 25 — and an auction runs many
rounds, so at 25 two thirds of every rollout in a game was being spent bidding: 668 of the 950 rolled-out
decisions in a three-game sample. The heuristic is already good at auctions, since `legal_commands` offers
only the minimum legal bid (ADR-005) and the question reduces to "is this square worth that much".
"""

ALWAYS_ROLL_OUT: Final = frozenset({Phase.TRADE_REVIEW})
"""Phases where every option is a rollout candidate, whatever the heuristic thinks of the gap.

Answering a trade is the one move that hands an opponent an asset, and the heuristic's verdict on it is
a symmetric price comparison that cannot see whose group the deal completes. It is also rare, so making
it the expensive decision costs almost nothing.
"""

# --- What a sampled future is judged on. Preferences, both of them. ---------------------------------

RENT_WEIGHT: Final = 3.0
"""How much a pound of standing rent is worth against a pound of net worth in :func:`_evaluate`.

Net worth counts a hotel at what it cost. The game pays out on what it *charges*, and a developed
monopoly is worth several times its book value — this is the thumb on the scale that says so. Three is
deliberately modest: the leaf evaluation is a preference, and a large weight here would make the bot
build hotels it cannot pay for.
"""

WIN_VALUE: Final = 1_000_000.0
"""A won position, in the same units. Large enough that no ordinary evaluation can outrank it."""

STREAM_HARD_BASE: Final = 64
"""First stream id this bot's rollouts use.

Streams 0-2 are the dice and the two decks (``factory.py``) and 16 upwards is the easy bot's choice
stream (``easy.py``). Clear of both, and — more importantly — clear of the *dice*: a rollout drawing on
stream 0 would be reading the real game's future rather than sampling a possible one.
"""

_MASK64: Final = 0xFFFFFFFFFFFFFFFF
_ODD_MULTIPLIER: Final = 0x9E3779B97F4A7C15


class Budget(BaseModel, frozen=True):
    """What one decision actually spent. Reported by :func:`search`, asserted by the tests.

    Returned rather than recorded on the bot, because a bot that accumulated counters would hold state
    and the ``Bot`` protocol promises it does not. This is a fact about one call, handed back to the
    caller that made it.
    """

    rollouts: int = 0
    apply_calls: int = 0


class _Meter:
    """The mutable half of :class:`Budget`, alive only for the duration of one :func:`search`.

    Mutable and local: purity is a property of ``search`` as seen from outside, and a counter that never
    outlives the call cannot leak into another decision.
    """

    def __init__(self) -> None:
        self.rollouts = 0
        self.apply_calls = 0

    def spent(self) -> Budget:
        return Budget(rollouts=self.rollouts, apply_calls=self.apply_calls)

    @property
    def exhausted(self) -> bool:
        return self.apply_calls >= MAX_APPLY_CALLS_PER_MOVE


def _fingerprint(state: GameState, player: PlayerId, legal: tuple[Command, ...]) -> int:
    """A cheap number that changes whenever the position the bot is choosing from changes.

    Not entropy for its own sake — each field is here for one property, and the list is the same one
    `easy.py` argues for, for the reason set out in this module's docstring (independence *between*
    positions, not unpredictability within one):

    * ``turn_number``, so two decisions in different turns sample different futures;
    * the seat's ``cash`` and ``position``, which are what move *within* a turn as the bot acts;
    * ``len(legal)``, which moves as options open and close;
    * the phase, so an answer inside an interrupt does not share a sample set with the roll that opened
      it.

    Deliberately not a hash of the whole state: this runs once per decision in a five-hundred-turn game.
    """
    mixed = (state.turn_number + 1) * _ODD_MULTIPLIER
    me = state.player(player)
    mixed ^= (me.cash + 1) * 0xD1B54A32D192ED03
    mixed ^= (me.position + 1) * 0xBF58476D1CE4E5B9
    mixed ^= len(legal) * 0x94D049BB133111EB
    mixed ^= (len(state.phase.value) + state.phase.value.count("_") * 31) * 0xA24BAED4963EE407
    return mixed & _MASK64


def _rollout_stream(fingerprint: int, player: PlayerId, candidate: int, sample: int) -> int:
    """The RNG stream one sampled future draws its dice from.

    Composed so the low bits identify *which* sample this is and the high bits identify the position:
    ``candidate`` and ``sample`` are small and bounded by the budget, so shifting the fingerprint clear
    of them keeps every (position, candidate, sample) triple on its own stream. Two different samples of
    the same candidate therefore deal different dice, which is the only thing that makes averaging them
    mean anything.
    """
    index = candidate * (ROLLOUTS_PER_CANDIDATE + 1) + sample
    return STREAM_HARD_BASE + player + index + (fingerprint << 12)


def _evaluate(state: GameState, player: PlayerId) -> float:
    """What this position is worth to ``player``. The leaf of a rollout.

    Net worth is the engine's own figure and the yardstick a capped game is scored on, so it is the
    spine of this — but it counts a hotel at what it cost, and the game pays out on what a hotel
    *charges*. So the standing rent on each side is weighted in beside it (:data:`RENT_WEIGHT`), which
    is what lets a rollout prefer three houses on a whole group over four scattered deeds worth the same
    money.

    Measured against the strongest opponent rather than the field: second place is a loss.
    """
    if state.player(player).bankrupt:
        return -WIN_VALUE
    if state.phase is Phase.GAME_OVER:
        return WIN_VALUE if state.winner == player else -WIN_VALUE
    others = tuple(seat.id for seat in state.solvent_players if seat.id != player)
    if not others:
        return WIN_VALUE
    rival = max(others, key=lambda seat: (state.net_worth(seat), potential_rent(state, seat), -seat))
    worth = state.net_worth(player) - state.net_worth(rival)
    rent = potential_rent(state, player) - potential_rent(state, rival)
    return float(worth) + RENT_WEIGHT * rent


def _rollout(
    state: GameState,
    player: PlayerId,
    command: Command,
    *,
    stream: int,
    policy: NormalBot,
    meter: _Meter,
) -> float:
    """Play ``command``, then a dozen more moves, and say what the position is worth.

    The clone's dice stream is replaced before anything is applied — see the module docstring on why a
    rollout must not see the real game's dice. ``model_copy(deep=True)`` is the engine's own idiom for
    a state nobody else is holding: ``GameState`` is frozen, ``apply`` returns a new one, and so a
    rollout is *only* a replay of a candidate line with nothing to undo afterwards.

    Both seats are played by the normal bot with ``may_trade=False``. Modelling the opponent as a
    competent-but-not-searching player is the one assumption in here, and it is stated rather than
    hidden; letting the policy open trades would put a search inside a search for no gain at this depth.
    """
    imagined = state.model_copy(deep=True, update={"rng": Rng(seed=state.rng.seed, stream=stream)})
    meter.rollouts += 1
    meter.apply_calls += 1
    imagined, _ = apply(imagined, command)

    for _ in range(ROLLOUT_DEPTH):
        if meter.exhausted or imagined.phase is Phase.GAME_OVER:
            break
        seat = imagined.seat_to_act
        if seat is None:
            break
        options = tuple(option for option in legal_commands(imagined) if option.player == seat)
        if not options:
            break
        meter.apply_calls += 1
        imagined, _ = apply(imagined, policy.choose(imagined, seat, options, may_trade=False))

    return _evaluate(imagined, player)


_POLICY: Final = NormalBot()
"""The rollout policy. One shared instance, which is safe for the same reason the server shares its
bots: the ``Bot`` protocol promises a bot holds no state, and this one holds none."""


def search(
    state: GameState,
    player: PlayerId,
    legal: tuple[Command, ...],
    *,
    may_trade: bool = True,
    bot: HardBot | None = None,
) -> tuple[Command, Budget]:
    """The whole decision, and what it cost. :meth:`HardBot.choose` is this function's first element.

    Returning the budget is what makes the acceptance criterion testable: "the per-move budget is
    deterministic" is a claim about counters, and a counter nobody can read is a claim nobody can check.
    The tests assert on this; nothing in the engine or the server reads it.

    ``bot`` is the seat's own instance, passed by :meth:`HardBot.choose` so that the ranking used here is
    the ranking of the bot that was asked. It defaults to a fresh one for the callers that have no bot in
    hand — the tests — and a fresh one is interchangeable with any other, because a bot holds no state.
    That default is the only line in this module that names a policy, and it is why the import below is
    deferred: `hard.py` imports this module, so a top-level import back would be a cycle. The dependency
    that matters points one way — the policy knows about the search, the search does not need the policy
    to be a particular one.

    The shape is: rank everything, then spend the rollouts on the options the ranking cannot separate.

    * A clear winner (``roll_dice`` at 60 against ``end_turn`` at 20) is played immediately and the
      budget comes back at zero. That is the common case, and it is why a hundred games of this bot
      finish in minutes rather than hours.
    * Otherwise the top :data:`ROLLOUT_CANDIDATES` within :data:`CLOSE_ENOUGH` are each played out
      :data:`ROLLOUTS_PER_CANDIDATE` times and compared on the mean.
    * Ties fall back to the heuristic score, and then to the order the options arrived in, so the answer
      is a pure function of the position — two instances, and a replay from the seed, agree.
    """
    if not legal:
        # The caller's bug, not a position: the reducer always offers the seat it is waiting on at least
        # `end_turn`. Same refusal as the other two bots, for the same reason.
        raise ValueError("no legal commands to choose from")

    if bot is None:
        from kesef_engine.bots.hard import HardBot as _HardBot

        bot = _HardBot()
    scored = [(bot._score(state, player, option), index, option) for index, option in enumerate(legal)]
    scored.sort(key=lambda entry: (-entry[0], entry[1]))

    if may_trade and scored[0][0] < PROPOSE_SCORE:
        # ADR-009's constructed offer, and the same gate the parent uses: looked for only when nothing
        # already on the table beats opening one, which is what keeps the draft search off the hot path.
        proposal = bot._propose(state, player)
        if proposal is not None:
            scored.insert(0, (PROPOSE_SCORE, len(legal), proposal))

    best_score = scored[0][0]

    margin = float("inf") if state.phase in ALWAYS_ROLL_OUT else CLOSE_ENOUGH
    close = [entry for entry in scored if best_score - entry[0] <= margin]
    # Only a line the engine agrees is playable can be rolled out, because a rollout *applies* it. The
    # protocol already promises `legal` is legal and `legal_commands`/`apply` are property-tested to
    # agree, so in a real game this filter never removes anything — it is here because the consequence
    # of being wrong is an `IllegalCommandError` raised from inside a bot's imagination, in the middle
    # of somebody's turn, and the honest fallback is to think less rather than to crash.
    candidates = [entry for entry in close if is_legal(state, entry[2])][:ROLLOUT_CANDIDATES]

    meter = _Meter()
    if len(candidates) < 2:
        # Nothing to separate. Not merely an optimisation: a rollout that compares one option against
        # itself is pure cost, and this is the branch that keeps the contest runnable.
        return scored[0][2], meter.spent()

    fingerprint = _fingerprint(state, player, legal)
    ranked: list[tuple[float, float, int, Command]] = []
    for position, (score, index, option) in enumerate(candidates):
        values = [
            _rollout(
                state,
                player,
                option,
                stream=_rollout_stream(fingerprint, player, position, sample),
                policy=_POLICY,
                meter=meter,
            )
            for sample in range(ROLLOUTS_PER_CANDIDATE)
        ]
        # The mean, and then the heuristic score as the tie-break: two samples of a twelve-command line
        # is a noisy estimate, and throwing the ranking away in favour of it would be trusting the noise.
        ranked.append((sum(values) / len(values), score, index, option))

    ranked.sort(key=lambda entry: (-entry[0], -entry[1], entry[2]))
    return ranked[0][3], meter.spent()
