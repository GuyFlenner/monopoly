"""Text-mode driver.

This exists so the rules can be proven correct before any pixel is drawn. If the game is
not playable and winnable here, no amount of UI polish will fix it — and a text driver
makes rule bugs obvious in a way an animated board hides.

    kesef boards            list the bundled boards
    kesef show classic      print a board's layout and economics
    kesef play              play a game in the terminal   (MON-105)
"""

from __future__ import annotations

import argparse
from collections.abc import Sequence

from kesef_engine.board.loader import available_boards, load_board
from kesef_engine.board.models import TileKind


def _print_boards() -> None:
    for board_id in available_boards():
        board = load_board(board_id)
        ownable = sum(1 for tile in board.tiles if tile.is_ownable)
        print(f"{board_id:10s}  {len(board.tiles)} tiles, {ownable} ownable  ({board.name_key})")


def _show_board(board_id: str) -> None:
    board = load_board(board_id)
    # ASCII only in CLI output: the Windows console defaults to cp1252 and mangles the rest.
    print(f"{board.id} :: {board.name_key}")
    print(f"{'#':>3}  {'kind':<16} {'group':<11} {'price':>6} {'rent':>6}  name_key")
    for tile in board.tiles:
        group = tile.group.value if tile.group else ""
        price = str(tile.price) if tile.price else ""
        rent = str(tile.rent[0]) if tile.kind is TileKind.PROPERTY else ""
        print(f"{tile.index:>3}  {tile.kind.value:<16} {group:<11} {price:>6} {rent:>6}  {tile.name_key}")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="kesef", description="Kesef Street — text-mode driver")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("boards", help="list bundled boards")

    show = sub.add_parser("show", help="print a board's layout")
    show.add_argument("board", choices=available_boards())

    play = sub.add_parser("play", help="play a game in the terminal")
    play.add_argument("--board", choices=available_boards(), default="classic")
    play.add_argument("--players", type=int, default=2, help="total seats (2-6)")
    play.add_argument("--bots", type=int, default=1, help="how many of those seats are bots")
    play.add_argument("--ruleset", choices=("universal", "kids"), default="universal")
    play.add_argument("--seed", type=int, default=0, help="0 means pick one and print it")

    args = parser.parse_args(argv)

    match args.command:
        case "boards":
            _print_boards()
        case "show":
            _show_board(args.board)
        case "play":
            print("`kesef play` is not implemented yet — see MON-105 in docs/BACKLOG.md")
            return 2
        case _:  # pragma: no cover - argparse rejects anything else
            parser.error(f"unknown command {args.command!r}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
