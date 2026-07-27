"""Rent (MON-104). The single most-often-wrong area, so every branch is a named test.

The traps, by name: undeveloped rent doubles on a full group (spec §3.6 trap 1); a
mortgaged property charges nothing but still counts toward completion (trap 2); utility
rent is a *multiple of the dice*, rolled specifically for the rent when a card delivers
the player (trap 9). ``RentCharged`` is narration — the money moves in ``CashChanged``,
or waits in a ``DebtFrame`` when it cannot.
"""

from __future__ import annotations

from kesef_engine.board.models import Tile, TileKind
from kesef_engine.events import Event, RentCharged
from kesef_engine.phases import Phase
from kesef_engine.primitives import CashReason, PlayerId, TileIndex
from kesef_engine.rules.cash import move_cash
from kesef_engine.rules.common import post_move_phase
from kesef_engine.rules.insolvency import open_debt
from kesef_engine.state import GameState


def charge(
    state: GameState, payer_id: PlayerId, tile_index: TileIndex, *, roll_for_amount: bool = False
) -> tuple[GameState, tuple[Event, ...]]:
    """Charge ``payer_id`` for standing on ``tile_index``, or open a debt.

    Returns a state resting in its final phase. ``roll_for_amount`` is the card-arrival
    hook (MON-206): a fresh ``purpose="rent"`` roll prices a utility instead of the roll
    that moved the token.
    """
    tile = state.board.tile(tile_index)
    prop = state.properties[tile_index]
    owner = prop.owner
    events: list[Event] = []
    # Computed *before* any rent roll and carried through: a ``purpose="rent"`` roll must
    # not decide where the turn rests, or a doubles arrival on a utility would silently
    # forfeit the extra roll it earned (GAP G-10).
    resting = post_move_phase(state, payer_id)
    if owner is None or owner == payer_id or prop.mortgaged or state.player(owner).bankrupt:
        # Trap 2 (mortgaged), plus: nobody pays themselves, and a bankrupt owner's
        # tiles charge nothing while awaiting MON-207's estate handling.
        return state._replace(phase=resting), ()

    if tile.kind is TileKind.UTILITY:
        if roll_for_amount or state.dice is None:
            # Trap 9: a card sends the player here, so the roll is made for the rent —
            # and never feeds the doubles streak (GAP G-10).
            from kesef_engine.rules import movement  # local: movement imports tiles imports rent

            state, dice, rolled = movement.roll(state, payer_id, purpose="rent", doubles_streak=state.doubles_streak)
            events.extend(rolled)
            dice_total = dice.total
        else:
            dice_total = state.dice.total
        multiplier = tile.rent[state.count_of_kind_owned(owner, TileKind.UTILITY) - 1]
        rent = RentCharged(
            payer=payer_id,
            owner=owner,
            tile=tile_index,
            amount=multiplier * dice_total,
            base_rent=dice_total,
            multiplier=multiplier,
            dice_total=dice_total,
            note_keys=("rent.note.utility_multiplier",),
            note_params={"multiplier": multiplier, "dice_total": dice_total},
        )
    elif tile.kind is TileKind.RAILROAD:
        count = state.count_of_kind_owned(owner, TileKind.RAILROAD)
        amount = tile.rent[count - 1]  # 25 / 50 / 100 / 200
        rent = RentCharged(
            payer=payer_id,
            owner=owner,
            tile=tile_index,
            amount=amount,
            base_rent=amount,
            note_keys=("rent.note.railroad_count",),
            note_params={"count": count},
        )
    else:
        rent = _property_rent(state, payer_id, tile, owner)

    events.append(rent)
    return _settle(state, rent, events, resting=resting)


def _property_rent(state: GameState, payer_id: PlayerId, tile: Tile, owner: PlayerId) -> RentCharged:
    prop = state.properties[tile.index]
    base = tile.rent[prop.houses]
    multiplier = 1
    note_keys: tuple[str, ...] = ()
    group = tile.group
    assert group is not None  # a PROPERTY tile always carries one
    if prop.houses == 0 and state.owns_whole_group(owner, group):
        # Trap 1. Mortgaged siblings still complete the group (trap 2's second half):
        # owns_whole_group reads ownership, not mortgage flags.
        multiplier = 2
        note_keys = ("rent.note.full_group_doubled",)
    return RentCharged(
        payer=payer_id,
        owner=owner,
        tile=tile.index,
        amount=base * multiplier,
        base_rent=base,
        houses=prop.houses,
        multiplier=multiplier,
        group=group,
        note_keys=note_keys,
        note_params={"group": group.value} if note_keys else {},
    )


def _settle(
    state: GameState, rent: RentCharged, events: list[Event], *, resting: Phase
) -> tuple[GameState, tuple[Event, ...]]:
    """``resting`` is ``charge``'s pre-roll verdict, passed in rather than recomputed: the
    same concept derived twice from different states is how the doubles re-roll got lost."""
    if state.player(rent.payer).cash < rent.amount:
        state, incurred = open_debt(
            state,
            debtor=rent.payer,
            creditor=rent.owner,
            amount=rent.amount,
            reason=CashReason.RENT,
            source_tile=rent.tile,
            resume=resting,
        )
        return state, (*events, *incurred)
    state, paid = move_cash(state, source=rent.payer, dest=rent.owner, amount=rent.amount, reason=CashReason.RENT)
    return state._replace(phase=resting), (*events, *paid)
