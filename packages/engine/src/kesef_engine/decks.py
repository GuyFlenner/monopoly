"""The two card decks, as ids and as effects.

Card ids are i18n keys (``card.chance.advance_to_go``) following ADR-003: the engine
never sees the sentence, only the key. The lists mirror the sixteen-card decks of the
classic universal ruleset.

The duplicate entry is deliberate: the classic Chance deck carries two identical
"advance to the nearest railroad" cards, and one key serving both keeps the catalogue at
sixteen entries.

**The effects are data too (MON-206).** :data:`CARD_EFFECTS` maps each id to a tuple of
:data:`CardStep` values, and :mod:`kesef_engine.rules.cards` is the only thing that knows
how to enact one. Keeping the table here rather than in the rule module means a variant
deck is a new table, not a new ``if``; keeping the *steps* a tuple is what lets a card
that opens a debt halfway through resume at the step it stopped (ADR-007 G-9).

A step carries no i18n text of its own. The card's sentence is the card's id, resolved by
the ``cards.*`` catalogue in the web package; every number a step needs is here as an
integer, so the engine never has a string to translate.
"""

from __future__ import annotations

from typing import Final

from pydantic import BaseModel, ConfigDict, Field

from kesef_engine.primitives import Deck, PlayerId, TileIndex

GET_OUT_OF_JAIL_IDS: Final[dict[Deck, str]] = {
    Deck.CHANCE: "card.chance.get_out_of_jail_free",
    Deck.COMMUNITY_CHEST: "card.community_chest.get_out_of_jail_free",
}
"""Which card id returns to which deck's bottom when a held jail card is spent (G-11)."""

CHANCE_CARD_IDS: Final[tuple[str, ...]] = (
    "card.chance.advance_to_go",
    "card.chance.advance_to_illinois_avenue",
    "card.chance.advance_to_st_charles_place",
    "card.chance.advance_to_nearest_utility",
    "card.chance.advance_to_nearest_railroad",
    "card.chance.advance_to_nearest_railroad",
    "card.chance.bank_pays_dividend",
    "card.chance.get_out_of_jail_free",
    "card.chance.go_back_three_spaces",
    "card.chance.go_to_jail",
    "card.chance.general_repairs",
    "card.chance.speeding_fine",
    "card.chance.trip_to_reading_railroad",
    "card.chance.advance_to_boardwalk",
    "card.chance.elected_chairman",
    "card.chance.building_loan_matures",
)

COMMUNITY_CHEST_CARD_IDS: Final[tuple[str, ...]] = (
    "card.community_chest.advance_to_go",
    "card.community_chest.bank_error",
    "card.community_chest.doctor_fee",
    "card.community_chest.sale_of_stock",
    "card.community_chest.get_out_of_jail_free",
    "card.community_chest.go_to_jail",
    "card.community_chest.holiday_fund",
    "card.community_chest.income_tax_refund",
    "card.community_chest.birthday",
    "card.community_chest.life_insurance",
    "card.community_chest.hospital_fee",
    "card.community_chest.school_fee",
    "card.community_chest.consultancy_fee",
    "card.community_chest.street_repairs",
    "card.community_chest.beauty_contest",
    "card.community_chest.inheritance",
)

# --- What a card does (MON-206) ---------------------------------------------

# The tiles the movement cards name. Both shipped boards share their economics slot for
# slot (see ``board/models.py``), so a card names a *slot* rather than a board-specific
# tile — which is what keeps one deck valid for the Israeli board as well as the classic
# one, and why these are indexes and not name keys.
GO_TILE: Final = 0
READING_RAILROAD_TILE: Final = 5
ST_CHARLES_PLACE_TILE: Final = 11
ILLINOIS_AVENUE_TILE: Final = 24
BOARDWALK_TILE: Final = 39


class _Step(BaseModel):
    """One indivisible piece of a card's effect."""

    model_config = ConfigDict(frozen=True)


class Collect(_Step):
    """The bank pays the holder."""

    amount: int = Field(gt=0)


class Pay(_Step):
    """The holder pays the bank. Card money never feeds the Free Parking pot — only a
    directly paid tax or jail fine does (see ``rules/tiles.pot_or_bank``)."""

    amount: int = Field(gt=0)


class PayEachPlayer(_Step):
    """The holder pays every other solvent player. One debt, N obligations (GAP G-7)."""

    amount: int = Field(gt=0)


class CollectFromEachPlayer(_Step):
    """Every other solvent player pays the holder.

    Expanded to one :class:`CollectFrom` per seat when the card is resolved: each payer is
    a separate step because any one of them may be unable to pay, and the collection from
    the *next* player must still happen once that debt is settled (ADR-007 G-9).
    """

    amount: int = Field(gt=0)


class CollectFrom(_Step):
    """One named player pays the holder. Only ever produced by the expansion above."""

    payer: PlayerId
    amount: int = Field(gt=0)


