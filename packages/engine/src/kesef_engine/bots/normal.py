"""The normal bot: a ranking, not a search (MON-602).

Where the easy bot picks at random, this one scores every legal command and takes the best. That makes
it **fully deterministic without needing an RNG at all** — no stream, no fingerprint, no draw. A game
between two normal bots replays exactly, and the easy bot's whole fingerprint apparatus is absent here
because there is nothing random to keep honest.

## The four opinions, and why each is worth points

The backlog names them, and each is a claim about *this* game rather than a general heuristic:

1. **A cash buffer.** The commonest way to lose is to own a lot and be unable to pay rent once. Rent is
   charged from cash and a shortfall opens a debt, so cash is not idle capital, it is the thing that
   keeps the other assets. The bot therefore declines purchases that would leave it thin — which is the
   single biggest difference from the easy bot, who buys everything it lands on until it cannot pay.
2. **Group completion.** Rent only really moves once a colour group is whole: an unimproved complete
   group doubles, and building is not even *legal* until it is. So a square that completes or advances a
   group is worth more than a square that does not, and the bot pays attention to which.
3. **Build to three houses.** The rent ladder's steepest step per pound is the third house; the fourth
   and the hotel cost more for less marginal rent. So building is scored highly up to three per square
   and barely at all beyond it — which also keeps cash back, feeding opinion 1.
4. **Sane trade evaluation, in both directions.** It accepts an offer that improves its group position
   without gutting its cash, and declines otherwise — *and* it opens one when the board has stalled.

## Why it proposes trades, which is not something a bot could originally do

The first version of this bot only *answered* offers, because `Bot.choose` promised to return a member
of the `legal` tuple and `ProposeTrade` is never enumerated in `legal_commands` — ADR-005's documented
exception, the offer space being unbounded. That made trades structurally unreachable to every bot, and
it is what stopped this bot passing its own gate: 69/100 wins against easy (needed 60) but **12 games
capped** at 500 turns against a limit of 5. Dumping a capped position showed why, and it was not a
scoring problem:

    seed 9, turn 501:  houses = 0 for BOTH seats
    brown [0,1]  light_blue [1,0,1]  pink [1,0,1]  red [1,0,0]  yellow [0,0,1]  ...

**Every colour group split, so neither side could ever build.** Rents stay at their printed value, both
seats bank GO salaries faster than they lose them, and the game is undecidable. The only mechanism in
the rules that un-splits a group is a trade.

ADR-009 amends the protocol: a bot may return a constructed `ProposeTrade`, validated by `is_legal`
like anybody else's draft. The trade this bot looks for is the reciprocal one — *I hold all of red but
one and you hold that one; you hold all of light blue but one and I hold that one* — and it is worth
noticing that such a swap helps the **opponent** as much as it helps the bot. That is the point rather
than a flaw: a board where both sides can build is a board where somebody eventually loses, and a bot
that cannot finish a game is a failure whatever its win rate.

Note what is *not* here: no check that a swap is allowed. The bot builds an offer, asks
:func:`~kesef_engine.legality.is_legal`, and drops it if the answer is no. Group-carrying-buildings,
ownership, cash, the ruleset's `simplified_trades` — every one of those is a rule and lives in the
engine.

## What it deliberately does not do

No lookahead, no rollouts, no opponent model. That is MON-603, and the point of keeping it out is that
this bot is the *floor* MON-603 must clear by the same margin it has to clear over easy — a normal bot
that already searched would leave nothing between the two.

It also holds **no randomness at all**, so easy.py's fingerprint-fork apparatus is absent: there is
nothing random here to keep honest. `choose` stays a pure function of `(state, player, legal)` plus the
driver's `may_trade` permission, which is a fact about the call rather than a memory.
"""

from __future__ import annotations

from typing import Final

from kesef_engine.board.models import TileKind
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
from kesef_engine.legality import is_legal
from kesef_engine.phases import PORTFOLIO_PHASES, Phase
from kesef_engine.primitives import BotLevel, PlayerId
from kesef_engine.state import GameState

