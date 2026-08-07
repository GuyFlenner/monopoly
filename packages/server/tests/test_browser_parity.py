"""The two transports answer the same thing (MON-805).

:mod:`kesef_server.browser` exists so the game can run at a static URL with nothing behind it —
the same handlers, called from a page instead of over HTTP. That is only worth having if the two
cannot drift, and "cannot drift" is not a claim a docstring can make. This file is the claim.

## How it is arranged

Every interaction goes through :class:`Pair`, which performs it **on both transports and asserts
the two answers are identical** before handing the agreed answer back. So parity is not a handful
of tests that remembered to compare; it is a property of every line below, and each test then goes
on to assert what the agreed answer actually *says* — a comparison of two empty dictionaries would
otherwise pass forever.

## What that covers, and what it leaves out

The projection itself is *shared* rather than duplicated: both transports call
:mod:`kesef_server.transport`, so ``GameView`` cannot differ by construction. What needs a test is
everything the two still spell separately:

* **The status of every answer**, success and refusal alike.
* **The refusal key and its params.** ``api.py`` has three exception handlers plus a validation
  handler; ``browser.py`` has one function with the same four branches, and the field paths in
  ``error.malformed_request`` are assembled differently in each (FastAPI prefixes ``loc`` with
  ``"body"``; validating a model directly does not).
* **The ``EndTurn.elapsed_seconds`` stamp** — one clock, read in one module, in both transports.
* **Bot driving**, including ADR-009's one-proposal-per-turn guard and the step cap. The HTTP
  transport drives bots in a background task; the browser inverts the pump into something the page
  calls. Same seed, same board, same moves — asserted by comparing the *finished game*, not the
  mechanism.

One thing is deliberately not asserted: a request body that is not JSON at all. FastAPI reports
that with the offending character offset inside ``loc`` and pydantic reports it with an empty
``loc``, so the two produce different ``fields`` params. It is unreachable on the local transport —
``client.ts`` builds every body with ``JSON.stringify`` — and matching a character offset no caller
can produce would be a test written to a defect rather than to a requirement.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Any

import pytest
from conftest import SESSION_TTL_SECONDS, FakeClock, new_game_payload, seat
from fastapi.testclient import TestClient

from kesef_engine.errors import BoardDataError
from kesef_server import browser
from kesef_server.api import app, get_settings, get_store
from kesef_server.browser import BrowserHost
from kesef_server.config import Settings
from kesef_server.sessions import SessionStore

Answer = tuple[int, Any]
"""A status and a decoded body — the two things the transports have to agree on."""

GAME_ID = "parity"
"""Named explicitly in every payload: both transports invent an id from ``secrets`` when none is
given, so leaving it out would make them disagree on purpose."""

FORWARD = (
    "roll_dice",
    "buy_property",
    "withdraw_from_auction",
    "respond_to_trade",
    "end_turn",
    "pay_jail_fine",
    "use_jail_card",
    "roll_for_jail",
)
"""Command kinds that move a turn along, most-urgent first — ``test_api``'s list plus two exits.

A game is driven with these so the walk terminates. Picking the first legal command instead would
mortgage and unmortgage forever, and preferring ``decline_purchase`` over ``buy_property`` opens an
auction.

