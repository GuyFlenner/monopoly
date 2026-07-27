"""The golden-game regenerator. See the package docstring for why this is an entry
point and not a library: tests must not be able to regenerate what they assert.

Each golden records the full recipe (seed, seats, ruleset, commands), the exact final
state, a projection of the event stream (type, actor, principal amount) and the RNG
draw-cost constants. ``traps.json`` maps **all ten** spec §3.6 traps to the golden and event
index where each one demonstrably occurs (1, 2, 7, 9, 10 since M1; 3, 4, 5, 6 and 8 added at
MON-209).

Scenario seeds are *searched*, deterministically, so the traps occur through real play
rather than hand-built states; the search runs only here, never in the test suite.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from kesef_engine.commands import Command
from kesef_engine.events import (
    AuctionStarted,
    BuildingChanged,
    CashChanged,
    Event,
    PlayerBankrupted,
    RentCharged,
    SentToJail,
    TokenMoved,
)
from kesef_engine.factory import Seat, new_game
from kesef_engine.legality import legal_commands
from kesef_engine.phases import Phase
from kesef_engine.primitives import AuctionReason, CashReason
from kesef_engine.reducer import apply
from kesef_engine.rng import Rng
from kesef_engine.ruleset import Ruleset
from kesef_engine.state import SCHEMA_VERSION, GameState

DEFAULT_OUT = Path("packages/engine/tests/goldens")
STEP_CAP = 1500
SEATS = (Seat(name="Player1"), Seat(name="Player2"))

PRIORITY_MAIN = (
    "build_house",
    "buy_property",
    "roll_dice",
    "roll_for_jail",
    "end_turn",
    "withdraw_from_auction",
    "decline_purchase",
    "pay_jail_fine",
    "use_jail_card",
)

# Policy A ends games fast: it concedes the moment it owes more than it holds.
CONCEDER = ("conceder", ("declare_bankruptcy",), False)
# Policy B fights: in debt it sells and mortgages before conceding, and it opens every
# auction with the minimum bid -- which is how mortgages, sales and auction wins enter
# the stream. Raising kinds appear *only* in debt, or the policy would strip-mine its
# own estate during ordinary portfolio phases.
FIGHTER = ("fighter", ("sell_house", "mortgage_property", "declare_bankruptcy"), True)

Policy = tuple[str, tuple[str, ...], bool]

SCARCE_BANK = Ruleset.universal().model_copy(update={"houses_available": 6, "hotels_available": 1})
"""A bank that can actually run out.

