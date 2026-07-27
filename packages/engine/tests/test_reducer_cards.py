"""MON-206 — Chance and Community Chest, one named test per card.

Every card in both decks gets its own test: the decks are *data*, and data with no test
is a table nobody has read. The mechanics that sit around them — the draw returning to
the bottom, a kept jail card leaving its own deck, an unpayable charge opening a debt, and
the ``CardFrame`` that lets a half-finished card resume — are tested separately below.

Cards are drawn the way a game draws them: a real roll onto a real card tile through
``apply``. The seed is chosen so the roll is not doubles, and the start tile so the walk
onto the card tile never passes GO — so any salary in the events belongs to the *card*.
"""

from __future__ import annotations

import pytest

from helpers import make_player, make_state
from kesef_engine.board.models import BOARD_SIZE, TileKind
from kesef_engine.commands import (
    Command,
    MortgageProperty,
    RollDice,
    UseJailCard,
)
from kesef_engine.decks import (
    CARD_EFFECTS,
    CHANCE_CARD_IDS,
    COMMUNITY_CHEST_CARD_IDS,
    GET_OUT_OF_JAIL_IDS,
)
from kesef_engine.errors import IllegalCommandError
from kesef_engine.events import (
    CardDrawn,
    CashChanged,
    DebtIncurred,
    Event,
    RentCharged,
    SentToJail,
    TokenMoved,
)
from kesef_engine.legality import is_legal, legal_commands
from kesef_engine.phases import Phase
from kesef_engine.primitives import CashReason, Deck
from kesef_engine.reducer import apply
from kesef_engine.rng import Rng
from kesef_engine.ruleset import Ruleset
from kesef_engine.state import CardFrame, DebtFrame, GameState, PlayerState, PropertyState

# A seed whose first roll is not doubles: doubles would grant a second roll and change the
# phase the turn rests in, which half these tests assert on.
_SEED = next(seed for seed in range(1000) if (roll := Rng(seed=seed).roll_dice())[0] != roll[1])
_TOTAL = sum(Rng(seed=_SEED).roll_dice()[:2])

CHANCE_TILES = (7, 22, 36)
CHEST_TILES = (2, 17, 33)
CHANCE, LATE_CHANCE, CHEST = 22, 36, 17
JAIL, GO_TO_JAIL_TILE = 10, 30
ELECTRIC_COMPANY, WATER_WORKS = 12, 28
B_AND_O_RAILROAD, READING_RAILROAD = 25, 5
NEW_YORK_AVENUE, ILLINOIS_AVENUE, ST_CHARLES_PLACE, BOARDWALK = 19, 24, 11, 39
MEDITERRANEAN_AVENUE, BALTIC_AVENUE = 1, 3

_CHANCE_FILLERS = ("card.chance.speeding_fine", "card.chance.bank_pays_dividend")
_CHEST_FILLERS = ("card.community_chest.doctor_fee", "card.community_chest.beauty_contest")


def _filler(card_id: str) -> str:
    """A second card for the deck, so "the draw went to the bottom" can actually fail."""
    pool = _CHANCE_FILLERS if card_id.startswith("card.chance.") else _CHEST_FILLERS
    return next(candidate for candidate in pool if candidate != card_id)


def _play(
    card_id: str,
    *,
    tile: int = CHANCE,
    cash: int = 1500,
    seats: tuple[PlayerState, ...] | None = None,
    properties: dict[int, PropertyState] | None = None,
    ruleset: Ruleset | None = None,
    deck: tuple[str, ...] | None = None,
    other_deck: tuple[str, ...] = (),
) -> tuple[GameState, tuple[Event, ...]]:
    """Roll player 0 onto ``tile`` with ``card_id`` on top of that tile's deck.

    ``other_deck`` stocks the *opposite* pile, which only the card that walks a player onto
    the other kind of card tile needs.
    """
    start = (tile - _TOTAL) % BOARD_SIZE
    assert start + _TOTAL < BOARD_SIZE, "the walk onto the card tile must not pass GO"
    if seats is None:
        seats = (make_player(0, cash=cash), make_player(1))
    seats = (PlayerState(**(dict(seats[0]) | {"position": start})), *seats[1:])
    state = make_state(seats=seats, seed=_SEED, properties=properties, ruleset=ruleset)
    stocked = deck if deck is not None else (card_id, _filler(card_id))
    drawn_from = "chance_deck" if tile in CHANCE_TILES else "community_chest_deck"
    opposite = "community_chest_deck" if drawn_from == "chance_deck" else "chance_deck"
    state = GameState(**(dict(state) | {drawn_from: stocked, opposite: other_deck}))
    return apply(state, RollDice(player=0))