``withdraw_from_auction`` and ``respond_to_trade`` are the two additions, and both were earned. The
hard bot bids and trades, so a walk without them stalled: the fallback picked ``place_bid``, the bot
raised, and fourteen iterations went by inside one auction at turn two. Parity held the whole way —
which is what this file is *for* — but "played out" has to mean the game moved."""


def _payload(**overrides: Any) -> dict[str, Any]:
    return new_game_payload(**{"game_id": GAME_ID, **overrides})


def _roll(player: int) -> dict[str, Any]:
    return {"command": {"kind": "roll_dice", "player": player}}


def _end_turn(player: int, **extras: Any) -> dict[str, Any]:
    return {"command": {"kind": "end_turn", "player": player, **extras}}


def _forward(legal_commands: list[dict[str, Any]]) -> dict[str, Any]:
    for kind in FORWARD:
        for command in legal_commands:
            if command["kind"] == kind:
                return {"command": command}
    return {"command": legal_commands[0]}


def _envelope(answer: str) -> Answer:
    """One envelope from :mod:`kesef_server.browser`, as a status and a body."""
    envelope = json.loads(answer)
    assert set(envelope) == {"status", "body"}, envelope
    return int(envelope["status"]), envelope["body"]


def _response(response: Any) -> Answer:
    """One ``TestClient`` response, in the same pair. A 204 has no body to decode."""
    return response.status_code, (None if response.status_code == 204 else response.json())


def _with_game_id(body: Any, game_id: str) -> Any:
    """A view with its game id overwritten — see :meth:`Pair.load_as_a_copy`."""
    return body | {"state": body["state"] | {"game_id": game_id}}


@dataclass
class Pair:
    """One game played twice at once: over HTTP, and through the browser facade.

    Every method performs the interaction on both and asserts the answers match, so a test cannot
    accidentally exercise one transport only. The agreed answer is returned so the test can go on
    to say something about it.
    """

    http: TestClient
    facade: BrowserHost

    def same(self, route: str, over_http: Answer, locally: Answer) -> Answer:
        assert locally == over_http, f"{route} diverged\n  http:  {over_http}\n  local: {locally}"
        return over_http

    def boards(self) -> Answer:
        return self.same("GET /boards", _response(self.http.get("/boards")), _envelope(self.facade.list_boards()))

    def rulesets(self) -> Answer:
        return self.same("GET /rulesets", _response(self.http.get("/rulesets")), _envelope(self.facade.list_rulesets()))

    def create(self, **overrides: Any) -> Answer:
        payload = _payload(**overrides)
        return self.same(
            "POST /games",
            _response(self.http.post("/games", json=payload)),
            _envelope(self.facade.create_game(json.dumps(payload))),
        )

    def load(self, save: object, if_exists: str | None = None) -> Answer:
        query = "" if if_exists is None else f"?if_exists={if_exists}"
        return self.same(
            "POST /games/load",
            _response(self.http.post(f"/games/load{query}", json=save)),
            _envelope(self.facade.load_game(json.dumps(save), if_exists)),
        )

    def load_raw(self, body: str) -> Answer:
        """``POST /games/load`` with bytes this harness did not encode.

        Every other method hands its payload to ``json.dumps``, which is fine for a save and wrong for
        a payload whose *shape* is the point: three thousand nested lists make the harness recurse
        before either transport sees them. This is the seam for asserting on the input rather than on
        a value.
        """
        return self.same(
            "POST /games/load",
            _response(self.http.post("/games/load", content=body.encode())),
            _envelope(self.facade.load_game(body, None)),
        )

    def load_as_a_copy(self, save: object) -> tuple[Answer, tuple[str, str]]:
        """``?if_exists=copy`` on both, compared with the minted id masked (ADR-011).

        The one interaction whose two answers *cannot* be identical: a copy is seated under a
        freshly minted ``game-<hex>`` and the two transports draw from their own ``secrets``. So the
        id is masked for the comparison and handed back for the test to make its own claim about —
        which is stricter than skipping the comparison, because every other field of the view still
        has to match exactly.
        """
        over_http = _response(self.http.post("/games/load?if_exists=copy", json=save))
        locally = _envelope(self.facade.load_game(json.dumps(save), "copy"))
        ids = (over_http[1]["state"]["game_id"], locally[1]["state"]["game_id"])
        masked = [(status, _with_game_id(body, "<minted>")) for status, body in (over_http, locally)]
        return self.same("POST /games/load?if_exists=copy", masked[0], masked[1]), ids

    def get(self, game_id: str, since: int | str | None = None) -> Answer:
        query = "" if since is None else f"?since={since}"
        return self.same(
            "GET /games/{id}",
            _response(self.http.get(f"/games/{game_id}{query}")),
            _envelope(self.facade.get_game(game_id, since)),
        )

    def save(self, game_id: str) -> Answer:
        return self.same(
            "GET /games/{id}/save",
            _response(self.http.get(f"/games/{game_id}/save")),
            _envelope(self.facade.save_game(game_id)),
        )

    def submit(self, game_id: str, body: dict[str, Any]) -> Answer:
        return self.same(
            "POST /games/{id}/commands",
            _response(self.http.post(f"/games/{game_id}/commands", json=body)),
            _envelope(self.facade.submit_command(game_id, json.dumps(body))),
        )

    def validate(self, game_id: str, body: dict[str, Any]) -> Answer:
        return self.same(
            "POST /games/{id}/validate",
            _response(self.http.post(f"/games/{game_id}/validate", json=body)),
            _envelope(self.facade.validate_command(game_id, json.dumps(body))),
        )

    def delete(self, game_id: str) -> Answer:
        return self.same(
            "DELETE /games/{id}",
            _response(self.http.delete(f"/games/{game_id}")),
            _envelope(self.facade.delete_game(game_id)),
        )

    def forward(self, game_id: str) -> Answer:
        """Play whichever legal command advances the turn, on both transports."""
        legal = self.get(game_id)[1]["legal_commands"]
        assert legal, "a UI driven by legal_commands cannot recover from an empty list"
        return self.submit(game_id, _forward(legal))

    async def pump(self, game_id: str, limit: int = 500) -> int:
        """Run the browser's bot pump to a standstill, the way the page does.

        Nothing to mirror on the HTTP side: its bots have already moved, inside the request, because
        starlette's ``TestClient`` runs background tasks before returning. That asymmetry is the
        whole point of the comparison that follows a pump.
        """
        for step in range(limit):
            status, body = _envelope(await self.facade.advance_bots_step(game_id))
            assert status == 200, body
            if body["done"]:
                return step
        raise AssertionError("the pump never reported done")


PairFactory = Callable[..., Pair]


@pytest.fixture
def pair(clock: FakeClock) -> Iterator[PairFactory]:
    """Build a matched transport pair, optionally with tuned settings.

    Both stores share the ``clock`` fixture and are created at the same reading, which is what
    makes the ``elapsed_seconds`` comparison a comparison of the *stamping* rather than of two
    clocks. ``bot_think_seconds`` defaults to 0 for the reason ``conftest.settings`` gives.
    """

    def build(**config_overrides: Any) -> Pair:
        config = Settings(bot_think_seconds=0, **config_overrides)
        stores = [
            SessionStore(max_sessions=config.max_sessions, ttl_seconds=SESSION_TTL_SECONDS, clock=clock)
            for _ in range(2)
        ]
        app.dependency_overrides[get_store] = lambda: stores[0]
        app.dependency_overrides[get_settings] = lambda: config
        return Pair(http=TestClient(app), facade=BrowserHost(store=stores[1], config=config))

    yield build
    app.dependency_overrides.clear()


# --- The import graph -------------------------------------------------------


def test_the_browser_transport_imports_no_web_framework() -> None:
    """``import kesef_server.browser`` must not pull in FastAPI, starlette, anyio or uvicorn.

    The load-bearing assertion of the whole module. Pyodide has no wheel for
    ``uvicorn[standard]``'s native extensions, so the browser build installs ``kesef-server`` with
    its declared dependencies *skipped* and adds back only the pure-Python ones by hand (see
    ``packages/web/src/local/engine.ts``). If an import creeps back onto this module's graph — a
    ``from fastapi import status`` in ``errors.py``, an eager ``from .api import app`` in
    ``__init__.py``, both of which were there before MON-805 — the browser build breaks at load
    time with a Python traceback in a console, and nothing in an ordinary test run would notice.

    Run in a subprocess because this very test session has FastAPI imported already.
    """
    probe = (
        "import sys, kesef_server.browser; "
        "print(sorted({m.split('.')[0] for m in sys.modules} & {'fastapi', 'starlette', 'anyio', 'uvicorn'}))"
    )
    completed = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True, check=True)
    assert completed.stdout.strip() == "[]", completed.stdout


# --- Meta -------------------------------------------------------------------


def test_the_board_list_matches(pair: PairFactory) -> None:
    status, boards = pair().boards()
    assert status == 200
    assert {board["id"] for board in boards} >= {"classic"}
    assert all(board["tile_count"] and board["name_key"] for board in boards)


def test_the_ruleset_list_matches(pair: PairFactory) -> None:
    status, rulesets = pair().rulesets()
    assert status == 200
    assert {ruleset["name"] for ruleset in rulesets} == {"universal", "kids"}


# --- Creating a game --------------------------------------------------------


def test_creating_a_game_matches(pair: PairFactory) -> None:
    status, view = pair().create()
    assert status == 201
    assert view["state"]["game_id"] == GAME_ID
    assert view["legal_commands"] == [{"kind": "roll_dice", "player": 0}]
    assert len(view["board"]["tiles"]) == 40


def test_a_duplicate_game_id_is_the_same_conflict(pair: PairFactory) -> None:
    both = pair()
    both.create()
    status, body = both.create()
    assert (status, body["reason_key"], body["params"]["game_id"]) == (409, "error.game_already_exists", GAME_ID)


def test_an_unknown_board_is_the_same_refusal(pair: PairFactory) -> None:
    status, body = pair().create(board_id="atlantis")
    assert (status, body["reason_key"], body["params"]["board_id"]) == (422, "error.unknown_board", "atlantis")


@pytest.mark.parametrize(
    ("seats", "reason_key", "param", "value"),
    [
        ([seat("Ann"), seat("Ann")], "error.duplicate_names", "name", "Ann"),
        ([seat("Ann")], "error.too_few_players", "minimum", 2),
        ([seat(f"P{index}") for index in range(7)], "error.too_many_players", "maximum", 6),
        # MON-735: the fourth. Both transports answered `error.invalid_new_game` here until the
        # factory named it, so this row is what proves neither of them kept the coarse fallback.
        (
            [seat("Ann"), {**seat("Bob"), "token": "token.Ann"}],
            "error.duplicate_tokens",
            "token",
            "token.Ann",
        ),
    ],
)
def test_a_seating_the_engine_refuses_is_the_same_keyed_refusal(
    pair: PairFactory, seats: list[dict[str, Any]], reason_key: str, param: str, value: int | str
) -> None:
    """``InvalidSeatingError``, forwarded whole by both transports (MON-418, G-33).

    Four distinct keys rather than one coarse ``error.invalid_new_game``: "two to six players", "no
    shared names" and "one pawn each" are rules, so the engine is where they are decided and named.
    Both transports forward the key *and* its params, which is what lets ``error.too_few_players``
    say how many are needed and ``error.duplicate_names`` say which name was repeated — and
    forwarding it is all either transport does, since a server that looked for duplicates itself
    would hold a copy of a rule even while agreeing with it.
    """
    status, body = pair().create(seats=seats)
    assert (status, body["reason_key"], body["params"][param]) == (422, reason_key, value)


def test_a_body_pydantic_refuses_names_the_same_fields(pair: PairFactory) -> None:
    """``error.malformed_request``'s ``fields`` param, assembled two different ways.

    ``api.py`` strips FastAPI's ``"body"`` prefix off each ``loc``; ``browser.py`` validates the
    model directly and strips nothing. This is the one place the two spellings could silently
    diverge, and ``fields`` is what a catalogue sentence interpolates.

    A bot seat with no ``bot_level``, rather than a wrong seat *count*: a count is no longer a body
    error at all since MON-418 moved that judgement into the factory, where it arrives as the keyed
    refusal above.
    """
    status, body = pair().create(seats=[seat("Ann"), seat("Bot", is_bot=True)])  # a bot with no level
    assert (status, body["reason_key"], body["params"]["fields"]) == (422, "error.malformed_request", "seats.1")


def test_the_session_cap_is_the_same_refusal(pair: PairFactory) -> None:
    """Both transports answer 503 on the same game, not one game apart."""
    both = pair(max_sessions=1)
    assert both.create()[0] == 201
    status, body = both.create(game_id="second")
    assert (status, body["reason_key"], body["params"]["limit"]) == (503, "error.server_at_capacity", 1)


# --- Reading a game ---------------------------------------------------------


def test_the_view_matches_with_and_without_a_cursor(pair: PairFactory) -> None:
    both = pair()
    both.create()
    both.submit(GAME_ID, _roll(0))

    assert both.get(GAME_ID)[1]["events"] == [], "no cursor means state only (G-34)"
    replayed = both.get(GAME_ID, 0)[1]
    assert replayed["events"], "since=0 replays the whole game; an empty log would pass every other check"
    assert replayed["events"][0]["seq"] == 1
    assert both.get(GAME_ID, replayed["event_cursor"])[1]["events"] == []


def test_a_cursor_that_is_not_a_cursor_is_the_same_refusal(pair: PairFactory) -> None:
    both = pair()
    both.create()
    for bad in (-1, "not-a-number"):
        status, body = both.get(GAME_ID, bad)
        assert (status, body["reason_key"], body["params"]["fields"]) == (422, "error.malformed_request", "since")


def test_the_save_file_matches(pair: PairFactory) -> None:
    """The one answer carrying hidden information, and therefore the one worth comparing whole."""
    both = pair()
    both.create()
    status, saved = both.save(GAME_ID)
    assert status == 200
    assert saved["state"]["rng"], "the save carries the RNG (ADR-008 §2); without it this proves little"
    assert len(saved["state"]["chance_deck"]) > 0, "and the deck order, which the projection hides"


def test_a_saved_game_loads_the_same_way(pair: PairFactory) -> None:
    both = pair()
    both.create()
    both.submit(GAME_ID, _roll(0))
    saved = both.save(GAME_ID)[1]
    both.delete(GAME_ID)

    status, restored = both.load(saved)
    assert status == 201
    assert restored["state"]["game_id"] == GAME_ID
    assert restored["state"]["phase"] == both.get(GAME_ID)[1]["state"]["phase"]


def test_a_save_that_is_not_a_game_is_the_same_refusal(pair: PairFactory) -> None:
    status, body = pair().load({"schema_version": 1, "game_id": "g"})
    assert (status, body["reason_key"]) == (422, "error.save_schema_mismatch")


def test_a_save_naming_an_unaddressable_game_is_the_same_refusal(pair: PairFactory) -> None:
    """``schemas.GAME_ID_PATTERN``: an id with a path separator took a slot no route could free."""
    both = pair()
    both.create()
    saved = both.save(GAME_ID)[1]
    both.delete(GAME_ID)
    saved["state"]["game_id"] = "kitchen/table"
    status, body = both.load(saved)
    assert (status, body["reason_key"]) == (422, "error.invalid_game_id")


def test_the_save_carries_the_log_and_the_log_comes_back_with_it(pair: PairFactory) -> None:
    """MON-715 / ADR-011, on both transports: a restored session has its history.

    Asserted through ``?since=0``, which is what the client actually asks for on a first fetch — so
    this is the path a reload takes, not a private view of the store.
    """
    both = pair()
    both.create()
    both.submit(GAME_ID, _roll(0))
    saved = both.save(GAME_ID)[1]
    played = [entry["event"]["type"] for entry in both.get(GAME_ID, 0)[1]["events"]]
    assert played, "the game produced no events, so this test cannot tell a kept log from a lost one"
    assert [event["type"] for event in saved["events"]] == played

    both.delete(GAME_ID)
    status, restored = both.load(saved)
    assert status == 201
    assert [entry["event"]["type"] for entry in both.get(GAME_ID, 0)[1]["events"]] == played
    assert restored["event_cursor"] == len(played), "the restored log was not sequenced 1..N"


def test_a_bare_gamestate_still_loads_on_both_transports(pair: PairFactory) -> None:
    """Every save written before ADR-011 is one, and both transports read it the same way."""
    both = pair()
    both.create()
    both.submit(GAME_ID, _roll(0))
    legacy = both.save(GAME_ID)[1]["state"]
    both.delete(GAME_ID)

    status, restored = both.load(legacy)
    assert status == 201
    assert restored["state"]["game_id"] == GAME_ID
    assert restored["event_cursor"] == 0, "a file with no log cannot restore one"


def test_the_three_conflict_policies_answer_the_same_way(pair: PairFactory) -> None:
    """ADR-011: refuse by default, replace on request, and copy to a minted id."""
    both = pair()
    both.create()
    saved = both.save(GAME_ID)[1]
    both.submit(GAME_ID, _roll(0))  # the live game is now ahead of the file

    assert both.load(saved)[0] == 409, "the default is still the refusal it always was"
    assert both.load(saved, "refuse")[0] == 409

    assert both.load(saved, "replace")[0] == 201
    assert both.get(GAME_ID, 0)[1]["events"] == [], "replace did not put the file's own log back"

    (status, copied), (http_id, local_id) = both.load_as_a_copy(saved)
    assert status == 201
    for minted in (http_id, local_id):
        assert minted.startswith("game-") and minted != GAME_ID
    assert copied["state"]["game_id"] == "<minted>"  # masked; the ids themselves are above
    assert both.get(GAME_ID)[0] == 200, "the copy ended the game it was supposed to leave alone"


def test_an_unknown_conflict_policy_is_the_same_keyed_refusal(pair: PairFactory) -> None:
    """FastAPI refuses the enum; ``browser._if_exists`` has to refuse it identically."""
    both = pair()
    both.create()
    saved = both.save(GAME_ID)[1]
    status, body = both.load(saved, "clobber")
    assert (status, body["reason_key"], body["params"]["fields"]) == (422, "error.malformed_request", "if_exists")


def test_a_deeply_nested_save_is_the_same_keyed_refusal(pair: PairFactory) -> None:
    """Neither transport may have a Python recursion limit reachable from its input.

    The browser facade takes its body as a string rather than through starlette, so it needs its own
    proof: both parse with pydantic-core (``SaveFile.from_json``), and a ``json.loads`` in either one
    would answer a 500 where the other answered a keyed 422 — a divergence this file exists to catch.
    """
    status, body = pair().load_raw("[" * 3000 + "]" * 3000)
    assert (status, body["reason_key"]) == (422, "error.save_schema_mismatch")


def test_an_oversized_save_is_the_same_refusal(pair: PairFactory) -> None:
    both = pair(max_save_bytes=64)
    status, body = both.load({"padding": "x" * 200})
    assert (status, body["reason_key"], body["params"]["limit_bytes"]) == (413, "error.save_too_large", 64)


def test_neither_transport_can_enumerate_the_live_games(pair: PairFactory) -> None:
    """MON-909 deleted the lobby route from both sides: the HTTP app has no `GET /games`, and
    the facade has no `list_games` for the local build's router to reach for."""
    both = pair()
    both.create()
    assert both.http.get("/games").status_code == 405
    assert not hasattr(both.facade, "list_games")