Trap 4 says the shortage is real, and with the standard 32 houses it is unreachable inside a
game a golden has room for: a policy has to complete a colour group first, and by then the
game is usually over. Six houses and one hotel is the same rule with a smaller box — the
divergence in trap 4's second sentence (who gets the last house) stays untouched, because
``Ruleset.building_shortage_auction`` is off in v1 and this is first-come-first-served."""


def pick(state: GameState, commands: tuple[Command, ...], policy: Policy) -> Command:
    _, debt_priority, opens_bidding = policy
    if state.phase is Phase.DEBT_SETTLEMENT:
        for kind in debt_priority:
            for command in commands:
                if command.kind == kind:
                    return command
    if opens_bidding:
        for command in commands:
            if command.kind == "place_bid" and command.amount == 1:
                return command
    for kind in PRIORITY_MAIN:
        for command in commands:
            if command.kind == kind:
                return command
    return commands[0]


def play_out(
    seed: int, policy: Policy, ruleset: Ruleset
) -> tuple[GameState, tuple[Command, ...], tuple[Event, ...], dict[int, int]] | None:
    """One full policy game. Returns (final_state, commands, events, trap_indexes) or
    None when the game fails to reach GAME_OVER inside the step cap."""
    state = new_game(SEATS, seed=seed, ruleset=ruleset)
    commands: list[Command] = []
    events: list[Event] = []
    traps: dict[int, int] = {}
    for _ in range(STEP_CAP):
        if state.phase is Phase.GAME_OVER:
            return state, tuple(commands), tuple(events), traps
        legal = legal_commands(state)
        if not legal:
            raise AssertionError(f"deadlock at seed {seed}: no legal commands outside GAME_OVER")
        command = pick(state, legal, policy)
        before = state
        state, produced = apply(state, command)
        commands.append(command)
        _scan_for_traps(before, state, produced, offset=len(events), traps=traps, bids=policy[2])
        events.extend(produced)
    return None


def _scan_for_traps(
    before: GameState,
    after: GameState,
    produced: tuple[Event, ...],
    *,
    offset: int,
    traps: dict[int, int],
    bids: bool,
) -> None:
    """Record the first event index at which each §3.6 trap occurs through real play.

    All ten are covered as of MON-209. Each condition is the *binding* form of its trap
    wherever a weaker one would also be satisfied by a broken implementation: trap 3 wants a
    sale at the group maximum with a strictly lower sibling (a group standing level would pass
    either way), and trap 4 wants the build that took the bank's last house rather than merely
    a build against a small bank.
    """
    for local, event in enumerate(produced):
        index = offset + local
        if isinstance(event, RentCharged):
            if 1 not in traps and event.multiplier == 2 and event.houses == 0 and event.group is not None:
                traps[1] = index  # undeveloped rent doubled on a full group
            if 9 not in traps and event.dice_total is not None and event.multiplier in (4, 10):
                traps[9] = index  # utility rent as a multiple of the dice
        elif isinstance(event, TokenMoved) and 2 not in traps:
            prop = before.properties[event.to_tile]
            if prop.mortgaged and prop.owner is not None and prop.owner != event.player:
                traps[2] = index  # a mortgaged property charges no rent
        elif isinstance(event, BuildingChanged):
            levels = _group_levels(before, event.tile)
            standing = before.properties[event.tile].houses
            if 3 not in traps and event.delta == -1 and levels and standing == max(levels) > min(levels):
                traps[3] = index  # even-build coming *down*: only the tallest may be sold
            if 4 not in traps and event.delta > 0 and after.houses_remaining == 0:
                traps[4] = index  # the bank's last house left the box
        elif isinstance(event, AuctionStarted) and 5 not in traps and bids:
            # ``bids`` gates this on a policy that actually bids: trap 5 is not only "an auction
            # opens" but "there is no reserve, so it can go for a shekel", and a golden played
            # by a policy that withdraws from everything cannot demonstrate the second half.
            if event.reason is AuctionReason.DECLINED_PURCHASE and before.current_player_id in event.eligible:
                traps[5] = index  # declining sends it to auction, and the decliner may bid
        elif isinstance(event, PlayerBankrupted) and 6 not in traps:
            if event.creditor == "bank" and event.tiles_transferred:
                traps[6] = index  # paying the bank sends the estate to auction
        elif isinstance(event, CashChanged) and 8 not in traps:
            if event.reason is CashReason.RENT and event.delta > 0 and before.player(event.player).in_jail:
                traps[8] = index  # jail is not a pause: the rent still comes in
        elif isinstance(event, SentToJail):
            if event.via == "three_doubles" and 7 not in traps:
                traps[7] = index  # third double jails without moving
            if event.via == "tile" and 10 not in traps:
                traps[10] = index  # going to jail is not passing GO


def _group_levels(state: GameState, tile_index: int) -> list[int]:
    """House counts across ``tile_index``'s colour group, or empty for a tile without one."""
    group = state.board.tile(tile_index).group
    if group is None:
        return []
    return [state.properties[member].houses for member in state.board.group_members(group)]


def find_seed(
    policy: Policy, ruleset: Ruleset, required: set[int], *, start: int, limit: int = 4000
) -> tuple[int, tuple[GameState, tuple[Command, ...], tuple[Event, ...], dict[int, int]]]:
    for seed in range(start, start + limit):
        outcome = play_out(seed, policy, ruleset)
        if outcome is not None and required <= set(outcome[3].keys()):
            return seed, outcome
    raise AssertionError(f"no seed in [{start}, {start + limit}) produced traps {sorted(required)}")


def project(event: Event) -> dict[str, Any]:
    """(type, actor, principal amount) — duplicated knowingly in test_goldens.py: the
    test must not import the regenerator, and a drift between the two copies fails the
    comparison loudly rather than silently."""
    dumped = event.model_dump(mode="json")
    player = next((dumped[field] for field in ("player", "payer", "debtor", "winner") if field in dumped), None)
    amount = next((dumped[field] for field in ("delta", "amount", "price", "total") if field in dumped), None)
    return {"type": dumped["type"], "player": player, "amount": amount}


Outcome = tuple[GameState, tuple[Command, ...], tuple[Event, ...], dict[int, int]]


