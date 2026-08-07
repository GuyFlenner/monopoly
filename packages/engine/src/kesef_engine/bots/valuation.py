"""What the board can charge, and what a square is worth taking off it (MON-742).

Five readings, no opinions about what to *do* with them. Split out of `hard.py` when that file had
grown to four concerns in seven hundred lines, and this is the concern with the clearest edge: every
function here is a pure function of a position, answers in shekels, and holds no preference about
whether the figure it returns is worth acting on. `hard.py` decides that; `search.py` plays it out.

The names lost their leading underscore on the way out. They were private to a *file* and are now
shared across three, and a name that crosses a module boundary should say so — the underscore would
have been a claim about privacy that three importers falsify.

## The one place a bot is allowed to talk about money

Everything here is a *valuation*, and the distinction from a rule is what keeps the package honest:

* :func:`estimated_rent` asks ``rules.rent`` what a square charges and never works it out itself
  (MON-737). The engine is the authority on rent; a bot that re-derived it would be a second one.
* :func:`worst_landing`, :func:`reserve` and :func:`potential_rent` are arithmetic *over* that
  answer — a maximum, a clamp, a sum — and each is a preference the module docstring in `hard.py`
  argues for.
* :func:`denial_value` prices a square by what owning it does to somebody else's plans, which is
  the one reading here that is about an opponent rather than about the board.

Nothing in this module is legality, and nothing in it moves money.
"""

from __future__ import annotations

from typing import Final

# `_group_progress` is the normal bot's reading of who holds what in a colour group, imported by the
# one package entitled to it. Duplicating that count here is how two valuations start to disagree.
from kesef_engine.bots.normal import _group_progress
from kesef_engine.primitives import PlayerId
from kesef_engine.state import GameState

MIN_RESERVE: Final = 60
"""The floor under :func:`reserve`. Enough for a tax or a cheap rent, and no more.

Early in the game the worst landing on the board really is trivial, and a bot keeping 250 back then is
declining squares it will never be offered again.
"""

MAX_RESERVE: Final = 900
"""The ceiling. Past this the bot would be saving for a landing that would ruin it anyway.

A hotel on the dark blue group charges far more than this; there is no reserve that survives it, and
sitting on cash that large instead of building is how a bot loses slowly.
"""

DENIAL_COMPLETING: Final = 45.0
"""Points for a square that would have completed an opponent's group.

Worth more than the gap between `buy_property` (50 + value) and `decline_purchase` (45), so it can turn
a purchase the bot would otherwise decline on thinness grounds — that is the whole point of it.
"""

DENIAL_SHARE: Final = 12.0
"""Points, scaled by how far along that group already is, for merely getting in the way of it."""

_AVERAGE_DICE_TOTAL: Final = 7
"""Used to turn a utility's dice multiplier into a figure comparable with a street's rent."""


# --- Estimating what the board can charge ----------------------------------------------------------