# --- Commands ---------------------------------------------------------------


def test_applying_a_command_matches(pair: PairFactory) -> None:
    both = pair()
    both.create()
    status, view = both.submit(GAME_ID, _roll(0))
    assert status == 200
    assert [entry["event"]["type"] for entry in view["events"]], "a roll produces events"
    assert view["state"]["dice"] is not None


def test_an_illegal_command_is_the_same_rejection(pair: PairFactory) -> None:
    """The engine's own key *and* its context params, forwarded by both transports (G-33)."""
    both = pair()
    both.create()
    status, body = both.submit(GAME_ID, _end_turn(0))
    assert status == 422
    assert body["reason_key"].startswith("error.")
    assert body["reason_key"] != "error.engine_failure", "a rules refusal is not a server defect"


def test_a_command_from_the_wrong_seat_is_the_same_rejection(pair: PairFactory) -> None:
    both = pair()
    both.create()
    status, body = both.submit(GAME_ID, _roll(1))
    assert (status, body["reason_key"]) == (422, "error.not_your_turn")


def test_a_command_with_an_invented_field_is_the_same_refusal(pair: PairFactory) -> None:
    """``extra="forbid"`` on the command models, reported identically by both transports."""
    both = pair()
    both.create()
    status, body = both.submit(GAME_ID, {"command": {"kind": "roll_dice", "player": 0, "loaded": True}})
    expected = (422, "error.malformed_request", "command.roll_dice.loaded")
    assert (status, body["reason_key"], body["params"]["fields"]) == expected


