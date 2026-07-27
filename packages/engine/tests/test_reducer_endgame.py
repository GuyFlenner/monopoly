"""MON-208 — the endgame: who wins, why, and when the engine is allowed to ask.

One test per bullet of the backlog item:

* the last solvent player wins, and the question is only asked once the interrupt stack
  has drained (G-8) — the evaluation point is ``insolvency.resolve_after_command``, so the
  tests here drive it through ``apply`` rather than calling ``maybe_end`` directly;
* Kids Mode's ``target_duration_minutes`` ends the game on **net worth**, off the
  caller-stamped clock that arrives as ``EndTurn.elapsed_seconds`` (G-6) — the path that
  made ``GameEnded.reason="time_limit"`` dead code until now;
* a mortgaged property contributes **zero** to that net worth (decided at MON-208, cited
  in ``GameState.net_worth``);
* ``final_standings`` names its players, and the elimination order breaks the bankrupt
  players' universal tie at zero;
* ``no_survivors`` is reachable — the official mortgage transfer fee cascades onto the
  creditor (G-13), and the last two players can leave together.
"""

from __future__ import annotations

from helpers import make_player, make_state
from kesef_engine.commands import DeclareBankruptcy, EndTurn, MortgageProperty, RollDice
from kesef_engine.errors import IllegalCommandError
from kesef_engine.events import Event, GameEnded, TurnStarted
from kesef_engine.legality import legal_commands
from kesef_engine.phases import Phase
from kesef_engine.primitives import CashReason
from kesef_engine.reducer import apply
from kesef_engine.rules import endgame
from kesef_engine.ruleset import Ruleset
from kesef_engine.state import DebtFrame, GameState, Obligation, PlayerState, PropertyState

KIDS = Ruleset.kids()
KIDS_LIMIT_SECONDS = 45 * 60
"""``Ruleset.kids().target_duration_minutes`` is 45. Pinned so a ruleset change shows up
here as a named failure rather than as a test that quietly stops timing anything."""

# The universal rules with a clock bolted on: mortgages stay enabled, which Kids Mode
# switches off, so the mortgaged-deed valuation rule can be exercised in a timed game.
TIMED_UNIVERSAL = Ruleset.universal().model_copy(update={"target_duration_minutes": 30})
TIMED_UNIVERSAL_SECONDS = 30 * 60


def _ended(events: tuple[Event, ...]) -> GameEnded:
    ended = [event for event in events if isinstance(event, GameEnded)]
    assert len(ended) == 1, f"expected exactly one GameEnded, got {len(ended)}"
    return ended[0]


def _timed_table(ruleset: Ruleset) -> GameState:
    """Three seats resting in AWAITING_END_TURN, with net worths that cannot tie.

    P1 is the richest by deed (₪300 cash + Boardwalk at ₪400 = ₪700), P0 second on cash
    alone (₪500) and P2 last (₪200) — so the clock has to read the *table*, not the seat
    order or the current player, to name the right winner.
    """
    seats = (make_player(0, cash=500), make_player(1, cash=300), make_player(2, cash=200))
    return make_state(
        seats=seats,
        ruleset=ruleset,
        properties={39: PropertyState(owner=1)},
        phase=Phase.AWAITING_END_TURN,
        current=0,
    )


# --- The last solvent player -------------------------------------------------


def test_the_last_solvent_player_wins_with_a_named_reason() -> None:
    seats = (make_player(0, cash=0), make_player(1, cash=900))
    frame = DebtFrame(
        resume=Phase.AWAITING_END_TURN,
        debtor=0,
        obligations=(Obligation(creditor=1, amount=500),),
        reason=CashReason.RENT,
    )
    state = make_state(seats=seats, phase=Phase.DEBT_SETTLEMENT, interrupts=(frame,), current=0)
    new_state, events = apply(state, DeclareBankruptcy(player=0))

    assert new_state.phase is Phase.GAME_OVER
    assert new_state.winner == 1
    ended = _ended(events)
    assert (ended.winner, ended.reason) == (1, "last_solvent")
    assert legal_commands(new_state) == (), "no command is legal once the game is over"


def test_the_endgame_waits_for_the_interrupt_stack_to_drain() -> None:
    """G-8: a bankruptcy to the bank leaves a live estate auction, and declaring a winner
    on top of it would freeze the game with a frame nobody may act in."""
    seats = (make_player(0, cash=0), make_player(1, cash=900), make_player(2, cash=900))
    frame = DebtFrame(
        resume=Phase.AWAITING_END_TURN,
        debtor=0,
        obligations=(Obligation(creditor="bank", amount=500),),
        reason=CashReason.TAX,
    )
    state = make_state(
        seats=seats,
        properties={1: PropertyState(owner=0)},
        phase=Phase.DEBT_SETTLEMENT,
        interrupts=(frame,),
        current=0,
    )
    mid, mid_events = apply(state, DeclareBankruptcy(player=0))
    assert mid.phase is Phase.AUCTION, "the estate is still being sold"
    assert not [event for event in mid_events if isinstance(event, GameEnded)]
    assert legal_commands(mid), "the deadlock catcher: a live auction still offers a move"


