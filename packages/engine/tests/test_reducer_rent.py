"""MON-104 — rent. The single most-often-wrong area: each backlog bullet is a named test."""

from __future__ import annotations

import pytest

from helpers import make_player, make_state
from kesef_engine.commands import EndTurn, RollDice
from kesef_engine.events import CashChanged, DebtIncurred, DiceRolled, Event, RentCharged, RentQuote
from kesef_engine.legality import is_legal
from kesef_engine.phases import Phase
from kesef_engine.primitives import CashReason
from kesef_engine.rng import Rng
from kesef_engine.state import HOTEL_LEVEL, DebtFrame, DiceState, GameState, PropertyState

_PLAIN_SEED = next(seed for seed in range(1000) if (r := Rng(seed=seed).roll_dice())[0] != r[1])
_DOUBLES_SEED = next(seed for seed in range(1000) if (r := Rng(seed=seed).roll_dice())[0] == r[1])
ORANGES = (16, 18, 19)  # New York Avenue is 19: rent (16, 80, 220, 600, 800, 1000)
RAILROADS = (5, 15, 25, 35)
ELECTRIC, WATER = 12, 28


def _total(seed: int) -> int:
    return sum(Rng(seed=seed).roll_dice()[:2])


def _land_on(
    target: int,
    properties: dict[int, PropertyState],
    *,
    seed: int = _PLAIN_SEED,
    cash: int = 1500,
) -> tuple[GameState, tuple[Event, ...]]:
    from kesef_engine.reducer import apply

    start = (target - _total(seed)) % 40
    seats = (make_player(0, position=start, cash=cash), make_player(1), make_player(2))
    state = make_state(seats=seats, seed=seed, properties=properties)
    return apply(state, RollDice(player=0))


def _rent_event(events: tuple[Event, ...]) -> RentCharged:
    return next(e for e in events if isinstance(e, RentCharged))


def test_property_rent_follows_the_house_tier() -> None:
    new_state, events = _land_on(19, {19: PropertyState(owner=1, houses=3)})
    rent = _rent_event(events)
    assert (rent.payer, rent.owner, rent.tile, rent.amount) == (0, 1, 19, 600)
    assert (rent.base_rent, rent.houses, rent.multiplier) == (600, 3, 1)
    moves = [e for e in events if isinstance(e, CashChanged)]
    assert [(e.player, e.delta, e.counterparty) for e in moves] == [(0, -600, 1), (1, 600, 0)]
    assert new_state.player(0).cash == 900
    assert new_state.player(1).cash == 2100


def test_undeveloped_rent_doubles_when_the_owner_holds_the_whole_group() -> None:
    props = {tile: PropertyState(owner=1) for tile in ORANGES}
    _, events = _land_on(19, props)
    rent = _rent_event(events)
    assert (rent.amount, rent.base_rent, rent.multiplier) == (32, 16, 2)
    assert "rent.note.full_group_doubled" in rent.note_keys


def test_undeveloped_rent_stays_single_without_the_whole_group() -> None:
    _, events = _land_on(19, {19: PropertyState(owner=1), 16: PropertyState(owner=1)})
    rent = _rent_event(events)
    assert (rent.amount, rent.multiplier) == (16, 1)


def test_a_mortgaged_property_charges_no_rent() -> None:
    new_state, events = _land_on(19, {19: PropertyState(owner=1, mortgaged=True)})
    assert not [e for e in events if isinstance(e, RentCharged)]
    assert not [e for e in events if isinstance(e, CashChanged)]
    assert new_state.phase is Phase.AWAITING_END_TURN


def test_a_mortgaged_sibling_still_counts_toward_group_completion() -> None:
    props = {
        16: PropertyState(owner=1, mortgaged=True),
        18: PropertyState(owner=1),
        19: PropertyState(owner=1),
    }
    _, events = _land_on(19, props)
    rent = _rent_event(events)
    assert (rent.amount, rent.multiplier) == (32, 2), "the mortgaged member completes the group"