CASH_BUFFER: Final = 250
"""Cash the bot tries to keep unspent.

Roughly one bad landing on a developed opponent square. Not a rule and not tuned to a seed — the point
is that it is *some* reserve, because the easy bot's reserve is zero and that is what beats it.
"""

BUILD_TARGET: Final = 3
"""Houses per square the bot builds to before it stops caring.

Three is the steepest rent-per-cost step on the classic ladder; the fourth house and the hotel cost
more for less. Compared against, never derived from, ``HOTEL_LEVEL``.
"""


def _group_progress(state: GameState, player: PlayerId, tile_index: int) -> tuple[int, int, int]:
    """This square's colour group, as ``(mine, theirs, total)``.

    Counts ownership off ``state.properties``, which is a read. The *rule* about what owning a whole
    group entitles you to stays in the engine's ``owns_whole_group``, and this bot never re-implements
    it — it asks for a preference ordering, not for a legality.

    ``theirs`` is what the first version lacked, and its absence is why the bot could lead a game
    without ever finishing one. See :func:`_completion_value`.
    """
    tile = state.board.tile(tile_index)
    if tile.group is None:
        return (0, 0, 0)
    siblings = [candidate.index for candidate in state.board.tiles if candidate.group is tile.group]
    mine = sum(1 for index in siblings if state.properties[index].owner == player)
    theirs = sum(
        1 for index in siblings if state.properties[index].owner is not None and state.properties[index].owner != player
    )
    return (mine, theirs, len(siblings))


def _completion_value(mine: int, theirs: int, total: int) -> float:
    """What one more square of this group is worth, as a preference.

    **A group somebody else holds a piece of can never be completed**, and noticing that is what turned
    a bot that led games into a bot that finishes them.

    The first version scored group progress without looking at the opponent, so it spread its cash
    evenly over groups that were already broken. In a two-player game that produces a board where
    *neither* side owns a whole group — so neither can build, rents stay at their printed value, and
    the two trade small rents indefinitely. Sixteen of a hundred games hit the 500-turn cap with this
    bot comfortably ahead on net worth and no way to convert it, which is exactly the failure the
    harness's capped-game gate exists to catch.

    A broken group still has some block value, so this is not zero — it just stops competing with a
    group that can actually be finished and built on.
    """
    if not total:
        return 0.0
    if theirs:
        return 4.0
    return 60.0 if mine + 1 == total else 30.0 * (mine + 1) / total


PROPOSE_SCORE: Final = 80.0
"""Where opening a trade sits in the same ranking every other command is scored on.

Below ``build_house``'s 90 and above ``roll_dice``'s 60, which reads as: finish improving what is
already yours, *then* go looking for a swap, and only then roll. Nothing else in a portfolio phase
scores between the two, so this is an ordering rather than a tuned number.
"""


def _price_of(state: GameState, tile_index: int) -> int:
    price = state.board.tile(tile_index).price
    return 0 if price is None else price


# --- Proposing a trade (ADR-009) ---------------------------------------------------------------


def _completing_tiles(state: GameState, taker: PlayerId, giver: PlayerId) -> tuple[int, ...]:
    """Tiles ``giver`` holds that would hand ``taker`` a whole colour group.

    One tile, never a package, and that falls out of the arithmetic rather than being a simplification:
    the only groups a single square can complete are those where ``taker`` already holds every member
    but one — ``mine + 1 == total`` — and ``giver`` holds that one. A group needing two squares is not
    reachable in one hop and is left alone.

    Ordered by price, dearest first, then by index: the dear groups are the ones whose rent ladder is
    worth owning, and the index breaks ties so the choice is a pure function of the position.
    """
    found: list[int] = []
    for tile in state.board.tiles:
        if tile.group is None or state.properties[tile.index].owner != giver:
            continue
        mine, _theirs, total = _group_progress(state, taker, tile.index)
        if total and mine + 1 == total:
            found.append(tile.index)
    return tuple(sorted(found, key=lambda index: (-_price_of(state, index), index)))


