"""Contract and behaviour tests.

The 501 assertions this file used to hold were not placeholders to be deleted — they pinned
the routes and schemas the frontend generates its types from. MON-301 turns each into a
behavioural test and keeps the pinning explicitly, in :data:`EXPECTED_PATHS` and
:data:`EXPECTED_SCHEMAS`: exhaustive inventories that fail if a route or a schema
*disappears* as loudly as if one appears unannounced (G-F20).

Every route below is asserted twice over: a 2xx, and a named field of the body. A status
code alone would pass against a handler that returned an empty object.
"""

from __future__ import annotations

import json
import tracemalloc
from collections.abc import MutableMapping
from typing import Any, Final

import pytest
from conftest import FakeClock, minimal_state, new_game_payload, seat
from fastapi import status
from fastapi.testclient import TestClient

from kesef_engine.board.models import BOARD_SIZE
from kesef_engine.decks import CHANCE_CARD_IDS, COMMUNITY_CHEST_CARD_IDS
from kesef_engine.state import MAX_PLAYERS, SCHEMA_VERSION
from kesef_server.api import WS_EVENT_STREAM_PATH, app, get_settings, get_store
from kesef_server.config import Settings
from kesef_server.sessions import SessionStore

UNPROCESSABLE = 422
"""Spelled as a number: starlette has renamed this constant once already."""

CONTENT_TOO_LARGE = 413

EXPECTED_PATHS: Final = {
    ("get", "/health"),
    ("get", "/boards"),
    ("get", "/rulesets"),
    ("post", "/games"),
    ("get", "/games"),
    ("post", "/games/load"),
    ("get", "/games/{game_id}"),
    ("get", "/games/{game_id}/save"),
    ("post", "/games/{game_id}/commands"),
    ("post", "/games/{game_id}/validate"),
    ("delete", "/games/{game_id}"),
    ("get", WS_EVENT_STREAM_PATH),
}
"""Every operation the document advertises. The frontend generates a client from this
document, so a route that vanishes is a compile error there — but only if something here
notices that it vanished."""

EXPECTED_SCHEMAS: Final = {
    # The projection (ADR-008)
    "GameView",
    "GameStateView",
    "BoardView",
    "TileView",
    "PlayerView",
    "GroupHoldings",
    "DiceView",
    "DeckCounts",
    "AuctionFrameView",
    "DebtFrameView",
    "TradeFrameView",
    "CardFrameView",
    "LoggedEvent",
    "PropertyState",
    # Requests and answers
    "NewGameRequest",
    "SeatConfig",
    "CommandRequest",
    "LegalityView",
    "ErrorResponse",
    "GameSummary",
    "BoardSummary",
    # The save file — the one place the full state is still on the wire
    "GameState",
    "PlayerState",
    "PlayerKind",
    "DiceState",
    "AuctionFrame",
    "DebtFrame",
    "TradeFrame",
    "CardFrame",
    "Rng",
    # Shared engine vocabulary
    "TileKind",
    "ColorGroup",
    "Ruleset",
    "RulesetName",
    "BotLevel",
    "Phase",
    "Deck",
    "CashReason",
    "AuctionReason",
    "TileLot",
    "BuildingLot",
    "Obligation",
    "TradeOffer",
    "TradeSide",
    # Commands
    "RollDice",
    "EndTurn",
    "BuyProperty",
    "DeclinePurchase",
    "PlaceBid",
    "WithdrawFromAuction",
    "BuildHouse",
    "SellHouse",
    "MortgageProperty",
    "UnmortgageProperty",
    "ProposeTrade",
    "RespondToTrade",
    "CancelTrade",
    "PayJailFine",
    "UseJailCard",
    "RollForJail",
    "DeclareBankruptcy",
    # Events
    "TurnStarted",
    "DiceRolled",
    "TokenMoved",
    "CashChanged",
    "RentCharged",
    "PropertyAcquired",
    "AuctionStarted",
    "BidPlaced",
    "BidderWithdrew",
    "AuctionEnded",
    "CardDrawn",
    "SentToJail",
    "LeftJail",
    "BuildingChanged",
    "MortgageChanged",
    "TradeProposed",
    "TradeExecuted",
    "TradeDeclined",
    "TradeCancelled",
    "DebtIncurred",
    "DebtSettled",
    "PlayerBankrupted",
    "PhaseChanged",
    "GameEnded",
    "BankruptcyShare",
    "PlayerStanding",
}
"""Every named schema in the document, and therefore every exported TypeScript type."""


