"""Jail (MON-205).

Three ways in — the GO_TO_JAIL tile, a card, three consecutive doubles — and three ways
out: the fine, a kept card, or rolling doubles. After ``max_jail_turns`` failed rolls the
fine is compulsory.

The rules implementations get wrong, each with a named test:

* **release by doubles moves the rolled total and grants no further roll.** The roll is
  taken with ``purpose="jail"``, which is what makes ``post_move_phase`` rest the turn
  instead of offering another one, and jail rolls never touch ``doubles_streak`` — so the
  three-doubles rule cannot be triggered from inside the cell (GAP G-12).
* **the compulsory fine still moves the roll, even when it had to be borrowed against the
  estate.** An unaffordable fine opens a ``DebtFrame``; when that settles, the player
  leaves *and walks the total of the roll that failed*
  (:func:`release_after_compulsory_fine`, called by the settlement path). Forfeiting the
  movement was the M1 stopgap, and it was invisible: the player simply stood still.
* **jail is not a pause** (spec §3.6 trap 8). ``JAIL_DECISION`` is a portfolio phase
  (GAP G-5), so a jailed player collects rent, builds and trades; nothing here changes
  that, and that is the point.

A bankrupt player is never left in the cell — the state model refuses it, and the estate
transfer in :mod:`kesef_engine.rules.insolvency` clears the flag with the rest.
"""

from __future__ import annotations

from kesef_engine.commands import PayJailFine, RollForJail, UseJailCard
from kesef_engine.decks import GET_OUT_OF_JAIL_IDS
from kesef_engine.events import Event, LeftJail
from kesef_engine.phases import Phase
from kesef_engine.primitives import CashReason, Deck, PlayerId
from kesef_engine.rules import movement, tiles
from kesef_engine.rules.cash import move_cash
from kesef_engine.rules.common import update_player
from kesef_engine.rules.insolvency import open_debt
from kesef_engine.state import GameState


def handle_pay_fine(state: GameState, command: PayJailFine) -> tuple[GameState, tuple[Event, ...]]:
    state, paid = move_cash(
        state,
        source=command.player,
        dest=tiles.pot_or_bank(state.ruleset),
        amount=state.ruleset.jail_fine,
        reason=CashReason.JAIL_FINE,
    )
    state = _release(state, command.player)
    return state._replace(phase=Phase.AWAITING_ROLL), (*paid, LeftJail(player=command.player, via="fine"))


def handle_use_card(state: GameState, command: UseJailCard) -> tuple[GameState, tuple[Event, ...]]:
    player = state.player(command.player)
    card = player.jail_cards[0]  # deterministic: the earliest-held card is spent first
    state = update_player(state, command.player, jail_cards=player.jail_cards[1:])
    state = _return_card(state, card)
    state = _release(state, command.player)
    return state._replace(phase=Phase.AWAITING_ROLL), (LeftJail(player=command.player, via="card"),)


def handle_roll_for_jail(state: GameState, command: RollForJail) -> tuple[GameState, tuple[Event, ...]]:
    player_id = command.player
    # A jail roll never changes the doubles streak (GAP G-12).
    state, dice, events = movement.roll(state, player_id, purpose="jail", doubles_streak=state.doubles_streak)
    all_events = list(events)
    if dice.is_doubles:
        state = _release(state, player_id)
        all_events.append(LeftJail(player=player_id, via="doubles"))
        return _move_out(state, player_id, dice.total, all_events)

    jail_turns = state.player(player_id).jail_turns + 1
    state = update_player(state, player_id, jail_turns=jail_turns)
    if jail_turns < state.ruleset.max_jail_turns:
        return state._replace(phase=Phase.AWAITING_END_TURN), tuple(all_events)

    # The fine is now compulsory; the official rule then moves the failed roll's total.
    fine = state.ruleset.jail_fine
    if state.player(player_id).cash < fine:
        # The debt settles itself the moment the estate raises the money, and
        # ``release_after_compulsory_fine`` then walks this roll — the dice survive in
        # ``state.dice``, which is why no continuation has to be stored on the frame.
        state, incurred = open_debt(
            state,
            debtor=player_id,
            creditor="bank",
            amount=fine,
            reason=CashReason.JAIL_FINE,
            resume=Phase.AWAITING_END_TURN,
        )
        return state, (*all_events, *incurred)
    state, paid = move_cash(
        state, source=player_id, dest=tiles.pot_or_bank(state.ruleset), amount=fine, reason=CashReason.JAIL_FINE
    )
    all_events.extend(paid)
    state = _release(state, player_id)
    all_events.append(LeftJail(player=player_id, via="time_served"))
    return _move_out(state, player_id, dice.total, all_events)


def release_after_compulsory_fine(state: GameState, player_id: PlayerId) -> tuple[GameState, tuple[Event, ...]]:
    """Leave the cell once a borrowed-against compulsory fine has been settled.

    Called by :func:`kesef_engine.rules.insolvency.settle_if_able`, which is the only place
    that knows the debt is paid. The roll that failed is still in ``state.dice`` (nothing
    rolls between the failure and the settlement — legality offers the debtor raising
    commands only), so the movement it earned is not lost.

    A ``JAIL_FINE`` debt with no roll behind it cannot arise in play for exactly that
    reason, but it is *representable*, and a state model that admits a shape owes the
    reducer a definition for it: ``apply`` answers its caller with a result or an
    ``IllegalCommandError``, never an ``AssertionError`` (ADR-005). With no roll to walk,
    the player simply leaves the cell and the popped debt's resume phase stands.
    """
    dice = state.dice
    state = _release(state, player_id)
    released = LeftJail(player=player_id, via="time_served")
    if dice is None:
        return state, (released,)
    return _move_out(state, player_id, dice.total, [released])


def _move_out(
    state: GameState, player_id: PlayerId, total: int, events: list[Event]
) -> tuple[GameState, tuple[Event, ...]]:
    """Leave the cell and walk the rolled total. ``purpose == "jail"`` means the landing
    resolves to AWAITING_END_TURN — release never grants another roll (GAP G-12)."""
    state, moved = movement.move_token(state, player_id, total)
    events.extend(moved)
    state, resolved = tiles.resolve_landing(state, player_id)
    events.extend(resolved)
    return state, tuple(events)


def _release(state: GameState, player_id: PlayerId) -> GameState:
    return update_player(state, player_id, in_jail=False, jail_turns=0)


def _return_card(state: GameState, card: Deck) -> GameState:
    """A spent jail card returns to the bottom of its own deck (GAP G-11)."""
    return state.deck_bottom(card, GET_OUT_OF_JAIL_IDS[card])