def _spare_tiles(state: GameState, player: PlayerId, opponent: PlayerId) -> tuple[int, ...]:
    """The bot's squares that are worth more on the table than in its hand, best first.

    A square in a group somebody else has broken into can never be built on — that is
    :func:`_completion_value`'s whole point — so its only remaining value is as a blocker, and a blocker
    is exactly the kind of thing to trade away. Squares in a group the bot could still complete are
    excluded, however broken the group looks: ``mine + 1 == total`` is a group one swap away from being
    whole, and giving that share up would be the bot bidding against itself.

    Ordered by what the square does for ``opponent``, because an offer the other side has no reason to
    accept is a wasted turn. ``opp_theirs - 1`` is not an off-by-one: the bot itself is currently counted
    among the opponent's obstacles in that group, and it is offering to stop being one.
    """
    scored: list[tuple[float, int, int]] = []
    for tile in state.board.tiles:
        if tile.group is None or state.properties[tile.index].owner != player:
            continue
        mine, theirs, total = _group_progress(state, player, tile.index)
        if not theirs or mine + 1 == total:
            continue
        opp_mine, opp_theirs, _ = _group_progress(state, opponent, tile.index)
        scored.append((-_completion_value(opp_mine, opp_theirs - 1, total), _price_of(state, tile.index), tile.index))
    return tuple(index for _value, _price, index in sorted(scored))


def _sweetener(state: GameState, player: PlayerId, want: int, give: tuple[int, ...]) -> int:
    """Cash to even up an offer the bot is getting the better of, and never more than it can spare.

    Printed prices, not a valuation: the bot is guessing at what the *other* side will find fair, and
    the price on the deed is the only figure both parties can see. Capped by the cash buffer, which is
    opinion 1 outranking opinion 4 — the same order :meth:`NormalBot._score_trade` applies to an
    incoming offer.
    """
    gap = _price_of(state, want) - sum(_price_of(state, index) for index in give)
    spare = state.player(player).cash - CASH_BUFFER
    return max(0, min(gap, spare))


def _same_group(state: GameState, one: int, other: int) -> bool:
    return state.board.tile(one).group is state.board.tile(other).group


def _drafts(state: GameState, player: PlayerId, opponent: PlayerId) -> list[TradeOffer]:
    """Offers to put to ``opponent``, best first. Legality is somebody else's job — see :func:`_offer`.

    Three shapes, in the order they are preferred:

    1. **The reciprocal swap.** Each side hands over the one square blocking the other's group, and no
       money changes hands. This is the offer that un-splits two groups at once, and the only one a
       rational opponent should take without being paid.
    2. **A spare square, plus cash to even it up.** The bot has something the opponent wants but nothing
       the opponent *needs*, so it pays the difference in printed prices.
    3. **Cash alone.** Nothing spare to give. Twice the printed price is a lot for one square and the
       right price for the square that completes a group, because a whole group is what makes building
       legal at all.

    **A give and a want in the same group are never paired**, and the case is not hypothetical: brown
    and dark blue have two members each, so when the two seats hold one apiece, *each* tile completes
    the group for whoever does not have it. Both therefore qualify — the bot's as a give, the
    opponent's as a want — and the resulting offer swaps one half of a split group for the other half,
    leaving it exactly as split as before. Perfectly legal, and a wasted turn every turn.
    """
    wants = _completing_tiles(state, player, opponent)
    if not wants:
        return []
    reciprocal = _completing_tiles(state, opponent, player)
    spare = _spare_tiles(state, player, opponent)
    drafts: list[TradeOffer] = []
    for want in wants:
        for give in reciprocal:
            if not _same_group(state, give, want):
                drafts.append(_offer(player, opponent, give=(give,), want=want, cash=0))
    for want in wants:
        for give in spare:
            if not _same_group(state, give, want):
                cash = _sweetener(state, player, want, (give,))
                drafts.append(_offer(player, opponent, give=(give,), want=want, cash=cash))
    for want in wants:
        cash = max(0, min(_price_of(state, want) * 2, state.player(player).cash - CASH_BUFFER))
        if cash:
            drafts.append(_offer(player, opponent, give=(), want=want, cash=cash))
    return drafts