def _card_cash(events: tuple[Event, ...], player: int = 0) -> int:
    """Net cash the card moved for ``player`` — the ledger, not a balance guess."""
    return sum(event.delta for event in events if isinstance(event, CashChanged) and event.player == player)


def _moved(events: tuple[Event, ...]) -> TokenMoved:
    """The *last* TokenMoved: the first one is the roll that delivered the player."""
    return [event for event in events if isinstance(event, TokenMoved)][-1]


# --- The decks as data ------------------------------------------------------


def test_each_deck_holds_exactly_the_standard_sixteen_cards() -> None:
    assert len(CHANCE_CARD_IDS) == 16
    assert len(COMMUNITY_CHEST_CARD_IDS) == 16
    # The classic Chance deck carries two identical "nearest railroad" cards; every other
    # id is unique, so a deck is sixteen cards and fifteen distinct keys.
    assert len(set(CHANCE_CARD_IDS)) == 15
    assert CHANCE_CARD_IDS.count("card.chance.advance_to_nearest_railroad") == 2
    assert len(set(COMMUNITY_CHEST_CARD_IDS)) == 16


def test_every_card_in_both_decks_has_an_effect() -> None:
    """A card id with no entry in the table would be drawn and silently do nothing."""
    for card_id in (*CHANCE_CARD_IDS, *COMMUNITY_CHEST_CARD_IDS):
        assert CARD_EFFECTS[card_id], f"{card_id} has no effect"
    assert set(CARD_EFFECTS) == set(CHANCE_CARD_IDS) | set(COMMUNITY_CHEST_CARD_IDS), "no orphan effects"


def test_every_card_id_is_an_i18n_key_never_prose() -> None:
    for card_id in CARD_EFFECTS:
        assert card_id.startswith(("card.chance.", "card.community_chest."))
        assert " " not in card_id


def test_a_drawn_card_goes_to_the_bottom_of_its_own_deck() -> None:
    filler = _filler("card.chance.speeding_fine")
    new_state, events = _play("card.chance.speeding_fine", deck=("card.chance.speeding_fine", filler))
    assert new_state.chance_deck == (filler, "card.chance.speeding_fine")
    assert new_state.community_chest_deck == (), "the other deck was not touched"
    assert [event for event in events if isinstance(event, CardDrawn)]


def test_the_card_drawn_event_names_the_deck_and_the_key() -> None:
    _, events = _play("card.community_chest.bank_error", tile=CHEST)
    drawn = next(event for event in events if isinstance(event, CardDrawn))
    assert (drawn.player, drawn.deck, drawn.card_id) == (0, Deck.COMMUNITY_CHEST, "card.community_chest.bank_error")


def test_a_deck_stocked_with_nothing_deals_nothing() -> None:
    """``new_game`` always stocks both decks; a hand-built state need not, and an empty
    deck must rest the turn rather than raise."""
    new_state, events = _play("card.chance.speeding_fine", deck=())
    assert new_state.phase is Phase.AWAITING_END_TURN
    assert not [event for event in events if isinstance(event, CardDrawn)]
    assert _card_cash(events) == 0


# --- Chance, card by card ---------------------------------------------------


def test_chance_advance_to_go_collects_the_salary() -> None:
    new_state, events = _play("card.chance.advance_to_go")
    assert new_state.player(0).position == 0
    assert _card_cash(events) == 200
    salary = next(event for event in events if isinstance(event, CashChanged))
    assert salary.reason is CashReason.GO_SALARY
    assert _moved(events).passed_go


def test_chance_advance_to_illinois_avenue_arrives_without_passing_go() -> None:
    new_state, events = _play("card.chance.advance_to_illinois_avenue")
    assert new_state.player(0).position == ILLINOIS_AVENUE
    assert _card_cash(events) == 0, "22 -> 24 passes no GO"
    assert new_state.phase is Phase.AWAITING_PURCHASE_DECISION, "an unowned arrival is offered for sale"


def test_chance_advance_to_st_charles_place_pays_the_salary_on_the_way() -> None:
    new_state, events = _play("card.chance.advance_to_st_charles_place")
    assert new_state.player(0).position == ST_CHARLES_PLACE
    assert _card_cash(events) == 200, "22 -> 11 wraps past GO"
    assert _moved(events).passed_go


