"""The text driver. Thin, but it is the first thing a new contributor runs."""

from __future__ import annotations

import pytest

from kesef_engine.cli import main


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


def test_play_reports_that_it_is_not_ready_yet(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["play"]) == 2
    assert "MON-105" in capsys.readouterr().out