def _offer(proposer: PlayerId, recipient: PlayerId, *, give: tuple[int, ...], want: int, cash: int) -> TradeOffer:
    return TradeOffer(
        proposer=proposer,
        recipient=recipient,
        give=TradeSide(cash=cash, tiles=give),
        receive=TradeSide(tiles=(want,)),
    )


def _find_trade(state: GameState, player: PlayerId) -> ProposeTrade | None:
    """The best offer this seat can legally make right now, or ``None``.

    Restricted to the portfolio phases even though ``is_legal`` would also allow a debtor to trade
    during ``DEBT_SETTLEMENT``: the offers built here swap squares rather than raise cash, so proposing
    one while money is owed would spend a turn not solving the problem in front of it.

    Every draft is put to :func:`~kesef_engine.legality.is_legal` and the first accepted one is
    returned. Building an offer the engine would reject and letting ``apply`` raise would be a bot
    guessing at rules, which is the one thing a bot in this codebase may never do.
    """
    if state.phase not in PORTFOLIO_PHASES:
        return None
    opponents = sorted(other.id for other in state.solvent_players if other.id != player)
    for opponent in opponents:
        for draft in _drafts(state, player, opponent):
            command = ProposeTrade(player=player, offer=draft)
            if is_legal(state, command):
                return command
    return None


