"""The text driver. Thin, but it is the first thing a new contributor runs."""

from __future__ import annotations

import io

import pytest

from kesef_engine.cli import main
from kesef_engine.commands import Command
from kesef_engine.factory import Seat, new_game
from kesef_engine.legality import legal_commands
from kesef_engine.phases import Phase
from kesef_engine.reducer import apply


def test_boards_lists_both_boards(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["boards"]) == 0
    out = capsys.readouterr().out
    assert "classic" in out
    assert "israel" in out
    assert "28 ownable" in out  # 22 properties + 4 railroads + 2 utilities


def test_show_prints_every_tile(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["show", "classic"]) == 0
    lines = capsys.readouterr().out.splitlines()
    # title + header + 40 tiles
    assert len(lines) == 42
    assert "tile.classic.boardwalk" in lines[-1]


def test_show_rejects_an_unknown_board() -> None:
    with pytest.raises(SystemExit):
        main(["show", "atlantis"])


# --- kesef play (MON-105): a seeded 2-player game, played to a winner ------------

_SEED = 42
_EXPECTED_WINNER_ID = 1
_EXPECTED_WINNER_CASH = 712  # pinned: a change here is a rules change, not noise

_PRIORITY = (
    "declare_bankruptcy",
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


def _menu_choice(commands: tuple[Command, ...]) -> int:
    """The 1-based menu number the scripted player picks: a fixed kind priority."""
    for kind in _PRIORITY:
        for index, command in enumerate(commands):
            if command.kind == kind:
                return index + 1
    return 1


def _script_full_game(seed: int) -> tuple[str, int, int]:
    """Walk the engine with the menu policy, recording each pick as stdin lines.

    The CLI renders ``legal_commands`` in its deterministic order, so the recorded
    numbers select the same commands when replayed through the real menu.
    """
    state = new_game((Seat(name="Player1"), Seat(name="Player2")), seed=seed)
    lines: list[str] = []
    while state.phase is not Phase.GAME_OVER:
        commands = legal_commands(state)
        assert commands, "a live game must always offer a move"
        choice = _menu_choice(commands)
        lines.append(str(choice))
        state, _ = apply(state, commands[choice - 1])
        assert len(lines) < 5000, "the scripted game failed to terminate"
    winner = state.winner
    assert winner is not None
    return "\n".join(lines) + "\n", winner, state.player(winner).cash


def test_play_runs_a_seeded_two_player_game_to_a_winner(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    script, winner, cash = _script_full_game(_SEED)
    assert winner == _EXPECTED_WINNER_ID
    assert cash == _EXPECTED_WINNER_CASH
    monkeypatch.setattr("sys.stdin", io.StringIO(script))
    assert main(["play", "--seed", str(_SEED), "--bots", "0"]) == 0
    out = capsys.readouterr().out
    assert f"seed={_SEED}" in out, "--seed prints the seed so the game is reproducible"
    assert f"winner: Player{_EXPECTED_WINNER_ID + 1} (id {_EXPECTED_WINNER_ID}) with {_EXPECTED_WINNER_CASH}" in out
    assert out.isascii(), "the Windows console mangles anything beyond ASCII"


def test_play_reprompts_on_nonsense_and_survives_it(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    script, _, _ = _script_full_game(_SEED)
    monkeypatch.setattr("sys.stdin", io.StringIO("banana\n99\n" + script))
    assert main(["play", "--seed", str(_SEED), "--bots", "0"]) == 0
    out = capsys.readouterr().out
    assert "not a choice: 'banana'" in out
    assert "not a choice: '99'" in out


def test_play_fails_cleanly_when_stdin_ends_early(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("sys.stdin", io.StringIO("1\n1\n"))
    assert main(["play", "--seed", "7", "--bots", "0"]) == 1
    assert "input ended" in capsys.readouterr().out
