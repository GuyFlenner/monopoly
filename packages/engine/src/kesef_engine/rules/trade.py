"""Trading (MON-204).

Cash, properties and jail cards, either way, between any two solvent players. Four things
here are worth reading before changing anything:

**Nothing is validated twice.** ``ProposeTrade`` is checked by
:func:`kesef_engine.legality.is_legal` (never enumerated — ADR-005's second exception), and
the re-check at acceptance time goes back through the *same* predicate,
:func:`~kesef_engine.legality._trade_side`. Duplicating "do they still own it?" here is how
legality and effect drift apart, and the group-carrying-buildings veto is the case that
would drift first.

**The swap is atomic.** Deliverability is settled for *both* sides before a single tile or
coin moves, so a failed leg cannot leave a half-swap behind. And because ``apply`` returns a
new state, a raise leaves the caller's state untouched by construction.

**A stale offer is voided, not rejected.** If a named holding is no longer there when the
recipient answers — a party went bankrupt (MON-207), or a save file outlived the table — the
engine emits ``TradeCancelled(by="system")``. Making it a legality rejection instead would
strand the recipient in a phase whose only commands all refuse to run.

**Mortgaged tiles travel with their obligation, and the receiver pays for the privilege.**
10% at transfer, and the same 10% again on lifting: the official dual fee (owner decision 2,
GAP §7), computed by :func:`kesef_engine.rules.mortgage.transfer_fee`. That charge can
exceed the receiver's cash, in which case it opens a nested ``DebtFrame`` on them — the
shape ADR-007 exists for. Settling that debt is MON-207's; shaping it correctly is here.
"""

from __future__ import annotations

from kesef_engine.commands import CancelTrade, ProposeTrade, RespondToTrade, TradeOffer, TradeSide
from kesef_engine.events import Event, TradeCancelled, TradeDeclined, TradeExecuted, TradeProposed
from kesef_engine.legality import _trade_side
from kesef_engine.primitives import CashReason, PlayerId
from kesef_engine.rules import insolvency, mortgage
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
    state, charged = _charge_transfer_fees(state, offer)
    events.extend(charged)
    return state, tuple(events)


def handle_cancel(state: GameState, command: CancelTrade) -> tuple[GameState, tuple[Event, ...]]:
    frame = state.top_interrupt
    assert isinstance(frame, TradeFrame)  # is_legal proved it
    return state.pop_interrupt(), (TradeCancelled(offer=frame.offer, by="proposer"),)


def _still_deliverable(state: GameState, offer: TradeOffer) -> bool:
    """Both parties are still at the table and still hold what the offer moves.

    Checked through the same predicate ``is_legal`` used at proposal time (one source of
    truth, ADR-005), plus solvency: a bankrupt party's estate has already been settled
    elsewhere, so their side of a pending offer is undeliverable by definition. That is also
    what keeps the transfer fee below from ever opening a debt on a player who has left the
    game (MON-207 owns the other half of the same rule — voiding at bankruptcy time).
    """
    proposer = state.player(offer.proposer)
    recipient = state.player(offer.recipient)
    if proposer.bankrupt or recipient.bankrupt:
        return False
    give_ok = _trade_side(state, proposer, offer.give)
    receive_ok = _trade_side(state, recipient, offer.receive)
    return bool(give_ok) and bool(receive_ok)


def _transfer_side(
    state: GameState, giver: PlayerId, taker: PlayerId, side: TradeSide, events: list[Event]
) -> GameState:
    """One half of the swap. ``_still_deliverable`` has already cleared *both* halves, so
    neither leg can fail here and no partial state is ever observable."""
    state, paid = move_cash(state, source=giver, dest=taker, amount=side.cash, reason=CashReason.TRADE)
    events.extend(paid)
    for tile_index in side.tiles:
        # Ownership moves; ``mortgaged`` is deliberately left alone — the obligation is part
        # of what the receiver accepted, and the fee below is what it costs them.
        state = update_property(state, tile_index, owner=taker)
    if side.jail_cards:
        giver_cards = tuple(card for card in state.player(giver).jail_cards if card not in side.jail_cards)
        state = update_player(state, giver, jail_cards=giver_cards)
        state = update_player(state, taker, jail_cards=(*state.player(taker).jail_cards, *side.jail_cards))
    return state


def _charge_transfer_fees(state: GameState, offer: TradeOffer) -> tuple[GameState, tuple[Event, ...]]:
    """The official dual mortgage fee, charged to whoever *received* a mortgaged tile.

    Both receivers are handled, in a fixed order (the recipient's intake first, then the
    proposer's) so the ledger is deterministic; each pays one aggregate fee for the
    mortgaged tiles they took. This runs after both legs precisely so that the swap itself
    stays atomic — the fee is a consequence of a completed trade, never a condition of it.
    A receiver whose cash falls short opens a nested ``DebtFrame`` rather than going negative
    (shortfall-as-data, G-18), suspending the phase the trade has already resumed into, so
    the frame's ``resume`` is where play continues once the fee is paid.
    """
    events: list[Event] = []
    for receiver, side in ((offer.recipient, offer.give), (offer.proposer, offer.receive)):
        mortgaged = tuple(index for index in sorted(side.tiles) if state.properties[index].mortgaged)
        fee = sum(mortgage.transfer_fee(state.board.tile(index)) for index in mortgaged)
        if not fee:
            continue
        if state.player(receiver).cash >= fee:
            state, paid = move_cash(
                state, source=receiver, dest="bank", amount=fee, reason=CashReason.MORTGAGE_TRANSFER_FEE
            )
            events.extend(paid)
        else:
            state, incurred = insolvency.open_debt(
                state,
                debtor=receiver,
                creditor="bank",
                amount=fee,
                reason=CashReason.MORTGAGE_TRANSFER_FEE,
                source_tile=mortgaged[0],
                resume=state.phase,
            )
            events.extend(incurred)
    return state, tuple(events)
