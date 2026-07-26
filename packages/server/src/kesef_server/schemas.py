"""The HTTP contract.

These models are the single source of truth for the frontend's types: CI generates
``packages/web/src/api/generated.ts`` from this app's OpenAPI schema, so a field renamed
here becomes a TypeScript error there rather than an undefined at runtime (MON-302).
"""

from __future__ import annotations

from typing import Self

from pydantic import BaseModel, Field, model_validator

from kesef_engine.bots.base import BotLevel
from kesef_engine.commands import Command
from kesef_engine.events import Event
from kesef_engine.ruleset import RulesetName
from kesef_engine.state import MAX_PLAYERS, MIN_PLAYERS, GameState


class SeatConfig(BaseModel):
    """One seat at the table. A seat is either a person or a bot."""

    name: str = Field(min_length=1, max_length=24)
    is_bot: bool = False
    bot_level: BotLevel | None = None
    token: str

    @model_validator(mode="after")
    def _check(self) -> Self:
        if self.is_bot and self.bot_level is None:
            raise ValueError("a bot seat needs a bot_level")
        if not self.is_bot and self.bot_level is not None:
            raise ValueError("a human seat must not carry a bot_level")
        return self


class NewGameRequest(BaseModel):
    seats: tuple[SeatConfig, ...] = Field(min_length=MIN_PLAYERS, max_length=MAX_PLAYERS)
    board_id: str = "classic"
    ruleset: RulesetName = RulesetName.UNIVERSAL
    locale: str = "en"
    seed: int | None = None
    """None means the server picks one and returns it, so a game can be replayed."""


class GameView(BaseModel):
    """Everything a client needs to render one frame.

    Bundling the legal commands with the state is what lets the UI stay rules-free: it
    renders the buttons it is handed instead of re-deriving them and drifting.
    """

    state: GameState
    legal_commands: tuple[Command, ...]
    events: tuple[Event, ...] = ()
    """Events produced by the command that led to this view — the animation script."""


class CommandRequest(BaseModel):
    command: Command


class GameSummary(BaseModel):
    game_id: str
    board_id: str
    ruleset: RulesetName
    turn_number: int
    player_names: tuple[str, ...]


class BoardSummary(BaseModel):
    """Board metadata for the new-game screen. Names arrive as keys; the UI translates."""

    id: str
    name_key: str
    tile_count: int
    ownable_count: int