def test_chance_advance_to_nearest_utility_rolls_for_the_rent() -> None:
    """Spec §3.6 trap 9: the roll is made *for the rent*, not for the move."""
    owned = {ELECTRIC_COMPANY: PropertyState(owner=1), WATER_WORKS: PropertyState(owner=1)}
    new_state, events = _play("card.chance.advance_to_nearest_utility", properties=owned)
    assert new_state.player(0).position == WATER_WORKS, "22 -> 28 is the next utility"
    rent = next(event for event in events if isinstance(event, RentCharged))
    assert rent.dice_total is not None
    assert rent.multiplier == 10, "the owner holds both utilities"
    assert rent.amount == 10 * rent.dice_total
    assert new_state.dice is not None and new_state.dice.purpose == "rent"
    assert _card_cash(events) == -rent.amount


def test_the_nearest_utility_card_charges_ten_times_even_for_one_utility() -> None:
    """The printed card charges **ten times the throw**, whatever the owner holds.

    Two different official rules meet on one tile: a utility landed on *by moving* charges 4×
    for one utility held and 10× for both, and MON-206 followed that tier here. The card names
    its own number, so the tier does not apply — and with only Water Works owned the two rules
    differ by a factor of two and a half, which is why this needs its own test rather than a
    comment.
    """
    owned = {WATER_WORKS: PropertyState(owner=1)}  # Electric Company stays with the bank
    new_state, events = _play("card.chance.advance_to_nearest_utility", properties=owned)
    assert new_state.player(0).position == WATER_WORKS
    assert new_state.count_of_kind_owned(1, TileKind.UTILITY) == 1, "the 4x tier would apply to a landing"
    rent = next(event for event in events if isinstance(event, RentCharged))
    assert rent.dice_total is not None
    assert rent.multiplier == 10, "the card's number, not the one-utility tier"
    assert rent.amount == 10 * rent.dice_total
    assert rent.note_keys == ("rent.note.card_utility_multiplier",), "the explanation names the card's rule"


def test_an_ordinary_landing_on_one_utility_still_charges_four_times() -> None:
    """The other side of the same coin: the tier is untouched for a landing that was *moved*
    into. Without this, the fix above could be a blanket 10x and nothing would notice."""
    owned = {ELECTRIC_COMPANY: PropertyState(owner=1)}
    seats = (make_player(0, position=ELECTRIC_COMPANY - _TOTAL), make_player(1))
    state = make_state(seats=seats, properties=owned, seed=_SEED)
    _, events = apply(state, RollDice(player=0))
    rent = next(event for event in events if isinstance(event, RentCharged))
    assert rent.multiplier == 4, "one utility owned, reached by moving"
    assert rent.note_keys == ("rent.note.utility_multiplier",)


def test_chance_advance_to_nearest_railroad_pays_double_rent() -> None:
    owned = {B_AND_O_RAILROAD: PropertyState(owner=1)}
    new_state, events = _play("card.chance.advance_to_nearest_railroad", properties=owned)
    assert new_state.player(0).position == B_AND_O_RAILROAD, "22 -> 25 is the next railroad"
    rent = next(event for event in events if isinstance(event, RentCharged))
    assert rent.base_rent == 25, "one railroad owned"
    assert rent.amount == 50, "the card doubles the rental"
    assert rent.multiplier == 2
    assert "rent.note.card_doubled" in rent.note_keys


def test_chance_advance_to_nearest_railroad_offers_an_unowned_railroad_for_sale() -> None:
    """ "If the railroad is unowned you may buy it" — the doubling never suppresses the sale."""
    new_state, events = _play("card.chance.advance_to_nearest_railroad")
    assert new_state.player(0).position == B_AND_O_RAILROAD
    assert new_state.phase is Phase.AWAITING_PURCHASE_DECISION
    assert not [event for event in events if isinstance(event, RentCharged)]


def test_chance_advance_to_nearest_railroad_wraps_past_go_for_the_salary() -> None:
    new_state, events = _play("card.chance.advance_to_nearest_railroad", tile=LATE_CHANCE)
    assert new_state.player(0).position == READING_RAILROAD, "36 -> 5 wraps past GO"
    assert _card_cash(events) == 200


