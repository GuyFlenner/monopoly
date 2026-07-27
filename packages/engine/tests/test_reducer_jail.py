"""MON-102/MON-205 (M1 slice) — jail decisions. The full rule set lands with MON-205."""

from __future__ import annotations

from helpers import make_player, make_state
from kesef_engine.commands import PayJailFine, RollForJail, UseJailCard
from kesef_engine.events import CashChanged, DebtIncurred, DiceRolled, LeftJail, TokenMoved
from kesef_engine.phases import Phase
from kesef_engine.primitives import CashReason, Deck
from kesef_engine.reducer import apply
from kesef_engine.rng import Rng
from kesef_engine.state import DebtFrame, GameState, PropertyState

JAIL = 10

_DOUBLES_SEED = next(seed for seed in range(1000) if (r := Rng(seed=seed).roll_dice())[0] == r[1])
_PLAIN_SEED = next(seed for seed in range(1000) if (r := Rng(seed=seed).roll_dice())[0] != r[1])


def _jailed_state(
    *, cash: int = 1500, jail_turns: int = 0, seed: int = _PLAIN_SEED, cards: tuple[Deck, ...] = ()
) -> GameState:
    seats = (make_player(0, position=JAIL, in_jail=True, jail_turns=jail_turns, cash=cash, jail_cards=cards),)
    board = make_state().board
    inert_landings = {tile.index: PropertyState(owner=0) for tile in board.tiles if tile.is_ownable}
    return make_state(seats=(*seats, make_player(1)), seed=seed, phase=Phase.JAIL_DECISION, properties=inert_landings)


def test_paying_the_fine_releases_and_leaves_the_roll_to_come() -> None:
    state = _jailed_state()
    new_state, events = apply(state, PayJailFine(player=0))
    assert new_state.phase is Phase.AWAITING_ROLL
    assert not new_state.player(0).in_jail
    fine = next(e for e in events if isinstance(e, CashChanged))
    assert (fine.delta, fine.reason, fine.counterparty) == (-50, CashReason.JAIL_FINE, "bank")
    assert next(e for e in events if isinstance(e, LeftJail)).via == "fine"


def test_using_a_card_releases_and_returns_it_to_the_bottom_of_its_own_deck() -> None:
    state = _jailed_state(cards=(Deck.CHANCE,))
    new_state, events = apply(state, UseJailCard(player=0))
    assert new_state.phase is Phase.AWAITING_ROLL
    assert not new_state.player(0).in_jail
    assert new_state.player(0).jail_cards == ()
    assert new_state.chance_deck[-1] == "card.chance.get_out_of_jail_free"
    assert new_state.community_chest_deck == state.community_chest_deck
    assert next(e for e in events if isinstance(e, LeftJail)).via == "card"


def test_rolling_doubles_releases_moves_the_total_and_grants_no_extra_roll() -> None:
    state = _jailed_state(seed=_DOUBLES_SEED)
    new_state, events = apply(state, RollForJail(player=0))
    rolled = next(e for e in events if isinstance(e, DiceRolled))
    assert rolled.purpose == "jail"
    assert not new_state.player(0).in_jail
    assert new_state.player(0).position == JAIL + rolled.total
    assert new_state.phase is Phase.AWAITING_END_TURN, "release by doubles does not grant another roll"
    assert new_state.doubles_streak == 0, "a jail roll never feeds the doubles streak"
    assert next(e for e in events if isinstance(e, LeftJail)).via == "doubles"


def test_a_failed_roll_counts_a_jail_turn_and_ends_the_turn() -> None:
    state = _jailed_state(seed=_PLAIN_SEED)
    new_state, events = apply(state, RollForJail(player=0))
    assert new_state.player(0).in_jail
    assert new_state.player(0).jail_turns == 1
    assert new_state.phase is Phase.AWAITING_END_TURN
    assert not [e for e in events if isinstance(e, TokenMoved)]


def test_the_compulsory_fine_after_max_jail_turns_pays_and_moves_the_roll() -> None:
    state = _jailed_state(seed=_PLAIN_SEED, jail_turns=2)  # universal max_jail_turns=3
    new_state, events = apply(state, RollForJail(player=0))
    rolled = next(e for e in events if isinstance(e, DiceRolled))
    fine = next(e for e in events if isinstance(e, CashChanged))
    assert (fine.delta, fine.reason) == (-50, CashReason.JAIL_FINE)
    assert not new_state.player(0).in_jail
    assert new_state.player(0).position == JAIL + rolled.total
    assert next(e for e in events if isinstance(e, LeftJail)).via == "time_served"


def test_an_unaffordable_compulsory_fine_opens_a_debt() -> None:
    state = _jailed_state(seed=_PLAIN_SEED, jail_turns=2, cash=10)
    new_state, events = apply(state, RollForJail(player=0))
    assert new_state.phase is Phase.DEBT_SETTLEMENT
    frame = new_state.top_interrupt
    assert isinstance(frame, DebtFrame)
    assert frame.debtor == 0
    assert frame.reason is CashReason.JAIL_FINE
    assert frame.total == 50
    assert new_state.player(0).in_jail, "still jailed until the fine is raised"
    incurred = next(e for e in events if isinstance(e, DebtIncurred))
    assert (incurred.creditor, incurred.amount) == ("bank", 50)


def test_the_fine_feeds_the_pot_under_the_house_rule() -> None:
    base = _jailed_state()
    ruleset = base.ruleset.model_copy(update={"free_parking_pot_enabled": True})
    state = GameState(**{**dict(base), "ruleset": ruleset})
    new_state, events = apply(state, PayJailFine(player=0))
    assert new_state.free_parking_pot == 50
    fine = next(e for e in events if isinstance(e, CashChanged))
    assert fine.counterparty == "free_parking_pot"
