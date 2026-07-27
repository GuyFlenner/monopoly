"""The two card decks, as ids.

Card ids are i18n keys (``card.chance.advance_to_go``) following ADR-003: the engine
never sees the sentence, only the key. The lists mirror the sixteen-card decks of the
classic universal ruleset; the *effects* behind each id land with MON-206 (TODO(MON-206)),
which also ships the ``cards.*`` catalogue namespace. Until then the decks are shuffled
into the opening state and card tiles are inert.

The duplicate entry is deliberate: the classic Chance deck carries two identical
"advance to the nearest railroad" cards, and one key serving both keeps the catalogue at
sixteen entries.
"""

from __future__ import annotations

from typing import Final

from kesef_engine.primitives import Deck

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