def test_chance_bank_pays_dividend_collects_fifty() -> None:
    new_state, events = _play("card.chance.bank_pays_dividend")
    assert _card_cash(events) == 50
    assert new_state.player(0).cash == 1550
    paid = next(event for event in events if isinstance(event, CashChanged))
    assert (paid.reason, paid.counterparty) == (CashReason.CARD, "bank")


def test_chance_get_out_of_jail_free_is_kept_and_leaves_the_deck() -> None:
    """G-11: a keepable card is held by *deck*, and it is not in the pile any more."""
    filler = _filler("card.chance.get_out_of_jail_free")
    new_state, _ = _play("card.chance.get_out_of_jail_free", deck=("card.chance.get_out_of_jail_free", filler))
    assert new_state.player(0).jail_cards == (Deck.CHANCE,)
    assert new_state.chance_deck == (filler,), "a kept card does not go to the bottom"


def test_chance_go_back_three_spaces_moves_backwards_without_salary() -> None:
    new_state, events = _play("card.chance.go_back_three_spaces")
    assert new_state.player(0).position == NEW_YORK_AVENUE, "22 - 3"
    back = _moved(events)
    assert back.forward is False, "the UI animates backwards rather than teleporting"
    assert (back.from_tile, back.to_tile) == (CHANCE, NEW_YORK_AVENUE)
    assert back.passed_go is False
    assert new_state.phase is Phase.AWAITING_PURCHASE_DECISION


def test_chance_go_to_jail_pays_no_salary() -> None:
    """Spec §3.6 trap 10: being *sent* to jail is never passing GO."""
    new_state, events = _play("card.chance.go_to_jail")
    assert next(event for event in events if isinstance(event, SentToJail)).via == "card"
    assert new_state.player(0).in_jail
    assert new_state.player(0).position == JAIL
    assert _card_cash(events) == 0
    assert new_state.phase is Phase.AWAITING_END_TURN


def test_chance_general_repairs_charges_per_house_and_per_hotel() -> None:
    built = {
        MEDITERRANEAN_AVENUE: PropertyState(owner=0, houses=3),
        BALTIC_AVENUE: PropertyState(owner=0, houses=5),
    }
    _, events = _play("card.chance.general_repairs", properties=built)
    assert _card_cash(events) == -(3 * 25 + 1 * 100)


def test_chance_general_repairs_costs_nothing_to_an_undeveloped_estate() -> None:
    new_state, events = _play("card.chance.general_repairs", properties={MEDITERRANEAN_AVENUE: PropertyState(owner=0)})
    assert _card_cash(events) == 0
    assert not [event for event in events if isinstance(event, CashChanged)], "no ledger entry for nothing"
    assert new_state.phase is Phase.AWAITING_END_TURN


def test_chance_speeding_fine_pays_fifteen() -> None:
    _, events = _play("card.chance.speeding_fine")
    assert _card_cash(events) == -15


def test_chance_trip_to_reading_railroad_advances_and_pays_the_salary() -> None:
    new_state, events = _play("card.chance.trip_to_reading_railroad")
    assert new_state.player(0).position == READING_RAILROAD
    assert _card_cash(events) == 200, "22 -> 5 wraps past GO"


def test_chance_advance_to_boardwalk_moves_to_the_last_tile() -> None:
    new_state, events = _play("card.chance.advance_to_boardwalk")
    assert new_state.player(0).position == BOARDWALK
    assert _card_cash(events) == 0
    assert new_state.phase is Phase.AWAITING_PURCHASE_DECISION


def test_chance_elected_chairman_pays_each_player() -> None:
    seats = (make_player(0), make_player(1), make_player(2))
    new_state, events = _play("card.chance.elected_chairman", seats=seats)
    assert _card_cash(events) == -100, "two other players at 50 each"
    assert new_state.player(1).cash == 1550
    assert new_state.player(2).cash == 1550
    assert not [event for event in events if isinstance(event, DebtIncurred)], "the chairman could pay"


def test_chance_building_loan_matures_collects_one_fifty() -> None:
    _, events = _play("card.chance.building_loan_matures")
    assert _card_cash(events) == 150


# --- Community Chest, card by card -----------------------------------------


def test_chest_advance_to_go_collects_the_salary() -> None:
    new_state, events = _play("card.community_chest.advance_to_go", tile=CHEST)
    assert new_state.player(0).position == 0
    assert _card_cash(events) == 200


def test_chest_bank_error_collects_two_hundred() -> None:
    _, events = _play("card.community_chest.bank_error", tile=CHEST)
    assert _card_cash(events) == 200


