"""The hard bot: the normal bot's ranking, plus a few turns of imagined play (MON-603).

It is a **subclass** of :class:`~kesef_engine.bots.normal.NormalBot`, and that is the honest way to
describe it: the four opinions underneath are the same four, and everything below is an amendment to
them. Copying the scorer to change three of its numbers would have produced two files that drift apart,
and a strength gate measured against a bot that is no longer the shipped one.

Five amendments, in the order they were worth points:

1. **A reserve that knows what it is afraid of.** The normal bot keeps a flat 250 back. That is too
   timid on turn three, when the worst landing on the board costs 20 — it declines Boardwalk holding
   410 — and far too thin on turn sixty, when one hotel costs 1 500. So the reserve here is *the worst
   single landing the board can currently charge*, clamped (:func:`_reserve`). The bot therefore buys
   almost everything early, which is where property is cheap and decisive, and hoards late, which is
   where a single miss ends the game.
2. **Denial.** A square is worth taking off the table for what it does to the *other* side's plans as
   well as for what it does to the bot's. The square that would have completed an opponent's group is
   the most valuable square on the board even when it does nothing for the bot, because a group nobody
   can complete is a group nobody can build on (:func:`_denial_value`).
3. **Short Monte-Carlo rollouts, spent only where the ranking is unsure.** The heuristic decides most
   moves outright — when the only options are roll (60) and end (20) there is nothing to think about.
   Where the top options are within :data:`CLOSE_ENOUGH` of each other, and always when answering a
   trade, the bot *plays the position out* a few times and takes the line that evaluates best.
4. **Scepticism about a helpful-looking swap.** The reciprocal swap the normal bot loves to offer
   completes a group for each side, and the two groups are rarely worth the same. Rollouts are what
   answer this, which is why a trade response is always rolled out however wide the heuristic gap.
5. **A smaller reserve for houses than for deeds.** Amendment 1 pointing the other way, and the last one
   found: a house is not an asset to protect, it is what makes the opponent pay. Under a house shortage
   the bot that converts cash into houses first wins, and two bots both saving for a rainy day sit there
   until the turn cap (:data:`BUILD_RESERVE`).

## Where the randomness comes from, and why the rollouts must *not* see the real dice

This is the subtlety the whole module turns on. ``apply`` is pure and the dice come from
``state.rng``, which is part of the state — so a rollout that cloned the state and played on would
draw **the dice the real game is about to deal**. That is not a Monte-Carlo sample of the future, it is
the future, and a bot that read it would be playing with the answers. It would also collapse the
sampling: every rollout of a given candidate would replay the same one line, so ``ROLLOUTS_PER_CANDIDATE``
would buy nothing but time.

So every rollout replaces the clone's stream with a fork of its own (:func:`_rollout_stream`), keyed on a
cheap fingerprint of the position. The fingerprint is `easy.py`'s technique used for a different reason
and it is worth being precise about the difference:

* In `easy.py` a naive ``fork`` **collapses** — it resets the counter, so a bot choosing twice from a
  position the dice have not moved makes the identical "random" choice, and its randomness is a fixed
  preference wearing a costume.
* Here, a repeated choice from an unchanged position is *correct*: ``choose`` is a pure function and must
  answer the same way twice. What the fingerprint buys is **independence between positions** — without
  it, every decision in a game would sample the same handful of dice sequences, and the bot's judgement
  would be systematically shaped by them rather than merely noisy.

Nothing is drawn from ``state.rng`` itself, so the dice a human sees are untouched and a replay from the
seed deals the same game whichever bots are seated.

## The budget is a constant, not a clock

``ROLLOUTS_PER_MOVE`` and ``MAX_APPLY_CALLS_PER_MOVE`` bound every decision, and
:func:`search` reports what it actually spent so a test can assert on it. **Wall-clock is measured and
never asserted** (G-F30): a time-based budget would make the bot's *choices* depend on how busy the
machine was, which is the same defect as a global RNG — the golden games would stop replaying, and the
contest result would depend on the CI runner. The counter is the gate; the stopwatch is a metric.

## What it still does not do

No tree, no nested search, no opponent model beyond "the opponent plays like the normal bot". The
rollout policy *is* the normal bot, asked with ``may_trade=False`` so that a rollout cannot open a
search of its own. "Short rollouts" is a claim about depth, and :data:`ROLLOUT_DEPTH` is twelve
commands — roughly two turns each side, enough to see a rent collected or a group built on and not
enough to be a plan.
"""

