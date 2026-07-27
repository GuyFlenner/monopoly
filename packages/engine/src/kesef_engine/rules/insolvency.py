"""Debts and bankruptcy (opened in M1; MON-207 owns the full settlement machinery).

The model is shortfall-as-data (GAP G-18): cash never goes negative — what cannot be
paid becomes a :class:`~kesef_engine.state.DebtFrame`, and settlement happens *the moment
the debtor's cash covers the total*, automatically, after every command. There is no
PayDebt command: raising the money is the player's move; paying it is not optional.

M1 scope, per the backlog re-point: ``DeclareBankruptcy`` fully applies for what a
winnable two-player game needs. TODO(MON-207): partial/multi-creditor settlement in turn
order, proportional estate division, the 10% mortgage-transfer fee, the bank's queued
estate auction, and cascade resolution.
"""

from __future__ import annotations

from typing import Literal

from kesef_engine.commands import DeclareBankruptcy
from kesef_engine.decks import GET_OUT_OF_JAIL_IDS
from kesef_engine.events import BuildingChanged, DebtIncurred, DebtSettled, Event, LeftJail, PlayerBankrupted
from kesef_engine.phases import Phase
from kesef_engine.primitives import CashReason, Deck, PlayerId, TileIndex
from kesef_engine.rules import endgame, turns
from kesef_engine.rules.cash import move_cash
from kesef_engine.rules.common import update_player, update_property
from kesef_engine.state import DebtFrame, GameState, Obligation


def open_debt(
    state: GameState,
    *,
    debtor: PlayerId,
    creditor: PlayerId | Literal["bank"],
    amount: int,
    reason: CashReason,
    source_tile: TileIndex | None = None,
    resume: Phase,
) -> tuple[GameState, tuple[Event, ...]]:
    """Suspend play into DEBT_SETTLEMENT. ``resume`` is where play continues once paid."""
    obligation = Obligation(creditor=creditor, amount=amount)
    frame = DebtFrame(resume=resume, debtor=debtor, obligations=(obligation,), reason=reason, source_tile=source_tile)
    state = state._replace(phase=resume).push_interrupt(frame)
    return state, (DebtIncurred(debtor=debtor, creditor=obligation.creditor, amount=amount),)


def settle_if_able(state: GameState) -> tuple[GameState, tuple[Event, ...]]:
    """Pay the live debt in full the moment the debtor's cash covers it.

    Runs after every command (the reducer calls it centrally), so a mortgage, a sale or
    an accepted trade settles the debt without a further command. M1 settles all-or-
    nothing; TODO(MON-207): partial settlement per obligation in turn order.
    """
    frame = state.top_interrupt
    if state.phase is not Phase.DEBT_SETTLEMENT or not isinstance(frame, DebtFrame):
        return state, ()
    if state.player(frame.debtor).cash < frame.total:
        return state, ()
    state = state.pop_interrupt()
    events: list[Event] = []
    for obligation in frame.obligations:
        state, paid = move_cash(
            state, source=frame.debtor, dest=obligation.creditor, amount=obligation.amount, reason=frame.reason
        )
        events.extend(paid)
        events.append(DebtSettled(debtor=frame.debtor, creditor=obligation.creditor, amount=obligation.amount))
    if frame.reason is CashReason.JAIL_FINE and state.player(frame.debtor).in_jail:
        # TODO(MON-205): the compulsory-fine roll's movement is forfeit in M1.
        state = update_player(state, frame.debtor, in_jail=False, jail_turns=0)
        events.append(LeftJail(player=frame.debtor, via="fine"))
    return state, tuple(events)