def test_chest_doctor_fee_pays_fifty() -> None:
    _, events = _play("card.community_chest.doctor_fee", tile=CHEST)
    assert _card_cash(events) == -50


def test_chest_sale_of_stock_collects_fifty() -> None:
    _, events = _play("card.community_chest.sale_of_stock", tile=CHEST)
    assert _card_cash(events) == 50


def test_chest_get_out_of_jail_free_is_kept_and_leaves_its_own_deck() -> None:
    """G-11: the *Community Chest* card is held as such, so it can return to that pile."""
    filler = _filler("card.community_chest.get_out_of_jail_free")
    new_state, _ = _play(
        "card.community_chest.get_out_of_jail_free",
        tile=CHEST,
        deck=("card.community_chest.get_out_of_jail_free", filler),
    )
    assert new_state.player(0).jail_cards == (Deck.COMMUNITY_CHEST,)
    assert new_state.community_chest_deck == (filler,)
    assert new_state.chance_deck == ()


def test_chest_go_to_jail_sends_without_salary() -> None:
    """The Chest twin of ``test_chance_go_to_jail_pays_no_salary``, and asserting the same
    four facts as it does. ``in_jail`` plus a zero ledger left the interesting half unchecked:
    the token has to *land on* the cell rather than stay where it was, the turn has to rest in
    ``AWAITING_END_TURN`` (a card-driven jailing grants no further roll — trap 7), and ``via``
    has to say a card did it, because the jail rules read that field."""
    new_state, events = _play("card.community_chest.go_to_jail", tile=CHEST)
    assert next(event for event in events if isinstance(event, SentToJail)).via == "card"
    assert new_state.player(0).in_jail
    assert new_state.player(0).position == JAIL
    assert _card_cash(events) == 0
    assert new_state.phase is Phase.AWAITING_END_TURN


def test_chest_holiday_fund_collects_one_hundred() -> None:
    _, events = _play("card.community_chest.holiday_fund", tile=CHEST)
    assert _card_cash(events) == 100


def test_chest_income_tax_refund_collects_twenty() -> None:
    _, events = _play("card.community_chest.income_tax_refund", tile=CHEST)
    assert _card_cash(events) == 20


def test_chest_birthday_collects_ten_from_each_player() -> None:
    seats = (make_player(0), make_player(1), make_player(2))
    new_state, events = _play("card.community_chest.birthday", tile=CHEST, seats=seats)
    assert _card_cash(events) == 20, "ten from each of two players"
    assert new_state.player(1).cash == 1490
    assert new_state.player(2).cash == 1490


def test_chest_life_insurance_collects_one_hundred() -> None:
    _, events = _play("card.community_chest.life_insurance", tile=CHEST)
    assert _card_cash(events) == 100


def test_chest_hospital_fee_pays_one_hundred() -> None:
    _, events = _play("card.community_chest.hospital_fee", tile=CHEST)
    assert _card_cash(events) == -100


def test_chest_school_fee_pays_fifty() -> None:
    _, events = _play("card.community_chest.school_fee", tile=CHEST)
    assert _card_cash(events) == -50


def test_chest_consultancy_fee_collects_twenty_five() -> None:
    _, events = _play("card.community_chest.consultancy_fee", tile=CHEST)
    assert _card_cash(events) == 25


def test_chest_street_repairs_charges_per_house_and_per_hotel() -> None:
    built = {
        MEDITERRANEAN_AVENUE: PropertyState(owner=0, houses=2),
        BALTIC_AVENUE: PropertyState(owner=0, houses=5),
    }
    _, events = _play("card.community_chest.street_repairs", tile=CHEST, properties=built)
    assert _card_cash(events) == -(2 * 40 + 1 * 115)


def test_a_repair_assessment_charges_for_every_hotel_not_merely_for_having_one() -> None:
    """Two hotels are two charges, and the houses beside them are still counted per house.

    No other card test in this file gives an estate more than one hotel, so ``_assessment``'s
    hotel *count* was unpinned: replacing ``hotels += 1`` with a saturating ``min(hotels, 1)``
    left every one of them green. Three built tiles here, over two colour groups, so the two
    multipliers cannot cover for each other either.
    """
    built = {
        MEDITERRANEAN_AVENUE: PropertyState(owner=0, houses=5),
        BALTIC_AVENUE: PropertyState(owner=0, houses=5),
        NEW_YORK_AVENUE: PropertyState(owner=0, houses=4),
    }
    _, events = _play("card.community_chest.street_repairs", tile=CHEST, properties=built)
    assert _card_cash(events) == -(4 * 40 + 2 * 115)