from __future__ import annotations

from typing import Final

from pydantic import BaseModel

from kesef_engine.board.models import TileKind

# The normal bot's internals, imported by the one module entitled to them: its subclass. The
# underscores mark them as private to the *bot package* rather than to the file — a group's ownership
# count and a printed price are readings both bots need, and duplicating them here is how the two
# valuations would start to disagree.
from kesef_engine.bots.normal import (
    PROPOSE_SCORE,
    NormalBot,
    _group_progress,
    _legal_drafts,
    _price_of,
)
from kesef_engine.commands import (
    BuildHouse,
    BuyProperty,
    Command,
    PlaceBid,
    ProposeTrade,
    RespondToTrade,
    TradeOffer,
)
from kesef_engine.legality import is_legal, legal_commands
from kesef_engine.phases import Phase
from kesef_engine.primitives import BotLevel, PlayerId
from kesef_engine.reducer import apply
from kesef_engine.rng import Rng
from kesef_engine.state import HOTEL_LEVEL, GameState

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

# --- Valuation weights. Preferences, all of them. ---------------------------------------------------

MIN_RESERVE: Final = 60
"""The floor under :func:`_reserve`. Enough for a tax or a cheap rent, and no more.

Early in the game the worst landing on the board really is trivial, and a bot keeping 250 back then is
declining squares it will never be offered again.
"""

MAX_RESERVE: Final = 900
"""The ceiling. Past this the bot would be saving for a landing that would ruin it anyway.

A hotel on the dark blue group charges far more than this; there is no reserve that survives it, and
sitting on cash that large instead of building is how a bot loses slowly.
"""

BUILD_RESERVE: Final = 150
"""The reserve the bot keeps back *when the spend is a house* — a ceiling on :func:`_reserve`, not a
separate figure.

Amendment 5, and the last one added, because the failure it fixes only shows up over a run of games. A
threat-scaled reserve is right for buying deeds and wrong for building on them, and the reason is that
the two spends do opposite things to the threat: a deed is an asset that sits there, whereas a house is
what makes the *opponent* pay. A bot holding 900 back against a hotel it might land on, instead of
building the houses that would bankrupt the other side first, is saving up to lose slowly.

The position that produced this number was a game capped at turn 501 with both seats rich, every colour
group whole, and **all thirty-two houses on the board**:

    turn 501:  hard  12 tiles, 12 houses, 3 725 cash, net 7 845
               normal 16 tiles, 20 houses, 7 566 cash, net 12 336

A house shortage neither side could escape. The only way out of one is to put a *fourth* house on a
square and trade four in for a hotel, the even-build rule means reaching four means three on every
sibling first, and both bots were too thrifty to buy that deep — so the supply stayed spread one and two
to a square forever and no rent ever grew big enough to end the game. It is a race for the supply, and
the reserve is what decides how fast a bot runs it. Measured over the same sixty games: 500 gave 22 wins
with the game still capping, 300 gave 23 and still capped, **150 gave 24 with nothing capped and the
longest game down from 501 turns to 175**. Below that it stops paying — 100 gave 23 — because a bot that
builds to its last shekel loses to the first rent it lands on.
"""

DENIAL_COMPLETING: Final = 45.0
"""Points for a square that would have completed an opponent's group.

Worth more than the gap between `buy_property` (50 + value) and `decline_purchase` (45), so it can turn
a purchase the bot would otherwise decline on thinness grounds — that is the whole point of it.
"""

DENIAL_SHARE: Final = 12.0
"""Points, scaled by how far along that group already is, for merely getting in the way of it."""

TRADE_NUDGE: Final = 0.01
"""How hard :meth:`HardBot._score_trade` leans on :func:`_swap_gain`.

Small on purpose. The gain is measured in rent — hundreds or thousands of shekels — and the parent's
verdicts are 50 and −20, so an unscaled correction would not be a nudge, it would be the whole answer.
The nudge only has to order the two answers correctly; the rollout is what decides between them.
"""

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

_AVERAGE_DICE_TOTAL: Final = 7
"""Used to turn a utility's dice multiplier into a figure comparable with a street's rent."""


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


# --- Estimating what the board can charge ----------------------------------------------------------