def test_an_unknown_command_kind_is_the_same_refusal(pair: PairFactory) -> None:
    both = pair()
    both.create()
    status, body = both.submit(GAME_ID, {"command": {"kind": "teleport", "player": 0}})
    assert (status, body["reason_key"]) == (422, "error.malformed_request")


def test_validating_a_command_matches(pair: PairFactory) -> None:
    both = pair()
    both.create()
    assert both.validate(GAME_ID, _roll(0))[1] == {"legal": True, "reason_key": None, "params": {}}
    # An illegal command validates as `legal: false` with a key, not as a 422 (G-32).
    status, refusal = both.validate(GAME_ID, _end_turn(0))
    assert status == 200
    assert refusal["legal"] is False
    assert refusal["reason_key"].startswith("error.")


def test_the_elapsed_seconds_stamp_matches(pair: PairFactory, clock: FakeClock) -> None:
    """Neither transport reads the client's number, and both read the same clock (GAP G-6)."""
    both = pair()
    both.create()
    both.submit(GAME_ID, _roll(0))
    clock.advance(125.9)

    # The number the client sent is nonsense on purpose; both transports overwrite it.
    while both.get(GAME_ID)[1]["state"]["current_player_id"] == 0:
        chosen = _forward(both.get(GAME_ID)[1]["legal_commands"])
        if chosen["command"]["kind"] == "end_turn":
            chosen = _end_turn(0, elapsed_seconds=999_999)
        assert both.submit(GAME_ID, chosen)[0] == 200

    assert both.get(GAME_ID)[1]["state"]["elapsed_seconds"] == 125, "floored whole seconds from the store's clock"