# --- The inventory ----------------------------------------------------------


def test_the_document_advertises_exactly_the_expected_operations(client: TestClient) -> None:
    schema = client.get("/openapi.json").json()
    advertised = {
        (method, path)
        for path, operations in schema["paths"].items()
        for method in operations
        if method != "parameters"
    }
    assert advertised == EXPECTED_PATHS


def test_the_document_declares_exactly_the_expected_schemas(client: TestClient) -> None:
    schema = client.get("/openapi.json").json()
    assert set(schema["components"]["schemas"]) == EXPECTED_SCHEMAS


def test_openapi_document_is_generated(client: TestClient) -> None:
    """The frontend's type generation depends on this document existing and being valid."""
    schema = client.get("/openapi.json").json()
    assert schema["info"]["title"] == "Kesef Street"
    assert "/games/{game_id}/commands" in schema["paths"]
    assert "GameView" in schema["components"]["schemas"]


def test_every_game_route_declares_the_structured_error_shape(client: TestClient) -> None:
    """G-33: a 422 the client cannot type is a 422 the client will render as prose."""
    schema = client.get("/openapi.json").json()
    for method, path in sorted(EXPECTED_PATHS):
        if not path.startswith("/games") or path == "/games":
            continue
        responses = schema["paths"][path][method]["responses"]
        failures = [code for code in responses if code.startswith(("4", "5"))]
        assert failures, f"{method.upper()} {path} declares no error response"
        for code in failures:
            body = responses[code].get("content", {}).get("application/json", {}).get("schema", {})
            assert "ErrorResponse" in str(body), f"{method.upper()} {path} {code} is untyped"


# --- Meta -------------------------------------------------------------------


