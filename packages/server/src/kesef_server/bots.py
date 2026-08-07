"""Advancing bot seats, so a game with a computer in it does not stall (MON-304).

MON-601 built the bot; nothing drove it. A game seated with a computer would reach that seat's turn
and stop, because the only thing that ever changed a game was a client posting a command and no
client speaks for a bot.

## What this module is, and is not

It is a **loop around the same door a human uses**: ask `legal_commands`, hand the tuple to the bot,
post whatever it returns through `apply`. There is no privileged path — a bot cannot make a move a
human could not make from the same position, because it is offered the same tuple and the reducer
checks it again. That is the property that makes "the bot cheated" un-implementable rather than
merely untrue.

It is *not* a scheduler and holds no state. One call advances the game as far as the bots can take
it and returns; the next human command triggers the next call.

## Who "the bot to act" is — the mistake worth reading

`legal_commands(state)` answers for **every seat that *may* act**, and "may" is much wider than "is
being waited on". Mortgaging is legal off-turn, so on any turn after its first a bot seat has
something legal to do at all times.

The first version of this driver iterated the seats in order and acted for the first bot with anything
legal. An all-bot game answered with this:

    step 4: current=0  seat 0 chose end_turn
    step 5: current=1  seat 0 chose mortgage_property     <-- not seat 1's turn any more
    step 6: current=1  seat 0 chose unmortgage_property
    step 7: current=1  seat 0 chose mortgage_property     <-- for two hundred steps

Seat 0 fidgeted with its own portfolio forever and seat 1 never took its turn. The bot was behaving
exactly as designed; the driver was asking the wrong seat.

So the driver acts only for the seat the engine is **waiting on** — and that question is answered by
`GameState.seat_to_act`, in the engine, rather than here. It was implemented here first and then moved:
the tournament harness needed the same answer, and "who is the game blocked on" having two
implementations is exactly how this defect happened in the first place.

## One trade proposal per seat per turn

ADR-009 lets a bot return a constructed `ProposeTrade`, which `legal_commands` never enumerates. That
buys a bot the one move that un-splits a colour group, and it brings a loop with it: a bot is a pure
function of the position, and declining an offer puts the position back to essentially what it was, so
a bot asked again would offer the identical swap forever — to a human, a decline button that summons
the same trade back immediately.

The loop is broken **here**, not with a flag in the engine's state and not with memory inside the bot
(a bot with memory is a second place the game's history lives, and it would break replay-from-seed).
Each seat gets one proposal per turn, spent whether the offer is accepted or declined.

Where the fact is *kept* is the interesting part. This driver cannot remember it: `_advance_bots` calls
`drive` with `max_steps=1` so each move is a fresh call, and a proposal to a human seat ends the call
entirely — the next `drive` happens in the *next HTTP request*, after the human has answered. A
local variable would reset every time and the human would be back in the loop. So it is read off the
**event log**, which is the game's own record of what has already happened: `TradeProposed` since the
last `TurnStarted`. `tournament.py` enforces the identical rule with a plain set, because that loop owns
every step and can simply remember.

## The step cap

A hard bound on how many commands one call will apply, and it is not decoration. The easy bot picks
uniformly among its legal moves, and on a developed board that tuple contains mortgage, unmortgage,
build and sell — so a bot can legitimately churn for a while before it happens to pick `end_turn`.
That terminates, but "terminates" is not good enough for a request handler: an engine change that
made some pair of commands mutually re-enabling would turn this loop into a hang, and a hang in a
game server is worse than a bot that stops moving and logs why. The cap is per call, so the next
command resumes.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Iterable
from dataclasses import dataclass

import structlog

from kesef_engine.bots import EasyBot, HardBot, NormalBot
from kesef_engine.bots.base import Bot, BotLevel
from kesef_engine.commands import Command
from kesef_engine.events import Event, TradeProposed, TurnStarted
from kesef_engine.legality import legal_commands
from kesef_engine.primitives import PlayerId
from kesef_engine.reducer import apply
from kesef_engine.state import GameState

log = structlog.get_logger(__name__)

_BOTS: dict[BotLevel, Bot] = {
    BotLevel.EASY: EasyBot(),
    BotLevel.NORMAL: NormalBot(),
    BotLevel.HARD: HardBot(),
}
"""One instance per level, shared across every game.