def estimated_rent(state: GameState, tile_index: int) -> int:
    """What landing on this square would cost right now, as an estimate. Zero if nobody owns it.

    **A valuation, not a charge — and no longer a second opinion.** ``rules/rent.py`` is the authority
    and the only thing that ever moves money. This used to be written *to the same shape* as the real
    ladder: it re-read the houses, re-applied the whole-group doubling, and re-derived the station and
    utility tiers from a count of its own. Every one of those was correct and none of them was
    guaranteed to stay correct, because the guarantee was that somebody would remember to change two
    files. ``rules.rent.quote`` (MON-420) answers all three authoritatively, so the estimate asks it —
    reached through ``GameState.rent_due``, the accessor the rest of the product uses, so a bot does
    not have to know which rule module owns the ladder (MON-737).

    Two things are still this function's own, and they are the reason it exists at all:

    * **A number, always.** A utility's rent is a multiple of a throw that has not happened, so the
      quote states its ``multiplier`` and leaves ``amount`` as ``None`` rather than inventing one — see
      :class:`~kesef_engine.events.RentQuote` on why a plausible fiction is worse than a gap. A bot
      ranking squares cannot hold ``None``, so :data:`_AVERAGE_DICE_TOTAL` stands in. That stand-in is
      the *whole* of the arithmetic left on this side, which is what makes it reviewable.
    * **Zero rather than absence.** ``None`` from the quote means nothing at all is owed — unowned,
      mortgaged, or owned by somebody who has left the game — and "nothing" is a figure that a maximum
      (:func:`worst_landing`) and a sum (:func:`potential_rent`) can both take. The bankrupt-owner arm
      is new here and is the one behaviour MON-737 changed: the estimate used to fear a dead player's
      hotel, which the engine would never have charged.

    The payer is any seat that is not the owner. Rent depends on the owner's holdings and never on who
    is paying; the only thing the payer's identity decides is that a square does not charge its own
    owner, which is precisely the case being asked around here — :func:`potential_rent` reads a seat's
    *own* estate, so passing that seat would quote every square at nothing. ``GameState`` will not
    validate a game with fewer than two seats, so there is always somebody to ask on behalf of.
    """
    owner = state.properties[tile_index].owner
    if owner is None:
        return 0
    quoted = state.rent_due(tile_index, payer_id=next(seat.id for seat in state.players if seat.id != owner))
    if quoted is None:
        return 0
    return quoted.amount if quoted.amount is not None else quoted.multiplier * _AVERAGE_DICE_TOTAL


def worst_landing(state: GameState, player: PlayerId) -> int:
    """The most expensive single square somebody else owns. The bot's exposure, in one number.

    A maximum rather than a sum or an average, because the reserve exists to survive *one* landing.
    Averaging over the board would understate the thing that actually ends games, which is stepping on
    the one hotel.
    """
    return max(
        (
            estimated_rent(state, tile.index)
            for tile in state.board.tiles
            if tile.is_ownable and state.properties[tile.index].owner not in (None, player)
        ),
        default=0,
    )


def reserve(state: GameState, player: PlayerId) -> int:
    """The cash this bot keeps back: its exposure, clamped. Amendment 1.

    The clamps are what make it a reserve rather than a panic. Below :data:`MIN_RESERVE` it would spend
    to its last shekel on an empty board and lose to a tax card; above :data:`MAX_RESERVE` it would be
    saving for a hotel landing that no plausible reserve survives, while its opponent built.
    """
    return max(MIN_RESERVE, min(MAX_RESERVE, worst_landing(state, player)))


def potential_rent(state: GameState, player: PlayerId) -> int:
    """Everything this seat's holdings would charge if every opponent landed on all of them once.

    A sum here, where :func:`worst_landing` takes a maximum, and the asymmetry is deliberate: a reserve
    protects against one landing, whereas the *value* of an estate is what it collects over a game.
    """
    return sum(estimated_rent(state, index) for index in state.tiles_owned_by(player))


# --- Amendment 2: denial -----------------------------------------------------------------------------


def denial_value(state: GameState, player: PlayerId, tile_index: int) -> float:
    """What taking this unowned square off the table does to everybody else's plans.

    The big number is for the square that would have *completed* a group: a group with an outsider in
    it can never be built on (``_completion_value`` in `normal.py` is the same observation from the
    other side), so buying that one square permanently caps what the opponent's whole set can charge.
    The small number is for getting in the way of a group that is merely coming along.

    Only unowned squares reach here — the bot pays for this at a purchase or an auction, and those are
    the only two moments a deed comes off the table.
    """
    tile = state.board.tile(tile_index)
    if tile.group is None or state.properties[tile_index].owner is not None:
        return 0.0
    best = 0.0
    for other in state.solvent_players:
        if other.id == player:
            continue
        theirs, outsiders, total = _group_progress(state, other.id, tile_index)
        if not total or outsiders:
            # Already broken by somebody: there is nothing left to deny.
            continue
        best = max(best, DENIAL_COMPLETING if theirs + 1 == total else DENIAL_SHARE * theirs / total)
    return best
