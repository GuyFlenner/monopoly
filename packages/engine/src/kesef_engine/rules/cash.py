"""The cash ledger — the only door money moves through (MON-102, GAP G-60).

Every change to any player's cash is exactly one :class:`~kesef_engine.events.CashChanged`
per player endpoint, carrying the delta, the resulting balance and the counterparty.
No other event moves money: ``RentCharged`` is narration alongside the ledger entry,
never the ledger entry. The money-conservation invariant (MON-209) audits this stream,
which is why the Free Parking pot is a named party rather than a bank alias.
"""

from __future__ import annotations

from typing import Literal

from kesef_engine.events import CashChanged, Event
from kesef_engine.primitives import CashReason, PlayerId
from kesef_engine.rules.common import update_player
from kesef_engine.state import GameState

Party = PlayerId | Literal["bank", "free_parking_pot"]


def move_cash(
    state: GameState, *, source: Party, dest: Party, amount: int, reason: CashReason
) -> tuple[GameState, tuple[Event, ...]]:
    """Move ``amount`` from ``source`` to ``dest``, emitting one ledger entry per player.

    The caller (legality, or the debt machinery) guarantees the payer can pay; a negative
    balance here is a bug and the state model's ``ge=0`` makes it loud. A zero amount is
    a no-op with no events — the ledger records movements, not non-events.
    """
    if amount < 0:
        raise ValueError("move_cash amount must be non-negative")
    if amount == 0:
        return state, ()
    events: list[Event] = []
    if isinstance(source, int):
        balance = state.player(source).cash - amount
        state = update_player(state, source, cash=balance)
        events.append(CashChanged(player=source, delta=-amount, reason=reason, balance=balance, counterparty=dest))
    elif source == "free_parking_pot":
        state = state._replace(free_parking_pot=state.free_parking_pot - amount)
    if isinstance(dest, int):
        balance = state.player(dest).cash + amount
        state = update_player(state, dest, cash=balance)
        events.append(CashChanged(player=dest, delta=amount, reason=reason, balance=balance, counterparty=source))
    elif dest == "free_parking_pot":
        state = state._replace(free_parking_pot=state.free_parking_pot + amount)
    return state, tuple(events)
