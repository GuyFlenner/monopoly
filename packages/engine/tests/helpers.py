"""Test factories.

A plain module rather than a conftest: pytest puts the test directory on ``sys.path``
(there is no ``__init__.py`` here), so ``from helpers import make_state`` works, and
mypy sees one unambiguous module name instead of two files both called ``tests``.
"""

from __future__ import annotations

from kesef_engine.board.models import BOARD_SIZE
from kesef_engine.rng import Rng
from kesef_engine.ruleset import Ruleset
from kesef_engine.state import GameState, PlayerKind, PlayerState, PropertyState


def make_player(player_id: int, name: str = "", *, cash: int = 1500, bot: bool = False) -> PlayerState:
    return PlayerState(
        id=player_id,
        name=name or f"P{player_id}",
        kind=PlayerKind(is_bot=bot, bot_level="easy" if bot else None),
        token=f"token.{player_id}",
        cash=cash,
    )


def make_state(
    *,
    board_id: str = "classic",
    players: int = 2,
    seed: int = 42,
    ruleset: Ruleset | None = None,
    properties: dict[int, PropertyState] | None = None,
) -> GameState:
    """A minimal, valid game state. ``properties`` patches individual tiles."""
    tiles = [PropertyState() for _ in range(BOARD_SIZE)]
    for index, prop in (properties or {}).items():
        tiles[index] = prop
    return GameState(
        game_id="test",
        board_id=board_id,
        ruleset=ruleset or Ruleset.universal(),
        rng=Rng(seed=seed),
        players=tuple(make_player(i) for i in range(players)),
        properties=tuple(tiles),
    )