Safe because a bot holds no state — that is a promise of the `Bot` protocol, and `test_bot_easy.py`
pins it. The hard bot spends a bounded rollout budget per move and keeps its counters inside the call
(`kesef_engine.bots.search.search`), so sharing one instance across concurrent games is safe for the same
reason as the other two.

**Every level in `BotLevel` now has an entry**, as of MON-603, and `test_bot_driving.py` asserts that
rather than trusting it. The `.get` below still returns `None` for a missing level, because "a level
this server cannot drive leaves the seat waiting" is a better failure than a crashed game if a future
level is added to the enum before its bot exists.
"""


def seats_that_proposed_this_turn(events: Iterable[Event]) -> frozenset[PlayerId]:
    """Which seats have already spent their one trade proposal in the current turn.

    Read off the log rather than remembered — see the module docstring on why this driver cannot keep
    it. Scanned backwards and stopped at the `TurnStarted` that opened the current turn, so the cost is
    the length of one turn rather than the length of the game.
    """
    spent: set[PlayerId] = set()
    for event in reversed(list(events)):
        if isinstance(event, TurnStarted):
            break
        if isinstance(event, TradeProposed):
            spent.add(event.offer.proposer)
    return frozenset(spent)


@dataclass(frozen=True)
class BotStep:
    """One command a bot played, what it produced, and the state it produced.

    The state travels with the step because the caller has to *persist each step as it happens*, not
    once at the end — see :func:`drive`.
    """

    player: PlayerId
    command: Command
    events: tuple[Event, ...]
    state: GameState


def bot_for(level: BotLevel | None) -> Bot | None:
    return None if level is None else _BOTS.get(level)


def _next_bot_move(
    state: GameState, *, traded_seats: frozenset[PlayerId] = frozenset()
) -> tuple[PlayerId, Command] | None:
    """The move the seat-being-waited-on would make, if it is a bot. `None` otherwise.

    `traded_seats` are the seats that have already proposed a trade this turn and so are offered the
    move without the permission (ADR-009).
    """
    seat = state.seat_to_act
    if seat is None:
        return None
    player = next((candidate for candidate in state.players if candidate.id == seat), None)
    if player is None:
        return None
    bot = bot_for(player.kind.bot_level)
    if bot is None:
        return None
    mine = tuple(command for command in legal_commands(state) if command.player == seat)
    if not mine:
        return None
    return seat, bot.choose(state, seat, mine, may_trade=seat not in traded_seats)


async def drive(
    state: GameState,
    *,
    think_seconds: float,
    max_steps: int,
    traded_seats: frozenset[PlayerId] = frozenset(),
) -> AsyncIterator[BotStep]:
    """Yield each bot move in turn, pausing before each one.

    An async **generator** rather than a function returning a list, and the shape is the point: the
    caller stores every step as it is yielded, so the WebSocket push for move one goes out while move
    two is still being thought about. A version that returned the whole turn at once would make the
    thinking delay a pause with nothing behind it — the client would sit through the silence and then
    receive six moves in a single frame, which is the freeze-then-jump this delay exists to prevent.

    `async` also means the pause yields the event loop, which is what lets those queues drain.

    `traded_seats` comes in from the caller because the log this driver would have to read is the
    session's, not the engine's — see the module docstring. It is carried forward inside the loop too,
    so a multi-step call obeys the same one-proposal rule a single-step one does.
    """
    turn = state.turn_number
    for _ in range(max_steps):
        if state.turn_number != turn:
            turn = state.turn_number
            traded_seats = frozenset()
        move = _next_bot_move(state, traded_seats=traded_seats)
        if move is None:
            return
        player, command = move
        if command.kind == "propose_trade":
            traded_seats |= {player}

        if think_seconds > 0:
            await asyncio.sleep(think_seconds)

        state, events = apply(state, command)
        yield BotStep(player=player, command=command, events=tuple(events), state=state)

    # Reached only by exhausting the cap — a `return` above is the ordinary exit. Not an exception:
    # the game is intact and every step so far is real, so stopping and saying so keeps the request
    # finite and the next command picks up where this left off.
    log.warning(
        "bots.step_cap_reached",
        max_steps=max_steps,
        phase=state.phase.value,
        hint="a bot took the whole cap in one call; check for a pair of mutually re-enabling commands",
    )