def test_a_whole_turn_each_stays_in_step(pair: PairFactory) -> None:
    """Twelve commands chosen from ``legal_commands``, the way the UI chooses them.

    The broadest of these tests: any divergence in the reducer's inputs — a stamp, a cursor, an
    event the store assigned a different ``seq`` — shows up as an inequality inside ``Pair``.
    """
    both = pair()
    both.create()
    for _ in range(12):
        assert both.forward(GAME_ID)[0] == 200
    view = both.get(GAME_ID, 0)[1]
    assert view["state"]["turn_number"] > 1
    assert view["event_cursor"] >= 6
    assert [entry["seq"] for entry in view["events"]] == list(range(1, view["event_cursor"] + 1))


# --- Deleting, and the missing game ----------------------------------------


def test_deleting_a_game_matches(pair: PairFactory) -> None:
    both = pair()
    both.create()
    assert both.delete(GAME_ID) == (204, None)
    assert both.get(GAME_ID)[0] == 404
    assert both.delete(GAME_ID)[0] == 404, "deleted in one transport and still there in the other"


@pytest.mark.parametrize("route", ["get", "save", "delete", "submit", "validate"])
def test_an_unknown_game_is_the_same_404_on_every_route(pair: PairFactory, route: str) -> None:
    both = pair()
    calls: dict[str, Callable[[], Answer]] = {
        "get": lambda: both.get("nope"),
        "save": lambda: both.save("nope"),
        "delete": lambda: both.delete("nope"),
        "submit": lambda: both.submit("nope", _roll(0)),
        "validate": lambda: both.validate("nope", _roll(0)),
    }
    status, body = calls[route]()
    assert (status, body["reason_key"], body["params"]["game_id"]) == (404, "error.game_not_found", "nope")


