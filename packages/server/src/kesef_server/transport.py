"""The half of a route that is not HTTP.

Every game route in this server does the same four things — look the session up, ask the
engine, store what it returned, project the result onto the wire shape — and *none* of those
four needs a request object, a response class or a framework. This module is that half,
extracted so it has exactly one implementation.

It was extracted for MON-805. The browser build (:mod:`kesef_server.browser`) runs the same
handlers with no server in front of them, and the first draft of it re-typed ``_view``,
``_logged``, ``_stamped``, ``_session`` and ``_create`` beside the originals in
:mod:`kesef_server.api`. Two copies of the projection is precisely the defect
:mod:`kesef_server.bots` opens by describing: "who is the game blocked on" having two
implementations is how that module's original bug happened. A parity test catches a *divergence*
after it exists; one function catches it by construction.

Two properties this module keeps, and they are the same two ``api.py`` claims:

* **No rules.** Nothing here compares cash against a price or decides what is legal. It asks
  ``legal_commands``, calls ``apply``, and copies the answer.
* **One clock.** :func:`stamped` overwrites ``EndTurn.elapsed_seconds`` from the store's clock,
  never from the caller. That is what stops a player forcing or dodging Kids Mode's ending
  (GAP G-6, MON-100 security review), and it holds for the browser transport too — where the
  clock happens to belong to the same person, so there is nothing to defend, but a second
  reading of a second clock would still be a second thing to keep in step.
"""

from __future__ import annotations

from kesef_engine.board.loader import available_boards, load_board
from kesef_engine.commands import Command, EndTurn
from kesef_engine.events import Event
from kesef_engine.legality import legal_commands
from kesef_engine.ruleset import Ruleset, RulesetName
from kesef_engine.state import GameState
from kesef_server import errors
from kesef_server.bots import drive, seats_that_proposed_this_turn
from kesef_server.schemas import (
    BoardSummary,
    BoardView,
    GameStateView,
    GameSummary,
    GameView,
    LoggedEvent,
    RulesetView,
)
from kesef_server.sessions import (
    DuplicateGameError,
    Session,
    SessionLimitReachedError,
    SessionStore,
    UnknownGameError,
)

# --- Sessions ---------------------------------------------------------------


def session(store: SessionStore, game_id: str) -> Session:
    """The live session, or an :class:`~kesef_server.errors.ApiError` naming the 404."""
    try:
        return store.get(game_id)
    except UnknownGameError:
        raise errors.game_not_found(game_id) from None


def create(store: SessionStore, state: GameState) -> Session:
    """Seat a new game, translating the store's two refusals into keyed failures."""
    try:
        return store.create(state)
    except DuplicateGameError:
        raise errors.game_already_exists(state.game_id) from None
    except SessionLimitReachedError:
        raise errors.server_at_capacity(len(store)) from None


# --- Projections ------------------------------------------------------------


def board_summaries() -> list[BoardSummary]:
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
                # Copied, not judged: see `Board.catalogue_ready` for why the flag is board data.
                # Every board is listed and the *picker* filters, so a board held back is visible
                # to a developer reading this response and absent from a parent's choices (MON-419).
                catalogue_ready=board.catalogue_ready,
            )
        )
    return summaries


def rulesets() -> list[RulesetView]:
    """Both rulesets, expanded and labelled (MON-417, G-36).

    The universal rules are the baseline every view is measured against, so they are resolved once
    here rather than per view. ``differing_settings`` is the engine's answer — a client working out
    which rules differ would be holding a rule.
    """
    universal = Ruleset.universal()
    return [RulesetView.from_ruleset(Ruleset.by_name(name), universal) for name in RulesetName]


def game_summaries(store: SessionStore) -> list[GameSummary]:
    return [
        GameSummary(
            game_id=held.state.game_id,
            board_id=held.state.board_id,
            ruleset=held.state.ruleset.name,
            turn_number=held.state.turn_number,
            player_names=tuple(player.name for player in held.state.players),
        )
        for held in store.all()
    ]


def view(held: Session, events: tuple[LoggedEvent, ...] = ()) -> GameView:
    """The projection. Every field is a copy or an engine call (ADR-008)."""
    return GameView(
        board=BoardView.from_board(held.state.board),
        state=GameStateView.from_state(held.state),
        legal_commands=legal_commands(held.state),
        events=events,
        event_cursor=held.cursor,
    )


def logged(held: Session, events: tuple[Event, ...]) -> tuple[LoggedEvent, ...]:
    """The just-applied events, with the ``seq`` the store assigned them."""
    return tuple(held.log[-len(events) :]) if events else ()


