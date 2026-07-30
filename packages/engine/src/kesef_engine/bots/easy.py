"""The easy bot: random, cheerful, and reliably beatable (MON-601).

Three rules, and the last two are the only opinions it holds:

1. Pick uniformly at random among the legal commands.
2. **Always buy what it can afford.** Affordability is not this file's judgement — a
   ``BuyProperty`` in ``legal`` *is* the engine saying the player can afford it, because
   ``legality.py`` rejects the unaffordable case with ``error.insufficient_funds``. So the rule
   reduces to "if buying is offered, buy", which is a preference rather than a rule and therefore
   allowed here.
3. **Never work against itself.** While solvent it does not dismantle — no selling buildings, no
   mortgaging. While settling a debt it does not spend — no building, no paying off mortgages.

That is the whole strategy. It exists so a six-year-old has an opponent who loses cheerfully, and
so MON-602 has a floor to beat.

## Why rule 3 exists, because "random among legal" sounds like it should not

It was added after watching MON-304 drive two of these bots against each other, which is the first
time anybody saw a bot turn as a *sequence*. The trace read:

    build_house, sell_house, build_house, sell_house, build_house, sell_house, …

Uniform choice over the legal set includes both halves of that pair, so the bot spent its turn
building a house and immediately selling it back at half price. It terminates — selling refunds less
than building costs, so the cash drains — but it burned two hundred commands to play one turn, and at
the server's 0.6 s thinking delay that is a human waiting two minutes while the board twitches.

The honest framing is that a bot dismantling its own houses for no reason is not "losing cheerfully",
it is broken, and "random" was never meant to include self-harm. So the same category of preference
that makes it buy makes it decline to sell.

**Debt settlement inverts it rather than lifting it.** Selling and mortgaging are the *only* ways to
raise cash, so a bot forbidden from them would sit in ``DEBT_SETTLEMENT`` with nothing it was willing
to do and bankruptcy as the only move left. But simply allowing everything there reproduced the same
defect with the other pair — the first version of this rule did exactly that, and an all-bot game
answered with 195 ``mortgage_changed`` events in one request: mortgage to raise cash, pay a mortgage
off to spend it, repeat, never settling.

So the exclusion flips. Solvent: do not give assets up for cash. In debt: do not spend cash on assets.
Both readings are the same rule — *do not undo what you just did* — and the phase decides which
direction "undoing" points in.

## Where the randomness comes from, and why it is not ``fork`` alone

``state.rng`` is the dice stream and is part of the serialized state. The bot must not draw from it:
a bot that consumed dice entropy would change the dice a human sees, so replaying a game with a
different bot would deal different rolls and every golden game would be a different game.

So the bot draws from its **own** stream. But `fork(stream)` resets the counter to zero, which is
not enough on its own, and the reason is worth writing down because it is the trap this file exists
to avoid:

    Suppose the bot holds three legal commands — build on 5, build on 7, end turn — and picks index
    1. The server applies it. Building draws no randomness, so ``state.rng`` has not moved; a fresh
    ``fork`` yields the same counter and therefore the same index. The bot builds on 7 again, and
    again, until the even-build rule stops it. It looks random and is in fact a fixed preference.

A bot whose "randomness" collapses like that would also make MON-602's ≥ 60/100 threshold
meaningless, since it is measured against *this* bot. The fix is to derive the stream from a cheap
fingerprint of the position, so two states that differ in any way the bot could act on draw
differently. The fingerprint is state, not a counter the bot keeps: ``choose`` stays a pure function
of ``(state, player, legal)``, which is what the ``Bot`` protocol promises and what makes a bot game
reproducible from its seed alone.
"""

from __future__ import annotations

from typing import Final

from kesef_engine.commands import Command
from kesef_engine.phases import Phase
from kesef_engine.primitives import BotLevel, PlayerId
from kesef_engine.rng import Rng
from kesef_engine.state import GameState