# --- The event stream ------------------------------------------------------


def test_the_event_replay_matches_the_view(pair: PairFactory) -> None:
    """What the fake socket replays is what ``?since=`` replays — one log, read two ways (G-34)."""
    both = pair()
    both.create()
    both.submit(GAME_ID, _roll(0))

    status, replay = _envelope(both.facade.events_since(GAME_ID, 0))
    assert status == 200
    from_view = both.get(GAME_ID, 0)[1]
    assert replay["events"] == from_view["events"]
    assert replay["event_cursor"] == from_view["event_cursor"] > 0

    tail = _envelope(both.facade.events_since(GAME_ID, replay["event_cursor"]))[1]
    assert tail["events"] == [], "a cursor at the head has nothing after it"


def test_the_event_stream_of_an_unknown_game_is_a_404(pair: PairFactory) -> None:
    """The fake socket's 4404 close code is read off this status, mirroring ``WS_GAME_NOT_FOUND``."""
    status, body = _envelope(pair().facade.events_since("nope", 0))
    assert (status, body["reason_key"]) == (404, "error.game_not_found")


# --- Bots ------------------------------------------------------------------


@pytest.mark.parametrize("level", ["easy", "normal", "hard"])
async def test_a_bot_game_played_out_stays_in_step(pair: PairFactory, level: str) -> None:
    """Same seed, same board, same bot: the background driver and the page's pump agree.

    The strongest assertion in this file and the cheapest to write, because it compares the
    *finished game* rather than the mechanism: it therefore covers ``seat_to_act``, ADR-009's
    one-proposal-per-turn guard and the ordering of every event either transport produced.

    All three levels, because the level is resolved through ``bots._BOTS`` and both transports go
    through that one table — a level the engine has and the table has not is treated as "no bot
    drives this seat", which is a game that silently stops rather than a crash. ``normal`` and
    ``hard`` are also the two that construct a ``ProposeTrade``, the move ``legal_commands`` never
    enumerates and the only one with a per-turn budget behind it.

    **The loop's shape is the thing to read, and it is easy to get wrong.** The two transports are
    only comparable where the bots have finished moving on *both*: over HTTP that is inside the
    request, because ``TestClient`` runs background tasks before returning, and here it is when the
    pump reports done. So every comparison is preceded by a pump — including the one after the loop,
    which an earlier version of this test omitted. It passed at ``easy`` and ``normal`` and failed at
    ``hard``, for a reason that was nothing to do with the bot: the loop's last action is a human's
    command, so HTTP's driver had answered it and ours had not yet been asked to. A difference in
    *when*, reported as a difference in what.
    """
    both = pair()
    both.create(seats=[seat("Ann"), seat("Bot", is_bot=True, bot_level=level)])
    steps = 0

    for _ in range(14):
        steps += await both.pump(GAME_ID)
        levelled = both.get(GAME_ID, 0)[1]
        mine = [command for command in levelled["legal_commands"] if command["player"] == 0]
        if not mine:
            break  # the game is over, or the human is out of it
        assert both.submit(GAME_ID, _forward(mine))[0] == 200

    await both.pump(GAME_ID)
    assert steps > 0, "the bot's turn came round; a pump that did nothing would prove nothing"
    replay = both.get(GAME_ID, 0)[1]
    assert replay["state"]["turn_number"] >= 3
    assert sum(1 for entry in replay["events"] if entry["event"]["type"] == "dice_rolled") >= 3


