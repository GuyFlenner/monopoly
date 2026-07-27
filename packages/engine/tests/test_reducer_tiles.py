"""MON-108 — inert and cashflow tiles: taxes, GO, Free Parking, Go-To-Jail, just visiting."""

from __future__ import annotations

from helpers import make_player, make_state
from kesef_engine.commands import RollDice
from kesef_engine.events import CashChanged, DebtIncurred, Event, SentToJail, TokenMoved
from kesef_engine.phases import Phase
from kesef_engine.primitives import CashReason
from kesef_engine.rng import Rng
from kesef_engine.ruleset import Ruleset
from kesef_engine.state import DebtFrame, GameState

INCOME_TAX, LUXURY_TAX, GO_TO_JAIL, FREE_PARKING, JAIL, CHANCE = 4, 38, 30, 20, 10, 7

_PLAIN_SEED = next(seed for seed in range(1000) if (r := Rng(seed=seed).roll_dice())[0] != r[1])
_TOTAL = sum(Rng(seed=_PLAIN_SEED).roll_dice()[:2])


def _land_on(
    target: int, *, cash: int = 1500, ruleset: Ruleset | None = None, pot: int = 0
) -> tuple[GameState, tuple[Event, ...]]:
    """Roll the known seed's total onto ``target`` and return (state, events)."""
    from kesef_engine.reducer import apply

    start = (target - _TOTAL) % 40
    state = make_state(seats=(make_player(0, position=start, cash=cash), make_player(1)), seed=_PLAIN_SEED)
    if ruleset is not None or pot:
        state = GameState(**{**dict(state), "ruleset": ruleset or state.ruleset, "free_parking_pot": pot})
    return apply(state, RollDice(player=0))


def test_income_tax_charges_the_flat_amount_to_the_bank() -> None:
    new_state, events = _land_on(INCOME_TAX)  # the walk to tile 4 wraps past GO: salary first
    tax = next(e for e in events if isinstance(e, CashChanged) and e.reason is CashReason.TAX)
    assert (tax.delta, tax.counterparty) == (-200, "bank")
    assert tax.balance == 1500 == new_state.player(0).cash, "salary in, tax out"
    assert new_state.free_parking_pot == 0
    assert new_state.phase is Phase.AWAITING_END_TURN


def test_luxury_tax_charges_its_own_flat_amount() -> None:
    new_state, events = _land_on(LUXURY_TAX)
    tax = next(e for e in events if isinstance(e, CashChanged))
    assert tax.delta == -100
    assert new_state.player(0).cash == 1400


def test_an_unpayable_tax_opens_a_debt_to_the_bank() -> None:
    # Luxury tax: the walk there passes no GO, so no salary can rescue the payer.
    new_state, events = _land_on(LUXURY_TAX, cash=30)
    assert new_state.phase is Phase.DEBT_SETTLEMENT
    frame = new_state.top_interrupt
    assert isinstance(frame, DebtFrame)
    assert frame.reason is CashReason.TAX
    assert frame.total == 100
    assert frame.source_tile == LUXURY_TAX
    assert new_state.player(0).cash == 30, "shortfall-as-data: cash never goes negative"
    assert [e for e in events if isinstance(e, DebtIncurred)]
    assert not [e for e in events if isinstance(e, CashChanged)]


def test_the_tax_feeds_the_pot_under_the_house_rule() -> None:
    pot_rules = Ruleset.universal().model_copy(update={"free_parking_pot_enabled": True})
    new_state, events = _land_on(INCOME_TAX, ruleset=pot_rules)
    tax = next(e for e in events if isinstance(e, CashChanged) and e.reason is CashReason.TAX)
    assert tax.counterparty == "free_parking_pot"
    assert new_state.free_parking_pot == 200


def test_free_parking_pays_out_the_pot_when_enabled() -> None:
    pot_rules = Ruleset.universal().model_copy(update={"free_parking_pot_enabled": True})
    new_state, events = _land_on(FREE_PARKING, ruleset=pot_rules, pot=350)
    collected = next(e for e in events if isinstance(e, CashChanged))
    assert (collected.delta, collected.reason, collected.counterparty) == (
        350,
        CashReason.FREE_PARKING_POT,
        "free_parking_pot",
    )
    assert new_state.free_parking_pot == 0
    assert new_state.player(0).cash == 1850


def test_free_parking_is_inert_under_the_official_rules() -> None:
    new_state, events = _land_on(FREE_PARKING)
    assert not [e for e in events if isinstance(e, CashChanged)]
    assert new_state.phase is Phase.AWAITING_END_TURN


def test_go_to_jail_sends_without_salary() -> None:
    new_state, events = _land_on(GO_TO_JAIL)
    assert next(e for e in events if isinstance(e, SentToJail)).via == "tile"
    assert new_state.player(0).in_jail
    assert new_state.player(0).position == JAIL
    assert not [e for e in events if isinstance(e, CashChanged)], "going to jail is not passing GO"
    assert new_state.phase is Phase.AWAITING_END_TURN
    moved = next(e for e in events if isinstance(e, TokenMoved))
    assert moved.to_tile == GO_TO_JAIL, "the walk onto the tile still animates"


def test_just_visiting_is_inert() -> None:
    new_state, events = _land_on(JAIL)
    assert not new_state.player(0).in_jail
    assert not [e for e in events if isinstance(e, CashChanged)]
    assert not [e for e in events if isinstance(e, SentToJail)]


def test_card_tiles_are_inert_until_mon_206() -> None:
    new_state, events = _land_on(CHANCE)  # wraps past GO: only the salary moves money
    assert not [e for e in events if isinstance(e, CashChanged) and e.reason is not CashReason.GO_SALARY]
    assert new_state.phase is Phase.AWAITING_END_TURN
    assert new_state.chance_deck == (), "no card was drawn"


def test_landing_exactly_on_go_pays_the_salary_once() -> None:
    new_state, events = _land_on(0)
    salary = next(e for e in events if isinstance(e, CashChanged))
    assert (salary.delta, salary.reason) == (200, CashReason.GO_SALARY)
    assert len([e for e in events if isinstance(e, CashChanged)]) == 1


def test_landing_exactly_on_go_pays_double_under_the_house_rule() -> None:
    doubled = Ruleset.universal().model_copy(update={"double_salary_on_exact_go": True})
    _, events = _land_on(0, ruleset=doubled)
    salary = next(e for e in events if isinstance(e, CashChanged))
    assert salary.delta == 400
