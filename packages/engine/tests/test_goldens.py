"""MON-107 — the golden-game regression net.

Each committed golden replays its recorded commands from ``new_game`` and must land on
the *exact* recorded final state plus the recorded event projection. The regenerator
(``python -m kesef_engine.goldens --regenerate``) is a separate entry point this module
never imports; CI additionally fails on any uncommitted diff under ``tests/goldens/``,
so regeneration is always a visible, reviewed act.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import TypeAdapter

from kesef_engine.board.models import BOARD_SIZE
from kesef_engine.commands import BuildHouse, Command
from kesef_engine.events import (
    AuctionStarted,
    BidPlaced,
    BuildingChanged,
    CardDrawn,
    CashChanged,
    DiceRolled,
    Event,
    MortgageChanged,
    PhaseChanged,
    PlayerBankrupted,
    RentCharged,
    SentToJail,
    TokenMoved,
)
from kesef_engine.factory import Seat, new_game
from kesef_engine.legality import is_legal
from kesef_engine.phases import PORTFOLIO_PHASES, Phase
from kesef_engine.primitives import AuctionReason, CashReason, Deck, TileLot
from kesef_engine.reducer import apply, apply_all
from kesef_engine.ruleset import Ruleset
from kesef_engine.state import GameState

GOLDENS_DIR = Path(__file__).parent / "goldens"
GOLDEN_PATHS = sorted(path for path in GOLDENS_DIR.glob("*.json") if path.name != "traps.json")
GOLDEN_NAMES = [path.stem for path in GOLDEN_PATHS]
ALL_TRAPS = {str(number) for number in range(1, 11)}
"""Every trap in spec §3.6. M1 mapped 1, 2, 7, 9 and 10; MON-209 added 3, 4, 5, 6 and 8, so
each of the ten rules "usually got wrong" now has a golden and an event index where it
demonstrably occurred through real play."""

_COMMANDS: TypeAdapter[Command] = TypeAdapter(Command)


def _load(path: Path) -> dict[str, Any]:
    payload: dict[str, Any] = json.loads(path.read_text(encoding="ascii"))
    return payload


def _replay(golden: dict[str, Any]) -> tuple[GameState, tuple[Event, ...]]:
    state = new_game(
        tuple(Seat.model_validate(seat) for seat in golden["seats"]),
        seed=golden["seed"],
        board_id=golden["board_id"],
        ruleset=Ruleset.model_validate(golden["ruleset"]),
    )
    return apply_all(state, tuple(_COMMANDS.validate_python(command) for command in golden["commands"]))


def _project(event: Event) -> dict[str, Any]:
    """(type, actor, principal amount). Duplicated knowingly from the regenerator —
    the test must not import it; drift between the copies fails the comparison."""
    dumped = event.model_dump(mode="json")
    player = next((dumped[field] for field in ("player", "payer", "debtor", "winner") if field in dumped), None)
    amount = next((dumped[field] for field in ("delta", "amount", "price", "total") if field in dumped), None)
    return {"type": dumped["type"], "player": player, "amount": amount}


SCARCE_BANK_GOLDEN = "scarce_bank_traps_seed_18"
"""The MON-209 golden: a small building bank, cards throughout, and a bankruptcy *to the bank*
whose whole estate goes to a queued auction. Named as a constant so a rename is a compile-time
break rather than a silently skipped test."""


def test_at_least_four_goldens_are_committed_and_one_ends_in_bankruptcy() -> None:
    assert len(GOLDEN_PATHS) >= 4
    bankruptcies = [path.stem for path in GOLDEN_PATHS if _load(path)["final_state"]["elimination_order"]]
    assert bankruptcies, "at least one golden must end in a bankruptcy"


def test_the_scarce_bank_golden_deals_cards_and_auctions_a_whole_bank_estate(
    replayed: dict[str, tuple[Event, ...]],
) -> None:
    """MON-209's added golden, pinned by what it is *for*.

    A recorded game that deals cards and liquidates an estate to the bank in a queued multi-lot
    auction — the two things the M1 corpus never did together, and the combination that ties
    MON-206's decks to MON-207's cascades in one replayable game rather than in two hand-built
    positions.
    """
    events = replayed[SCARCE_BANK_GOLDEN]
    drawn = [event for event in events if isinstance(event, CardDrawn)]
    assert len(drawn) >= 20, f"only {len(drawn)} cards were dealt"
    assert len({event.card_id for event in drawn}) >= 20, "the same few cards over and over is not deck coverage"

    to_the_bank = [event for event in events if isinstance(event, PlayerBankrupted) and event.creditor == "bank"]
    assert to_the_bank, "no bankruptcy to the bank, so there is no estate auction to exercise"
    lots = [
        event
        for event in events
        if isinstance(event, AuctionStarted) and event.reason is AuctionReason.BANKRUPTCY_TO_BANK
    ]
    assert len(lots) == len(to_the_bank[0].tiles_transferred) >= 2, "every deed in the estate is offered, in turn"
    assert _load(GOLDENS_DIR / f"{SCARCE_BANK_GOLDEN}.json")["final_state"]["phase"] == "game_over"


@pytest.mark.parametrize("path", GOLDEN_PATHS, ids=GOLDEN_NAMES)
def test_replay_reaches_the_exact_recorded_final_state(path: Path) -> None:
    golden = _load(path)
    final_state, _ = _replay(golden)
    assert json.loads(final_state.model_dump_json()) == golden["final_state"]


@pytest.mark.parametrize("path", GOLDEN_PATHS, ids=GOLDEN_NAMES)
def test_replay_reproduces_the_recorded_event_projection(path: Path) -> None:
    golden = _load(path)
    _, events = _replay(golden)
    assert [_project(event) for event in events] == golden["events"]


@pytest.mark.parametrize("path", GOLDEN_PATHS, ids=GOLDEN_NAMES)
def test_the_recorded_rng_draw_costs_still_hold(path: Path) -> None:
    """A changed dice or shuffle cost is a named failure here, never a mystery golden
    shift: two draws roll the dice, fifteen shuffle a sixteen-card deck."""
    from kesef_engine.rng import Rng

    probe = Rng(seed=1)
    _, _, after_dice = probe.roll_dice()
    _, after_shuffle = probe.shuffled(tuple(range(16)))
    actual = {"dice_roll_draws": after_dice.counter, "deck_shuffle_draws_16": after_shuffle.counter}
    assert _load(path)["rng_costs"] == actual


@pytest.mark.parametrize("path", GOLDEN_PATHS, ids=GOLDEN_NAMES)
def test_the_ledger_balances_on_replay(path: Path) -> None:
    """Every CashChanged balance must equal the running cash it claims — the ledger
    rule (G-60) audited over whole recorded games, not single commands."""
    golden = _load(path)
    running = dict.fromkeys(range(len(golden["seats"])), golden["ruleset"]["starting_cash"])
    _, events = _replay(golden)
    for event in events:
        if isinstance(event, CashChanged):
            running[event.player] += event.delta
            assert running[event.player] == event.balance >= 0


# --- traps.json: every §3.6 trap occurred through real play ------------------------


def test_traps_json_maps_every_trap_in_the_spec() -> None:
    traps = _load(GOLDENS_DIR / "traps.json")
    assert set(traps) == ALL_TRAPS, f"unmapped traps: {sorted(ALL_TRAPS - set(traps))}"
    for entry in traps.values():
        assert entry["golden"] in GOLDEN_NAMES


@pytest.fixture(scope="module")
def replayed() -> dict[str, tuple[Event, ...]]:
    return {path.stem: _replay(_load(path))[1] for path in GOLDEN_PATHS}


def _trap_events(replayed: dict[str, tuple[Event, ...]], trap: str) -> tuple[tuple[Event, ...], int]:
    entry = _load(GOLDENS_DIR / "traps.json")[trap]
    return replayed[entry["golden"]], entry["event_index"]


def test_trap_1_undeveloped_rent_doubles_on_a_full_group(replayed: dict[str, tuple[Event, ...]]) -> None:
    events, index = _trap_events(replayed, "1")
    rent = events[index]
    assert isinstance(rent, RentCharged)
    assert (rent.multiplier, rent.houses) == (2, 0)
    assert rent.group is not None
    assert rent.amount == rent.base_rent * 2
    assert "rent.note.full_group_doubled" in rent.note_keys


def test_trap_2_a_mortgaged_property_charges_no_rent(replayed: dict[str, tuple[Event, ...]]) -> None:
    events, index = _trap_events(replayed, "2")
    landing = events[index]
    assert isinstance(landing, TokenMoved)
    flips = [event for event in events[:index] if isinstance(event, MortgageChanged) and event.tile == landing.to_tile]
    assert flips and flips[-1].mortgaged, "the tile was mortgaged when the token arrived"
    for event in events[index + 1 :]:
        if isinstance(event, DiceRolled):
            break
        assert not isinstance(event, RentCharged)
        assert not (isinstance(event, CashChanged) and event.reason is CashReason.RENT)


def test_trap_7_the_third_double_jails_without_moving(replayed: dict[str, tuple[Event, ...]]) -> None:
    events, index = _trap_events(replayed, "7")
    jailed = events[index]
    assert isinstance(jailed, SentToJail)
    assert jailed.via == "three_doubles"
    roll = events[index - 1]
    assert isinstance(roll, DiceRolled)
    assert roll.doubles_streak == 3
    assert roll.first == roll.second


def test_trap_9_utility_rent_multiplies_the_dice(replayed: dict[str, tuple[Event, ...]]) -> None:
    events, index = _trap_events(replayed, "9")
    rent = events[index]
    assert isinstance(rent, RentCharged)
    assert rent.dice_total is not None
    assert rent.multiplier in (4, 10)
    assert rent.amount == rent.multiplier * rent.dice_total


def test_trap_10_going_to_jail_is_not_passing_go(replayed: dict[str, tuple[Event, ...]]) -> None:
    """Pinned on the payer's cash and position across the whole jailing command rather than
    a forward scan of the event window: a scan in one direction cannot see a salary paid
    just before the jailing, and the tile walks the token 30 -> 10 without passing GO."""
    events, index = _trap_events(replayed, "10")
    jailed = events[index]
    assert isinstance(jailed, SentToJail)
    assert jailed.via == "tile"

    entry = _load(GOLDENS_DIR / "traps.json")["10"]
    before, after = _states_around(_load(GOLDENS_DIR / f"{entry['golden']}.json"), index)
    jail_tile = before.board.go_to_jail_target
    assert before.player(jailed.player).position != jail_tile
    assert after.player(jailed.player).position == jail_tile
    assert after.player(jailed.player).in_jail
    assert after.player(jailed.player).cash == before.player(jailed.player).cash, "no salary on the way to jail"


def _states_around(golden: dict[str, Any], event_index: int) -> tuple[GameState, GameState]:
    """The states either side of the command that produced ``events[event_index]``."""
    state = new_game(
        tuple(Seat.model_validate(seat) for seat in golden["seats"]),
        seed=golden["seed"],
        board_id=golden["board_id"],
        ruleset=Ruleset.model_validate(golden["ruleset"]),
    )
    produced = 0
    for payload in golden["commands"]:
        before = state
        state, events = apply(state, _COMMANDS.validate_python(payload))
        produced += len(events)
        if produced > event_index:
            return before, state
    raise AssertionError(f"event index {event_index} is past the end of {golden['name']}")


def _group_levels(state: GameState, tile_index: int) -> list[int]:
    """House counts across ``tile_index``'s colour group — the even-build yardstick."""
    group = state.board.tile(tile_index).group
    assert group is not None, "a built tile always belongs to a colour group"
    return [state.properties[member].houses for member in state.board.group_members(group)]


