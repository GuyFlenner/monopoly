"""The hard bot: the normal bot's ranking, plus a few turns of imagined play (MON-603).

It is a **subclass** of :class:`~kesef_engine.bots.normal.NormalBot`, and that is the honest way to
describe it: the four opinions underneath are the same four, and everything below is an amendment to
them. Copying the scorer to change three of its numbers would have produced two files that drift apart,
and a strength gate measured against a bot that is no longer the shipped one.

Five amendments, in the order they were worth points:

1. **A reserve that knows what it is afraid of.** The normal bot keeps a flat 250 back. That is too
   timid on turn three, when the worst landing on the board costs 20 — it declines Boardwalk holding
   410 — and far too thin on turn sixty, when one hotel costs 1 500. So the reserve here is *the worst
   single landing the board can currently charge*, clamped
   (:func:`~kesef_engine.bots.valuation.reserve`). The bot therefore buys almost everything early,
   which is where property is cheap and decisive, and hoards late, which is where a single miss ends
   the game.
2. **Denial.** A square is worth taking off the table for what it does to the *other* side's plans as
   well as for what it does to the bot's. The square that would have completed an opponent's group is
   the most valuable square on the board even when it does nothing for the bot, because a group nobody
   can complete is a group nobody can build on
   (:func:`~kesef_engine.bots.valuation.denial_value`).
3. **Short Monte-Carlo rollouts, spent only where the ranking is unsure.** The heuristic decides most
   moves outright — when the only options are roll (60) and end (20) there is nothing to think about.
   Where the top options are within ``CLOSE_ENOUGH`` of each other, and always when answering a trade,
   the bot *plays the position out* a few times and takes the line that evaluates best. All of that is
   `search.py`, including why a rollout must never draw on the real game's dice.
4. **Scepticism about a helpful-looking swap.** The reciprocal swap the normal bot loves to offer
   completes a group for each side, and the two groups are rarely worth the same. Rollouts are what
   answer this, which is why a trade response is always rolled out however wide the heuristic gap.
5. **A smaller reserve for houses than for deeds.** Amendment 1 pointing the other way, and the last one
   found: a house is not an asset to protect, it is what makes the opponent pay. Under a house shortage
   the bot that converts cash into houses first wins, and two bots both saving for a rainy day sit there
   until the turn cap (:data:`BUILD_RESERVE`).

## Where the rest of it lives (MON-742)

This file was seven hundred and eighty lines carrying four concerns, and the split is along the seam
between *taste* and *machinery*:

* `valuation.py` — what the board can charge and what a square is worth taking off it. Shekels, no
  opinions about what to do with them.
* `search.py` — the rollouts, the RNG streams they draw on, and the budget that bounds them. It calls
  back into whichever policy it was handed, and does not care which one.
* here — the policy: the five amendments above, expressed as a scorer, plus the trade valuation
  (:func:`_swap_gain`) that amendments 4 and 5 are argued in terms of.

The dependency points one way. This file imports both of the others; neither imports it, apart from
one deferred import in `search.py` that exists only to give a bot-less caller a default.

## What it measured

Over the fixed contest — seeds 1–50, each played from both seats, scored by `tournament.py`'s
thresholds, which were set before any of these bots existed (G-62):

    hard vs normal:  80/100 wins (needed 60), 0 draws, 0 capped (max 5), turns 35/104/309
    hard vs easy:    89/100 wins (needed 60), 0 draws, 0 capped (max 5), turns 16/71/250

Both are asserted rather than reported, in `test_bot_hard.py::TestTheStrengthGate`, and the second one
is asserted rather than inherited: "hard beats normal, normal beats easy, therefore hard beats easy" is
an argument about a relation that is not transitive, and every amendment above is aimed at the *normal*
bot's habits in particular.

The rollouts are what earn that. With ``ROLLOUT_CANDIDATES`` set to 1, so that no decision ever has two
candidates to compare and the bot is nothing but its heuristics, the same five amendments win **15 of
30** against the normal bot on the same seeds. With the search on, 24 of 30.

## What it still does not do

No tree, no nested search, no opponent model beyond "the opponent plays like the normal bot" — see
`search.py`, which is where that assumption is made and stated.
"""

from __future__ import annotations

from typing import Final

# The normal bot's internals, imported by the one module entitled to them: its subclass. The
# underscores mark them as private to the *bot package* rather than to the file — a printed price is a
# reading both bots need, and duplicating it here is how the two valuations would start to disagree.
from kesef_engine.bots.normal import (
    PROPOSE_SCORE,
    NormalBot,
    _legal_drafts,
    _price_of,
)
from kesef_engine.bots.search import search
from kesef_engine.bots.valuation import DENIAL_COMPLETING, denial_value, reserve
from kesef_engine.commands import (
    BuildHouse,
    BuyProperty,
    Command,
    PlaceBid,
    ProposeTrade,
    RespondToTrade,
    TradeOffer,
)
from kesef_engine.primitives import BotLevel, PlayerId
from kesef_engine.state import HOTEL_LEVEL, GameState

# --- Valuation weights. Preferences, both of them. --------------------------------------------------

BUILD_RESERVE: Final = 150
"""The reserve the bot keeps back *when the spend is a house* — a ceiling on
:func:`~kesef_engine.bots.valuation.reserve`, not a separate figure.

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

TRADE_NUDGE: Final = 0.01
"""How hard :meth:`HardBot._score_trade` leans on :func:`_swap_gain`.

Small on purpose. The gain is measured in rent — hundreds or thousands of shekels — and the parent's
verdicts are 50 and −20, so an unscaled correction would not be a nudge, it would be the whole answer.
The nudge only has to order the two answers correctly; the rollout is what decides between them.
"""


class HardBot(NormalBot):
    """The normal bot's four opinions, amended five times and backed by short rollouts.

    Holds no state: the rollout policy is another stateless bot, and the budget counters live and die
    inside one :func:`~kesef_engine.bots.search.search` call.
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
        return reserve(state, player)

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
                if state.player(player).cash - cost < min(reserve(state, player), BUILD_RESERVE):
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
                return base + denial_value(state, player, state.player(player).position)

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
        denial = denial_value(state, player, tile)
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
        ``TRADE_REVIEW`` is in ``search.ALWAYS_ROLL_OUT`` — and the nudge only has to get both answers
        into the candidate set with the right one ranked first.
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