def _estimated_rent(state: GameState, tile_index: int) -> int:
    """What landing on this square would cost right now, as an estimate. Zero if nobody owns it.

    **This is a valuation, not a charge.** ``rules/rent.py`` is the authority and the only thing that
    ever moves money; if the two disagree, that function is right and this is a bad guess — which costs
    the bot points and cannot cost a player a shekel. It is written to the same shape as the real ladder
    on purpose, because a threat estimate that budgeted for a different game would be worse than none:

    * a street charges its printed figure for the number of houses on it, doubled when the group is
      whole and unimproved (``state.owns_whole_group`` answers that — the rule is not restated here);
    * a station charges by how many of its group the owner holds;
    * a utility charges a multiple of the dice, so an average total stands in for the roll.

    A mortgaged deed charges nothing, which is a rule the estimate has to know about because a bot that
    feared a mortgaged square would keep the wrong reserve.
    """
    prop = state.properties[tile_index]
    owner = prop.owner
    if owner is None or prop.mortgaged:
        return 0
    tile = state.board.tile(tile_index)
    if tile.kind is TileKind.PROPERTY:
        assert tile.group is not None  # a PROPERTY tile always carries one
        base = tile.rent[prop.houses]
        doubled = prop.houses == 0 and state.owns_whole_group(owner, tile.group)
        return base * 2 if doubled else base
    held = sum(
        1
        for candidate in state.board.tiles
        if candidate.kind is tile.kind and state.properties[candidate.index].owner == owner
    )
    step = tile.rent[min(held, len(tile.rent)) - 1] if tile.rent else 0
    return step * _AVERAGE_DICE_TOTAL if tile.kind is TileKind.UTILITY else step


def _worst_landing(state: GameState, player: PlayerId) -> int:
    """The most expensive single square somebody else owns. The bot's exposure, in one number.

    A maximum rather than a sum or an average, because the reserve exists to survive *one* landing.
    Averaging over the board would understate the thing that actually ends games, which is stepping on
    the one hotel.
    """
    return max(
        (
            _estimated_rent(state, tile.index)
            for tile in state.board.tiles
            if tile.is_ownable and state.properties[tile.index].owner not in (None, player)
        ),
        default=0,
    )


def _reserve(state: GameState, player: PlayerId) -> int:
    """The cash this bot keeps back: its exposure, clamped. Amendment 1.

    The clamps are what make it a reserve rather than a panic. Below :data:`MIN_RESERVE` it would spend
    to its last shekel on an empty board and lose to a tax card; above :data:`MAX_RESERVE` it would be
    saving for a hotel landing that no plausible reserve survives, while its opponent built.
    """
    return max(MIN_RESERVE, min(MAX_RESERVE, _worst_landing(state, player)))


def _potential_rent(state: GameState, player: PlayerId) -> int:
    """Everything this seat's holdings would charge if every opponent landed on all of them once.

    A sum here, where :func:`_worst_landing` takes a maximum, and the asymmetry is deliberate: a reserve
    protects against one landing, whereas the *value* of an estate is what it collects over a game.
    """
    return sum(_estimated_rent(state, index) for index in state.tiles_owned_by(player))


# --- Amendment 2: denial -----------------------------------------------------------------------------


def _denial_value(state: GameState, player: PlayerId, tile_index: int) -> float:
    """What taking this unowned square off the table does to everybody else's plans.

    The big number is for the square that would have *completed* a group: a group with an outsider in
    it can never be built on (``_completion_value`` in `normal.py` is the same observation from the
    other side), so buying that one square permanently caps what the opponent's whole set can charge.
    The small number is for getting in the way of a group that is merely coming along.

    Only unowned squares reach here — the bot pays for this at a purchase or an auction, and those are
    the only two moments a deed comes off the table.
    """
    tile = state.board.tile(tile_index)
    if tile.group is None or state.properties[tile_index].owner is not None:
        return 0.0
    best = 0.0
    for other in state.solvent_players:
        if other.id == player:
            continue
        theirs, outsiders, total = _group_progress(state, other.id, tile_index)
        if not total or outsiders:
            # Already broken by somebody: there is nothing left to deny.
            continue
        best = max(best, DENIAL_COMPLETING if theirs + 1 == total else DENIAL_SHARE * theirs / total)
    return best


# --- Amendment 3: the rollouts -----------------------------------------------------------------------


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
    rival = max(others, key=lambda seat: (state.net_worth(seat), _potential_rent(state, seat), -seat))
    worth = state.net_worth(player) - state.net_worth(rival)
    rent = _potential_rent(state, player) - _potential_rent(state, rival)
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