def test_health(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == status.HTTP_200_OK
    assert response.json() == {"status": "ok"}


def test_boards_endpoint_lists_both_boards(client: TestClient) -> None:
    response = client.get("/boards")
    assert response.status_code == status.HTTP_200_OK
    boards = {board["id"]: board for board in response.json()}
    assert set(boards) == {"classic", "israel"}
    assert boards["classic"]["tile_count"] == 40
    assert boards["classic"]["ownable_count"] == 28


def test_boards_endpoint_returns_keys_not_prose(client: TestClient) -> None:
    """The API must never hand the client an English string to display."""
    for board in client.get("/boards").json():
        assert board["name_key"].startswith("board.")


def test_rulesets_endpoint_exposes_what_kids_mode_changes(client: TestClient) -> None:
    rulesets = {ruleset["name"]: ruleset for ruleset in client.get("/rulesets").json()}
    assert set(rulesets) == {"universal", "kids"}
    assert rulesets["universal"]["auctions_enabled"] is True
    assert rulesets["kids"]["auctions_enabled"] is False
    assert rulesets["kids"]["hints_enabled"] is True


def test_games_list_starts_empty(client: TestClient) -> None:
    assert client.get("/games").json() == []


def test_games_list_names_the_games_it_holds(client: TestClient) -> None:
    """The old version of this test could not fail: the store was provably always empty."""
    created = _create(client)
    summaries = client.get("/games").json()
    assert [summary["game_id"] for summary in summaries] == [created["state"]["game_id"]]
    assert summaries[0]["player_names"] == ["Ann", "Ben"]
    assert summaries[0]["ruleset"] == "universal"


# --- POST /games ------------------------------------------------------------


def test_creating_a_game_returns_the_opening_view(client: TestClient) -> None:
    response = client.post("/games", json=new_game_payload())
    assert response.status_code == status.HTTP_201_CREATED
    view = response.json()
    assert view["state"]["turn_number"] == 1
    assert view["state"]["phase"] == "awaiting_roll"
    assert [player["name"] for player in view["state"]["players"]] == ["Ann", "Ben"]
    assert view["legal_commands"] == [{"kind": "roll_dice", "player": 0}]
    assert view["events"] == []
    assert view["event_cursor"] == 0


def test_the_view_ships_the_whole_board_so_a_client_can_draw_one(client: TestClient) -> None:
    """G-30: before ADR-008 no endpoint returned a single tile, so the UI could not render."""
    board = _create(client)["board"]
    assert len(board["tiles"]) == BOARD_SIZE
    assert board["tiles"][1]["name_key"] == "tile.classic.mediterranean_avenue"
    assert board["tiles"][1]["is_ownable"] is True
    assert board["tiles"][0]["is_ownable"] is False
    assert board["go_to_jail_target"] == 10


def test_the_view_never_ships_the_rng_or_the_deck_order(client: TestClient) -> None:
    """G-35: the shuffled deck told the client every card it was about to draw."""
    state = _create(client)["state"]
    assert "rng" not in state
    assert "chance_deck" not in state
    assert "community_chest_deck" not in state
    assert state["deck_counts"] == {
        "chance": len(CHANCE_CARD_IDS),
        "community_chest": len(COMMUNITY_CHEST_CARD_IDS),
    }


def test_the_view_promotes_the_derived_fields_the_dossier_needs(client: TestClient) -> None:
    player = _create(client)["state"]["players"][0]
    assert player["net_worth"] == 1500
    assert player["tiles_owned"] == []
    assert player["is_bot"] is False
    assert len(player["group_holdings"]) == 8
    assert player["group_holdings"][0]["complete"] is False


def test_a_seed_may_be_omitted_and_the_game_still_reports_one(client: TestClient) -> None:
    """The save file must be enough to replay, so the server's own seed has to come back."""
    first = client.post("/games", json=new_game_payload(seed=None))
    assert first.status_code == status.HTTP_201_CREATED
    saved = client.get(f"/games/{first.json()['state']['game_id']}/save").json()
    assert isinstance(saved["rng"]["seed"], int)


def test_a_client_may_name_its_game(client: TestClient) -> None:
    view = client.post("/games", json=new_game_payload(game_id="kitchen-table")).json()
    assert view["state"]["game_id"] == "kitchen-table"


def test_a_duplicate_game_id_is_a_conflict_not_a_silent_overwrite(client: TestClient) -> None:
    client.post("/games", json=new_game_payload(game_id="dup"))
    response = client.post("/games", json=new_game_payload(game_id="dup", seats=[seat("Cal"), seat("Dot")]))
    assert response.status_code == status.HTTP_409_CONFLICT
    assert response.json()["reason_key"] == "error.game_already_exists"
    assert [player["name"] for player in client.get("/games/dup").json()["state"]["players"]] == ["Ann", "Ben"]


def test_the_session_cap_is_a_key_based_error(client: TestClient) -> None:
    app.dependency_overrides[get_store] = lambda: SessionStore(max_sessions=0, clock=FakeClock())
    response = client.post("/games", json=new_game_payload())
    assert response.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
    assert response.json()["reason_key"] == "error.server_at_capacity"


def test_an_unknown_board_is_a_key_based_422(client: TestClient) -> None:
    response = client.post("/games", json=new_game_payload(board_id="atlantis"))
    assert response.status_code == UNPROCESSABLE
    assert response.json() == {"reason_key": "error.unknown_board", "params": {"board_id": "atlantis"}}


def test_duplicate_seat_names_are_the_engines_refusal_not_the_servers(client: TestClient) -> None:
    """The server does not look for duplicate names; the factory does. See errors.py."""
    response = client.post("/games", json=new_game_payload(seats=[seat("Ann"), seat("ann")]))
    assert response.status_code == UNPROCESSABLE
    assert response.json()["reason_key"] == "error.invalid_new_game"


def test_seat_count_is_validated_before_the_engine_is_reached(client: TestClient) -> None:
    """A one-player game is rejected by the schema, and the rejection is still a key."""
    response = client.post("/games", json={"seats": [seat("Solo")]})
    assert response.status_code == UNPROCESSABLE
    assert response.json()["reason_key"] == "error.malformed_request"


def test_too_many_seats_is_rejected(client: TestClient) -> None:
    response = client.post("/games", json={"seats": [seat(f"P{i}") for i in range(MAX_PLAYERS + 1)]})
    assert response.status_code == UNPROCESSABLE


def test_a_bot_seat_without_a_level_is_rejected(client: TestClient) -> None:
    seats = [seat("Human"), {"name": "Bot", "is_bot": True, "token": "token.2"}]
    response = client.post("/games", json={"seats": seats})
    assert response.status_code == UNPROCESSABLE


def test_a_human_seat_with_a_bot_level_is_rejected(client: TestClient) -> None:
    seats = [seat("Human"), {"name": "Also human", "is_bot": False, "bot_level": "hard", "token": "token.2"}]
    response = client.post("/games", json={"seats": seats})
    assert response.status_code == UNPROCESSABLE


def test_a_bot_seat_is_seated_as_a_bot(client: TestClient) -> None:
    seats = [seat("Human"), seat("Bot", is_bot=True, bot_level="hard")]
    view = client.post("/games", json=new_game_payload(seats=seats)).json()
    assert [player["is_bot"] for player in view["state"]["players"]] == [False, True]
    assert view["state"]["players"][1]["kind"] == {"bot_level": "hard"}


def test_a_seats_grammatical_gender_reaches_the_state(client: TestClient) -> None:
    """Owner decision 5 / G-42: Hebrew conjugates by the subject's gender."""
    seats = [seat("Ann", grammatical_gender="f"), seat("Ben", grammatical_gender="m")]
    view = client.post("/games", json=new_game_payload(seats=seats)).json()
    assert [player["grammatical_gender"] for player in view["state"]["players"]] == ["f", "m"]


# --- POST /games/{id}/commands ---------------------------------------------


def test_a_command_advances_the_game_and_returns_its_events(client: TestClient) -> None:
    game_id = _create(client)["state"]["game_id"]
    response = client.post(f"/games/{game_id}/commands", json=_roll(0))
    assert response.status_code == status.HTTP_200_OK
    view = response.json()
    dice = view["state"]["dice"]
    assert dice is not None
    assert dice["total"] == dice["first"] + dice["second"]
    assert [entry["seq"] for entry in view["events"]] == list(range(1, len(view["events"]) + 1))
    assert view["event_cursor"] == len(view["events"])
    assert {entry["event"]["type"] for entry in view["events"]} >= {"dice_rolled", "token_moved"}


def test_the_legal_commands_a_client_is_handed_are_the_ones_the_engine_accepts(client: TestClient) -> None:
    """The UI renders these as buttons, so every one of them has to be accepted (ADR-005)."""
    game_id = _create(client)["state"]["game_id"]
    view = client.post(f"/games/{game_id}/commands", json=_roll(0)).json()
    assert view["legal_commands"]
    for command in view["legal_commands"]:
        answer = client.post(f"/games/{game_id}/validate", json={"command": command}).json()
        assert answer["legal"] is True, f"{command} was offered but is not legal: {answer}"


def test_an_illegal_command_is_a_422_carrying_the_engines_key_and_params(client: TestClient) -> None:
    game_id = _create(client)["state"]["game_id"]
    response = client.post(f"/games/{game_id}/commands", json=_roll(1))
    assert response.status_code == UNPROCESSABLE
    assert response.json() == {"reason_key": "error.not_your_turn", "params": {}}


def test_a_rejections_context_params_survive_to_the_client(client: TestClient) -> None:
    """G-33: without the params, `error.insufficient_funds` can never say how much short."""
    game_id = _create(client)["state"]["game_id"]
    client.post(f"/games/{game_id}/commands", json=_roll(0))
    response = client.post(f"/games/{game_id}/commands", json={"command": {"kind": "end_turn", "player": 0}})
    assert response.status_code == UNPROCESSABLE
    assert response.json() == {
        "reason_key": "error.wrong_phase",
        "params": {"phase": "awaiting_purchase_decision"},
    }


def test_the_server_stamps_elapsed_seconds_and_ignores_the_clients_clock(client: TestClient, clock: FakeClock) -> None:
    """A client-chosen clock would let a player force or dodge Kids Mode's ending."""
    game_id = _create(client)["state"]["game_id"]
    clock.advance(42.9)
    client.post(f"/games/{game_id}/commands", json=_roll(0))
    view = _end_turn(client, game_id, elapsed_seconds=999_999)
    assert view["state"]["elapsed_seconds"] == 42


def test_a_command_against_an_unknown_game_is_a_404_with_a_key(client: TestClient) -> None:
    response = client.post("/games/nope/commands", json=_roll(0))
    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert response.json()["reason_key"] == "error.game_not_found"


def test_a_malformed_command_is_a_keyed_422(client: TestClient) -> None:
    game_id = _create(client)["state"]["game_id"]
    response = client.post(f"/games/{game_id}/commands", json={"command": {"kind": "teleport", "player": 0}})
    assert response.status_code == UNPROCESSABLE
    assert response.json()["reason_key"] == "error.malformed_request"


# --- POST /games/{id}/validate --------------------------------------------


def test_validate_answers_without_changing_anything(client: TestClient) -> None:
    """G-32: the trade builder needs a validation path that is not a speculative command."""
    game_id = _create(client)["state"]["game_id"]
    before = client.get(f"/games/{game_id}").json()
    response = client.post(f"/games/{game_id}/validate", json=_roll(0))
    assert response.status_code == status.HTTP_200_OK
    assert response.json() == {"legal": True, "reason_key": None, "params": {}}
    assert client.get(f"/games/{game_id}").json() == before


def test_validate_reports_an_illegal_command_as_a_200_with_a_reason(client: TestClient) -> None:
    game_id = _create(client)["state"]["game_id"]
    body = client.post(f"/games/{game_id}/validate", json=_roll(1)).json()
    assert body == {"legal": False, "reason_key": "error.not_your_turn", "params": {}}


def test_validate_against_an_unknown_game_is_a_404(client: TestClient) -> None:
    response = client.post("/games/nope/validate", json=_roll(0))
    assert response.status_code == status.HTTP_404_NOT_FOUND


# --- GET /games/{id} -------------------------------------------------------


def test_the_view_is_safe_to_poll_and_carries_no_events_without_a_cursor(client: TestClient) -> None:
    game_id = _create(client)["state"]["game_id"]
    client.post(f"/games/{game_id}/commands", json=_roll(0))
    response = client.get(f"/games/{game_id}")
    assert response.status_code == status.HTTP_200_OK
    view = response.json()
    assert view["events"] == []
    assert view["event_cursor"] > 0


def test_a_cursor_replays_only_what_the_client_has_not_seen(client: TestClient) -> None:
    game_id = _create(client)["state"]["game_id"]
    cursor = client.post(f"/games/{game_id}/commands", json=_roll(0)).json()["event_cursor"]
    replayed = client.get(f"/games/{game_id}?since=0").json()["events"]
    assert [entry["seq"] for entry in replayed] == list(range(1, cursor + 1))
    assert client.get(f"/games/{game_id}?since={cursor}").json()["events"] == []


def test_an_unknown_game_is_a_404_with_a_key(client: TestClient) -> None:
    response = client.get("/games/nope")
    assert response.status_code == status.HTTP_404_NOT_FOUND
    # ADR-008 §4 / G-33: errors are `{reason_key, params}` everywhere, not FastAPI's
    # `{detail}` — the key used to arrive under a field the generated client could not type.
    assert response.json()["reason_key"] == "error.game_not_found"


def test_a_negative_cursor_is_refused(client: TestClient) -> None:
    game_id = _create(client)["state"]["game_id"]
    assert client.get(f"/games/{game_id}?since=-1").status_code == UNPROCESSABLE


# --- Save and load ---------------------------------------------------------


def test_the_save_route_is_the_only_one_that_returns_hidden_information(client: TestClient) -> None:
    game_id = _create(client)["state"]["game_id"]
    response = client.get(f"/games/{game_id}/save")
    assert response.status_code == status.HTTP_200_OK
    saved = response.json()
    assert saved["rng"]["seed"] == 7
    assert len(saved["chance_deck"]) == len(CHANCE_CARD_IDS)
    assert saved["schema_version"] == SCHEMA_VERSION


def test_saving_an_unknown_game_is_a_404(client: TestClient) -> None:
    assert client.get("/games/nope/save").status_code == status.HTTP_404_NOT_FOUND


def test_a_saved_game_round_trips_through_load(client: TestClient) -> None:
    game_id = _create(client)["state"]["game_id"]
    client.post(f"/games/{game_id}/commands", json=_roll(0))
    saved = client.get(f"/games/{game_id}/save").json()
    client.delete(f"/games/{game_id}")

    response = client.post("/games/load", json=saved)
    assert response.status_code == status.HTTP_201_CREATED
    restored = response.json()
    assert restored["state"]["game_id"] == game_id
    assert restored["state"]["phase"] == saved["phase"]
    assert restored["state"]["players"][0]["position"] == saved["players"][0]["position"]
    assert client.get(f"/games/{game_id}/save").json() == saved


def test_loading_a_game_that_is_already_live_is_a_conflict(client: TestClient) -> None:
    game_id = _create(client)["state"]["game_id"]
    saved = client.get(f"/games/{game_id}/save").json()
    assert client.post("/games/load", json=saved).status_code == status.HTTP_409_CONFLICT


def test_a_stale_save_schema_is_a_keyed_422(client: TestClient) -> None:
    saved = minimal_state().model_dump(mode="json") | {"schema_version": SCHEMA_VERSION - 1}
    response = client.post("/games/load", json=saved)
    assert response.status_code == UNPROCESSABLE
    assert response.json()["reason_key"] == "error.save_schema_mismatch"


def test_a_save_naming_an_unknown_board_does_not_escape_as_a_500(client: TestClient) -> None:
    """``BoardDataError`` is not a ``ValueError``, so pydantic does not wrap it: as a declared
    body parameter it left the server as a traceback (MON-100 security advisory)."""
    saved = minimal_state().model_dump(mode="json") | {"board_id": "atlantis"}
    response = client.post("/games/load", json=saved)
    assert response.status_code == UNPROCESSABLE
    assert response.json()["reason_key"] == "error.save_schema_mismatch"


def test_a_structurally_broken_save_is_a_keyed_422(client: TestClient) -> None:
    response = client.post("/games/load", json={"not": "a game"})
    assert response.status_code == UNPROCESSABLE
    assert response.json()["reason_key"] == "error.save_schema_mismatch"


def test_an_oversized_save_is_refused_before_it_is_parsed(client: TestClient) -> None:
    app.dependency_overrides[get_settings] = lambda: Settings(max_save_bytes=64)
    response = client.post("/games/load", json=minimal_state().model_dump(mode="json"))
    assert response.status_code == CONTENT_TOO_LARGE
    assert response.json() == {"reason_key": "error.save_too_large", "params": {"limit_bytes": 64}}


# --- The bounded body read (MON-303 security review) ------------------------
#
# These two go straight at the ASGI app rather than through ``TestClient``, because the test
# client's transport calls ``request.read()`` and hands the app the whole body as one
# ``http.request`` message. Measuring the server's allocation through a client that has
# already buffered the upload would measure nothing.

CHUNK_BYTES: Final = 4096
"""One upload chunk. Also the ceiling below, so "one chunk over the line" is exact."""

OVERSIZED_CHUNKS: Final = 1024
"""4 MB sent against a 4 KB ceiling — a thousand times the limit."""


async def _post_load_chunked(chunks: int, ceiling: int) -> tuple[list[dict[str, Any]], int]:
    """POST a chunked ``/games/load`` body, returning the ASGI messages and chunks consumed.

    ``consumed`` is the falsifier: an app that buffers before checking asks for every chunk,
    an app that checks while reading stops at the first one over the line.
    """
    app.dependency_overrides[get_settings] = lambda: Settings(max_save_bytes=ceiling)
    consumed = 0

    async def receive() -> dict[str, Any]:
        nonlocal consumed
        if consumed >= chunks:
            return {"type": "http.request", "body": b"", "more_body": False}
        consumed += 1
        # A fresh buffer per chunk: one shared object would make the accumulation that
        # ``test_the_bounded_read_never_buffers_the_whole_body`` measures invisible.
        return {"type": "http.request", "body": b"x" * CHUNK_BYTES, "more_body": True}

    messages: list[dict[str, Any]] = []

    async def send(message: MutableMapping[str, Any]) -> None:
        messages.append(dict(message))

    scope: dict[str, Any] = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "POST",
        "path": "/games/load",
        "raw_path": b"/games/load",
        "root_path": "",
        "scheme": "http",
        "query_string": b"",
        # No content-length: a chunked upload declares none, which is exactly the case the
        # header fast path cannot cover.
        "headers": [(b"host", b"testserver"), (b"content-type", b"application/json")],
        "client": ("testclient", 50000),
        "server": ("testserver", 80),
    }
    await app(scope, receive, send)
    return messages, consumed