def _has_a_binding_build(golden: dict[str, Any]) -> bool:
    """Whether any build in ``golden`` landed on its group's *lowest* tile while a sibling
    stood strictly higher — the only shape in which even-build constrained the choice.

    One replay for the whole golden: asking ``_states_around`` per candidate would replay the
    game once per build, which for nineteen builds is nineteen games.
    """
    state = new_game(
        tuple(Seat.model_validate(seat) for seat in golden["seats"]),
        seed=golden["seed"],
        board_id=golden["board_id"],
        ruleset=Ruleset.model_validate(golden["ruleset"]),
    )
    for payload in golden["commands"]:
        before = state
        state, events = apply(state, _COMMANDS.validate_python(payload))
        for event in events:
            if not isinstance(event, BuildingChanged) or event.delta != 1:
                continue
            levels = _group_levels(before, event.tile)
            if levels and before.properties[event.tile].houses == min(levels) < max(levels):
                return True
    return False


def test_trap_3_even_build_binds_in_both_directions(replayed: dict[str, tuple[Event, ...]]) -> None:
    """Houses within a group never differ by more than one, on the way up *and* down (trap 3).

    The recorded index is the **down** direction, because that is the half implementations get
    wrong: the sale is at the group maximum while a sibling stands strictly lower, so the rule
    was actually binding rather than trivially satisfied by a level group. The up direction is
    asserted by a scan of the same golden for a build on a tile at the group minimum with a
    strictly higher sibling.
    """
    entry = _load(GOLDENS_DIR / "traps.json")["3"]
    golden = _load(GOLDENS_DIR / f"{entry['golden']}.json")
    sale = replayed[entry["golden"]][entry["event_index"]]
    assert isinstance(sale, BuildingChanged)
    assert sale.delta == -1, "one level at a time, so the levels either side are unambiguous"

    before, after = _states_around(golden, entry["event_index"])
    levels = _group_levels(before, sale.tile)
    assert before.properties[sale.tile].houses == max(levels), "only the tallest tile may be sold"
    assert min(levels) < max(levels), "a level group would satisfy the rule without exercising it"
    settled = _group_levels(after, sale.tile)
    assert max(settled) - min(settled) <= 1, "and the group is still even afterwards"
    assert _has_a_binding_build(golden), "the up direction never bound here, so half the trap is untested"