def test_chest_beauty_contest_collects_ten() -> None:
    _, events = _play("card.community_chest.beauty_contest", tile=CHEST)
    assert _card_cash(events) == 10


def test_chest_inheritance_collects_one_hundred() -> None:
    _, events = _play("card.community_chest.inheritance", tile=CHEST)
    assert _card_cash(events) == 100


# --- Debts a card opens -----------------------------------------------------


def test_an_unpayable_card_charge_opens_a_debt_frame() -> None:
    """ "exactly as rent does today": shortfall-as-data, one obligation to the bank."""
    new_state, events = _play("card.community_chest.hospital_fee", tile=CHEST, cash=40)
    assert new_state.phase is Phase.DEBT_SETTLEMENT
    frame = new_state.top_interrupt
    assert isinstance(frame, DebtFrame)
    assert (frame.debtor, frame.reason, frame.total) == (0, CashReason.CARD, 100)
    assert frame.creditors == ("bank",)
    assert frame.resume is Phase.AWAITING_END_TURN
    assert new_state.player(0).cash == 40, "cash never goes negative"
    assert [event for event in events if isinstance(event, DebtIncurred)]


def test_pay_each_player_creates_one_debt_with_one_obligation_per_creditor() -> None:
    """G-7: one ``DebtFrame``, N obligations — not N frames."""
    seats = (make_player(0, cash=60), make_player(1), make_player(2), make_player(3))
    new_state, _ = _play("card.chance.elected_chairman", seats=seats)
    frame = new_state.top_interrupt
    assert isinstance(frame, DebtFrame)
    assert len(new_state.interrupts) == 1
    assert frame.creditors == (1, 2, 3)
    assert frame.total == 150
    assert all(obligation.amount == 50 for obligation in frame.obligations)


def test_pay_each_player_skips_a_bankrupt_seat() -> None:
    seats = (make_player(0), make_player(1), make_player(2, cash=0, bankrupt=True))
    state = make_state(seats=seats)
    assert state.player(2).bankrupt
    new_state, events = _play("card.chance.elected_chairman", seats=seats)
    assert _card_cash(events) == -50, "only the one solvent opponent is paid"
    assert new_state.player(2).cash == 0


def test_a_card_debt_leaves_the_turn_resting_where_the_card_found_it() -> None:
    """The resume phase is the turn's, not the card's: settling must not swallow the rest
    of the turn (the same contract rent keeps)."""
    new_state, _ = _play("card.chance.general_repairs", cash=0, properties={BALTIC_AVENUE: PropertyState(owner=0)})
    # No buildings, so nothing is owed and the turn rests immediately.
    assert new_state.phase is Phase.AWAITING_END_TURN
    assert new_state.interrupts == ()


# --- The CardFrame: suspend and resume (ADR-007 G-9) ------------------------


def _birthday_with_a_broke_payer() -> tuple[GameState, tuple[Event, ...]]:
    """Three seats: the middle one cannot pay the ₪10, and owns a tile to mortgage."""
    seats = (make_player(0), make_player(1, cash=0), make_player(2))
    return _play(
        "card.community_chest.birthday",
        tile=CHEST,
        seats=seats,
        properties={MEDITERRANEAN_AVENUE: PropertyState(owner=1)},
    )


def test_a_card_suspends_into_a_card_frame_when_a_step_opens_a_debt() -> None:
    new_state, _ = _birthday_with_a_broke_payer()
    assert new_state.phase is Phase.DEBT_SETTLEMENT
    assert len(new_state.interrupts) == 2, "the card sits under the debt"
    card = new_state.interrupts[0]
    assert isinstance(card, CardFrame)
    assert (card.card_id, card.deck) == ("card.community_chest.birthday", Deck.COMMUNITY_CHEST)
    assert card.step == 1, "the first collection is done; the second has not run"
    assert card.resume is Phase.AWAITING_END_TURN
    assert new_state.pending_card is not None, "G-9: the UI keeps the card face-up"
    assert new_state.player(2).cash == 1500, "the second player has not paid yet"


