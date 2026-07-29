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
4. **Sane trade evaluation.** It accepts an offer that improves its group position without gutting its
   cash, and declines otherwise. It never *proposes* — `ProposeTrade` is not enumerated in
   `legal_commands` (ADR-005's documented exception), so a bot cannot offer a trade without inventing
   one, and inventing one is a search this bot does not do.

## What it deliberately does not do

No lookahead, no rollouts, no opponent model. That is MON-603, and the point of keeping it out is that
this bot is the *floor* MON-603 must clear by the same margin it has to clear over easy — a normal bot
that already searched would leave nothing between the two.
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
    RespondToTrade,
    RollDice,
    RollForJail,
    SellHouse,
    UnmortgageProperty,
    UseJailCard,
    WithdrawFromAuction,
)
from kesef_engine.phases import Phase
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


def _price_of(state: GameState, tile_index: int) -> int:
    price = state.board.tile(tile_index).price
    return 0 if price is None else price


class NormalBot:
    """Scores every legal command and takes the highest. No randomness, no search."""

    level: BotLevel = BotLevel.NORMAL

    def choose(self, state: GameState, player: PlayerId, legal: tuple[Command, ...]) -> Command:
        if not legal:
            raise ValueError("no legal commands to choose from")
        # `max` with a stable key over the tuple's own order: equal scores resolve to the earliest
        # command, so the choice is a pure function of the position and cannot drift.
        return max(legal, key=lambda command: self._score(state, player, command))

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
