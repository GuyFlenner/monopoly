"""MON-205 — jail, in full.

The commonly mis-implemented rules are named here: release by doubles moves the rolled
total and grants no further roll, jail rolls never touch ``doubles_streak`` (GAP G-12), the
compulsory fine after ``max_jail_turns`` escalates to ``DEBT_SETTLEMENT`` when it cannot be
paid *and still moves the roll once settled*, and jail is not a pause — rent, building and
trading all continue from the cell (spec §3.6 trap 8).
"""

from __future__ import annotations

from helpers import make_player, make_state
from kesef_engine.commands import (
    BuildHouse,
    DeclareBankruptcy,
    MortgageProperty,
    PayJailFine,
    ProposeTrade,
    RollForJail,
    TradeOffer,
    TradeSide,
    UseJailCard,
)
from kesef_engine.events import CashChanged, DebtIncurred, DiceRolled, LeftJail, RentCharged, TokenMoved
from kesef_engine.legality import is_legal, legal_commands
from kesef_engine.phases import Phase
from kesef_engine.primitives import CashReason, Deck
from kesef_engine.reducer import apply
from kesef_engine.rng import Rng
from kesef_engine.rules import tiles
from kesef_engine.state import DebtFrame, GameState, Obligation, PropertyState

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


# --- MON-205: the full rule set ----------------------------------------------


def test_settling_the_compulsory_fine_releases_and_still_walks_the_roll() -> None:
    """The M1 stopgap forfeited the movement: the fine was paid out of the DebtFrame and
    the player left the cell standing on the jail tile. The official rule moves the total
    of the roll that failed, which is why the dice survive in ``state.dice``."""
    state = _jailed_state(seed=_PLAIN_SEED, jail_turns=2, cash=10)
    debted, _ = apply(state, RollForJail(player=0))
    assert debted.phase is Phase.DEBT_SETTLEMENT
    rolled = debted.dice
    assert rolled is not None and rolled.purpose == "jail"

    # Mortgaging the railroad raises 100, and settlement is automatic — there is no
    # PayDebt command, because raising the money is the move and paying it is not optional.
    settled, events = apply(debted, MortgageProperty(player=0, tile=5))
    assert not settled.player(0).in_jail
    assert settled.player(0).jail_turns == 0
    assert settled.player(0).position == JAIL + rolled.total, "the failed roll's movement happens"
    assert settled.phase is Phase.AWAITING_END_TURN, "release never grants another roll"
    assert settled.doubles_streak == 0
    assert next(e for e in events if isinstance(e, LeftJail)).via == "time_served"
    assert [e for e in events if isinstance(e, TokenMoved)], "the token moved on settlement"


def test_the_voluntary_fine_does_not_move_the_player() -> None:
    """The negative half of the test above: paying the fine as a *decision* leaves the roll
    to come, so a mover there would move the player twice in one turn."""
    state = _jailed_state()
    new_state, events = apply(state, PayJailFine(player=0))
    assert new_state.player(0).position == JAIL
    assert new_state.phase is Phase.AWAITING_ROLL
    assert not [e for e in events if isinstance(e, TokenMoved)]


def test_a_jailed_player_still_collects_rent() -> None:
    """Spec §3.6 trap 8: jail is not a pause."""
    seats = (make_player(0, position=JAIL, in_jail=True), make_player(1, position=5))
    state = make_state(seats=seats, phase=Phase.JAIL_DECISION, properties={5: PropertyState(owner=0)})
    moved, events = tiles.resolve_landing(state, 1)
    charged = next(e for e in events if isinstance(e, RentCharged))
    assert (charged.owner, charged.amount) == (0, 25)
    assert moved.player(0).cash == 1525, "the jailed owner was paid"
    assert moved.player(0).in_jail, "and is still in the cell"


def test_a_jailed_player_may_build_and_trade() -> None:
    """Trap 8's other half: JAIL_DECISION is a portfolio phase (GAP G-5)."""
    seats = (make_player(0, position=JAIL, in_jail=True), make_player(1))
    state = make_state(
        seats=seats,
        phase=Phase.JAIL_DECISION,
        properties={1: PropertyState(owner=0), 3: PropertyState(owner=0)},
    )
    builds = {c.tile for c in legal_commands(state) if isinstance(c, BuildHouse) and c.player == 0}
    assert builds == {1, 3}
    built, _ = apply(state, BuildHouse(player=0, tile=1))
    assert built.properties[1].houses == 1
    assert built.phase is Phase.JAIL_DECISION, "the cell door did not open"

    offer = TradeOffer(proposer=0, recipient=1, give=TradeSide(tiles=(1,)), receive=TradeSide(cash=100))
    assert is_legal(state, ProposeTrade(player=0, offer=offer)).legal


def test_a_player_who_goes_bankrupt_while_jailed_leaves_no_dangling_cell() -> None:
    """The invariant: bankrupt implies not in jail, no jail cards, no tiles."""
    seats = (
        make_player(0, position=JAIL, in_jail=True, jail_turns=1, cash=10, jail_cards=(Deck.CHANCE,)),
        make_player(1),
        make_player(2),
    )
    debt = DebtFrame(
        resume=Phase.AWAITING_END_TURN,
        debtor=0,
        obligations=(Obligation(creditor=1, amount=900),),
        reason=CashReason.RENT,
    )
    state = make_state(
        seats=seats,
        phase=Phase.DEBT_SETTLEMENT,
        interrupts=(debt,),
        properties={1: PropertyState(owner=0)},
    )
    new_state, _ = apply(state, DeclareBankruptcy(player=0))
    loser = new_state.player(0)
    assert loser.bankrupt
    assert not loser.in_jail and loser.jail_turns == 0
    assert loser.jail_cards == ()
    assert new_state.tiles_owned_by(0) == ()


def test_a_jail_roll_never_feeds_the_doubles_streak() -> None:
    """G-12, restated as a property of the streak rather than of one roll: two failed jail
    rolls in a row leave the streak where it started, so the three-doubles rule cannot be
    triggered from inside the cell."""
    state = _jailed_state(seed=_DOUBLES_SEED)
    assert state.doubles_streak == 0
    released, events = apply(state, RollForJail(player=0))
    rolled = next(e for e in events if isinstance(e, DiceRolled))
    assert rolled.first == rolled.second, "a doubles roll, which would normally count"
    assert rolled.doubles_streak == 0
    assert released.doubles_streak == 0