@pytest.mark.parametrize(("owned", "expected"), [(1, 25), (2, 50), (3, 100), (4, 200)])
def test_railroad_rent_climbs_25_50_100_200_by_count_owned(owned: int, expected: int) -> None:
    props = {tile: PropertyState(owner=1) for tile in RAILROADS[:owned]}
    _, events = _land_on(15 if owned >= 2 else 5, props)
    rent = _rent_event(events)
    assert rent.amount == expected
    assert rent.note_keys == ("rent.note.railroad_count",)
    assert rent.note_params == {"count": owned}


def test_utility_rent_is_four_times_the_dice_with_one_owned() -> None:
    _, events = _land_on(ELECTRIC, {ELECTRIC: PropertyState(owner=1)})
    rent = _rent_event(events)
    assert rent.amount == 4 * _total(_PLAIN_SEED)
    assert (rent.multiplier, rent.dice_total) == (4, _total(_PLAIN_SEED))
    assert "rent.note.utility_multiplier" in rent.note_keys


def test_utility_rent_is_ten_times_the_dice_with_both_owned() -> None:
    props = {ELECTRIC: PropertyState(owner=1), WATER: PropertyState(owner=1)}
    _, events = _land_on(ELECTRIC, props)
    rent = _rent_event(events)
    assert rent.amount == 10 * _total(_PLAIN_SEED)
    assert rent.multiplier == 10


def test_a_card_arrival_rolls_fresh_dice_for_the_utility_rent() -> None:
    """The MON-206 hook, mechanics landed now: a purpose='rent' roll prices the charge."""
    from kesef_engine.rules import rent as rent_module

    seats = (make_player(0, position=ELECTRIC), make_player(1))
    state = make_state(seats=seats, seed=_PLAIN_SEED, properties={ELECTRIC: PropertyState(owner=1)})
    new_state, events = rent_module.charge(state, 0, ELECTRIC, roll_for_amount=True)
    rolled = next(e for e in events if isinstance(e, DiceRolled))
    assert rolled.purpose == "rent"
    rent = _rent_event(events)
    assert rent.amount == 4 * rolled.total
    assert rent.dice_total == rolled.total
    assert new_state.doubles_streak == state.doubles_streak, "a rent roll never feeds the streak"


def test_a_utility_rent_roll_does_not_forfeit_the_doubles_re_roll() -> None:
    """The other half of GAP G-10: the resting phase is decided by the *move* roll that
    brought the player here, so a doubles arrival on a utility keeps its extra roll. Rent
    used to recompute the phase from post-roll state, where ``purpose='rent'`` reads as
    "no doubles" and the earned roll vanished."""
    from kesef_engine.rules import rent as rent_module

    seats = (make_player(0, position=ELECTRIC), make_player(1))
    state = make_state(seats=seats, seed=_PLAIN_SEED, properties={ELECTRIC: PropertyState(owner=1)})
    doubles = DiceState(first=4, second=4, purpose="move")
    state = GameState(**{**dict(state), "dice": doubles, "doubles_streak": 1})
    new_state, events = rent_module.charge(state, 0, ELECTRIC, roll_for_amount=True)
    assert next(e for e in events if isinstance(e, DiceRolled)).purpose == "rent"
    assert new_state.phase is Phase.AWAITING_ROLL, "the doubles re-roll survives the rent roll"
    assert new_state.doubles_streak == 1, "and the rent roll still does not feed the streak"


def test_the_owner_is_never_charged_their_own_rent() -> None:
    _, events = _land_on(19, {19: PropertyState(owner=0)})
    assert not [e for e in events if isinstance(e, RentCharged)]


def test_a_bankrupt_owners_tiles_charge_nothing() -> None:
    from kesef_engine.reducer import apply

    start = (19 - _total(_PLAIN_SEED)) % 40
    seats = (make_player(0, position=start), make_player(1), make_player(2, cash=0, bankrupt=True))
    state = make_state(seats=seats, seed=_PLAIN_SEED, properties={19: PropertyState(owner=2)})
    state = GameState(**{**dict(state), "elimination_order": (2,)})
    _, events = apply(state, RollDice(player=0))
    assert not [e for e in events if isinstance(e, RentCharged)]
    assert not [e for e in events if isinstance(e, CashChanged)]


