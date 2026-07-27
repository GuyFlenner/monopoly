"""The reducer — the engine's single entry point for change.

    state, events = apply(state, command)

Pure: no I/O, no mutation, no globals. Given the same state and command you get the same
result, every time, on every machine.

Legality is decided by :func:`kesef_engine.legality.is_legal` — the reducer never
re-derives a predicate (ADR-005: one source of truth), it only *enacts* approved
commands. Dispatch is phase-first, command-kind second, because the phase decides which
commands even exist; the rule bodies live in ``kesef_engine/rules/``, one module per
area, so "where is rent calculated" has exactly one answer.
"""

from __future__ import annotations

from kesef_engine.commands import (
    BuildHouse,
    BuyProperty,
    CancelTrade,
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
    UnmortgageProperty,
    UseJailCard,
    WithdrawFromAuction,
)
from kesef_engine.errors import IllegalCommandError
from kesef_engine.events import Event, PhaseChanged
from kesef_engine.legality import is_legal
from kesef_engine.phases import TRANSIENT_PHASES, Phase
from kesef_engine.rules import auction, development, insolvency, jail, mortgage, movement, purchase, trade, turns
from kesef_engine.state import GameState


def apply(state: GameState, command: Command) -> tuple[GameState, tuple[Event, ...]]:
    """Apply one command, returning the resulting state and the events it produced.

    Raises:
        IllegalCommandError: with :func:`~kesef_engine.legality.is_legal`'s
            ``reason_key`` and params, when the command is not legal in ``state``.
            Callers that drive the UI from ``legal_commands`` never see this.

    Transient phases (:data:`kesef_engine.phases.TRANSIENT_PHASES`) resolve to completion
    before returning, and a debt whose total the debtor's cash now covers settles
    automatically — so the returned state always rests where a player must act next.
    A single trailing ``PhaseChanged`` narrates the entry-to-rest transition.
    """
    verdict = is_legal(state, command)
    if not verdict.legal:
        assert verdict.reason_key is not None  # the LegalityResult validator guarantees it
        raise IllegalCommandError(verdict.reason_key, **verdict.params)

    entry_phase = state.phase
    new_state, events = _dispatch(state, command)
    new_state, settled = insolvency.settle_if_able(new_state)
    all_events = [*events, *settled]
    if new_state.phase is not entry_phase:
        all_events.append(PhaseChanged(previous=entry_phase, current=new_state.phase))
    assert new_state.phase not in TRANSIENT_PHASES  # the contract: callers never rest here
    return new_state, tuple(all_events)


def apply_all(state: GameState, commands: tuple[Command, ...]) -> tuple[GameState, tuple[Event, ...]]:
    """Fold a sequence of commands. The basis of the golden-game regression tests."""
    events: list[Event] = []
    for command in commands:
        state, produced = apply(state, command)
        events.extend(produced)
    return state, tuple(events)


def _dispatch(state: GameState, command: Command) -> tuple[GameState, tuple[Event, ...]]:
    match state.phase:
        case Phase.AWAITING_ROLL | Phase.JAIL_DECISION | Phase.AWAITING_END_TURN:
            return _quiet_phase(state, command)
        case Phase.AWAITING_PURCHASE_DECISION:
            return purchase.decide(state, command)
        case Phase.AUCTION:
            return auction.act(state, command)
        case Phase.DEBT_SETTLEMENT:
            return _debt_settlement(state, command)
        case Phase.TRADE_REVIEW:
            return _trade_review(state, command)
        case _:  # pragma: no cover - is_legal rejects GAME_OVER; transients never rest
            raise AssertionError(f"is_legal admitted {command.kind!r} in phase {state.phase}")


def _quiet_phase(state: GameState, command: Command) -> tuple[GameState, tuple[Event, ...]]:
    """The portfolio phases: the current player's turn commands, plus any solvent
    player's portfolio commands (the MON-204 design decision)."""
    match command:
        case RollDice():
            return movement.handle_roll_dice(state, command)
        case EndTurn():
            return turns.handle_end_turn(state, command)
        case PayJailFine():
            return jail.handle_pay_fine(state, command)
        case UseJailCard():
            return jail.handle_use_card(state, command)
        case RollForJail():
            return jail.handle_roll_for_jail(state, command)
        case _:
            return _portfolio(state, command)


def _debt_settlement(state: GameState, command: Command) -> tuple[GameState, tuple[Event, ...]]:
    match command:
        case DeclareBankruptcy():
            return insolvency.handle_declare_bankruptcy(state, command)
        case _:
            return _portfolio(state, command)  # the RAISING kinds; is_legal gated them


def _trade_review(state: GameState, command: Command) -> tuple[GameState, tuple[Event, ...]]:
    match command:
        case RespondToTrade():
            return trade.handle_respond(state, command)
        case CancelTrade():
            return trade.handle_cancel(state, command)
        case _:  # pragma: no cover - is_legal admits nothing else in TRADE_REVIEW
            raise AssertionError(f"is_legal admitted {command.kind!r} in TRADE_REVIEW")


def _portfolio(state: GameState, command: Command) -> tuple[GameState, tuple[Event, ...]]:
    match command:
        case BuildHouse():
            return development.handle_build(state, command)
        case SellHouse():
            return development.handle_sell(state, command)
        case MortgageProperty():
            return mortgage.handle_mortgage(state, command)
        case UnmortgageProperty():
            return mortgage.handle_unmortgage(state, command)
        case ProposeTrade():
            return trade.handle_propose(state, command)
        case BuyProperty() | DeclinePurchase() | PlaceBid() | WithdrawFromAuction():  # pragma: no cover
            raise AssertionError(f"{command.kind!r} outside its phase slipped past is_legal")
        case _:  # pragma: no cover - the union is closed
            raise AssertionError(f"unhandled command {command.kind!r} in phase {state.phase}")