def test_a_suspended_card_resumes_at_the_step_it_stopped_at() -> None:
    suspended, _ = _birthday_with_a_broke_payer()
    debtor_frame = suspended.top_interrupt
    assert isinstance(debtor_frame, DebtFrame)
    assert debtor_frame.debtor == 1

    resumed, events = apply(suspended, MortgageProperty(player=1, tile=MEDITERRANEAN_AVENUE))
    assert resumed.interrupts == (), "the debt settled and the card finished"
    assert resumed.phase is Phase.AWAITING_END_TURN
    assert resumed.player(0).cash == 1520, "ten from each of the two other players"
    assert resumed.player(1).cash == 30 - 10, "the mortgage raised 30, the debt took 10"
    assert resumed.player(2).cash == 1490, "the step after the debt ran on resume"
    assert not [event for event in events if isinstance(event, CardDrawn)], "no second card was drawn"


def test_a_suspended_card_charges_the_debtor_exactly_once() -> None:
    """The step counter is what prevents the re-run: without it the resume would collect
    from player 1 a second time."""
    suspended, _ = _birthday_with_a_broke_payer()
    resumed, events = apply(suspended, MortgageProperty(player=1, tile=MEDITERRANEAN_AVENUE))
    paid = [
        event
        for event in events
        if isinstance(event, CashChanged) and event.player == 1 and event.reason is CashReason.CARD
    ]
    assert len(paid) == 1, "the collection settled once, not once per resume"
    assert resumed.player(1).cash == 20


# --- A card that lands on another card tile ---------------------------------


def test_going_back_three_spaces_onto_a_card_tile_draws_that_deck_s_card() -> None:
    """36 - 3 = 33, a Community Chest tile. The second card resolves in the same command."""
    new_state, events = _play(
        "card.chance.go_back_three_spaces",
        tile=LATE_CHANCE,
        deck=("card.chance.go_back_three_spaces", _filler("card.chance.go_back_three_spaces")),
        other_deck=("card.community_chest.bank_error", "card.community_chest.inheritance"),
    )
    assert new_state.player(0).position == 33
    drawn = [event for event in events if isinstance(event, CardDrawn)]
    assert len(drawn) == 2, "the Chance card, then the Community Chest card it landed on"
    assert (drawn[0].deck, drawn[1].deck) == (Deck.CHANCE, Deck.COMMUNITY_CHEST)
    assert _card_cash(events) == 200, "the ₪200 bank error the second card paid"
    assert new_state.community_chest_deck == (
        "card.community_chest.inheritance",
        "card.community_chest.bank_error",
    ), "the second card went to the bottom of its own deck"
    assert new_state.interrupts == ()
    assert new_state.phase is not Phase.CARD_RESOLUTION


def test_a_card_arrival_on_your_own_property_charges_nothing() -> None:
    new_state, events = _play(
        "card.chance.advance_to_boardwalk",
        properties={BOARDWALK: PropertyState(owner=0)},
    )
    assert new_state.player(0).position == BOARDWALK
    assert not [event for event in events if isinstance(event, RentCharged)]
    assert new_state.phase is Phase.AWAITING_END_TURN


# --- Jail cards: use, and the deck they return to --------------------------


def test_a_kept_jail_card_makes_use_jail_card_legal_and_returns_to_its_own_deck() -> None:
    """G-11: the card returns to the bottom of the deck it came from, not the other one."""
    seats = (make_player(0, in_jail=True, jail_cards=(Deck.COMMUNITY_CHEST,)), make_player(1))
    state = make_state(seats=seats, phase=Phase.JAIL_DECISION)
    state = GameState(**(dict(state) | {"chance_deck": ("card.chance.speeding_fine",), "community_chest_deck": ()}))
    assert is_legal(state, UseJailCard(player=0))

    new_state, _ = apply(state, UseJailCard(player=0))
    assert new_state.player(0).jail_cards == ()
    assert new_state.community_chest_deck == (GET_OUT_OF_JAIL_IDS[Deck.COMMUNITY_CHEST],)
    assert new_state.chance_deck == ("card.chance.speeding_fine",), "the other deck is untouched"