def test_unpayable_rent_opens_a_debt_to_the_owner() -> None:
    new_state, events = _land_on(19, {19: PropertyState(owner=1, houses=3)}, cash=100)
    assert new_state.phase is Phase.DEBT_SETTLEMENT
    frame = new_state.top_interrupt
    assert isinstance(frame, DebtFrame)
    assert (frame.debtor, frame.reason, frame.total) == (0, CashReason.RENT, 600)
    assert frame.obligations[0].creditor == 1
    assert frame.source_tile == 19
    rent = _rent_event(events)
    assert rent.amount == 600, "the figure is still explained even when it cannot be paid"
    assert [e for e in events if isinstance(e, DebtIncurred)]
    assert not [e for e in events if isinstance(e, CashChanged)], "no partial payment: shortfall-as-data"
    assert new_state.player(0).cash == 100


def test_paying_rent_on_doubles_still_grants_the_extra_roll() -> None:
    target = (0 + _total(_DOUBLES_SEED)) % 40
    board = make_state().board
    if not board.tile(target).is_ownable:  # keep the test honest for any doubles seed
        pytest.skip("this doubles seed does not land on an ownable tile from GO")
    new_state, _ = _land_on(target, {target: PropertyState(owner=1)}, seed=_DOUBLES_SEED)
    assert new_state.phase is Phase.AWAITING_ROLL


class TestEveryRentIsExplained:
    """Spec §5.5: every rent figure can be *explained*, not merely charged (MON-416).

    This is a product gate, written into ``CLAUDE.md`` — "every rent figure can be explained, not
    merely charged (``rent.note.*`` keys exist for this reason)" — and it was unmet in the one case
    that matters most. ``_property_rent`` emitted ``note_keys=()`` unless the whole-group doubling
    applied, so the commonest rent in the game, the printed figure on a lone unimproved square, was
    the only charge with no reason attached. The utility, railroad and card paths always explained
    themselves; the plain case did not.

    Four cases, and the ordering between them is the part worth testing: a built square is never
    *also* group-doubled, because the doubling exists to compensate for having no houses.
    """

    def test_a_plain_unimproved_square_says_it_is_the_printed_rent(self) -> None:
        _, events = _land_on(19, {19: PropertyState(owner=1)})
        rent = _rent_event(events)
        assert rent.note_keys == ("rent.note.base",)
        assert rent.multiplier == 1

    def test_houses_say_how_many(self) -> None:
        _, events = _land_on(19, {19: PropertyState(owner=1, houses=3)}, cash=5000)
        rent = _rent_event(events)
        assert rent.note_keys == ("rent.note.with_houses",)
        # The figure jumped because of the tier ladder, so the count is what explains it.
        assert rent.note_params == {"houses": 3}

    def test_a_hotel_says_hotel_rather_than_five_houses(self) -> None:
        # "Five houses" is the engine's representation; "a hotel" is what a child sees on the square.
        _, events = _land_on(19, {19: PropertyState(owner=1, houses=HOTEL_LEVEL)}, cash=5000)
        rent = _rent_event(events)
        assert rent.note_keys == ("rent.note.with_hotel",)

    def test_the_group_doubling_still_wins_on_an_unimproved_group(self) -> None:
        # Regression guard on the ordering: this case existed before MON-416 and must not have been
        # displaced by the new branches above it.
        group = make_state().board.tile(19).group
        assert group is not None
        siblings = {tile.index: PropertyState(owner=1) for tile in make_state().board.tiles if tile.group is group}
        _, events = _land_on(19, siblings)
        rent = _rent_event(events)
        assert rent.note_keys == ("rent.note.full_group_doubled",)
        assert rent.multiplier == 2

    def test_the_doubling_note_names_the_group_as_a_key_and_carries_its_multiplier(self) -> None:
        """MON-415: a key, not ``ColorGroup.value``, and the figure the note is about.

        ``note_params={"group": "light_blue"}`` was the one place a raw engine enum reached a
        sentence: the client had to hold a ``Record<ColorGroup, string>`` and translate at the
        render boundary, or a Hebrew page said ``light_blue``. The ``_key`` suffix is what makes
        it resolvable without the client knowing the enum exists. ``multiplier`` travels because
        this was the only note whose own number it could not state.
        """
        group = make_state().board.tile(19).group
        assert group is not None
        siblings = {tile.index: PropertyState(owner=1) for tile in make_state().board.tiles if tile.group is group}
        rent = _rent_event(_land_on(19, siblings)[1])
        assert rent.note_params == {"group_key": f"group.{group.value}", "multiplier": 2}
        # The falsifier: the bare enum value must not be anywhere in the params.
        assert group.value not in rent.note_params.values()

    def test_no_rent_the_engine_can_charge_is_ever_unexplained(self) -> None:
        """The invariant, over played games rather than over the four cases above.

        The unit tests pin the *wording* of each case; this pins the property the gate actually
        states, across every rent any path can produce — including the utility and railroad ones, and
        including whatever a card reroutes. A fifth rent path added without a note fails here even if
        nobody thinks to write a unit test for it.
        """
        from kesef_engine.reducer import apply  # local, like every other apply in this file

        charged = 0
        for seed in range(40):
            state = make_state(seats=(make_player(0, cash=100_000), make_player(1, cash=100_000)), seed=seed)
            # Give player 1 the whole board's ownables, so almost every landing charges rent.
            state = GameState(
                **{
                    **dict(state),
                    "properties": tuple(
                        PropertyState(owner=1) if tile.is_ownable else prop
                        for tile, prop in zip(state.board.tiles, state.properties, strict=True)
                    ),
                }
            )
            for _ in range(30):
                if not is_legal(state, RollDice(player=state.current_player_id)).legal:
                    break
                state, events = apply(state, RollDice(player=state.current_player_id))
                for rent in (e for e in events if isinstance(e, RentCharged)):
                    charged += 1
                    assert rent.note_keys, f"rent of {rent.amount} on tile {rent.tile} has no explanation"
                if is_legal(state, EndTurn(player=state.current_player_id)).legal:
                    state, _ = apply(state, EndTurn(player=state.current_player_id))

        # A test that charged no rent would pass while asserting nothing.
        assert charged > 20, f"only {charged} rents charged — the fixture stopped exercising rent"