def _status_and_body(messages: list[dict[str, Any]]) -> tuple[int, Any]:
    start = next(message for message in messages if message["type"] == "http.response.start")
    body = b"".join(message.get("body", b"") for message in messages if message["type"] == "http.response.body")
    return int(start["status"]), json.loads(body)


async def test_an_oversized_save_is_refused_even_without_a_content_length() -> None:
    """A chunked upload declares no length, so the read itself has to be bounded too.

    The 413 was never the interesting half. This asserts the *ceiling was never exceeded*:
    the app stops pulling chunks at the first one that crosses the line, so it read two of
    the thousand that were on offer.
    """
    messages, consumed = await _post_load_chunked(chunks=OVERSIZED_CHUNKS, ceiling=CHUNK_BYTES)
    status_code, body = _status_and_body(messages)
    assert status_code == CONTENT_TOO_LARGE
    assert body == {"reason_key": "error.save_too_large", "params": {"limit_bytes": CHUNK_BYTES}}
    assert consumed == 2, "one chunk fits at exactly the ceiling; the second crosses it and ends the read"


async def test_the_bounded_read_never_buffers_the_whole_body() -> None:
    """The 413 was arriving *after* the allocation it was meant to prevent.

    Before this fix ``await request.body()`` buffered the upload and then compared its length
    to the ceiling: the reviewer measured a 120 MB ``tracemalloc`` peak for a 60 MB body sent
    against a 1 KB limit — 60 MB in the accumulated chunks and 60 MB again in the join. So the
    assertion here is on *memory*, not on the status code, because the status code was already
    right while the defect was live.
    """
    body_bytes = OVERSIZED_CHUNKS * CHUNK_BYTES
    tracemalloc.start()
    try:
        messages, _ = await _post_load_chunked(chunks=OVERSIZED_CHUNKS, ceiling=CHUNK_BYTES)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()

    assert _status_and_body(messages)[0] == CONTENT_TOO_LARGE
    # Generous in absolute terms — a request costs a few tens of KB in framework objects —
    # and still two orders of magnitude below the body, which is the only thing that matters:
    # the pre-fix implementation peaks at ~2x the body.
    assert peak < 100 * CHUNK_BYTES, f"peaked at {peak} bytes reading a {body_bytes}-byte body"
    assert peak < body_bytes // 8