async def test_the_pump_stops_at_the_step_budget(pair: PairFactory) -> None:
    """``bot_max_steps_per_call`` bounds the page's pump exactly as it bounds the HTTP loop.

    Not decoration: an engine change that made two commands mutually re-enabling would otherwise
    turn this loop into a tab that never answers, and a hang is worse than a bot that stops moving.
    """
    both = pair(bot_max_steps_per_call=2)
    both.create(seats=[seat("A", is_bot=True, bot_level="easy"), seat("B", is_bot=True, bot_level="easy")])

    assert await both.pump(GAME_ID) == 2, "two steps, then the budget is spent"
    cursor = _envelope(both.facade.get_game(GAME_ID))[1]["event_cursor"]
    assert cursor > 0

    spent = _envelope(await both.facade.advance_bots_step(GAME_ID))[1]
    assert spent == {"done": True, "events": [], "event_cursor": cursor}, "a spent budget moves nothing"


async def test_a_bot_step_on_a_deleted_game_is_a_404(pair: PairFactory) -> None:
    """The page can leave a game between two pump calls, and a click is faster than a bot thinks."""
    both = pair()
    both.create(seats=[seat("A", is_bot=True, bot_level="easy"), seat("B")])
    both.facade.store.delete(GAME_ID)
    status, body = _envelope(await both.facade.advance_bots_step(GAME_ID))
    assert (status, body["reason_key"]) == (404, "error.game_not_found")


async def test_pumping_concurrently_changes_nothing(clock: FakeClock) -> None:
    """Six pumps in flight at once reach the position one pump at a time reaches.

    The lock's reason for existing. ``bot_think_seconds`` is non-zero here on purpose: with no
    pause there is no await inside the critical section and the hazard cannot arise, so a test that
    kept the suite's zero would pass with the lock deleted. With a pause, two unlocked pumps both
    snapshot the same state, both apply to it, and the game takes one command's worth of RNG for
    two commands' worth of log — which is exactly the divergence this compares away.
    """
    config = Settings(bot_think_seconds=0.01, bot_max_steps_per_call=4)
    seats = [seat("A", is_bot=True, bot_level="easy"), seat("B", is_bot=True, bot_level="easy")]
    payload = json.dumps(_payload(seats=seats))

    hosts = [
        BrowserHost(SessionStore(max_sessions=4, ttl_seconds=SESSION_TTL_SECONDS, clock=clock), config)
        for _ in range(2)
    ]
    for host in hosts:
        assert _envelope(host.create_game(payload))[0] == 201

    await asyncio.gather(*(hosts[0].advance_bots_step(GAME_ID) for _ in range(6)))
    for _ in range(6):
        await hosts[1].advance_bots_step(GAME_ID)

    concurrent = _envelope(hosts[0].get_game(GAME_ID, 0))
    sequential = _envelope(hosts[1].get_game(GAME_ID, 0))
    assert concurrent[1]["event_cursor"] > 0, "the bots moved; two empty logs would be equal and vacuous"
    assert concurrent == sequential
    assert _envelope(hosts[0].save_game(GAME_ID)) == _envelope(hosts[1].save_game(GAME_ID)), "same RNG, not just log"