def test_trap_4_the_building_shortage_is_real(replayed: dict[str, tuple[Event, ...]]) -> None:
    """32 houses and 12 hotels; when they run out, they are out (trap 4).

    The golden plays against a smaller box so the shortage is reachable inside one game, and
    the assertion is the one that matters: with the bank's last house gone, a build that would
    otherwise be legal is refused specifically with ``error.no_houses_left``. "The counter says
    zero" would also be satisfied by a counter nobody reads.

    Trap 4's second sentence — auctioning a *contested* last house — is the documented v1
    divergence (owner decision 1, GAP §7): ``building_shortage_auction`` is False and buildings
    are first-come-first-served. What v1 implements is the finite bank, and that is what this
    pins.
    """
    entry = _load(GOLDENS_DIR / "traps.json")["4"]
    golden = _load(GOLDENS_DIR / f"{entry['golden']}.json")
    build = replayed[entry["golden"]][entry["event_index"]]
    assert isinstance(build, BuildingChanged)
    assert build.delta > 0

    _, after = _states_around(golden, entry["event_index"])
    assert after.houses_remaining == 0, "the build emptied the box"
    assert not after.ruleset.building_shortage_auction, "v1 is first-come-first-served"
    refusals = {
        is_legal(after, BuildHouse(player=owner, tile=tile)).reason_key
        for tile in range(BOARD_SIZE)
        if (owner := after.properties[tile].owner) is not None
    }
    assert "error.no_houses_left" in refusals, (
        f"an empty box refused nothing by that name; reasons seen: {sorted(key or 'legal' for key in refusals)}"
    )