def stamped(store: SessionStore, held: Session, command: Command) -> Command:
    """Overwrite ``EndTurn.elapsed_seconds`` with the store's own reading.

    The engine owns no clock, but Kids Mode ends a game after
    ``Ruleset.target_duration_minutes``, so the time has to arrive on a command (GAP G-6). It
    arrives from *here*, never from the request: a client that chose its own number could force
    the ending on the turn it happens to be winning, or postpone it forever. This is the only
    clock read in the server, and ``SessionStore`` is the only thing that holds a clock (see its
    module docstring).
    """
    if isinstance(command, EndTurn):
        return command.model_copy(update={"elapsed_seconds": store.elapsed_seconds(held)})
    return command


def wire_params(context: dict[str, object]) -> dict[str, int | str]:
    """Coerce an error's context to what the catalogue can interpolate.

    ``IllegalCommandError`` is typed ``**context: object``; every rule in the engine passes ints
    and strings, and anything else would be a bug in the *engine* rather than something to hide
    here — so it is stringified rather than dropped.
    """
    return {key: value if isinstance(value, int | str) else str(value) for key, value in context.items()}


# --- Bots -------------------------------------------------------------------


async def advance_bots_once(
    store: SessionStore, game_id: str, *, think_seconds: float
) -> tuple[LoggedEvent, ...] | None:
    """Let the seat the engine is waiting on move, if it is a bot. ``None`` if none can.

    **One step, stored before it returns.** Both transports drive bots a single move at a time
    for the same reason (MON-304): each move has to reach the log — and therefore the WebSocket
    subscribers, or the browser's fake socket — while the next one is still being thought about.
    A version that played a whole turn and returned it would turn the thinking delay into a
    silence followed by six moves in one frame, which is the freeze-then-jump the delay exists
    to prevent.

    The one thing passed *in* to the driver is which seats have already proposed a trade this
    turn (ADR-009), derived from the session log on every step because a proposal to a human ends
    the call altogether — a driver-local memory would reset before the human had answered, and
    the same offer would come straight back.

    **The caller must hold** ``Session.advance_lock`` (MON-806). This function reads a position and
    writes the move it produced, with an ``await`` in between, so two callers running it
    concurrently would both read the same position, compute the same move and append the same
    events twice. The lock is not taken *here* because the two transports hold it across different
    spans: :func:`advance_bots` holds it for a whole run of steps, and the browser facade holds it
    for one, since a page pumps step by step.

    Raises :class:`~kesef_server.sessions.UnknownGameError` if the game has been deleted since the
    caller last looked: whether that is worth reporting is the caller's decision, and the two
    transports make it differently — the HTTP background task is a quiet no-op, the browser's pump
    answers the 404 the page is waiting for.
    """
    held = store.get(game_id)
    async for step in drive(
        held.state,
        think_seconds=think_seconds,
        max_steps=1,
        traded_seats=seats_that_proposed_this_turn(entry.event for entry in held.log),
    ):
        return logged(store.update(game_id, step.state, step.events), step.events)
    return None


async def advance_bots(store: SessionStore, game_id: str, *, think_seconds: float, max_steps: int) -> None:
    """Let every bot that can act do so, one stored move at a time, under this game's lock.

    The HTTP transport's whole bot driver: :func:`api._advance_bots` is a background task that calls
    this and nothing else. The browser transport does *not* call it — a page cannot wait for a whole
    bot turn inside one call, so it pumps :func:`advance_bots_once` itself and holds the same lock
    per step.

    **One game gets one driver at a time (MON-806).** Every command queues one of these, so two
    quick commands give the same game two, and the read-one-step-write loop inside
    :func:`advance_bots_once` races against its twin. ``Session.advance_lock`` serializes them: the
    latecomer waits, re-reads a position the first driver has already finished, finds nothing to do
    and leaves. A skip-if-running flag would be cheaper but wrong — the running driver may already
    have decided "no bot can act" from the position *before* the command that queued the second
    task, and skipping would strand the bot until the next request.

    **A game deleted while this runs is a quiet no-op**, not an error: there is nobody left to
    advance, and this has no caller to report to.

    The step cap is per call, so the next command resumes. It is not decoration: an engine change
    that made two commands mutually re-enabling would otherwise turn this into a hang, and a hang in
    a game server is worse than a bot that stops moving and logs why.
    """
    try:
        held = store.get(game_id)
    except UnknownGameError:
        return
    async with held.advance_lock:
        for _ in range(max_steps):
            try:
                if await advance_bots_once(store, game_id, think_seconds=think_seconds) is None:
                    return
            except UnknownGameError:
                return
