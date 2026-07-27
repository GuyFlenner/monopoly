"""Jail decisions (M1 slice; MON-205 owns the full rule set).

What lands now: pay the fine, spend a card, roll for doubles, the compulsory fine after
``max_jail_turns``. The commonly mis-implemented rule is named and tested: release by
doubles moves the rolled total and does NOT grant another roll, and jail rolls never
touch ``doubles_streak`` (GAP G-12).
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
        # TODO(MON-205): settling this debt releases without moving (see insolvency).
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
    if card is Deck.CHANCE:
        return state._replace(chance_deck=(*state.chance_deck, GET_OUT_OF_JAIL_IDS[card]))
    return state._replace(community_chest_deck=(*state.community_chest_deck, GET_OUT_OF_JAIL_IDS[card]))