def golden_payload(name: str, seed: int, ruleset: Ruleset, outcome: Outcome) -> dict[str, Any]:
    final_state, commands, events, _ = outcome
    return {
        "schema_version": SCHEMA_VERSION,
        "name": name,
        "seed": seed,
        "board_id": "classic",
        "ruleset": ruleset.model_dump(mode="json"),
        "seats": [seat.model_dump(mode="json") for seat in SEATS],
        "rng_costs": rng_costs(),
        "commands": [command.model_dump(mode="json") for command in commands],
        "final_state": json.loads(final_state.model_dump_json()),
        "events": [project(event) for event in events],
    }


def rng_costs() -> dict[str, int]:
    """The draw-cost constants each golden pins. A changed cost renames itself in the
    pinning test instead of surfacing as a mystery golden shift."""
    probe = Rng(seed=1)
    _, _, after_dice = probe.roll_dice()
    _, after_shuffle = probe.shuffled(tuple(range(16)))
    return {"dice_roll_draws": after_dice.counter, "deck_shuffle_draws_16": after_shuffle.counter}


def regenerate(out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    universal = Ruleset.universal()
    potted = universal.model_copy(update={"free_parking_pot_enabled": True})

    goldens: dict[str, dict[str, Any]] = {}
    trap_map: dict[str, dict[str, Any]] = {}

    # 1. The CLI's own seed, played by the conceder: a fast game ending in bankruptcy.
    outcome = play_out(42, CONCEDER, universal)
    assert outcome is not None, "seed 42 regressed: the conceder game no longer terminates"
    goldens["conceder_seed_42"] = golden_payload("conceder_seed_42", 42, universal, outcome)
    _fold_traps(trap_map, "conceder_seed_42", outcome[3])

    # 2. A conceder game exhibiting the rent traps (1: full-group double, 9: utility dice).
    seed, outcome = find_seed(CONCEDER, universal, {1, 9}, start=1)
    name = f"rent_traps_seed_{seed}"
    goldens[name] = golden_payload(name, seed, universal, outcome)
    _fold_traps(trap_map, name, outcome[3])

    # 3. A fighter game (pot house rule on) exhibiting the jail and mortgage traps
    #    (2: mortgaged charges nothing, 7: three doubles, 10: jail is not passing GO).
    seed, outcome = find_seed(FIGHTER, potted, {2, 7, 10}, start=1)
    name = f"fighter_traps_seed_{seed}"
    goldens[name] = golden_payload(name, seed, potted, outcome)
    _fold_traps(trap_map, name, outcome[3])

    # 4. A game against a bank of six houses and one hotel, which is what makes the last
    #    three traps occur through play rather than from a hand-built position (MON-209):
    #    3 (even-build coming down, a sale at the group maximum with a lower sibling),
    #    4 (the bank's last house leaves the box) and 6 (a bankruptcy *to the bank*, whose
    #    estate goes to a queued auction). It deals cards throughout, so it is also the
    #    golden the backlog asks for: cards plus a bankruptcy-to-bank estate auction.
    #    Added last so the traps M1 already mapped keep their existing goldens.
    seed, outcome = find_seed(FIGHTER, SCARCE_BANK, {3, 4, 6}, start=1)
    name = f"scarce_bank_traps_seed_{seed}"
    goldens[name] = golden_payload(name, seed, SCARCE_BANK, outcome)
    _fold_traps(trap_map, name, outcome[3])

    for name, payload in goldens.items():
        (out_dir / f"{name}.json").write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="ascii")
    (out_dir / "traps.json").write_text(json.dumps(trap_map, indent=2, sort_keys=True) + "\n", encoding="ascii")
    print(f"wrote {len(goldens)} goldens + traps.json to {out_dir}")
    for trap, entry in sorted(trap_map.items()):
        print(f"  trap {trap}: {entry['golden']} @ event {entry['event_index']}")


def _fold_traps(trap_map: dict[str, dict[str, Any]], golden: str, found: dict[int, int]) -> None:
    for trap, index in found.items():
        trap_map.setdefault(str(trap), {"golden": golden, "event_index": index})


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m kesef_engine.goldens")
    parser.add_argument("--regenerate", action="store_true", help="rewrite the committed goldens")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="target directory")
    args = parser.parse_args(argv)
    if not args.regenerate:
        parser.print_help()
        return 2
    regenerate(args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