def test_no_survivors_is_reachable_through_the_official_transfer_fee() -> None:
    """G-13: the receiver of a mortgaged deed owes 10% at transfer, cannot pay it, and
    concedes in turn — so the game ends with nobody left and ``winner`` is None."""
    seats = (make_player(0, cash=0), make_player(1, cash=10))
    frame = DebtFrame(
        resume=Phase.AWAITING_END_TURN,
        debtor=0,
        obligations=(Obligation(creditor=1, amount=500),),
        reason=CashReason.RENT,
    )
    state = make_state(
        seats=seats,
        properties={39: PropertyState(owner=0, mortgaged=True)},  # mortgage 200 -> fee 20
        phase=Phase.DEBT_SETTLEMENT,
        interrupts=(frame,),
        current=0,
    )
    mid, _ = apply(state, DeclareBankruptcy(player=0))
    assert mid.phase is Phase.DEBT_SETTLEMENT and mid.pending_debt is not None
    assert mid.pending_debt.debtor == 1, "the fee cascaded onto the creditor"

    final, events = apply(mid, DeclareBankruptcy(player=1))
    assert final.phase is Phase.GAME_OVER
    assert final.winner is None
    ended = _ended(events)
    assert (ended.winner, ended.reason) == (None, "no_survivors")
    assert [(standing.player, standing.rank, standing.net_worth) for standing in ended.final_standings] == [
        (1, 1, 0),
        (0, 2, 0),
    ], "both fell, so the elimination order alone ranks them: the later you fall, the higher"


# --- The clock (Kids Mode) ---------------------------------------------------


def test_a_kids_mode_game_ends_on_the_clock_with_the_richest_player_winning() -> None:
    state = _timed_table(KIDS)
    assert state.elapsed_seconds == 0
    new_state, events = apply(state, EndTurn(player=0, elapsed_seconds=KIDS_LIMIT_SECONDS))

    assert new_state.elapsed_seconds == KIDS_LIMIT_SECONDS
    assert new_state.phase is Phase.GAME_OVER
    assert new_state.winner == 1, "the richest survivor, not the current player and not seat 0"
    ended = _ended(events)
    assert (ended.winner, ended.reason) == (1, "time_limit")
    assert [(standing.player, standing.rank, standing.net_worth) for standing in ended.final_standings] == [
        (1, 1, 700),
        (0, 2, 500),
        (2, 3, 200),
    ]
    assert not [event for event in events if isinstance(event, TurnStarted)], (
        "the seat is not handed on: the game ended as the turn closed"
    )


def test_the_clock_does_not_end_the_game_one_second_early() -> None:
    state = _timed_table(KIDS)
    new_state, events = apply(state, EndTurn(player=0, elapsed_seconds=KIDS_LIMIT_SECONDS - 1))
    assert new_state.phase is not Phase.GAME_OVER
    assert new_state.winner is None
    assert not [event for event in events if isinstance(event, GameEnded)]
    assert [event.player for event in events if isinstance(event, TurnStarted)] == [1]


def test_a_ruleset_with_no_time_limit_never_ends_on_the_clock() -> None:
    """The universal game has no time ending at all, not an unreachable one — so a caller
    that stamps a decade of wall clock changes nothing."""
    state = _timed_table(Ruleset.universal())
    new_state, events = apply(state, EndTurn(player=0, elapsed_seconds=10**9))
    assert new_state.elapsed_seconds == 10**9
    assert new_state.phase is Phase.AWAITING_ROLL
    assert not [event for event in events if isinstance(event, GameEnded)]


def test_the_clock_is_caller_stamped_and_cannot_be_rewound() -> None:
    """G-6: the engine owns no clock, so a stale stamp from a lagging caller must not
    shorten the game — the accumulator is monotone."""
    stamped, _ = apply(_timed_table(KIDS), EndTurn(player=0, elapsed_seconds=600))
    assert stamped.elapsed_seconds == 600

    lagging = _timed_table(KIDS)._replace(elapsed_seconds=600)
    rewound, _ = apply(lagging, EndTurn(player=0, elapsed_seconds=5))
    assert rewound.elapsed_seconds == 600, "a stale stamp cannot shorten the game"

    unstamped, _ = apply(lagging, EndTurn(player=0))
    assert unstamped.elapsed_seconds == 600, "an unstamped EndTurn leaves the clock alone"
    assert unstamped.phase is not Phase.GAME_OVER