def test_drawing_the_jail_card_then_using_it_round_trips_through_one_deck() -> None:
    drawn, _ = _play(
        "card.chance.get_out_of_jail_free",
        deck=("card.chance.get_out_of_jail_free", "card.chance.speeding_fine"),
    )
    assert drawn.player(0).jail_cards == (Deck.CHANCE,)
    jailed = GameState(
        **(
            dict(drawn)
            | {
                "players": (
                    PlayerState(**(dict(drawn.player(0)) | {"in_jail": True, "position": JAIL})),
                    *drawn.players[1:],
                ),
                "phase": Phase.JAIL_DECISION,
            }
        )
    )
    released, _ = apply(jailed, UseJailCard(player=0))
    assert released.chance_deck == ("card.chance.speeding_fine", GET_OUT_OF_JAIL_IDS[Deck.CHANCE])
    assert released.player(0).jail_cards == ()


# --- Every card, over three solvencies -------------------------------------

_ALL_CARDS = sorted(set(CHANCE_CARD_IDS) | set(COMMUNITY_CHEST_CARD_IDS))


@pytest.mark.parametrize("card_id", _ALL_CARDS)
@pytest.mark.parametrize("cash", (0, 25, 1500))
def test_every_card_rests_the_turn_and_balances_the_ledger(card_id: str, cash: int) -> None:
    """The sweep behind the named tests: all 31 cards at three cash levels.

    Three properties, each of which a single card getting its arithmetic wrong would break:
    the returned state never rests in a transient phase (the reducer's contract), every
    ledger entry's ``balance`` equals the running cash it claims (G-60), and a live game
    always offers somebody a move (the ADR-007 deadlock consequence).
    """
    owned = {
        B_AND_O_RAILROAD: PropertyState(owner=1),
        WATER_WORKS: PropertyState(owner=1),
        MEDITERRANEAN_AVENUE: PropertyState(owner=0, houses=3),
        BALTIC_AVENUE: PropertyState(owner=0, houses=3),
    }
    tile = CHANCE if card_id.startswith("card.chance.") else CHEST
    new_state, events = _play(card_id, tile=tile, cash=cash, properties=owned)

    assert new_state.phase is not Phase.CARD_RESOLUTION
    assert new_state.phase not in (Phase.MOVING, Phase.RESOLVING_TILE)
    assert legal_commands(new_state), f"{card_id} left nobody able to act"

    running = {0: cash, 1: 1500}
    for event in events:
        if isinstance(event, CashChanged):
            running[event.player] += event.delta
            assert running[event.player] == event.balance >= 0, f"{card_id} broke the ledger"
    for player_id, expected in running.items():
        assert new_state.player(player_id).cash == expected


# --- legal_commands and apply agree ----------------------------------------


def _enumerable(state: GameState) -> tuple[Command, ...]:
    from kesef_engine.commands import DeclareBankruptcy, EndTurn, RollForJail

    actors = [player.id for player in state.players]
    probes: list[Command] = []
    for actor in actors:
        probes.extend(
            [
                RollDice(player=actor),
                EndTurn(player=actor),
                RollForJail(player=actor),
                UseJailCard(player=actor),
                DeclareBankruptcy(player=actor),
            ]
        )
        for tile in (MEDITERRANEAN_AVENUE, BALTIC_AVENUE, BOARDWALK):
            probes.append(MortgageProperty(player=actor, tile=tile))
    return tuple(probes)


def test_legal_commands_and_apply_agree_in_card_resolution() -> None:
    """CARD_RESOLUTION is transient: a card either finishes or suspends into a debt, so a
    state resting there offers nothing — and ``apply`` must reject everything with a key,
    not crash."""
    card = CardFrame(resume=Phase.AWAITING_END_TURN, card_id="card.chance.speeding_fine", deck=Deck.CHANCE)
    state = make_state(phase=Phase.CARD_RESOLUTION, interrupts=(card,))
    assert legal_commands(state) == ()
    for command in _enumerable(state):
        assert not is_legal(state, command)
        with pytest.raises(IllegalCommandError) as raised:
            apply(state, command)
        assert raised.value.reason_key


def test_legal_commands_and_apply_agree_while_a_card_debt_is_live() -> None:
    """The reachable half: the card is suspended, the debtor is the only actor, and every
    command offered is accepted."""
    suspended, _ = _birthday_with_a_broke_payer()
    assert isinstance(suspended.pending_card, CardFrame)
    offered = legal_commands(suspended)
    assert offered, "a debtor is never offered nothing"
    assert {command.player for command in offered} == {1}, "only the debtor may act"
    for command in offered:
        apply(suspended, command)  # a raise here is the failure
    for command in _enumerable(suspended):
        if command in offered:
            continue
        with pytest.raises(IllegalCommandError) as raised:
            apply(suspended, command)
        assert raised.value.reason_key