class HardBot(NormalBot):
    """The normal bot's four opinions, amended five times and backed by short rollouts.

    Holds no state: the rollout policy is another stateless bot, and the budget counters live and die
    inside one :func:`search` call.
    """

    level: BotLevel = BotLevel.HARD

    def choose(
        self,
        state: GameState,
        player: PlayerId,
        legal: tuple[Command, ...],
        *,
        may_trade: bool = True,
    ) -> Command:
        command, _budget = search(state, player, legal, may_trade=may_trade, bot=self)
        return command

    # --- Amendment 1: the reserve -------------------------------------------------------------------

    def _buffer(self, state: GameState, player: PlayerId) -> int:
        return _reserve(state, player)

    # --- Amendment 2: denial, wherever a deed can be taken off the table ----------------------------

    def _score(self, state: GameState, player: PlayerId, command: Command) -> float:
        """The parent's ranking, with three commands answered here instead.

        The split is on whether the amendment *adds* to the parent's verdict or *replaces* it, and
        getting that wrong is the bug this shape exists to prevent. A purchase is an addition: the parent
        prices the square and denial is one more reason to want it, so a refusal on affordability grounds
        stands. A bid and a house are replacements, because in both cases the parent's refusal is the
        very thing being amended — an early "the parent said no, so no" would make those two amendments
        unreachable in exactly the positions they are for.
        """
        match command:
            case BuildHouse(tile=tile_index):
                # Amendment 5, replacing the parent's verdict. The parent ranks the third house highest
                # and the hotel barely at all, which is the right *ordering* and the wrong *ceiling*: it
                # left both bots sitting on cash under a house shortage only a hotel can clear, in a game
                # that then ran to the turn cap.
                #
                # So: building is the best thing this bot can do whenever it can afford it above the
                # development reserve, and the small step per house keeps the parent's preference for
                # spreading the first houses across a group before topping any one square up.
                cost = state.board.tile(tile_index).house_cost or 0
                if state.player(player).cash - cost < min(_reserve(state, player), BUILD_RESERVE):
                    return 5.0
                return 92.0 - state.properties[tile_index].houses * 4.0

            case PlaceBid(amount=amount):
                return self._score_bid(state, player, command, amount)

            case ProposeTrade():
                # The parent never scores this: it decides whether to open a trade *outside* its ranking,
                # because for it there is nothing to weigh a proposal against. Here a proposal is one
                # option among the rest and takes the slot the parent gives it implicitly — below
                # building, above rolling — so that a rollout can compare the two.
                return PROPOSE_SCORE

            case BuyProperty():
                base = super()._score(state, player, command)
                if base < 0:
                    # The parent has refused it outright: the purchase is unaffordable. Denial is a
                    # reason to want a square, never a reason to go broke for one.
                    return base
                # `BuyProperty` carries no tile; the square is the one the seat is standing on, which is
                # the reading the parent and the rest of the product make.
                return base + _denial_value(state, player, state.player(player).position)

            case _:
                return super()._score(state, player, command)

    def _score_bid(self, state: GameState, player: PlayerId, command: PlaceBid, amount: int) -> float:
        """A bid, where denial has to enter the bot's *willingness to pay* and not only its ranking.

        The parent refuses any bid above what the square is worth to it, and a square in somebody else's
        colour group is worth almost nothing on that reading — `_completion_value` gives a group that
        cannot be completed four points. So a bonus added after the parent's refusal would never be
        reached, and amendment 2 would be a rule that fires everywhere except an auction.

        A square that blocks a group outright is worth its printed price **over again**, and that is the
        ceiling: twice the deed for a deed the bot does not want on its own account, and not a shekel
        more. Below it the reserve still governs, so denial cannot bid the bot broke.
        """
        base = super()._score(state, player, command)
        lot = state.auction.lot if state.auction is not None else None
        tile = lot.tile if lot is not None and lot.kind == "tile" else None
        if tile is None:
            return base
        denial = _denial_value(state, player, tile)
        if not denial:
            return base
        if state.player(player).cash - amount < self._buffer(state, player):
            # Opinion 1 outranks amendment 2, the same way it outranks every other opinion here.
            return -50.0
        worth = _price_of(state, tile) * (1.0 + denial / DENIAL_COMPLETING)
        return (55.0 + denial) if amount <= worth else base

    # --- Amendment 4: which offer to open ----------------------------------------------------------

    def _propose(self, state: GameState, player: PlayerId) -> ProposeTrade | None:
        """The best offer this seat can open, skipping the ones that help the other side more.

        The normal bot opens the first legal draft, and its favourite is the reciprocal swap — each side
        hands over the square blocking the other's group. That offer un-splits two groups at once, which
        is what stops games running forever, and it is *not* symmetric: dark blue with a hotel charges
        several times what brown does. So each draft is priced by what it hands each side
        (:func:`_swap_gain`) and one that hands the opponent more is passed over for the next.

        If every draft fails that test the bot opens none, which is the honest answer — and it is why
        `_legal_drafts` is a generator: the walk stops at the first draft worth making.
        """
        for draft in _legal_drafts(state, player, buffer=self._buffer(state, player)):
            if _swap_gain(state, player, draft.offer) >= 0.0:
                return draft
        return None

    def _score_trade(self, state: GameState, player: PlayerId, command: RespondToTrade) -> float:
        """The parent's verdict, corrected for whose group the deal completes.

        The parent prices both sides of an offer with the same function, which is fair and blind: it
        cannot see that the group it is handing over will charge more than the group it is gaining. The
        correction is a small nudge rather than a veto because a rollout is what actually decides this —
        ``TRADE_REVIEW`` is in :data:`ALWAYS_ROLL_OUT` — and the nudge only has to get both answers into
        the candidate set with the right one ranked first.
        """
        base = super()._score_trade(state, player, command)
        frame = state.pending_trade
        if frame is None:
            return base
        gain = _swap_gain(state, player, frame.offer) * TRADE_NUDGE
        return base + (gain if command.accept else -gain)