class Repairs(_Step):
    """A per-building assessment on the holder's whole estate."""

    per_house: int = Field(ge=0)
    per_hotel: int = Field(ge=0)


class AdvanceTo(_Step):
    """Walk forward to a named tile, collecting the salary if GO is passed on the way."""

    tile: TileIndex = Field(ge=0)


class GoBack(_Step):
    """Walk backwards. Walking backwards over GO pays nothing — the salary is for
    *passing* GO, which is a forward act (spec §3.6 trap 10's sibling)."""

    spaces: int = Field(gt=0)


class AdvanceToNearestRailroad(_Step):
    """Forward to the next railroad, then pay the owner **twice** the rental due.

    If the railroad is unowned it is offered for sale exactly as an ordinary arrival
    would be.
    """


class AdvanceToNearestUtility(_Step):
    """Forward to the next utility, then pay rent priced by a roll made for the rent.

    Spec §3.6 trap 9: the dice are thrown *for the rent*, not for a move, so the throw
    never feeds the doubles streak and never earns another turn.
    """


class GoToJail(_Step):
    """Straight to the cell: no movement along the board, and no salary (trap 10)."""


class KeepJailCard(_Step):
    """The holder keeps the card. It leaves its deck until it is used or forfeited, and
    then returns to the bottom of *that* deck — which is why a held card is stored as a
    :class:`~kesef_engine.primitives.Deck` and not as a count (GAP G-11)."""


CardStep = (
    Collect
    | Pay
    | PayEachPlayer
    | CollectFromEachPlayer
    | CollectFrom
    | Repairs
    | AdvanceTo
    | GoBack
    | AdvanceToNearestRailroad
    | AdvanceToNearestUtility
    | GoToJail
    | KeepJailCard
)
"""What a card is made of. A closed union, so an unhandled step is a type error."""


CARD_EFFECTS: Final[dict[str, tuple[CardStep, ...]]] = {
    # --- Chance ---
    # "Advance to GO" carries no explicit Collect: walking to GO passes GO, and the mover
    # pays the salary for that. Paying it twice was the bug this comment exists to prevent.
    "card.chance.advance_to_go": (AdvanceTo(tile=GO_TILE),),
    "card.chance.advance_to_illinois_avenue": (AdvanceTo(tile=ILLINOIS_AVENUE_TILE),),
    "card.chance.advance_to_st_charles_place": (AdvanceTo(tile=ST_CHARLES_PLACE_TILE),),
    "card.chance.advance_to_nearest_utility": (AdvanceToNearestUtility(),),
    "card.chance.advance_to_nearest_railroad": (AdvanceToNearestRailroad(),),
    "card.chance.bank_pays_dividend": (Collect(amount=50),),
    "card.chance.get_out_of_jail_free": (KeepJailCard(),),
    "card.chance.go_back_three_spaces": (GoBack(spaces=3),),
    "card.chance.go_to_jail": (GoToJail(),),
    "card.chance.general_repairs": (Repairs(per_house=25, per_hotel=100),),
    "card.chance.speeding_fine": (Pay(amount=15),),
    "card.chance.trip_to_reading_railroad": (AdvanceTo(tile=READING_RAILROAD_TILE),),
    "card.chance.advance_to_boardwalk": (AdvanceTo(tile=BOARDWALK_TILE),),
    "card.chance.elected_chairman": (PayEachPlayer(amount=50),),
    "card.chance.building_loan_matures": (Collect(amount=150),),
    # --- Community Chest ---
    "card.community_chest.advance_to_go": (AdvanceTo(tile=GO_TILE),),
    "card.community_chest.bank_error": (Collect(amount=200),),
    "card.community_chest.doctor_fee": (Pay(amount=50),),
    "card.community_chest.sale_of_stock": (Collect(amount=50),),
    "card.community_chest.get_out_of_jail_free": (KeepJailCard(),),
    "card.community_chest.go_to_jail": (GoToJail(),),
    "card.community_chest.holiday_fund": (Collect(amount=100),),
    "card.community_chest.income_tax_refund": (Collect(amount=20),),
    "card.community_chest.birthday": (CollectFromEachPlayer(amount=10),),
    "card.community_chest.life_insurance": (Collect(amount=100),),
    "card.community_chest.hospital_fee": (Pay(amount=100),),
    "card.community_chest.school_fee": (Pay(amount=50),),
    "card.community_chest.consultancy_fee": (Collect(amount=25),),
    "card.community_chest.street_repairs": (Repairs(per_house=40, per_hotel=115),),
    "card.community_chest.beauty_contest": (Collect(amount=10),),
    "card.community_chest.inheritance": (Collect(amount=100),),
}
"""Every card id in both decks, mapped to its effect. Exhaustive by test."""
