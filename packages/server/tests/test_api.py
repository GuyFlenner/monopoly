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
from conftest import SESSION_TTL_SECONDS, FakeClock, minimal_state, new_game_payload, seat
from fastapi import status
from fastapi.testclient import TestClient

from kesef_engine.board.models import BOARD_SIZE
from kesef_engine.decks import CHANCE_CARD_IDS, COMMUNITY_CHEST_CARD_IDS
from kesef_engine.errors import BoardDataError, EngineError, IllegalCommandError
from kesef_engine.ruleset import Ruleset
from kesef_engine.state import MAX_PLAYERS, MIN_PLAYERS, SCHEMA_VERSION
from kesef_server.api import WS_EVENT_STREAM_PATH, app, get_settings, get_store
from kesef_server.config import Settings
from kesef_server.errors import MAX_REFLECTED_CHARS
from kesef_server.schemas import ErrorResponse, is_addressable_game_id
from kesef_server.sessions import SessionStore

UNPROCESSABLE = 422
"""Spelled as a number: starlette has renamed this constant once already."""

CONTENT_TOO_LARGE = 413

EXPECTED_PATHS: Final = {
    ("get", "/health"),
    ("get", "/boards"),
    ("get", "/rulesets"),
    ("post", "/games"),
    # No `("get", "/games")`: MON-909 deleted the lobby route. It enumerated every live game id
    # and its players on a public API, nullifying the 64 bits of id entropy that is currently all
    # that stands between a stranger and somebody else's game.
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
    # MON-712: per-game amendments to the named rule set, a closed set of fields rather than an
    # open patch over `Ruleset` — see the class docstring on why the wire is not the engine's model.
    "HouseRules",
    "AuctionMinimum",
    "SeatConfig",
    "CommandRequest",
    "LegalityView",
    "ErrorResponse",
    "BoardSummary",
    # The ruleset projection (MON-417, G-36): `/rulesets` no longer returns raw flags, so the
    # setup screen's client-side diff and its `ruleset.<field>` label map both deleted.
    "RulesetView",
    "RuleFlagView",
    "RuleFlagValue",
    "RuleNumberValue",
    "RuleNumberListValue",
    "RuleAbsentValue",
    # The save file — the one place the full state is still on the wire. Since ADR-011 it is an
    # envelope: the state, and the session's log that a bare `GameState` had no room for.
    "SaveFile",
    "IfExists",
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
    # MON-420: the shape `RentCharged` inherits, and what `GameStateView.rent_quotes` ships.
    "RentQuote",
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
        if not path.startswith("/games"):
            continue
        responses = schema["paths"][path][method]["responses"]
        failures = [code for code in responses if code.startswith(("4", "5"))]
        assert failures, f"{method.upper()} {path} declares no error response"
        for code in failures:
            body = responses[code].get("content", {}).get("application/json", {}).get("schema", {})
            assert "ErrorResponse" in str(body), f"{method.upper()} {path} {code} is untyped"


UNDECLARED_FAILURES: Final = [
    ("get", "/nope", status.HTTP_404_NOT_FOUND),
    ("get", "/games/a/b", status.HTTP_404_NOT_FOUND),
    ("get", "/games/kitchen-table/nonsense", status.HTTP_404_NOT_FOUND),
    ("put", "/games", status.HTTP_405_METHOD_NOT_ALLOWED),
    ("delete", "/health", status.HTTP_405_METHOD_NOT_ALLOWED),
    ("post", "/games/anything/save", status.HTTP_405_METHOD_NOT_ALLOWED),
]
"""Failures the document does not declare, which is exactly why they escaped.

The test above walks the *declared* operations and structurally could not catch these: with no
`StarletteHTTPException` handler, `GET /nope` answered `{"detail":"Not Found"}` and `PUT /games`
`{"detail":"Method Not Allowed"}` — a shape declared nowhere, so a generated client could not
branch on it (G-33 / ADR-008 §4)."""


@pytest.mark.parametrize(("method", "path", "expected"), UNDECLARED_FAILURES)
def test_a_failure_the_document_never_declared_still_answers_in_the_one_shape(
    client: TestClient, method: str, path: str, expected: int
) -> None:
    response = client.request(method, path)
    assert response.status_code == expected
    body = response.json()
    assert set(body) == {"reason_key", "params"}, f"{method.upper()} {path} answered {body}"
    assert body["reason_key"].startswith("error.")
    ErrorResponse.model_validate(body)


def test_the_two_starlette_failures_carry_the_keys_the_catalogue_will_need(client: TestClient) -> None:
    """Named rather than merely well-shaped: a client that cannot tell 404 from 405 by key is
    back to branching on a status code and guessing at the sentence."""
    assert client.get("/nope").json() == {"reason_key": "error.not_found", "params": {"status": 404}}
    refused = client.put("/games")
    assert refused.json() == {"reason_key": "error.method_not_allowed", "params": {"status": 405}}
    assert "Allow" in refused.headers, "a 405 without Allow is a 405 the client cannot act on"


# --- CORS -------------------------------------------------------------------

CORS_ORIGIN: Final = "http://localhost:5173"
"""The one origin `Settings.cors_origins` ships with — the Vite dev server."""

SAFELISTED_REQUEST_HEADERS: Final = {"accept", "accept-language", "content-language", "content-type"}
"""The CORS spec's own always-allowed set, which starlette adds to whatever we pass. A browser
may send these on a cross-origin request with no preflight at all, so they are not ours to
withhold — the assertion below is about the headers this API adds *beyond* them."""


def _preflight(client: TestClient, method: str, headers: str | None = None) -> Any:
    asking = {"Origin": CORS_ORIGIN, "Access-Control-Request-Method": method}
    if headers is not None:
        asking["Access-Control-Request-Headers"] = headers
    return client.options("/games", headers=asking)


def _listed(response: Any, header: str) -> set[str]:
    return {value.strip().lower() for value in response.headers[header].split(",")}


def test_the_preflight_permits_exactly_the_verbs_and_headers_this_api_serves() -> None:
    """MON-909: `allow_methods=["*"]` advertised PUT, PATCH and TRACE cross-origin on an app that
    answers 405 to all three, and `allow_headers=["*"]` let a page send anything at all.

    `Authorization` is named on purpose and ahead of its use: MON-906 puts per-seat Bearer
    secrets on `/games/{id}` requests, and a browser will not send that header cross-origin
    unless the preflight already permits it.
    """
    with TestClient(app) as client:
        response = _preflight(client, "POST", headers="Content-Type, Authorization")

        assert response.status_code == status.HTTP_200_OK
        assert _listed(response, "access-control-allow-methods") == {"get", "post", "delete", "options"}
        assert _listed(response, "access-control-allow-headers") == SAFELISTED_REQUEST_HEADERS | {"authorization"}
        assert response.headers["access-control-allow-origin"] == CORS_ORIGIN


@pytest.mark.parametrize("method", ["PUT", "PATCH", "TRACE"])
def test_a_verb_the_api_does_not_serve_is_refused_at_the_preflight(method: str) -> None:
    """A failed preflight is a 400 whose allow-list does not name what was asked for, and a
    browser refuses to send the real request on that answer alone."""
    with TestClient(app) as client:
        response = _preflight(client, method)
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert method.lower() not in _listed(response, "access-control-allow-methods")


def test_a_header_the_api_never_reads_is_refused_at_the_preflight() -> None:
    with TestClient(app) as client:
        response = _preflight(client, "POST", headers="X-Seat-Secret")
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert "x-seat-secret" not in _listed(response, "access-control-allow-headers")


def test_an_origin_the_settings_do_not_name_gets_no_allow_origin_back() -> None:
    with TestClient(app) as client:
        response = client.options(
            "/games",
            headers={"Origin": "https://not-ours.example", "Access-Control-Request-Method": "POST"},
        )
        assert "access-control-allow-origin" not in response.headers


def test_a_reflected_id_is_truncated_rather_than_amplified(client: TestClient) -> None:
    """A 5000-character `board_id` came back inside a 5061-byte body. No catalogue sentence is
    improved by more than a glance at the id."""
    response = client.post("/games", json=new_game_payload(board_id="z" * 5000))
    assert response.status_code == UNPROCESSABLE
    reflected = response.json()["params"]["board_id"]
    assert len(reflected) <= MAX_REFLECTED_CHARS + 3
    assert reflected.startswith("zzz") and reflected.endswith("...")
    assert len(response.content) < 200


def test_a_reflected_game_id_is_truncated_too(client: TestClient) -> None:
    long_id = "g" * 5000
    response = client.get(f"/games/{long_id}")
    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert len(response.json()["params"]["game_id"]) <= MAX_REFLECTED_CHARS + 3


def test_an_engine_failure_that_is_not_an_illegal_command_is_still_a_key(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`IllegalCommandError` had a handler; nothing else did, so any other `EngineError` left
    the server as a bare 500 with a traceback."""
    game_id = _create(client)["state"]["game_id"]

    def explode(*_args: object, **_kwargs: object) -> None:
        raise BoardDataError("a rule module could not read its board")

    monkeypatch.setattr("kesef_server.api.apply", explode)
    response = client.post(f"/games/{game_id}/commands", json=_roll(0))
    assert response.status_code == status.HTTP_500_INTERNAL_SERVER_ERROR
    assert response.json() == {"reason_key": "error.engine_failure", "params": {}}
    assert "board" not in response.text, "the exception's own text must not reach the client"

    # And the document says so, or the generated client cannot branch on it (G-33).
    responses = client.get("/openapi.json").json()["paths"]["/games/{game_id}/commands"]["post"]["responses"]
    assert "ErrorResponse" in str(responses["500"])


def test_an_unknown_board_key_is_not_pinned_on_every_engine_failure(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`except EngineError` labelled every failure `error.unknown_board`, including ones that
    had nothing to do with a board id."""

    def explode(*_args: object, **_kwargs: object) -> None:
        raise EngineError("something else entirely")

    monkeypatch.setattr("kesef_server.api.new_game", explode)
    response = client.post("/games", json=new_game_payload())
    assert response.json()["reason_key"] == "error.engine_failure"


def test_a_context_param_the_catalogue_could_not_interpolate_is_coerced(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`IllegalCommandError` is typed `**context: object`. Every rule in the engine passes ints
    and strings, so the coercion arm was unreachable and api.py's 100% was not honest about it.
    An engine that one day passes a tuple gets a string, not a 500."""

    def refuse(*_args: object, **_kwargs: object) -> None:
        raise IllegalCommandError("error.made_up", tiles=(1, 2), amount=7)

    game_id = _create(client)["state"]["game_id"]
    monkeypatch.setattr("kesef_server.api.apply", refuse)
    response = client.post(f"/games/{game_id}/commands", json=_roll(0))
    assert response.status_code == UNPROCESSABLE
    assert response.json() == {"reason_key": "error.made_up", "params": {"tiles": "(1, 2)", "amount": 7}}


def test_a_route_specific_key_is_not_flattened_into_the_generic_one(client: TestClient) -> None:
    """The handler must only cover what starlette raises. A 404 a *route* answered still says
    which game was missing."""
    assert client.get("/games/nope").json()["reason_key"] == "error.game_not_found"


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


def test_boards_endpoint_says_whether_a_board_can_be_named(client: TestClient) -> None:
    """MON-419 / G-46: the flag the picker filters on, so no board of blanks can be chosen.

    Both boards carry verified names in both languages as of MON-503, so both are true here — and
    the assertion that matters is not the value but that the field *exists on every board*, since
    the picker treats a missing flag as "not ready" and would offer nothing at all.
    """
    boards = client.get("/boards").json()
    assert boards, "no boards listed, so this asserts nothing"
    for board in boards:
        assert "catalogue_ready" in board, f"{board['id']} would be filtered out of the picker"
        assert board["catalogue_ready"] is True


def test_boards_endpoint_returns_keys_not_prose(client: TestClient) -> None:
    """The API must never hand the client an English string to display."""
    for board in client.get("/boards").json():
        assert board["name_key"].startswith("board.")


def test_rulesets_endpoint_exposes_what_kids_mode_changes(client: TestClient) -> None:
    """MON-417: the raw flags still ship, and each setting now arrives explained.

    The ``ruleset`` object is unchanged — the game screen reads flags off it — but a client no
    longer has to diff two of them or invent label keys, which is what the setup screen did.
    """
    rulesets = {view["name"]: view for view in client.get("/rulesets").json()}
    assert set(rulesets) == {"universal", "kids"}
    assert rulesets["universal"]["ruleset"]["auctions_enabled"] is True
    assert rulesets["kids"]["ruleset"]["auctions_enabled"] is False
    assert rulesets["kids"]["ruleset"]["hints_enabled"] is True
    assert rulesets["kids"]["label_key"] == "setup.kids"


# --- House rules, per game (MON-712) -----------------------------------------
#
# The owner's report: a child bid ₪1 on every declined square and won all of them. Two settings
# answer it — turning the auction off, and giving it a floor — and both had to become *reachable*,
# because until this the wire took only a rule set's name.
#
# The falsifier throughout is a house rule that is accepted and then dropped on the floor: a request
# body pydantic is happy with, a 201, and a game playing the unamended rules. So every test below
# reads the flag back off the *game's own* projection rather than off the request.


def test_a_table_can_turn_auctions_off_for_its_own_game(client: TestClient) -> None:
    payload = new_game_payload(house_rules={"auctions_enabled": False})
    view = client.post("/games", json=payload).json()
    assert view["state"]["ruleset"]["auctions_enabled"] is False
    # And it is still the universal rule set: turning one thing off is not switching to Kids Mode.
    assert view["state"]["ruleset"]["name"] == "universal"
    assert view["state"]["ruleset"]["starting_cash"] == 1500


def test_a_table_can_give_the_auction_a_floor(client: TestClient) -> None:
    payload = new_game_payload(house_rules={"auction_minimum": "list_price"})
    view = client.post("/games", json=payload).json()
    assert view["state"]["ruleset"]["auction_minimum"] == "list_price"
    assert view["state"]["ruleset"]["auctions_enabled"] is True, "a floor is not an off switch"


def test_a_game_with_no_house_rules_is_the_named_rule_set_exactly(client: TestClient) -> None:
    """The default has to stay the printed rules, or the goldens record a variant."""
    view = client.post("/games", json=new_game_payload()).json()
    assert view["state"]["ruleset"] == Ruleset.universal().model_dump(mode="json")


def test_house_rules_amend_kids_mode_without_replacing_it(client: TestClient) -> None:
    """Composability, which is the reason every field is optional and defaults to `None`.

    A kids game already has auctions off. A house rule that says nothing about auctions must leave
    them off — an amendment that rebuilt the rule set from its own fields would turn them back on.
    """
    payload = new_game_payload(ruleset="kids", house_rules={"auction_minimum": "list_price"})
    ruleset = client.post("/games", json=payload).json()["state"]["ruleset"]
    assert ruleset["auctions_enabled"] is False, "the kids setting survived the amendment"
    assert ruleset["auction_minimum"] == "list_price"
    assert ruleset["starting_cash"] == 2000, "and so did everything else Kids Mode changes"


def test_the_wire_is_not_an_open_patch_over_the_engine_model(client: TestClient) -> None:
    """`extra="forbid"`: a client cannot hand itself 500 houses and call it a house rule."""
    payload = new_game_payload(house_rules={"houses_available": 500})
    assert client.post("/games", json=payload).status_code == UNPROCESSABLE


def test_a_house_rule_that_is_not_a_rule_is_refused(client: TestClient) -> None:
    payload = new_game_payload(house_rules={"auction_minimum": "whatever_i_like"})
    assert client.post("/games", json=payload).status_code == UNPROCESSABLE


def test_every_ruleset_flag_arrives_with_a_label_key(client: TestClient) -> None:
    for view in client.get("/rulesets").json():
        assert view["flags"], f"{view['name']} explains nothing"
        for flag in view["flags"]:
            assert flag["label_key"] == f"ruleset.{flag['field']}"
        assert "name" not in {flag["field"] for flag in view["flags"]}, "the identity is not a setting"


def test_the_universal_rules_differ_from_themselves_in_nothing(client: TestClient) -> None:
    """The baseline half of the diff. A ``differs_from_universal`` that were always true would
    satisfy the Kids-mode test below and list every rule in the game under "what this changes"."""
    universal = next(view for view in client.get("/rulesets").json() if view["name"] == "universal")
    assert [flag["field"] for flag in universal["flags"] if flag["differs_from_universal"]] == []


def test_kids_mode_marks_exactly_the_settings_it_changes(client: TestClient) -> None:
    kids = next(view for view in client.get("/rulesets").json() if view["name"] == "kids")
    changed = {flag["field"] for flag in kids["flags"] if flag["differs_from_universal"]}
    assert changed == {
        "starting_cash",
        "auctions_enabled",
        "mortgages_enabled",
        "max_jail_turns",
        "hints_enabled",
        "target_duration_minutes",
        "simplified_trades",
    }


def test_a_flag_carries_both_halves_of_the_change_classified_by_kind(client: TestClient) -> None:
    """Both values, tagged — so a row reads "Auctions: off (full rules: on)" without the client
    sniffing at ``boolean | number | number[] | null``."""
    kids = next(view for view in client.get("/rulesets").json() if view["name"] == "kids")
    flags = {flag["field"]: flag for flag in kids["flags"]}

    assert flags["auctions_enabled"]["value"] == {"kind": "flag", "on": False}
    assert flags["auctions_enabled"]["universal_value"] == {"kind": "flag", "on": True}
    assert flags["starting_cash"]["value"] == {"kind": "number", "value": 2000}
    # A boolean must never classify as the number 1: `isinstance(True, int)` is true in Python.
    assert flags["hints_enabled"]["value"]["kind"] == "flag"
    # "No target length" is its own case, not a zero.
    assert flags["target_duration_minutes"]["universal_value"] == {"kind": "absent"}
    assert flags["target_duration_minutes"]["value"] == {"kind": "number", "value": 45}
    assert flags["starting_cash_denominations"]["value"] == {
        "kind": "numbers",
        "values": [500, 100, 50, 20, 10, 5, 1],
    }


def test_there_is_no_route_that_enumerates_the_live_games(client: TestClient, store: SessionStore) -> None:
    """MON-909: the lobby route is gone, and a live game does not bring it back.

    `POST /games` still exists, so the path is known and the answer is starlette's keyed 405 —
    the same shape every other refusal has, not FastAPI's `{"detail": ...}`.
    """
    created = _create(client)
    assert store.all(), "nothing was live, so an empty answer would prove nothing"

    refused = client.get("/games")
    assert refused.status_code == status.HTTP_405_METHOD_NOT_ALLOWED
    assert refused.json() == {"reason_key": "error.method_not_allowed", "params": {"status": 405}}
    assert created["state"]["game_id"] not in refused.text, "the refusal leaked the id it refused to list"


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
    assert isinstance(saved["state"]["rng"]["seed"], int)


def test_a_client_may_name_its_game(client: TestClient) -> None:
    view = client.post("/games", json=new_game_payload(game_id="kitchen-table")).json()
    assert view["state"]["game_id"] == "kitchen-table"


UNADDRESSABLE_GAME_IDS: Final = [
    "kitchen/table",  # 201, listed, then unreachable by GET, POST, %2F *or* DELETE
    "..",  # 201, then 404 to both GET and DELETE
    ".",  # 201, 200 to GET, and 405 to DELETE
    "../etc",
    "  ",
    "a b",
    "a\n",
    "a" * 65,
    "",
]
"""Ids that cannot survive a URL path segment. Each one used to occupy a session slot that
no route could reach or free — see ``schemas.GAME_ID_PATTERN``."""


@pytest.mark.parametrize("game_id", UNADDRESSABLE_GAME_IDS)
def test_a_game_id_that_could_not_be_addressed_is_refused(client: TestClient, game_id: str) -> None:
    response = client.post("/games", json=new_game_payload(game_id=game_id))
    assert response.status_code == UNPROCESSABLE, f"{game_id!r} was accepted"
    assert response.json() == {"reason_key": "error.malformed_request", "params": {"fields": "game_id"}}


def test_the_session_cap_cannot_be_wedged_by_ids_that_cannot_be_deleted(client: TestClient) -> None:
    """The security condition, stated as the thing an attacker wanted (MON-303 review).

    A one-slot server: every unaddressable id must leave the slot free, because a game under
    such an id could never be deleted and 503 would then be permanent.
    """
    store = SessionStore(max_sessions=1, ttl_seconds=SESSION_TTL_SECONDS, clock=FakeClock())
    app.dependency_overrides[get_store] = lambda: store

    for game_id in UNADDRESSABLE_GAME_IDS:
        assert client.post("/games", json=new_game_payload(game_id=game_id)).status_code == UNPROCESSABLE
    assert len(store) == 0, "an id nobody can delete took the only slot"

    assert client.post("/games", json=new_game_payload(game_id="kitchen-table")).status_code == 201
    assert client.post("/games", json=new_game_payload(game_id="second")).status_code == 503
    assert client.delete("/games/kitchen-table").status_code == status.HTTP_204_NO_CONTENT
    assert client.post("/games", json=new_game_payload(game_id="second")).status_code == 201


def test_a_duplicate_game_id_is_a_conflict_not_a_silent_overwrite(client: TestClient) -> None:
    client.post("/games", json=new_game_payload(game_id="dup"))
    response = client.post("/games", json=new_game_payload(game_id="dup", seats=[seat("Cal"), seat("Dot")]))
    assert response.status_code == status.HTTP_409_CONFLICT
    assert response.json()["reason_key"] == "error.game_already_exists"
    assert [player["name"] for player in client.get("/games/dup").json()["state"]["players"]] == ["Ann", "Ben"]


def test_the_session_cap_is_a_key_based_error(client: TestClient) -> None:
    full = SessionStore(max_sessions=0, ttl_seconds=SESSION_TTL_SECONDS, clock=FakeClock())
    app.dependency_overrides[get_store] = lambda: full
    response = client.post("/games", json=new_game_payload())
    assert response.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
    assert response.json()["reason_key"] == "error.server_at_capacity"


def test_an_unknown_board_is_a_key_based_422(client: TestClient) -> None:
    response = client.post("/games", json=new_game_payload(board_id="atlantis"))
    assert response.status_code == UNPROCESSABLE
    assert response.json() == {"reason_key": "error.unknown_board", "params": {"board_id": "atlantis"}}


def test_duplicate_seat_names_are_the_engines_refusal_and_say_which_name(client: TestClient) -> None:
    """MON-418: the server does not look for duplicate names; the factory does, and it names one.

    ``error.invalid_new_game`` used to be the answer — one coarse key covering three different
    mistakes, so a screen could only recite all of them and hope the parent spotted theirs.
    """
    response = client.post("/games", json=new_game_payload(seats=[seat("Ann"), seat("ann")]))
    assert response.status_code == UNPROCESSABLE
    assert response.json() == {"reason_key": "error.duplicate_names", "params": {"name": "ann"}}


def test_a_one_player_game_is_refused_with_the_rule_not_with_a_field_path(client: TestClient) -> None:
    """MON-418: "a game needs two players" reaches the screen as itself.

    The constraint was a pydantic ``min_length`` on ``seats``, so this answered
    ``error.malformed_request`` with ``fields: "seats"`` — a form complaint about a rule, and one
    the setup screen deliberately does not check for itself (validation is the engine's, ADR-005).
    """
    response = client.post("/games", json={"seats": [seat("Solo")]})
    assert response.status_code == UNPROCESSABLE
    assert response.json() == {
        "reason_key": "error.too_few_players",
        "params": {"minimum": MIN_PLAYERS, "seats": 1},
    }


def test_an_empty_table_is_refused_the_same_way(client: TestClient) -> None:
    """Zero seats reaches the engine too, now that the field carries no ``min_length``."""
    response = client.post("/games", json={"seats": []})
    assert response.status_code == UNPROCESSABLE
    assert response.json()["reason_key"] == "error.too_few_players"


def test_a_refusal_the_factory_does_not_name_stays_one_coarse_key(client: TestClient) -> None:
    """MON-418 keyed the three refusals a *player* can cause. This is the floor under the rest.

    Two seats sharing a ``token`` is reachable from the wire — ``SeatConfig.token`` is free-form —
    and it is refused by ``GameState``'s own validator as a bare ``ValueError`` rather than by the
    factory's keyed checks. That is a client defect, not a mistake a parent made (the setup screen
    assigns a distinct piece per seat), so it keeps the coarse key: guessing a precise one here
    would mean the transport holding a copy of a rule, which is what ``errors.py`` forbids.
    """
    seats = [seat("Ann"), {**seat("Bob"), "token": seat("Ann")["token"]}]
    response = client.post("/games", json={"seats": seats})
    assert response.status_code == UNPROCESSABLE
    assert response.json() == {"reason_key": "error.invalid_new_game", "params": {}}


def test_too_many_seats_is_refused_with_the_ceiling(client: TestClient) -> None:
    response = client.post("/games", json={"seats": [seat(f"P{i}") for i in range(MAX_PLAYERS + 1)]})
    assert response.status_code == UNPROCESSABLE
    assert response.json() == {
        "reason_key": "error.too_many_players",
        "params": {"maximum": MAX_PLAYERS, "seats": MAX_PLAYERS + 1},
    }


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


@pytest.mark.parametrize(
    "command",
    [
        {"kind": "roll_dice", "player": 0, "<img src=x>": 1},
        {"kind": "end_turn", "player": 0, "elapsed_second": 5},
        {"kind": "place_bid", "player": 0, "amount": 5, "ammount": 500},
    ],
    ids=["injected key", "misspelled elapsed_seconds", "misspelled amount"],
)
def test_a_command_carrying_a_field_the_engine_does_not_declare_is_refused(
    client: TestClient, command: dict[str, Any]
) -> None:
    """A command is a closed shape, and the wire is the only place one is built from untrusted
    keys. Silently ignored, a misspelled `elapsed_seconds` drops a player's clock and a 200 says
    the request was fine."""
    game_id = _create(client)["state"]["game_id"]
    response = client.post(f"/games/{game_id}/commands", json={"command": command})
    assert response.status_code == UNPROCESSABLE
    assert response.json()["reason_key"] == "error.malformed_request"


def test_a_trade_payload_forbids_extras_too(client: TestClient) -> None:
    """`TradeSide` is command payload: a misspelled `cash` that is ignored offers nothing while
    looking like a full offer."""
    game_id = _create(client)["state"]["game_id"]
    offer = {
        "proposer": 0,
        "recipient": 1,
        "give": {"cash": 10, "cashh": 500},
        "receive": {"tiles": [1]},
    }
    response = client.post(
        f"/games/{game_id}/commands",
        json={"command": {"kind": "propose_trade", "player": 0, "offer": offer}},
    )
    assert response.status_code == UNPROCESSABLE
    assert response.json()["reason_key"] == "error.malformed_request"


def test_a_dumped_command_still_round_trips_through_the_wire(client: TestClient) -> None:
    """`extra="forbid"` must not break the shape the API hands out. Every command in
    `legal_commands` is dumped by this server and sent straight back by the UI."""
    game_id = _create(client)["state"]["game_id"]
    for command in client.get(f"/games/{game_id}").json()["legal_commands"]:
        answer = client.post(f"/games/{game_id}/validate", json={"command": command})
        assert answer.status_code == status.HTTP_200_OK, answer.text
        assert answer.json()["legal"] is True


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


def test_an_idle_game_is_evicted_and_answers_the_ordinary_404(
    client: TestClient, clock: FakeClock, store: SessionStore
) -> None:
    """`session_ttl_minutes` reaching the wire: from the client's side an evicted game is a
    game that is not there, which is the same key as one that never was."""
    game_id = _create(client)["state"]["game_id"]
    clock.advance(SESSION_TTL_SECONDS + 1)
    response = client.get(f"/games/{game_id}")
    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert response.json()["reason_key"] == "error.game_not_found"
    assert store.all() == (), "the slot was answered 404 but never reclaimed"


def test_a_negative_cursor_is_refused(client: TestClient) -> None:
    game_id = _create(client)["state"]["game_id"]
    assert client.get(f"/games/{game_id}?since=-1").status_code == UNPROCESSABLE


# --- Save and load ---------------------------------------------------------


def test_the_save_route_is_the_only_one_that_returns_hidden_information(client: TestClient) -> None:
    game_id = _create(client)["state"]["game_id"]
    response = client.get(f"/games/{game_id}/save")
    assert response.status_code == status.HTTP_200_OK
    saved = response.json()
    assert saved["state"]["rng"]["seed"] == 7
    assert len(saved["state"]["chance_deck"]) == len(CHANCE_CARD_IDS)
    assert saved["state"]["schema_version"] == SCHEMA_VERSION


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
    assert restored["state"]["phase"] == saved["state"]["phase"]
    assert restored["state"]["players"][0]["position"] == saved["state"]["players"][0]["position"]
    assert client.get(f"/games/{game_id}/save").json() == saved


def test_loading_a_game_that_is_already_live_is_a_conflict(client: TestClient) -> None:
    """The default, and therefore the answer to the same request as yesterday's (ADR-011)."""
    game_id = _create(client)["state"]["game_id"]
    saved = client.get(f"/games/{game_id}/save").json()
    assert client.post("/games/load", json=saved).status_code == status.HTTP_409_CONFLICT
    refused = client.post("/games/load?if_exists=refuse", json=saved)
    assert refused.status_code == status.HTTP_409_CONFLICT
    assert refused.json()["params"]["game_id"] == game_id


def test_a_load_may_replace_the_live_game_when_the_player_says_so(client: TestClient, store: SessionStore) -> None:
    """MON-714: the answer to "Replace the game in progress" (ADR-011).

    The file is deliberately *behind* the live game, because that is the case where a replace is a
    real decision rather than a no-op — and the case a silent replace would have lost without asking.
    """
    game_id = _create(client)["state"]["game_id"]
    saved = client.get(f"/games/{game_id}/save").json()
    client.post(f"/games/{game_id}/commands", json=_roll(0))
    ahead = client.get(f"/games/{game_id}").json()["state"]
    assert ahead["phase"] != saved["state"]["phase"], "the live game did not move, so nothing is at stake"

    response = client.post("/games/load?if_exists=replace", json=saved)
    assert response.status_code == status.HTTP_201_CREATED
    assert response.json()["state"]["game_id"] == game_id, "a replace keeps the id it took over"
    assert client.get(f"/games/{game_id}").json()["state"]["phase"] == saved["state"]["phase"]
    assert len(store) == 1, "a replace left two sessions behind"


def test_a_load_may_be_seated_beside_the_live_game_as_a_copy(client: TestClient, store: SessionStore) -> None:
    """MON-714: the answer to "Load as a separate game" (ADR-011)."""
    game_id = _create(client)["state"]["game_id"]
    saved = client.get(f"/games/{game_id}/save").json()

    response = client.post("/games/load?if_exists=copy", json=saved)
    assert response.status_code == status.HTTP_201_CREATED
    copied = response.json()["state"]["game_id"]
    assert copied != game_id
    assert is_addressable_game_id(copied), f"a minted id no route can address: {copied!r}"
    assert client.get(f"/games/{game_id}").status_code == status.HTTP_200_OK
    assert client.get(f"/games/{copied}").json()["state"]["turn_number"] == saved["state"]["turn_number"]
    assert len(store) == 2


def test_a_conflict_policy_only_matters_on_a_conflict(client: TestClient) -> None:
    """``if_exists`` answers a conflict; it is not a mode that rewrites every load."""
    game_id = _create(client)["state"]["game_id"]
    saved = client.get(f"/games/{game_id}/save").json()
    client.delete(f"/games/{game_id}")

    restored = client.post("/games/load?if_exists=copy", json=saved)
    assert restored.status_code == status.HTTP_201_CREATED
    assert restored.json()["state"]["game_id"] == game_id, "an unconflicted load minted a new id"


def test_an_unknown_conflict_policy_is_a_keyed_422(client: TestClient) -> None:
    game_id = _create(client)["state"]["game_id"]
    saved = client.get(f"/games/{game_id}/save").json()
    response = client.post("/games/load?if_exists=clobber", json=saved)
    assert response.status_code == UNPROCESSABLE
    assert response.json()["reason_key"] == "error.malformed_request"
    assert response.json()["params"]["fields"] == "if_exists"


def test_the_save_carries_the_session_log_and_a_load_puts_it_back(client: TestClient) -> None:
    """MON-715 / ADR-011 — the half of a session a bare ``GameState`` had no room for.

    Read back through ``?since=0``, which is the request the client's first fetch makes, so what is
    asserted here is what *"What's happened"* is filled from rather than a private view of the store.
    """
    game_id = _create(client)["state"]["game_id"]
    client.post(f"/games/{game_id}/commands", json=_roll(0))
    played = [entry["event"] for entry in client.get(f"/games/{game_id}?since=0").json()["events"]]
    assert played, "the roll produced no events, so a lost log would be indistinguishable from a kept one"

    saved = client.get(f"/games/{game_id}/save").json()
    assert saved["events"] == played, "the save does not carry the log"
    assert "seq" not in saved["events"][0], "seq belongs to a session, not to a file"

    client.delete(f"/games/{game_id}")
    restored = client.post("/games/load", json=saved).json()
    assert restored["event_cursor"] == len(played)
    replayed = client.get(f"/games/{game_id}?since=0").json()["events"]
    assert [entry["event"] for entry in replayed] == played
    assert [entry["seq"] for entry in replayed] == list(range(1, len(played) + 1))


def test_a_save_written_before_the_envelope_still_loads(client: TestClient) -> None:
    """A bare ``GameState`` is every file saved before ADR-011, and it must not become garbage."""
    game_id = _create(client)["state"]["game_id"]
    client.post(f"/games/{game_id}/commands", json=_roll(0))
    legacy = client.get(f"/games/{game_id}/save").json()["state"]
    client.delete(f"/games/{game_id}")

    response = client.post("/games/load", json=legacy)
    assert response.status_code == status.HTTP_201_CREATED
    assert response.json()["state"]["game_id"] == game_id
    assert response.json()["event_cursor"] == 0, "a file with no log cannot restore one"


def test_a_deeply_nested_save_is_a_keyed_422_and_not_a_traceback(client: TestClient) -> None:
    """The route must not have a Python recursion limit reachable from the wire.

    Found in review of ADR-011's own diff: the first draft read ``json.loads(raw)`` in order to branch
    on whether a ``state`` key was present. Python's JSON parser recurses per nesting level, so six
    kilobytes of brackets — well inside ``max_save_bytes`` — raised ``RecursionError``, which is not a
    ``ValueError`` and so escaped the handler's ``except`` as a 500 with a traceback, on an
    unauthenticated route. It is the same shape of defect the MON-100 review found here when a
    ``BoardDataError`` escaped the same clause.

    ``SaveFile.from_json`` lets pydantic-core parse, which has its own depth limit and reports it as an
    ordinary ``ValidationError``. Asserted at 3000 levels because that is well past CPython's default
    recursion limit and still a small request.
    """
    response = client.post("/games/load", content=b"[" * 3000 + b"]" * 3000)

    assert response.status_code == UNPROCESSABLE, response.text
    assert response.json()["reason_key"] == "error.save_schema_mismatch"


def test_a_save_whose_log_is_not_events_is_the_same_keyed_refusal(client: TestClient) -> None:
    """The log is validated, not trusted: it drives narration and the animation queue."""
    game_id = _create(client)["state"]["game_id"]
    saved = client.get(f"/games/{game_id}/save").json()
    client.delete(f"/games/{game_id}")
    saved["events"] = [{"type": "no_such_event_has_ever_happened"}]

    response = client.post("/games/load", json=saved)
    assert response.status_code == UNPROCESSABLE
    assert response.json()["reason_key"] == "error.save_schema_mismatch"


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


@pytest.mark.parametrize("game_id", ["kitchen/table", "  ", "..", ".", "../etc", "a" * 65])
def test_a_save_naming_an_unaddressable_game_is_refused(client: TestClient, store: SessionStore, game_id: str) -> None:
    """The load route takes its id from inside the body, where no field constraint reaches."""
    saved = minimal_state(game_id=game_id).model_dump(mode="json")
    response = client.post("/games/load", json=saved)
    assert response.status_code == UNPROCESSABLE, f"{game_id!r} was accepted"
    assert response.json() == {"reason_key": "error.invalid_game_id", "params": {}}
    assert len(store) == 0, "the refused save must not have taken a slot"


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


def test_the_load_route_still_declares_a_savefile_body(client: TestClient) -> None:
    """The body is read raw, so the contract is declared by hand — assert it is still there."""
    operation = client.get("/openapi.json").json()["paths"]["/games/load"]["post"]
    schema = operation["requestBody"]["content"]["application/json"]["schema"]
    assert schema == {"$ref": "#/components/schemas/SaveFile"}


# --- DELETE ----------------------------------------------------------------


def test_deleting_a_game_removes_it(client: TestClient, store: SessionStore) -> None:
    game_id = _create(client)["state"]["game_id"]
    assert client.delete(f"/games/{game_id}").status_code == status.HTTP_204_NO_CONTENT
    assert client.get(f"/games/{game_id}").status_code == status.HTTP_404_NOT_FOUND
    assert len(store) == 0


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