def _swap_gain(state: GameState, player: PlayerId, offer: TradeOffer) -> float:
    """How much better off ``player`` is than the other side if this offer goes through.

    Priced in standing rent, not in printed prices: what a deed is worth in this game is what its group
    will charge once it is whole, and that is exactly the asymmetry the printed price hides. A square
    that completes dark blue for the opponent is a worse thing to give away than a pink square is,
    however similar the two prices look.

    Positive means the bot gains more than it gives up. The same function reads an offer the bot has
    drafted and one that is sitting on the table, because a trade is symmetric and only the seat asking
    differs — which is also what makes the scepticism testable from both ends.
    """
    other = offer.recipient if player == offer.proposer else offer.proposer
    incoming, outgoing = (offer.give, offer.receive) if player == offer.recipient else (offer.receive, offer.give)

    mine = _group_gain(state, player, gaining=incoming.tiles, losing=outgoing.tiles)
    theirs = _group_gain(state, other, gaining=outgoing.tiles, losing=incoming.tiles)
    cash = float(incoming.cash - outgoing.cash)
    return (mine - theirs) + cash


def _group_gain(state: GameState, player: PlayerId, *, gaining: tuple[int, ...], losing: tuple[int, ...]) -> float:
    """What the deeds moving in and out are worth to ``player``, in rent this estate could charge.

    A square that completes a group is priced at what the *whole* group would charge with a hotel on
    each square, because that is what completing it unlocks; one that does not is priced at its printed
    value, which is roughly what it is worth as a blocker. The same reading is applied to what is going
    out, so a bot cannot talk itself into a swap by valuing only its half.
    """
    held = {index for index in state.tiles_owned_by(player) if index not in losing}
    value = 0.0
    for index in gaining:
        value += _unlocked_value(state, index, held | {index})
    for index in losing:
        value -= _unlocked_value(state, index, held | set(losing))
    return value


def _unlocked_value(state: GameState, tile_index: int, held: set[int]) -> float:
    """What this square is worth to somebody holding ``held`` — the group's ceiling if it completes it."""
    tile = state.board.tile(tile_index)
    if tile.group is None:
        return float(_price_of(state, tile_index))
    siblings = tuple(candidate for candidate in state.board.tiles if candidate.group is tile.group)
    if any(candidate.index not in held for candidate in siblings):
        return float(_price_of(state, tile_index))
    return float(sum(candidate.rent[HOTEL_LEVEL] for candidate in siblings))


# --- The search itself ------------------------------------------------------------------------------

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

    bot = bot if bot is not None else HardBot()
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