class NormalBot:
    """Scores every legal command and takes the highest. No randomness, no search."""

    level: BotLevel = BotLevel.NORMAL

    def choose(
        self,
        state: GameState,
        player: PlayerId,
        legal: tuple[Command, ...],
        *,
        may_trade: bool = True,
    ) -> Command:
        if not legal:
            raise ValueError("no legal commands to choose from")
        # `max` with a stable key over the tuple's own order: equal scores resolve to the earliest
        # command, so the choice is a pure function of the position and cannot drift.
        best = max(legal, key=lambda command: self._score(state, player, command))
        if not may_trade or self._score(state, player, best) >= PROPOSE_SCORE:
            # Nothing to search for, or something better already on offer — and checking the score
            # first is what keeps the search off the hot path: it runs at most twice a turn, when the
            # only things left to do are roll and end.
            return best
        return _find_trade(state, player) or best

    def _score(self, state: GameState, player: PlayerId, command: Command) -> float:
        me = state.player(player)
        in_debt = state.phase is Phase.DEBT_SETTLEMENT

        match command:
            case BuyProperty():
                # The square the seat is standing on: `BuyProperty` carries no tile, and assuming it
                # targets the current position is the same reading the rest of the product makes.
                tile_index = me.position
                price = _price_of(state, tile_index)
                mine, theirs, total = _group_progress(state, player, tile_index)
                kind = state.board.tile(tile_index).kind

                # Opinion 2: what this square does to a group. Completing one is the big prize,
                # because it is what makes building legal at all — and a group the opponent has
                # already broken into cannot be completed by anybody.
                completion = _completion_value(mine, theirs, total)
                if not total and kind in (TileKind.RAILROAD, TileKind.UTILITY):
                    # Stations pay without any building, so they are worth having, just not chasing.
                    completion = 8.0

                # Opinion 1: the buffer. A purchase that leaves the bot thin is worth much less than
                # the same purchase made comfortably — and one that leaves it broke is worth nothing.
                after = me.cash - price
                if after < 0:
                    return -100.0
                thinness = 0.0 if after >= CASH_BUFFER else -30.0 * (CASH_BUFFER - after) / CASH_BUFFER
                return 50.0 + completion + thinness

            case DeclinePurchase():
                # Scored just under an unattractive purchase, so it wins exactly when buying is bad.
                return 45.0

            case BuildHouse(tile=build_tile):
                houses = state.properties[build_tile].houses
                cost = state.board.tile(build_tile).house_cost or 0
                if me.cash - cost < CASH_BUFFER:
                    # Opinion 1 again: houses are the best investment in the game and still not worth
                    # the last of the cash.
                    return 5.0
                # Opinion 3, in two halves. Up to the target, building is the best thing it can do.
                if houses < BUILD_TARGET:
                    return 90.0 - houses * 5.0
                # Past the target it is still worth doing when cash is genuinely spare — and the first
                # version scored this at 10.0, *below* `end_turn`'s 20.0, so the bot never built a
                # fourth house or a hotel at all. It won 69/100 anyway and capped 16 games against a
                # limit of 5: without hotels it could not raise rent enough to actually bankrupt
                # anybody, so it out-played the easy bot for five hundred turns and never finished.
                #
                # "Builds to three houses" is a statement about what it does *first*, not a ceiling.
                return 40.0 if me.cash - cost >= CASH_BUFFER * 2 else 5.0

            case RollDice():
                # Has to happen, but after any building worth doing — hence below `build_house` and
                # above `end_turn`.
                return 60.0

            case EndTurn():
                return 20.0

            case PayJailFine():
                # Out early while there is a board to play; sit it out when the reserve is thin.
                return 55.0 if me.cash - 50 >= CASH_BUFFER else 15.0

            case UseJailCard():
                # Free, so better than paying.
                return 65.0

            case RollForJail():
                return 40.0

            case PlaceBid(amount=amount):
                lot = state.auction.lot if state.auction is not None else None
                bid_tile = lot.tile if lot is not None and lot.kind == "tile" else None
                if bid_tile is None:
                    # A building lot in a shortage auction: no group to reason about.
                    return 25.0 if me.cash - amount >= CASH_BUFFER else -50.0
                mine, theirs, total = _group_progress(state, player, bid_tile)
                worth = _price_of(state, bid_tile) + _completion_value(mine, theirs, total) * 2.0
                if me.cash - amount < CASH_BUFFER or amount > worth:
                    # `legal_commands` offers the minimum legal bid only (ADR-005), so declining to
                    # value it means withdrawing rather than bidding lower.
                    return -50.0
                return 55.0

            case WithdrawFromAuction():
                return 30.0

            case RespondToTrade():
                # Opinion 4. The frame names the offer; accepting is worth it when the squares coming
                # in advance a group by more than the ones going out, and the cash cost is bearable.
                return self._score_trade(state, player, command)

            case SellHouse() | MortgageProperty():
                # Raising cash is right in a debt and wrong outside one — the same rule the easy bot
                # learned the hard way (see `easy.py` on undoing your own moves).
                return 70.0 if in_debt else -10.0

            case UnmortgageProperty():
                return -10.0 if in_debt else 25.0

            case DeclareBankruptcy():
                # Genuinely last: only chosen when everything else scores below it, which in debt
                # settlement means nothing can be sold or mortgaged.
                return -90.0

            case _:
                return 0.0

    def _score_trade(self, state: GameState, player: PlayerId, command: RespondToTrade) -> float:
        """Accept or decline the offer on the table.

        `respond_to_trade` carries only `accept`, so both answers appear in `legal` and this scores
        each. The valuation is the same group-progress reading purchases use, applied to both sides.
        """
        frame = state.pending_trade
        accept = command.accept
        if frame is None:
            return 0.0 if accept else 35.0

        offer = frame.offer
        # "Mine" is whichever side this seat receives. The proposer gives `give` and asks for
        # `receive`, so a recipient receives `give`.
        incoming = offer.give if player == offer.recipient else offer.receive
        outgoing = offer.receive if player == offer.recipient else offer.give

        def value(tiles: tuple[int, ...]) -> float:
            total = 0.0
            for tile_index in tiles:
                mine, theirs, group_total = _group_progress(state, player, tile_index)
                total += _price_of(state, tile_index)
                total += _completion_value(mine, theirs, group_total)
            return total

        gain = value(incoming.tiles) + incoming.cash
        loss = value(outgoing.tiles) + outgoing.cash
        me = state.player(player)
        if me.cash - outgoing.cash < CASH_BUFFER:
            # Cannot afford the cash side comfortably, whatever the squares are worth.
            return 35.0 if not accept else -20.0
        good = gain > loss
        return (50.0 if good else -20.0) if accept else (-20.0 if good else 50.0)
