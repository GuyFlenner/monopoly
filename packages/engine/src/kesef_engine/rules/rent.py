"""Rent (MON-104). The single most-often-wrong area, so every branch is a named test.

The traps, by name: undeveloped rent doubles on a full group (spec §3.6 trap 1); a
mortgaged property charges nothing but still counts toward completion (trap 2); utility
rent is a *multiple of the dice*, rolled specifically for the rent when a card delivers
the player (trap 9). ``RentCharged`` is narration — the money moves in ``CashChanged``,
or waits in a ``DebtFrame`` when it cannot.
"""

from __future__ import annotations

from kesef_engine.board.models import Tile, TileKind
from kesef_engine.events import Event, RentCharged, RentQuote
from kesef_engine.phases import Phase
from kesef_engine.primitives import CashReason, PlayerId, TileIndex
from kesef_engine.rules.cash import move_cash
from kesef_engine.rules.common import post_move_phase
from kesef_engine.rules.insolvency import open_debt
from kesef_engine.state import HOTEL_LEVEL, GameState


def charge(
    state: GameState,
    payer_id: PlayerId,
    tile_index: TileIndex,
    *,
    roll_for_amount: bool = False,
    card_doubles_rent: bool = False,
    utility_multiplier: int | None = None,
) -> tuple[GameState, tuple[Event, ...]]:
    """Charge ``payer_id`` for standing on ``tile_index``, or open a debt.

    Returns a state resting in its final phase. The three keyword arguments are the
    card-arrival hooks (MON-206), and none of them changes what an ordinary landing charges:

    * ``roll_for_amount`` prices a utility from a fresh ``purpose="rent"`` roll instead of the
      roll that moved the token (trap 9);
    * ``card_doubles_rent`` is the "pay twice the rental" clause the nearest-railroad card
      carries;
    * ``utility_multiplier`` replaces the *tier* — an ordinary landing charges 4× the throw for
      one utility held and 10× for both, while the printed "advance to the nearest utility"
      card charges 10× regardless of how many the owner holds. Two different official rules
      for one tile, and the card names its number, so the number travels with the card
      (``AdvanceToNearestUtility.multiplier``) rather than being re-derived here.
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
        #
        # That last clause is belt-and-braces against a hand-built save, not doubt about the
        # invariant: ``handle_declare_bankruptcy`` reassigns every deed before it marks the
        # seat, so in a played game a bankrupt player owns nothing and this arm is dead code.
        # It stays because ``owner`` comes from a loaded file, and charging rent to a ghost is
        # a worse failure than one redundant comparison.
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
        by_tier = tile.rent[state.count_of_kind_owned(owner, TileKind.UTILITY) - 1]
        multiplier = by_tier if utility_multiplier is None else utility_multiplier
        # The explanation has to say *which* rule produced the figure, or a child asking "why
        # ten times when he only owns one?" gets an answer that is simply wrong.
        note = "rent.note.utility_multiplier" if utility_multiplier is None else "rent.note.card_utility_multiplier"
        rent = RentCharged(
            payer=payer_id,
            owner=owner,
            tile=tile_index,
            amount=multiplier * dice_total,
            base_rent=dice_total,
            multiplier=multiplier,
            dice_total=dice_total,
            note_keys=(note,),
            note_params={"multiplier": multiplier, "dice_total": dice_total},
        )
    elif tile.kind is TileKind.RAILROAD:
        rent = _charged(_railroad_quote(state, tile, owner, card_doubles_rent=card_doubles_rent), payer_id)
    else:
        rent = _charged(_property_quote(state, tile, owner), payer_id)

    events.append(rent)
    return _settle(state, rent, events, resting=resting)


def quote(state: GameState, tile_index: TileIndex, *, payer_id: PlayerId) -> RentQuote | None:
    """What ``tile_index`` would charge ``payer_id`` right now, or ``None`` for nothing at all.

    The accessor behind ``GameState.rent_due`` (MON-420), and the reason the "explain this rent"
    affordance can print real numbers: the tier ladder, the whole-group doubling and the railroad
    and utility multipliers all live in this module and nowhere else, so a screen that wanted the
    current figure previously had to either stay silent or grow a second copy of them.

    ``None`` is the answer for every square that charges nothing — unowned, owned by the payer,
    mortgaged, or owned by a player who has left the game. That is the *same* set of conditions
    :func:`charge` short-circuits on, read from one place, so a quote can never promise a rent the
    charge would not take (and a UI never has to work out that a mortgaged deed is dormant).

    Pure and roll-free. A utility's rent is a multiple of a throw, and quoting one does **not**
    roll: see :class:`~kesef_engine.events.RentQuote` for why the amount is ``None`` there rather
    than a plausible guess.
    """
    tile = state.board.tile(tile_index)
    prop = state.properties[tile_index]
    owner = prop.owner
    if owner is None or owner == payer_id or prop.mortgaged or state.player(owner).bankrupt:
        return None
    if tile.kind is TileKind.UTILITY:
        return _utility_quote(state, tile, owner)
    if tile.kind is TileKind.RAILROAD:
        return _railroad_quote(state, tile, owner, card_doubles_rent=False)
    return _property_quote(state, tile, owner)


def _charged(quoted: RentQuote, payer_id: PlayerId) -> RentCharged:
    """The same facts, with a payer attached.

    One conversion rather than two constructor calls per rent path: ``RentCharged`` *is* a
    ``RentQuote`` plus ``payer``, so spelling the fields out twice would be the place the two
    drifted apart the first time one of them gained a note.
    """
    assert quoted.amount is not None, "only a utility quote is amountless, and charging one rolls"
    return RentCharged(payer=payer_id, **dict(quoted))


def _utility_quote(state: GameState, tile: Tile, owner: PlayerId) -> RentQuote:
    """A utility's rent, expressed as the multiplier because the throw has not happened.

    An ordinary landing charges 4× the throw for one utility held and 10× for both. ``charge``
    builds its own ``RentCharged`` for this square rather than going through here, because it has
    a roll and this deliberately does not — the note key differs for exactly that reason.
    """
    multiplier = tile.rent[state.count_of_kind_owned(owner, TileKind.UTILITY) - 1]
    return RentQuote(
        owner=owner,
        tile=tile.index,
        multiplier=multiplier,
        note_keys=("rent.note.utility_quote",),
        note_params={"multiplier": multiplier},
    )


def _railroad_quote(state: GameState, tile: Tile, owner: PlayerId, *, card_doubles_rent: bool) -> RentQuote:
    """25 / 50 / 100 / 200 by how many the owner holds, optionally doubled by a card.

    The doubling is the *card's*, so it is a multiplier over the printed tier rather than a second
    table: the explanation stays "N railroads, doubled by the card".
    """
    count = state.count_of_kind_owned(owner, TileKind.RAILROAD)
    amount = tile.rent[count - 1]
    doubling = 2 if card_doubles_rent else 1
    notes: tuple[str, ...] = ("rent.note.railroad_count",)
    if card_doubles_rent:
        notes = (*notes, "rent.note.card_doubled")
    return RentQuote(
        owner=owner,
        tile=tile.index,
        amount=amount * doubling,
        base_rent=amount,
        multiplier=doubling,
        note_keys=notes,
        note_params={"count": count},
    )


def _property_quote(state: GameState, tile: Tile, owner: PlayerId) -> RentQuote:
    """Rent for a street, with an explanation in every case (MON-416).

    Spec §5.5 asks that *every* rent figure can be explained, not merely charged, and this function
    used to emit ``note_keys=()`` unless the group doubling applied — which left the **most common
    rent a child pays**, the printed figure on a lone unimproved square, as the one charge in the
    game with no reason attached. The three other rent paths (utility, railroad, and the card
    variants of both) always said why; this was the gap.

    Exactly one note, chosen by which rule produced the number:

    * a hotel, because "with a hotel" is what a child sees on the square;
    * houses, with how many — the tier ladder is why the figure jumped;
    * the whole-group doubling, which applies only to an *unimproved* group;
    * otherwise the printed rent, which is a reason even though it is the boring one.

    The cases are ordered, not independent: a built square is never also group-doubled, because the
    doubling is the compensation for having no houses.
    """
    prop = state.properties[tile.index]
    base = tile.rent[prop.houses]
    multiplier = 1
    group = tile.group
    assert group is not None  # a PROPERTY tile always carries one
    note_params: dict[str, int | str] = {}

    if prop.houses >= HOTEL_LEVEL:
        note_keys: tuple[str, ...] = ("rent.note.with_hotel",)
    elif prop.houses > 0:
        note_keys = ("rent.note.with_houses",)
        note_params = {"houses": prop.houses}
    elif state.owns_whole_group(owner, group):
        # Trap 1. Mortgaged siblings still complete the group (trap 2's second half):
        # owns_whole_group reads ownership, not mortgage flags.
        multiplier = 2
        note_keys = ("rent.note.full_group_doubled",)
        # `group_key`, not `group`: the sentence names a colour, and shipping `group.value` put
        # the engine's English identifier ("light_blue") into a Hebrew page unless the client
        # translated an engine enum at the render boundary (MON-415). The `_key` suffix is the
        # convention that makes it resolvable without the client knowing what a ColorGroup is —
        # see `RentQuote.note_params`. `multiplier` travels too, so the note that *is* about a
        # doubling is not the one note whose number the event cannot state.
        note_params = {"group_key": f"group.{group.value}", "multiplier": multiplier}
    else:
        note_keys = ("rent.note.base",)

    return RentQuote(
        owner=owner,
        tile=tile.index,
        amount=base * multiplier,
        base_rent=base,
        houses=prop.houses,
        multiplier=multiplier,
        group=group,
        note_keys=note_keys,
        note_params=note_params,
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