def test_trap_5_declining_opens_an_auction_with_no_reserve(replayed: dict[str, tuple[Event, ...]]) -> None:
    """A declined property goes to auction, the decliner may bid, and there is no reserve —
    it can go for ₪1 (trap 5)."""
    entry = _load(GOLDENS_DIR / "traps.json")["5"]
    golden = _load(GOLDENS_DIR / f"{entry['golden']}.json")
    events = replayed[entry["golden"]]
    started = events[entry["event_index"]]
    assert isinstance(started, AuctionStarted)
    assert started.reason is AuctionReason.DECLINED_PURCHASE

    before, after = _states_around(golden, entry["event_index"])
    assert before.current_player_id in started.eligible, "the player who declined may still bid"
    frame = after.auction
    assert frame is not None and frame.min_bid == 1, "no reserve: the floor is one shekel"
    assert any(isinstance(event, BidPlaced) and event.amount == 1 for event in events), (
        "no one-shekel bid anywhere in the golden, so 'no reserve' is asserted but not demonstrated"
    )


def test_trap_6_bankruptcy_to_the_bank_auctions_the_estate(replayed: dict[str, tuple[Event, ...]]) -> None:
    """Paying the bank sends the properties to auction (trap 6).

    The player-creditor half of the same trap — everything transfers, mortgages included — is
    MON-207's unit tests; this pins the bank half, which is the one that needs a queued
    multi-lot auction and is where a two-player game used to deadlock (G-8).
    """
    entry = _load(GOLDENS_DIR / "traps.json")["6"]
    events = replayed[entry["golden"]]
    bankrupted = events[entry["event_index"]]
    assert isinstance(bankrupted, PlayerBankrupted)
    assert bankrupted.creditor == "bank"
    assert bankrupted.tiles_transferred, "an estate with no deeds has nothing to auction"
    opened = next(
        event
        for event in events[entry["event_index"] :]
        if isinstance(event, AuctionStarted) and event.reason is AuctionReason.BANKRUPTCY_TO_BANK
    )
    assert opened.lot in {TileLot(tile=tile) for tile in bankrupted.tiles_transferred}
    assert opened.eligible and bankrupted.player not in opened.eligible, "the debtor does not bid for their own estate"