def test_the_clock_waits_for_the_interrupt_stack_to_drain() -> None:
    """The ordering of G-8 applies to the time ending too.

    The state is hand-built: ``EndTurn`` is only legal in a quiet phase, so play can never
    stamp the clock while a frame is live. A save file can arrive in this shape, and the
    guard has to be the drain — not the reason the game is ending.
    """
    seats = (make_player(0, cash=0), make_player(1, cash=900), make_player(2, cash=900))
    frame = DebtFrame(
        resume=Phase.AWAITING_END_TURN,
        debtor=0,
        obligations=(Obligation(creditor=1, amount=100),),
        reason=CashReason.RENT,
    )
    state = make_state(
        seats=seats,
        ruleset=TIMED_UNIVERSAL,
        properties={1: PropertyState(owner=0), 3: PropertyState(owner=0)},
        phase=Phase.DEBT_SETTLEMENT,
        interrupts=(frame,),
        current=0,
    )._replace(elapsed_seconds=TIMED_UNIVERSAL_SECONDS)
    assert endgame.time_is_up(state)

    # 30 of mortgage value: not enough, so the debt stays open and so does the game.
    mid, mid_events = apply(state, MortgageProperty(player=0, tile=1))
    assert mid.phase is Phase.DEBT_SETTLEMENT
    assert not [event for event in mid_events if isinstance(event, GameEnded)]

    final, events = apply(mid, MortgageProperty(player=0, tile=3))  # 30 + 30 >= 100? no
    assert final.phase is Phase.DEBT_SETTLEMENT, "still short, so still no ending"
    assert not [event for event in events if isinstance(event, GameEnded)]

    drained, closing = apply(final, DeclareBankruptcy(player=0))
    assert drained.phase is Phase.GAME_OVER
    ended = _ended(closing)
    # Two players are still solvent, so this is the clock's ending and not a bankruptcy
    # win: the drain merely let the engine finally ask the question.
    assert (ended.reason, ended.winner) == ("time_limit", 1)


def test_a_mortgaged_property_contributes_nothing_to_the_net_worth_that_decides_a_timed_game() -> None:
    """MON-208's valuation decision, made falsifiable: unmortgaged, P0's deed would carry
    the ₪400 that wins the game; pledged, it carries nothing and P1 takes it."""
    seats = (make_player(0, cash=200), make_player(1, cash=300))
    unpledged = make_state(
        seats=seats,
        ruleset=TIMED_UNIVERSAL,
        properties={39: PropertyState(owner=0)},
        phase=Phase.AWAITING_END_TURN,
        current=0,
    )
    _, events = apply(unpledged, EndTurn(player=0, elapsed_seconds=TIMED_UNIVERSAL_SECONDS))
    assert _ended(events).winner == 0, "600 against 300 while the deed counts"

    pledged = make_state(
        seats=seats,
        ruleset=TIMED_UNIVERSAL,
        properties={39: PropertyState(owner=0, mortgaged=True)},
        phase=Phase.AWAITING_END_TURN,
        current=0,
    )
    _, events = apply(pledged, EndTurn(player=0, elapsed_seconds=TIMED_UNIVERSAL_SECONDS))
    ended = _ended(events)
    assert ended.winner == 1, "200 against 300 once the deed is pledged"
    standings = {standing.player: standing.net_worth for standing in ended.final_standings}
    assert standings == {0: 200, 1: 300}


def test_a_timed_game_that_ends_on_the_clock_rejects_every_further_command() -> None:
    state = _timed_table(KIDS)
    over, _ = apply(state, EndTurn(player=0, elapsed_seconds=KIDS_LIMIT_SECONDS))
    assert legal_commands(over) == ()
    try:
        apply(over, RollDice(player=1))
    except IllegalCommandError as error:
        assert error.reason_key == "error.game_over"
    else:  # pragma: no cover - the assertion above is the test
        raise AssertionError("a finished game accepted a command")


# --- final_standings ---------------------------------------------------------


def test_the_elimination_order_decides_second_from_third() -> None:
    """Every bankrupt player is worth zero, so without the elimination order the table
    could not rank them at all (GAP §1 minor). P1 falls second and therefore finishes
    second; P2 fell first and finishes last."""
    seats = (
        make_player(0, cash=900),
        make_player(1, cash=0),
        make_player(2, cash=0, bankrupt=True),
    )
    frame = DebtFrame(
        resume=Phase.AWAITING_END_TURN,
        debtor=1,
        obligations=(Obligation(creditor=0, amount=500),),
        reason=CashReason.RENT,
    )
    state = make_state(
        seats=seats,
        phase=Phase.DEBT_SETTLEMENT,
        interrupts=(frame,),
        current=0,
    )._replace(elimination_order=(2,))

    final, events = apply(state, DeclareBankruptcy(player=1))
    assert final.elimination_order == (2, 1)
    ended = _ended(events)
    assert [(standing.player, standing.rank) for standing in ended.final_standings] == [(0, 1), (1, 2), (2, 3)]
    assert [standing.net_worth for standing in ended.final_standings] == [900, 0, 0]


def test_final_standings_name_every_seat_including_the_bankrupt() -> None:
    """G-B5: a results screen needs no arithmetic of its own, so nobody is left out."""
    seats: tuple[PlayerState, ...] = (
        make_player(0, cash=900),
        make_player(1, cash=100),
        make_player(2, cash=0, bankrupt=True),
    )
    state = make_state(seats=seats, phase=Phase.AWAITING_ROLL, current=0)._replace(elimination_order=(2,))
    standings = endgame.final_standings(state)
    assert [standing.player for standing in standings] == [0, 1, 2]
    assert [standing.rank for standing in standings] == [1, 2, 3]
