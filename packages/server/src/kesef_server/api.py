"""HTTP + WebSocket transport for the rules engine.

The server owns sessions, serialization and fan-out. It owns no rules. If a conditional in
this file starts to look like a rule, it belongs in :mod:`kesef_engine`.

Endpoints marked 501 have their request and response schemas defined already, on purpose:
the frontend generates its TypeScript from this app's OpenAPI document, so fixing the
contract now unblocks UI work in parallel with the engine (MON-301, MON-302).
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware

from kesef_engine.board.loader import available_boards, load_board
from kesef_engine.ruleset import Ruleset, RulesetName
from kesef_server.config import Settings, settings
from kesef_server.schemas import (
    BoardSummary,
    CommandRequest,
    GameSummary,
    GameView,
    NewGameRequest,
)
from kesef_server.sessions import SessionStore, UnknownGameError

app = FastAPI(
    title="Kesef Street",
    version="0.1.0",
    summary="A bilingual property-trading board game",
    description=(
        "Transport for the kesef-engine rules core. All human-facing strings in this API "
        "are i18n keys, never prose — the client owns language."
    ),
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

_store = SessionStore(max_sessions=settings.max_sessions)


def get_store() -> SessionStore:
    """Overridable in tests so each test gets a clean store."""
    return _store


def get_settings() -> Settings:
    return settings


StoreDep = Annotated[SessionStore, Depends(get_store)]


@app.get("/health", tags=["meta"])
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/boards", tags=["meta"])
def list_boards() -> list[BoardSummary]:
    """The boards available on the new-game screen."""
    summaries = []
    for board_id in available_boards():
        board = load_board(board_id)
        summaries.append(
            BoardSummary(
                id=board.id,
                name_key=board.name_key,
                tile_count=len(board.tiles),
                ownable_count=sum(1 for tile in board.tiles if tile.is_ownable),
            )
        )
    return summaries


@app.get("/rulesets", tags=["meta"])
def list_rulesets() -> list[Ruleset]:
    """Both rulesets, fully expanded, so the UI can show what Kids Mode actually changes."""
    return [Ruleset.by_name(name) for name in RulesetName]


@app.post("/games", status_code=status.HTTP_201_CREATED, tags=["game"])
def create_game(request: NewGameRequest, store: StoreDep) -> GameView:
    """Start a game and return the opening view."""
    raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, detail="MON-301: game creation")


@app.get("/games", tags=["game"])
def list_games(store: StoreDep) -> list[GameSummary]:
    return [
        GameSummary(
            game_id=session.state.game_id,
            board_id=session.state.board_id,
            ruleset=session.state.ruleset.name,
            turn_number=session.state.turn_number,
            player_names=tuple(player.name for player in session.state.players),
        )
        for session in store.all()
    ]


@app.get("/games/{game_id}", tags=["game"])
def get_game(game_id: str, store: StoreDep) -> GameView:
    """The current view. Safe to poll, and the reconnect path for the UI."""
    raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, detail="MON-301: game view")


@app.post("/games/{game_id}/commands", tags=["game"])
def submit_command(game_id: str, request: CommandRequest, store: StoreDep) -> GameView:
    """Apply one command. The only way a game changes."""
    raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, detail="MON-301: command submission")


@app.delete("/games/{game_id}", status_code=status.HTTP_204_NO_CONTENT, tags=["game"])
def delete_game(game_id: str, store: StoreDep) -> None:
    try:
        store.get(game_id)
    except UnknownGameError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="error.game_not_found") from None
    store.delete(game_id)