def handle_declare_bankruptcy(state: GameState, command: DeclareBankruptcy) -> tuple[GameState, tuple[Event, ...]]:
    """The debtor concedes. Buildings liquidate to the bank at half price (the official
    rule); the estate then transfers whole to a single creditor, or to the bank.
    """
    frame = state.top_interrupt
    assert isinstance(frame, DebtFrame)  # is_legal proved it
    debtor_id = frame.debtor
    events: list[Event] = []

    # 1. Buildings are sold to the bank at half price; the proceeds join the estate.
    for tile_index in state.tiles_owned_by(debtor_id):
        prop = state.properties[tile_index]
        if prop.houses:
            tile = state.board.tile(tile_index)
            refund = prop.houses * (tile.house_cost or 0) // 2
            state = update_property(state, tile_index, houses=0)
            events.append(BuildingChanged(tile=tile_index, houses=0, delta=-prop.houses))
            state, paid = move_cash(
                state, source="bank", dest=debtor_id, amount=refund, reason=CashReason.SELL_BUILDING
            )
            events.extend(paid)

    # 2. The estate transfers. A single player creditor takes everything (MON-207);
    #    otherwise the bank path applies. TODO(MON-207): proportional multi-creditor
    #    division and the bank's queued estate auction — M1 returns tiles to the bank.
    debtor = state.player(debtor_id)
    tiles_transferred = state.tiles_owned_by(debtor_id)
    cash_transferred = debtor.cash
    cards_transferred = debtor.jail_cards
    sole_creditor = frame.obligations[0].creditor if len(frame.obligations) == 1 else "bank"

    if isinstance(sole_creditor, int):
        state, paid = move_cash(
            state, source=debtor_id, dest=sole_creditor, amount=cash_transferred, reason=CashReason.BANKRUPTCY_TRANSFER
        )
        events.extend(paid)
        for tile_index in tiles_transferred:
            # Mortgaged tiles transfer with their obligation. TODO(MON-207): the 10%
            # mortgage-transfer fee (owner decision 2) is not charged in M1.
            state = update_property(state, tile_index, owner=sole_creditor)
        state = update_player(state, debtor_id, jail_cards=())  # release before the creditor takes them
        creditor_state = state.player(sole_creditor)
        state = update_player(state, sole_creditor, jail_cards=creditor_state.jail_cards + cards_transferred)
    else:
        state, paid = move_cash(
            state, source=debtor_id, dest="bank", amount=cash_transferred, reason=CashReason.BANKRUPTCY_TRANSFER
        )
        events.extend(paid)
        for tile_index in tiles_transferred:
            state = update_property(state, tile_index, owner=None, mortgaged=False)
        state = _return_jail_cards(state, debtor_id, cards_transferred)

    events.append(
        PlayerBankrupted(
            player=debtor_id,
            creditor=sole_creditor,
            tiles_transferred=tiles_transferred,
            cash_transferred=cash_transferred,
            jail_cards_transferred=cards_transferred,
        )
    )

    # 3. The debtor leaves the game holding nothing (state invariant: bankrupt => free).
    #    Cash is *not* zeroed here: the whole balance already moved through move_cash above,
    #    which is the only writer of cash (the ledger rule, G-60).
    state = update_player(state, debtor_id, bankrupt=True, in_jail=False, jail_turns=0, jail_cards=())
    state = state._replace(elimination_order=(*state.elimination_order, debtor_id))
    state = state.pop_interrupt()

    # 4. Endgame evaluates only after the interrupts drain (GAP G-8), then the seat
    #    moves on if the bankrupt player still held it.
    state, ended = endgame.maybe_end(state)
    events.extend(ended)
    if state.phase is not Phase.GAME_OVER and state.player(state.current_player_id).bankrupt:
        state, started = turns.advance_turn(state)
        events.extend(started)
    return state, tuple(events)


def _return_jail_cards(state: GameState, holder: PlayerId, cards: tuple[Deck, ...]) -> GameState:
    """Jail cards go to the bottoms of their own decks (GAP G-11)."""
    state = update_player(state, holder, jail_cards=())
    for card in cards:
        if card is Deck.CHANCE:
            state = state._replace(chance_deck=(*state.chance_deck, GET_OUT_OF_JAIL_IDS[card]))
        else:
            state = state._replace(community_chest_deck=(*state.community_chest_deck, GET_OUT_OF_JAIL_IDS[card]))
    return state