STREAM_BOT_BASE: Final = 16
"""First stream id reserved for bots.

Streams 0–2 are the dice and the two decks (see ``factory.py``). Starting well clear of them leaves
room for more engine streams without a bot silently colliding with one — a collision would not fail
a test, it would quietly correlate a bot's choices with the deck order.
"""

_MASK64: Final = 0xFFFFFFFFFFFFFFFF
_ODD_MULTIPLIER: Final = 0x9E3779B97F4A7C15
"""An odd constant, so multiplication modulo 2**64 is a bijection and no two fingerprints collide
through it alone."""


def _stream_for(state: GameState, player: PlayerId, legal: tuple[Command, ...]) -> int:
    """A stream id that changes whenever the position the bot is choosing from changes.

    The fields are chosen for one property each, not for entropy's sake:

    * ``turn_number`` — moves the stream on every turn, so a bot facing the identical choice on two
      different turns does not repeat itself.
    * the seat's ``cash`` and ``position`` — the two things that change *within* a turn as the bot
      acts. Cash is what makes the repeated-build case above draw a fresh index: building pays for
      the house, so the next fingerprint differs.
    * ``len(legal)`` — cheap, and it changes as options open and close.

    Deliberately **not** a hash of the whole state: this runs once per bot decision and a full state
    hash would be the most expensive thing in a 500-turn tournament game, for no gain the four
    fields above do not already give.
    """
    me = state.player(player)
    mixed = (state.turn_number + 1) * _ODD_MULTIPLIER
    mixed ^= (me.cash + 1) * 0xD1B54A32D192ED03
    mixed ^= (me.position + 1) * 0xBF58476D1CE4E5B9
    mixed ^= len(legal) * 0x94D049BB133111EB
    return STREAM_BOT_BASE + player + ((mixed & _MASK64) << 8)


_DISMANTLING: Final = frozenset({"sell_house", "mortgage_property"})
"""Give an asset up for cash. Excluded while solvent."""

_SPENDING: Final = frozenset({"build_house", "unmortgage_property"})
"""Spend cash on an asset. Excluded while settling a debt, where the cash is needed for the debt."""


class EasyBot:
    """Random among the legal moves, except that it always buys.

    Holds no state of its own — deliberately. A bot with memory would be a second place the game's
    history lives, and it would break the promise that a game replays identically from its seed and
    command list.
    """

    level: BotLevel = BotLevel.EASY

    def choose(
        self,
        state: GameState,
        player: PlayerId,
        legal: tuple[Command, ...],
        *,
        may_trade: bool = True,
    ) -> Command:
        # `may_trade` is accepted and ignored: ADR-009 lets a bot construct a `ProposeTrade`, and this
        # bot never does. Constructing an offer is a search, and "random among legal" is the whole of
        # this bot's strategy — there is nothing here to permit or forbid. The parameter is on the
        # signature rather than absent from it because the `Bot` protocol carries it, and a driver that
        # had to ask which bots accept the keyword would be the beginnings of a bot registry.
        del may_trade
        if not legal:
            # The caller's bug, not a position: the reducer always offers at least `end_turn` to the
            # seat it is waiting on. Raising beats returning something invented.
            raise ValueError("no legal commands to choose from")

        # Rule 2. `legal` containing a purchase is the engine's own statement that it is affordable,
        # so there is no arithmetic here.
        for command in legal:
            if command.kind == "buy_property":
                return command

        # Rule 3, in whichever direction the phase points. `or legal` is the safety net: if every
        # legal move is an excluded one, refusing them all would leave nothing to return.
        against_itself = _SPENDING if state.phase is Phase.DEBT_SETTLEMENT else _DISMANTLING
        legal = tuple(c for c in legal if c.kind not in against_itself) or legal

        index, _ = Rng(seed=state.rng.seed, stream=_stream_for(state, player, legal)).below(len(legal))
        chosen = legal[index]
        # The protocol's one hard promise, cheap enough to assert: a bot may never return a command
        # outside the tuple it was handed. Everything downstream — the reducer, the server, the log —
        # trusts that, so it is checked here rather than discovered as an IllegalCommandError.
        assert chosen in legal
        return chosen
