"""Trading (M1 slice; MON-204 owns the full rule set).

``ProposeTrade`` is validated by :func:`kesef_engine.legality.is_legal` (never
enumerated — ADR-005's second exception), so these handlers only enact. TRADE_REVIEW
admits nothing but respond/cancel, so the table cannot change under a pending offer in
M1. TODO(MON-207): the 10% mortgage-transfer fee when a mortgaged tile changes hands.
"""

from __future__ import annotations

from kesef_engine.commands import CancelTrade, ProposeTrade, RespondToTrade, TradeOffer, TradeSide
from kesef_engine.events import Event, TradeCancelled, TradeDeclined, TradeExecuted, TradeProposed
from kesef_engine.legality import _trade_side
from kesef_engine.primitives import CashReason, PlayerId
from kesef_engine.rules.cash import move_cash
from kesef_engine.rules.common import update_player, update_property
from kesef_engine.state import GameState, TradeFrame


def handle_propose(state: GameState, command: ProposeTrade) -> tuple[GameState, tuple[Event, ...]]:
    frame = TradeFrame(resume=state.phase, offer=command.offer)
    return state.push_interrupt(frame), (TradeProposed(offer=command.offer),)


def handle_respond(state: GameState, command: RespondToTrade) -> tuple[GameState, tuple[Event, ...]]:
    frame = state.top_interrupt
    assert isinstance(frame, TradeFrame)  # is_legal proved it
    offer = frame.offer
    state = state.pop_interrupt()
    if not command.accept:
        return state, (TradeDeclined(offer=offer),)
    if not _still_deliverable(state, offer):
        # A named holding changed hands before the recipient answered: the engine
        # voids the offer rather than executing a swap a party can no longer honour.
        return state, (TradeCancelled(offer=offer, by="system"),)
    events: list[Event] = []
    state = _transfer_side(state, offer.proposer, offer.recipient, offer.give, events)
    state = _transfer_side(state, offer.recipient, offer.proposer, offer.receive, events)
    events.append(TradeExecuted(offer=offer))
    return state, tuple(events)


def handle_cancel(state: GameState, command: CancelTrade) -> tuple[GameState, tuple[Event, ...]]:
    frame = state.top_interrupt
    assert isinstance(frame, TradeFrame)  # is_legal proved it
    return state.pop_interrupt(), (TradeCancelled(offer=frame.offer, by="proposer"),)


def _still_deliverable(state: GameState, offer: TradeOffer) -> bool:
    """Both parties still hold what the offer moves — checked through the same
    predicate ``is_legal`` used at proposal time (one source of truth, ADR-005)."""
    give_ok = _trade_side(state, state.player(offer.proposer), offer.give)
    receive_ok = _trade_side(state, state.player(offer.recipient), offer.receive)
    return bool(give_ok) and bool(receive_ok)


def _transfer_side(
    state: GameState, giver: PlayerId, taker: PlayerId, side: TradeSide, events: list[Event]
) -> GameState:
    """One half of the swap. Both halves run before anyone observes the state, so the
    trade is atomic: either command succeeds whole or apply raised before touching it."""
    state, paid = move_cash(state, source=giver, dest=taker, amount=side.cash, reason=CashReason.TRADE)
    events.extend(paid)
    for tile_index in side.tiles:
        state = update_property(state, tile_index, owner=taker)
    if side.jail_cards:
        giver_cards = tuple(card for card in state.player(giver).jail_cards if card not in side.jail_cards)
        state = update_player(state, giver, jail_cards=giver_cards)
        state = update_player(state, taker, jail_cards=(*state.player(taker).jail_cards, *side.jail_cards))
    return state