def test_the_load_route_still_declares_a_gamestate_body(client: TestClient) -> None:
    """The body is read raw, so the contract is declared by hand — assert it is still there."""
    operation = client.get("/openapi.json").json()["paths"]["/games/load"]["post"]
    schema = operation["requestBody"]["content"]["application/json"]["schema"]
    assert schema == {"$ref": "#/components/schemas/GameState"}


# --- DELETE ----------------------------------------------------------------


def test_deleting_a_game_removes_it(client: TestClient) -> None:
    game_id = _create(client)["state"]["game_id"]
    assert client.delete(f"/games/{game_id}").status_code == status.HTTP_204_NO_CONTENT
    assert client.get(f"/games/{game_id}").status_code == status.HTTP_404_NOT_FOUND
    assert client.get("/games").json() == []


def test_deleting_an_unknown_game_is_a_404_with_a_key(client: TestClient) -> None:
    response = client.delete("/games/nope")
    assert response.status_code == status.HTTP_404_NOT_FOUND
    # ADR-008 §4: `{reason_key, params}`, not FastAPI's `{detail}`. See the note above.
    assert response.json()["reason_key"] == "error.game_not_found"


# --- Playing a real game over HTTP -----------------------------------------


def test_two_players_can_take_a_turn_each_through_the_api(client: TestClient) -> None:
    """The acceptance path, driven the way the UI will drive it: only ever send a command the
    last view offered, and never work out whether it is allowed."""
    game_id = _create(client)["state"]["game_id"]
    view = client.get(f"/games/{game_id}").json()
    seen: set[str] = set()

    for _ in range(12):
        commands = view["legal_commands"]
        assert commands, "a UI driven by legal_commands cannot recover from an empty list"
        chosen = _prefer(commands)
        seen.add(chosen["kind"])
        response = client.post(f"/games/{game_id}/commands", json={"command": chosen})
        assert response.status_code == status.HTTP_200_OK, response.text
        view = response.json()

    assert {"roll_dice", "end_turn"} <= seen
    assert view["state"]["turn_number"] > 1
    assert view["event_cursor"] >= 6
    assert client.get(f"/games/{game_id}?since=0").json()["events"][0]["seq"] == 1