class TestRentDueQuotesWhatASquareWouldCharge:
    """MON-420 — ``state.rent_due(tile, payer_id=…)``: the charge, before the landing.

    The multipliers lived only inside ``rules.rent``'s private property path, so MON-405/406's
    "explain this rent" screen had nothing to render and its only options were silence or a second
    copy of the tier ladder in TypeScript. What makes the accessor worth having rather than merely
    convenient is that a quote and a charge are *one shape* — asserted below on the field sets, not
    on a sample, so the two cannot drift the first time either gains a note.
    """

    def test_a_quote_and_a_charge_are_the_same_shape(self) -> None:
        assert set(RentQuote.model_fields) | {"type", "payer"} == set(RentCharged.model_fields)

    def test_an_unimproved_street_quotes_its_printed_rent_with_the_same_note(self) -> None:
        state = make_state(properties={19: PropertyState(owner=1)})
        quoted = state.rent_due(19, payer_id=0)
        assert quoted is not None
        assert quoted.owner == 1
        assert quoted.amount == state.board.tile(19).rent[0]
        assert quoted.note_keys == ("rent.note.base",)
        # And it is the figure the charge actually takes, read off a real landing rather than
        # recomputed here: a quote agreeing with a second copy of the rule would prove nothing.
        charged = _rent_event(_land_on(19, {19: PropertyState(owner=1)})[1])
        assert (quoted.amount, quoted.note_keys) == (charged.amount, charged.note_keys)

    def test_a_hotel_quotes_the_top_tier_and_says_hotel(self) -> None:
        state = make_state(properties={19: PropertyState(owner=1, houses=HOTEL_LEVEL)})
        quoted = state.rent_due(19, payer_id=0)
        assert quoted is not None
        assert quoted.amount == state.board.tile(19).rent[HOTEL_LEVEL]
        assert quoted.houses == HOTEL_LEVEL
        assert quoted.note_keys == ("rent.note.with_hotel",)

    def test_a_full_group_quotes_the_doubling_with_the_group_as_a_key(self) -> None:
        board = make_state().board
        group = board.tile(19).group
        assert group is not None
        siblings = {tile.index: PropertyState(owner=1) for tile in board.tiles if tile.group is group}
        quoted = make_state(properties=siblings).rent_due(19, payer_id=0)
        assert quoted is not None
        assert quoted.multiplier == 2
        assert quoted.amount == board.tile(19).rent[0] * 2
        assert quoted.note_params == {"group_key": f"group.{group.value}", "multiplier": 2}

    def test_a_railroad_quotes_by_how_many_the_owner_holds(self) -> None:
        board = make_state().board
        state = make_state(properties={index: PropertyState(owner=1) for index in RAILROADS[:3]})
        quoted = state.rent_due(RAILROADS[0], payer_id=0)
        assert quoted is not None
        assert quoted.amount == board.tile(RAILROADS[0]).rent[2]
        assert quoted.note_params == {"count": 3}

    def test_a_utility_quotes_its_multiplier_and_no_amount_because_the_throw_has_not_happened(self) -> None:
        """The documented caveat. An invented amount would be a number the engine cannot stand
        behind, and quoting must not roll — ``rent_due`` is asked for every square on every frame.
        """
        state = make_state(properties={ELECTRIC: PropertyState(owner=1)})
        quoted = state.rent_due(ELECTRIC, payer_id=0)
        assert quoted is not None
        assert quoted.amount is None
        assert quoted.dice_total is None
        assert quoted.multiplier == 4
        assert quoted.note_keys == ("rent.note.utility_quote",)
        # Both utilities held is the other tier, and still no amount.
        both = make_state(properties={index: PropertyState(owner=1) for index in (ELECTRIC, WATER)})
        quoted_both = both.rent_due(ELECTRIC, payer_id=0)
        assert quoted_both is not None and (quoted_both.multiplier, quoted_both.amount) == (10, None)

    def test_quoting_a_utility_leaves_the_state_and_its_rng_untouched(self) -> None:
        """Roll-free, measured rather than asserted: a quote that rolled would advance the RNG,
        and every subsequent dice roll in the game would then be a different one."""
        state = make_state(properties={ELECTRIC: PropertyState(owner=1)})
        before = state.model_dump_json()
        for _ in range(3):
            state.rent_due(ELECTRIC, payer_id=0)
        assert state.model_dump_json() == before

    @pytest.mark.parametrize(
        ("properties", "why"),
        [
            ({}, "nobody owns it"),
            ({19: PropertyState(owner=0)}, "nobody pays themselves"),
            ({19: PropertyState(owner=1, mortgaged=True)}, "a mortgaged deed is dormant (trap 2)"),
        ],
    )
    def test_a_square_that_charges_nothing_quotes_nothing(self, properties: dict[int, PropertyState], why: str) -> None:
        """``None`` rather than a zero, and for the same reasons ``charge`` short-circuits on —
        read from one place, so a quote can never promise a rent the charge would not take."""
        assert make_state(properties=properties).rent_due(19, payer_id=0) is None, why

    def test_a_bankrupt_owners_square_quotes_nothing(self) -> None:
        seats = (make_player(0), make_player(1, bankrupt=True))
        state = make_state(seats=seats, properties={19: PropertyState(owner=1)}, current=0)
        assert state.rent_due(19, payer_id=0) is None

    def test_every_ownable_square_quotes_an_explanation(self) -> None:
        """The gate one layer out: the quote path is a second way to produce a rent figure, so
        "no rent is ever unexplained" has to hold for it too, not only for what ``charge`` emits."""
        board = make_state().board
        owned = {tile.index: PropertyState(owner=1) for tile in board.tiles if tile.is_ownable}
        state = make_state(properties=owned)
        priced = [
            quoted for tile in state.board.tiles if (quoted := state.rent_due(tile.index, payer_id=0)) is not None
        ]
        assert len(priced) == 28, "every ownable square should quote something"
        for entry in priced:
            assert entry.note_keys, f"tile {entry.tile} quotes {entry.amount} with no explanation"