def test_trap_8_jail_is_not_a_pause(replayed: dict[str, tuple[Event, ...]]) -> None:
    """A jailed player still collects rent (trap 8) — and still owns an estate they may build
    on and trade from the cell, which is why ``JAIL_DECISION`` is a portfolio phase (G-5)."""
    entry = _load(GOLDENS_DIR / "traps.json")["8"]
    golden = _load(GOLDENS_DIR / f"{entry['golden']}.json")
    collected = replayed[entry["golden"]][entry["event_index"]]
    assert isinstance(collected, CashChanged)
    assert collected.reason is CashReason.RENT
    assert collected.delta > 0, "the jailed player is being paid, not paying"
    before, _ = _states_around(golden, entry["event_index"])
    assert before.player(collected.player).in_jail, "the collector was in the cell at the time"
    assert Phase.JAIL_DECISION in PORTFOLIO_PHASES, "and their portfolio stayed open (G-5)"


# --- Coverage floor: what the goldens collectively visit ---------------------------

M1_PHASE_FLOOR = {
    "awaiting_roll",
    "awaiting_end_turn",
    "awaiting_purchase_decision",
    "auction",
    "debt_settlement",
    "jail_decision",
    "game_over",
}
# TRADE_REVIEW joins with MON-204's golden. CARD_RESOLUTION never will: it is transient, so
# a card either finishes or suspends into a debt inside the command that drew it, and
# ``PhaseChanged`` only ever names the phase a command *entered* and the one it came to
# rest in. What MON-206 adds to this floor is CashReason.CARD below, plus its own touch
# test. (MON-209 then raises the floor to "every Phase and CashReason", per the backlog.)
M1_REASON_FLOOR = {
    CashReason.GO_SALARY,
    CashReason.RENT,
    CashReason.PURCHASE,
    CashReason.AUCTION_WIN,
    CashReason.TAX,
    CashReason.JAIL_FINE,
    CashReason.CARD,
    CashReason.BUILD,
    CashReason.SELL_BUILDING,
    CashReason.MORTGAGE,
    CashReason.BANKRUPTCY_TRANSFER,
}


def test_the_goldens_collectively_visit_the_m1_phase_and_reason_floor(
    replayed: dict[str, tuple[Event, ...]],
) -> None:
    phases: set[str] = {"awaiting_roll"}  # every game opens here
    reasons: set[CashReason] = set()
    for events in replayed.values():
        for event in events:
            if isinstance(event, PhaseChanged):
                phases.update((event.previous.value, event.current.value))
            elif isinstance(event, CashChanged):
                reasons.add(event.reason)
    assert phases >= M1_PHASE_FLOOR
    assert reasons >= M1_REASON_FLOOR


def test_the_goldens_deal_from_both_decks_and_walk_a_token_backwards(
    replayed: dict[str, tuple[Event, ...]],
) -> None:
    """MON-206's golden touch: the cards are dealt through real play, not only from
    hand-built states, and the one card that moves a token *backwards* actually fired."""
    drawn = [event for events in replayed.values() for event in events if isinstance(event, CardDrawn)]
    assert len(drawn) >= 20, f"only {len(drawn)} cards were dealt across the goldens"
    assert {event.deck for event in drawn} == set(Deck), "one deck was never dealt from"
    backwards = [
        event for events in replayed.values() for event in events if isinstance(event, TokenMoved) and not event.forward
    ]
    assert backwards, "'go back three spaces' never occurred, so its mover is untested here"