def test_landing_on_an_unowned_property_offers_both_answers(client: TestClient) -> None:
    """Landing on a property must offer exactly what the rules offer — not a subset."""
    game_id = _create(client)["state"]["game_id"]
    view = client.post(f"/games/{game_id}/commands", json=_roll(0)).json()
    assert view["state"]["phase"] == "awaiting_purchase_decision", "seed 7 is chosen so this holds"
    assert {command["kind"] for command in view["legal_commands"]} >= {"buy_property", "decline_purchase"}


def test_buying_a_property_shows_up_in_the_promoted_dossier_fields(client: TestClient) -> None:
    game_id = _create(client)["state"]["game_id"]
    client.post(f"/games/{game_id}/commands", json=_roll(0))
    view = client.post(f"/games/{game_id}/commands", json={"command": {"kind": "buy_property", "player": 0}}).json()
    player = view["state"]["players"][0]
    assert len(player["tiles_owned"]) == 1
    assert sum(entry["owned"] for entry in player["group_holdings"]) == 1
    assert player["net_worth"] == 1500, "cash out, deed in — a purchase at list price is net neutral"


def test_declining_a_purchase_opens_an_auction_the_view_can_render(client: TestClient) -> None:
    """The auction frame's derived fields must reach the bid widget (G-36)."""
    game_id = _create(client)["state"]["game_id"]
    client.post(f"/games/{game_id}/commands", json=_roll(0))
    view = client.post(f"/games/{game_id}/commands", json={"command": {"kind": "decline_purchase", "player": 0}}).json()
    assert view["state"]["phase"] == "auction"
    frame = view["state"]["interrupts"][-1]
    assert frame["kind"] == "auction"
    assert frame["reason"] == "declined_purchase"
    assert frame["min_bid"] >= 1
    assert frame["withdrawn"] == []
    assert sorted(frame["eligible"]) == [0, 1]


