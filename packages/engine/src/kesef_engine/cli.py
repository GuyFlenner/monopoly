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
import secrets
import sys
from collections.abc import Sequence

from kesef_engine.board.loader import available_boards, load_board
from kesef_engine.board.models import TileKind
from kesef_engine.commands import Command
from kesef_engine.events import (
    AuctionEnded,
    AuctionStarted,
    CardDrawn,
    CashChanged,
    DebtIncurred,
    DiceRolled,
    Event,
    GameEnded,
    LeftJail,
    PropertyAcquired,
    RentCharged,
    SentToJail,
    TokenMoved,
    TurnStarted,
)
from kesef_engine.factory import Seat, new_game
from kesef_engine.legality import legal_commands
from kesef_engine.phases import Phase
from kesef_engine.primitives import BotLevel
from kesef_engine.reducer import apply
from kesef_engine.ruleset import Ruleset, RulesetName
from kesef_engine.state import GameState


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


# --- kesef play (MON-105) ----------------------------------------------------
# The driver is deliberately dumb: it renders legal_commands as a numbered menu and
# sends back whichever the player picks. It holds no rule knowledge — a command the
# engine did not offer cannot even be typed. Bots playing their own seats is MON-601;
# until then every seat is prompted, bot or not. ASCII only: the Windows console
# defaults to cp1252 and mangles anything richer.


def _play(args: argparse.Namespace) -> int:
    seed = args.seed or (secrets.randbelow(2**32 - 1) + 1)
    if not 2 <= args.players <= 6:
        print("players must be 2-6")
        return 2
    bots = max(0, min(args.bots, args.players - 1))
    if bots:
        print("note: bots do not drive their own seats until MON-601; every seat is prompted")
    seats = tuple(
        Seat(name=f"Player{n + 1}", bot_level=BotLevel.EASY if n >= args.players - bots else None)
        for n in range(args.players)
    )
    ruleset = Ruleset.by_name(RulesetName(args.ruleset))
    state = new_game(seats, seed=seed, board_id=args.board, ruleset=ruleset)
    print(f"kesef play :: board={args.board} ruleset={args.ruleset} seed={seed}")

    while state.phase is not Phase.GAME_OVER:
        commands = legal_commands(state)
        if not commands:
            print("no legal commands - this is an engine bug (MON-209 owns the deadlock invariant)")
            return 1
        _print_status(state)
        for number, command in enumerate(commands, start=1):
            print(f"  {number}. {_describe_command(command, state)}")
        choice = _read_choice(len(commands))
        if choice is None:
            print("input ended before the game did")
            return 1
        state, events = apply(state, commands[choice - 1])
        for event in events:
            line = _describe_event(event, state)
            if line:
                print(f"    {line}")
    winner = state.winner
    assert winner is not None  # GAME_OVER via last_solvent always names one
    print(f"winner: {state.player(winner).name} (id {winner}) with {state.player(winner).cash}")
    return 0


def _print_status(state: GameState) -> None:
    player = state.current_player
    tile = state.board.tile(player.position)
    holdings = ", ".join(
        f"{p.name}:{p.cash}" + ("(jail)" if p.in_jail else "") + ("(out)" if p.bankrupt else "") for p in state.players
    )
    print(f"-- turn {state.turn_number} [{state.phase.value}] {player.name} on {tile.name_key} | {holdings}")


def _read_choice(count: int) -> int | None:
    while True:
        print(f"choose 1-{count}> ", end="", flush=True)
        line = sys.stdin.readline()
        if not line:
            return None
        text = line.strip()
        if text.isdigit() and 1 <= int(text) <= count:
            return int(text)
        print(f"not a choice: {text!r}")


def _describe_command(command: Command, state: GameState) -> str:
    name = state.player(command.player).name
    extras = {key: value for key, value in dict(command).items() if key not in ("kind", "player") and value is not None}
    detail = " ".join(f"{key}={value}" for key, value in extras.items())
    return f"[{name}] {command.kind}" + (f" {detail}" if detail else "")


def _describe_event(event: Event, state: GameState) -> str:
    """One ASCII line per event worth narrating; '' silences the rest."""
    match event:
        case DiceRolled():
            doubles = " doubles!" if event.first == event.second else ""
            return f"{_name(state, event.player)} rolled {event.first}+{event.second}={event.total}{doubles}"
        case TokenMoved():
            passed = " passing GO" if event.passed_go else ""
            return f"{_name(state, event.player)} moved to {state.board.tile(event.to_tile).name_key}{passed}"
        case CashChanged():
            sign = "+" if event.delta >= 0 else ""
            return f"{_name(state, event.player)} {sign}{event.delta} ({event.reason.value}) -> {event.balance}"
        case RentCharged():
            note = f" x{event.multiplier}" if event.multiplier > 1 else ""
            return f"rent {event.amount}{note} on {state.board.tile(event.tile).name_key}"
        case PropertyAcquired():
            return f"{_name(state, event.player)} acquired {state.board.tile(event.tile).name_key} ({event.via})"
        case CardDrawn():
            # Added at MON-209: the driver narrated a card's *consequences* — a jump across the
            # board, a fine, a jailing — without ever saying a card had been drawn, which is the
            # one thing that makes those consequences make sense to someone reading along.
            return f"{_name(state, event.player)} drew {event.card_id}"
        case AuctionStarted():
            return "auction opened"
        case AuctionEnded():
            return f"auction ended: winner={event.winner} price={event.price}"
        case SentToJail():
            return f"{_name(state, event.player)} sent to jail ({event.via})"
        case LeftJail():
            return f"{_name(state, event.player)} left jail ({event.via})"
        case DebtIncurred():
            return f"{_name(state, event.debtor)} owes {event.amount} to {event.creditor}"
        case TurnStarted():
            return f"turn {event.turn_number}: {_name(state, event.player)}"
        case GameEnded():
            standings = ", ".join(f"#{s.rank} {_name(state, s.player)} ({s.net_worth})" for s in event.final_standings)
            return f"game over: {standings}"
        case _:
            return ""


def _name(state: GameState, player_id: int) -> str:
    return state.player(player_id).name


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
            return _play(args)
        case _:  # pragma: no cover - argparse rejects anything else
            parser.error(f"unknown command {args.command!r}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