async def test_both_transports_serialize_on_the_same_lock(pair: PairFactory) -> None:
    """``Session.advance_lock`` is the one lock, held by the HTTP driver and by the page's pump.

    MON-806 put the lock on the session rather than on either transport, and this is what stops the
    browser facade quietly growing a second one: a private lock would pass every test above — the
    invariant it buys is the same — and would then fail to exclude the HTTP driver in a build where
    both run, which is exactly what a developer serving the built site from uvicorn does.

    Held while it is held, released when it is not: a lock left acquired after an answer would
    deadlock the next pump, and that is a hang rather than a wrong answer, so it is worth pinning.
    """
    both = pair()
    both.create(seats=[seat("A", is_bot=True, bot_level="easy"), seat("B")])
    session = both.facade.store.get(GAME_ID)
    assert not session.advance_lock.locked()

    async with session.advance_lock:
        # Taken from outside, the facade's pump has to wait — so the answer cannot arrive yet.
        pumping = asyncio.ensure_future(both.facade.advance_bots_step(GAME_ID))
        await asyncio.sleep(0)
        assert not pumping.done(), "the pump ran while another driver held this game's lock"

    assert _envelope(await pumping)[0] == 200
    assert not session.advance_lock.locked(), "released, or the next pump would hang forever"


# --- Failures that are this side's fault ------------------------------------


def test_an_engine_failure_that_is_not_a_rejection_is_the_same_keyed_500(
    pair: PairFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A ``BoardDataError`` out of a rule module is a defect here, not a client mistake.

    Both transports say so with a key and neither leaks the exception's text — the same
    ``_engine_error_handler`` property ``test_api`` pins, checked on the branch that has no
    framework to fall back on.
    """
    both = pair()
    both.create()

    def explode(*_args: object, **_kwargs: object) -> None:
        raise BoardDataError("a rule module could not read its board")

    monkeypatch.setattr("kesef_server.api.apply", explode)
    monkeypatch.setattr("kesef_server.browser.apply", explode)
    answer = both.submit(GAME_ID, _roll(0))
    assert answer == (500, {"reason_key": "error.engine_failure", "params": {}})
    assert "board" not in json.dumps(answer[1]), "the exception's own text must not reach the client"


def test_a_failure_that_is_not_the_engines_is_not_dressed_up_as_one(
    pair: PairFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A ``TypeError`` from this module is a bug in this module, and it is allowed to escape.

    Deliberate. ``api.py`` lets one become starlette's unhandled 500 with a traceback in the log,
    and the equivalent here is a Python traceback in the browser's console — which is exactly where
    somebody debugging the page will look. Swallowing it into ``error.engine_failure`` would blame
    the engine for a defect in the transport.
    """
    both = pair()
    both.create()

    def explode(*_args: object, **_kwargs: object) -> None:
        raise TypeError("a defect in the transport, not in the rules")

    monkeypatch.setattr("kesef_server.browser.apply", explode)
    with pytest.raises(TypeError):
        both.facade.submit_command(GAME_ID, json.dumps(_roll(0)))


# --- The page's surface ----------------------------------------------------


def test_the_asgi_app_is_still_reachable_from_the_package() -> None:
    """``from kesef_server import app`` still works, and nothing else appeared beside it.

    ``__init__.py`` resolves ``app`` through ``__getattr__`` so that importing this package does
    not import FastAPI (see ``test_the_browser_transport_imports_no_web_framework``). A lazy
    attribute is easy to get subtly wrong in the direction of "every missing name is now an import
    error", so both halves are asserted.
    """
    import kesef_server

    assert kesef_server.app.title == "Kesef Street"
    with pytest.raises(AttributeError, match="no attribute 'nonesuch'"):
        getattr(kesef_server, "nonesuch")  # noqa: B009 - the point is the dynamic lookup


def test_the_module_level_functions_share_one_host() -> None:
    """What the page actually calls. One host per page, so two calls are two turns of one game."""
    assert browser.host() is browser.host()
    assert _envelope(browser.list_boards())[0] == 200
    assert _envelope(browser.list_rulesets())[0] == 200

    game_id = "module-level"
    payload = json.dumps(new_game_payload(game_id=game_id))
    assert _envelope(browser.create_game(payload))[0] == 201
    try:
        assert _envelope(browser.get_game(game_id))[1]["state"]["game_id"] == game_id
        assert _envelope(browser.submit_command(game_id, json.dumps(_roll(0))))[0] == 200
        assert _envelope(browser.validate_command(game_id, json.dumps(_end_turn(0))))[1]["legal"] is False
        assert _envelope(browser.get_game(game_id, 0))[1]["events"]
        assert _envelope(browser.events_since(game_id, 0))[1]["events"]
        state = _envelope(browser.save_game(game_id))[1]
    finally:
        assert _envelope(browser.delete_game(game_id)) == (204, None)

    assert _envelope(browser.load_game(json.dumps(state)))[0] == 201
    try:
        # Two human seats, so the pump has nothing to do and says so without pausing.
        assert _envelope(asyncio.run(browser.advance_bots_step(game_id)))[1]["done"] is True
    finally:
        assert _envelope(browser.delete_game(game_id)) == (204, None)