# --- Helpers ---------------------------------------------------------------


def _create(client: TestClient, **overrides: object) -> dict[str, Any]:
    response = client.post("/games", json=new_game_payload(**overrides))
    assert response.status_code == status.HTTP_201_CREATED, response.text
    body: dict[str, Any] = response.json()
    return body


def _roll(player: int) -> dict[str, Any]:
    return {"command": {"kind": "roll_dice", "player": player}}


def _end_turn(client: TestClient, game_id: str, **extras: object) -> dict[str, Any]:
    """Answer whatever the tile asked, then end the turn."""
    view = client.get(f"/games/{game_id}").json()
    while not any(command["kind"] == "end_turn" for command in view["legal_commands"]):
        chosen = _prefer(view["legal_commands"])
        response = client.post(f"/games/{game_id}/commands", json={"command": chosen})
        assert response.status_code == status.HTTP_200_OK, response.text
        view = response.json()
    current = view["state"]["current_player_id"]
    end_turn: dict[str, Any] = {"kind": "end_turn", "player": current, **extras}
    response = client.post(f"/games/{game_id}/commands", json={"command": end_turn})
    assert response.status_code == status.HTTP_200_OK, response.text
    body: dict[str, Any] = response.json()
    return body


_PREFERENCE = ("roll_dice", "buy_property", "end_turn", "pay_jail_fine", "use_jail_card", "roll_for_jail")


def _prefer(commands: list[dict[str, Any]]) -> dict[str, Any]:
    """Play forwards: prefer the commands that advance a turn, in that order."""
    for kind in _PREFERENCE:
        for command in commands:
            if command["kind"] == kind:
                return command
    return commands[0]


@pytest.fixture(autouse=True)
def _no_leaked_overrides() -> Any:
    """Two tests swap a dependency mid-test; make sure none of it survives the test."""
    yield
    app.dependency_overrides.clear()
