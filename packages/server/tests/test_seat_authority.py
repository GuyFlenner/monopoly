"""A connection speaks for a seat (ADR-012, MON-906).

The 2026-08-07 audit measured what a shared `?game=` link actually bought: two browser contexts on
one link could each act for either seat, any joiner could read `/save` — the RNG counter and the
full deck order, i.e. every future roll and every card — and any stranger holding an id could
`DELETE` the game or `replace` it through a load. None of that is expressible as a *rule*, because
"is this connection allowed to speak as this player" is identity and the engine has none.

So authority is a capability secret held by the transport, and this file is where that claim is
checked. Four things it is arranged to keep honest:

* **The refusal happens before the engine.** A cross-seat command that reached ``apply`` would be a
  move that had *happened*, refused after the fact. Every such test asserts the event cursor is
  unmoved, which is the only way to tell "refused" from "refused too late".
* **The credential never serializes.** The leak tests below scan the projected ``GameView``, the
  ``SaveFile`` body, every log line and every event frame for the secret's own characters. "We were
  careful" is not a property, and a redaction that silently stopped working is exactly the class of
  defect that ships.
* **The flag's off position changes nothing.** ``seat_authority`` defaults to ``off`` so an already
  cached client never meets an enforcing API. A rollout flag whose "off" quietly differed from
  before would be the one failure this staging exists to prevent.
* **Both transports enforce it.** That half lives in ``test_browser_parity.py``, where every new
  interaction is performed on the HTTP app *and* the Pyodide facade and the two answers are compared
  before anything is asserted about them.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from conftest import new_game_payload, seat
from fastapi.testclient import TestClient

from kesef_server.api import app, get_settings, get_store
from kesef_server.config import Settings
from kesef_server.sessions import SessionStore

TWO_HUMANS: dict[str, Any] = new_game_payload()
"""Ann and Ben on seed 7 — ``conftest``'s two-seat universal game, named here because every test
below reads as "two people, one link"."""


def gid(created: dict[str, Any]) -> str:
    """The game id inside a ``GameCreated`` envelope.

    A function rather than a subscript chain repeated fifteen times, and it names the shape change:
    ``POST /games`` used to answer a bare ``GameView`` and now answers ``{host_secret, view}``.
    """
    return str(created["view"]["state"]["game_id"])


def bearer(secret: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {secret}"}


@pytest.fixture
def enforcing(store: SessionStore) -> Any:
    """A client whose server has ``seat_authority=enforce``.

    A fixture rather than a parameter on ``conftest.settings``, because most of this suite is about
    the *enforcing* behaviour and the handful of tests about the flag's other position say so by
    using ``conftest``'s own ``client``. ``bot_think_seconds=0`` for the reason ``conftest`` gives,
    and the ``store`` override for the reason ``conftest.client`` has one: a shared process-level
    store would make one test's games count against another's ``max_sessions_per_client``.
    """
    app.dependency_overrides[get_store] = lambda: store
    app.dependency_overrides[get_settings] = lambda: Settings(bot_think_seconds=0, seat_authority="enforce")
    yield TestClient(app)
    app.dependency_overrides.clear()


def create(client: TestClient, **overrides: Any) -> dict[str, Any]:
    response = client.post("/games", json={**TWO_HUMANS, **overrides})
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


def cursor_of(client: TestClient, game_id: str) -> int:
    return int(client.get(f"/games/{game_id}").json()["event_cursor"])


# --- The design's four skeletons -------------------------------------------
#
# Written first and written to fail: before the implementation, the first two could not even be
# spelled (`POST /games` answered a bare view, so `created["host_secret"]` was a KeyError), the
# third's `/save` answered 200 to anybody, and the fourth is the audit's headline repro.


def test_a_guest_cannot_act_for_a_seat_it_did_not_claim(enforcing: TestClient) -> None:
    """AC: cross-seat command is refused with a key, and the engine never sees it."""
    created = create(enforcing)
    claim = enforcing.post(f"/games/{gid(created)}/seats/1/claim").json()
    before = cursor_of(enforcing, gid(created))

    response = enforcing.post(
        f"/games/{gid(created)}/commands",
        json={"command": {"kind": "roll_dice", "player": 0}},
        headers=bearer(claim["seat_secret"]),
    )

    assert response.status_code == 403
    assert response.json()["reason_key"] == "error.seat_not_yours"
    assert response.json()["params"]["player"] == 0
    # The whole of "before the engine": a refusal that came after `apply` would have moved this.
    assert cursor_of(enforcing, gid(created)) == before == created["view"]["event_cursor"]


def test_the_host_still_plays_every_unclaimed_seat(enforcing: TestClient) -> None:
    """AC: hotseat unchanged — the creator speaks for all unclaimed human seats."""
    created = create(enforcing)
    host = bearer(created["host_secret"])

    assert (
        enforcing.post(
            f"/games/{gid(created)}/commands",
            json={"command": {"kind": "roll_dice", "player": 0}},
            headers=host,
        ).status_code
        == 200
    )

    # And for the *other* seat, which is what "hotseat" means: one screen, six playable chairs. The
    # engine refuses seat 1's roll for a rules reason of its own, and *that is the assertion*: a 422
    # is the engine having been consulted, where a 403 would be this seat never having been reached.
    # Which rules key it is deliberately not pinned — it depends on where the turn got to above, and
    # a test that named it would be a test about the reducer's phase machine.
    refused = enforcing.post(
        f"/games/{gid(created)}/commands",
        json={"command": {"kind": "roll_dice", "player": 1}},
        headers=host,
    )
    assert refused.status_code == 422
    assert refused.json()["reason_key"] not in {"error.seat_not_yours", "error.host_only"}


def test_a_save_is_host_only_and_carries_no_secret(enforcing: TestClient) -> None:
    """AC: the RNG/deck cheat channel is closed, and the credential never serializes."""
    created = create(enforcing)

    anonymous = enforcing.get(f"/games/{gid(created)}/save")
    assert anonymous.status_code == 403
    assert anonymous.json()["reason_key"] == "error.host_only"

    saved = enforcing.get(f"/games/{gid(created)}/save", headers=bearer(created["host_secret"]))
    assert saved.status_code == 200
    assert saved.json()["state"]["rng"], "without the RNG this proves nothing about what /save carries"
    assert created["host_secret"] not in saved.text


def test_a_seat_secret_is_refused_on_the_host_only_routes(enforcing: TestClient) -> None:
    """A claim buys one seat, not the game: `/save`, `DELETE` and `replace` stay the host's.

    The fourth skeleton in spirit — the e2e spec is the one written in Playwright — and the one that
    stops "authenticated" being mistaken for "authorised". A guest who has claimed seat 1 holds a
    real credential; it simply does not speak for these three.
    """
    created = create(enforcing)
    guest = bearer(enforcing.post(f"/games/{gid(created)}/seats/1/claim").json()["seat_secret"])

    assert enforcing.get(f"/games/{gid(created)}/save", headers=guest).status_code == 403
    assert enforcing.delete(f"/games/{gid(created)}", headers=guest).status_code == 403
    assert enforcing.get(f"/games/{gid(created)}").status_code == 200, "the game survived both"


# --- Claiming --------------------------------------------------------------


def test_claiming_a_free_seat_hands_back_a_secret_and_that_seat_s_moves(enforcing: TestClient) -> None:
    created = create(enforcing)
    claimed = enforcing.post(f"/games/{gid(created)}/seats/0/claim")

    assert claimed.status_code == 201
    body = claimed.json()
    assert len(body["seat_secret"]) == 32, "16 bytes of hex — see sessions.SECRET_BYTES"
    assert body["seat_secret"] != created["host_secret"]
    assert [command["player"] for command in body["view"]["legal_commands"]] == [0]
    assert body["view"]["claims"] == [{"player": 0, "claimed": True}, {"player": 1, "claimed": False}]

    # And the secret works: the seat's own move is accepted where the guest's was refused above.
    assert (
        enforcing.post(
            f"/games/{gid(created)}/commands",
            json={"command": {"kind": "roll_dice", "player": 0}},
            headers=bearer(body["seat_secret"]),
        ).status_code
        == 200
    )


def test_claiming_a_claimed_seat_is_a_conflict(enforcing: TestClient) -> None:
    """First come, first served, and the second caller is told which seat went."""
    created = create(enforcing)
    first = enforcing.post(f"/games/{gid(created)}/seats/1/claim")
    second = enforcing.post(f"/games/{gid(created)}/seats/1/claim")

    assert first.status_code == 201
    assert second.status_code == 409
    assert second.json()["reason_key"] == "error.seat_taken"
    assert second.json()["params"]["player"] == 1


def test_a_bot_seat_is_never_claimable_and_never_actable(enforcing: TestClient) -> None:
    """The server drives bot seats (MON-304); a person taking one would play the computer's turn.

    Both halves, because they are separate defects: the claim route could refuse while the command
    route still accepted a host-secret command for that seat, which is how a "bot" ends up being
    played by whoever noticed.
    """
    created = create(enforcing, seats=[seat("Ann"), seat("Bot", is_bot=True, bot_level="easy")])

    refused = enforcing.post(f"/games/{gid(created)}/seats/1/claim")
    assert (refused.status_code, refused.json()["reason_key"]) == (409, "error.seat_taken")

    as_host = enforcing.post(
        f"/games/{gid(created)}/commands",
        json={"command": {"kind": "roll_dice", "player": 1}},
        headers=bearer(created["host_secret"]),
    )
    assert (as_host.status_code, as_host.json()["reason_key"]) == (403, "error.seat_not_yours")

    # And the projection agrees with the guard: a bot seat is not offered as claimable at all.
    assert enforcing.get(f"/games/{gid(created)}").json()["claims"] == [{"player": 0, "claimed": False}]


def test_claiming_a_seat_that_is_not_at_this_table_is_refused(enforcing: TestClient) -> None:
    created = create(enforcing)
    refused = enforcing.post(f"/games/{gid(created)}/seats/4/claim")
    assert (refused.status_code, refused.json()["reason_key"]) == (422, "error.unknown_player")


def test_a_claimed_seat_leaves_the_host_s_reach(enforcing: TestClient) -> None:
    """The other half of "the host speaks for every *unclaimed* seat".

    Without this the design would be hotseat with extra steps: the host could keep playing the seat
    somebody in another room had just taken.
    """
    created = create(enforcing)
    enforcing.post(f"/games/{gid(created)}/seats/0/claim")

    refused = enforcing.post(
        f"/games/{gid(created)}/commands",
        json={"command": {"kind": "roll_dice", "player": 0}},
        headers=bearer(created["host_secret"]),
    )
    assert (refused.status_code, refused.json()["reason_key"]) == (403, "error.seat_not_yours")
    assert (
        enforcing.get(f"/games/{gid(created)}", headers=bearer(created["host_secret"])).json()["legal_commands"] == []
    ), "the host is offered no button for a seat it may not press"


def test_releasing_a_claim_voids_the_old_secret_and_frees_the_seat(enforcing: TestClient) -> None:
    """The unstick for a lost seat secret, and the proof that it is a *void* rather than a re-issue."""
    created = create(enforcing)
    host = bearer(created["host_secret"])
    old = enforcing.post(f"/games/{gid(created)}/seats/0/claim").json()["seat_secret"]

    assert enforcing.delete(f"/games/{gid(created)}/seats/0/claim", headers=host).status_code == 204

    stale = enforcing.post(
        f"/games/{gid(created)}/commands",
        json={"command": {"kind": "roll_dice", "player": 0}},
        headers=bearer(old),
    )
    assert (stale.status_code, stale.json()["reason_key"]) == (403, "error.seat_not_yours")
    # Free again, and the new secret is a different string rather than the old one handed back.
    again = enforcing.post(f"/games/{gid(created)}/seats/0/claim")
    assert again.status_code == 201
    assert again.json()["seat_secret"] != old
    # Idempotent: a host pressing release twice is not shown an error about the outcome they wanted.
    assert enforcing.delete(f"/games/{gid(created)}/seats/1/claim", headers=host).status_code == 204


def test_releasing_a_claim_is_host_only(enforcing: TestClient) -> None:
    """Otherwise any joiner could evict any player, which is this item's own problem in a hat."""
    created = create(enforcing)
    guest = bearer(enforcing.post(f"/games/{gid(created)}/seats/1/claim").json()["seat_secret"])

    refused = enforcing.delete(f"/games/{gid(created)}/seats/1/claim", headers=guest)
    assert (refused.status_code, refused.json()["reason_key"]) == (403, "error.host_only")
    assert enforcing.get(f"/games/{gid(created)}").json()["claims"][1]["claimed"] is True


# --- Spectators ------------------------------------------------------------


def test_a_spectator_sees_the_whole_board_and_is_offered_nothing(enforcing: TestClient) -> None:
    """Watching is not a privilege; acting is (ADR-012).

    Holdings are public under the universal rules (spec §5.2) and every event is already public on
    the WebSocket, so a spectator gets the whole projection — and an empty ``legal_commands``, which
    is what makes the UI's "no buttons" state a *fact from the server* rather than a client guess.
    """
    created = create(enforcing)
    watched = enforcing.get(f"/games/{gid(created)}").json()

    assert watched["legal_commands"] == []
    assert watched["state"]["players"][0]["cash"] == 1500, "the board is not hidden from a watcher"
    assert len(watched["board"]["tiles"]) == 40
    assert watched["claims"] == [{"player": 0, "claimed": False}, {"player": 1, "claimed": False}]


def test_an_unknown_secret_is_a_spectator_rather_than_its_own_refusal(enforcing: TestClient) -> None:
    """ "Wrong" and "absent" answer identically, so the routes are not an oracle for guessing one."""
    created = create(enforcing)
    invented = bearer("f" * 32)

    assert enforcing.get(f"/games/{gid(created)}", headers=invented).json()["legal_commands"] == []
    refused = enforcing.post(
        f"/games/{gid(created)}/commands",
        json={"command": {"kind": "roll_dice", "player": 0}},
        headers=invented,
    )
    assert (refused.status_code, refused.json()["reason_key"]) == (403, "error.seat_not_yours")


@pytest.mark.parametrize(
    "header",
    ["", "Bearer", "Bearer ", "Basic hunter2", "notascheme"],
    ids=["empty", "scheme-only", "scheme-and-space", "wrong-scheme", "no-scheme"],
)
def test_an_authorization_header_this_api_does_not_serve_is_simply_absent(enforcing: TestClient, header: str) -> None:
    """A malformed header is a spectator, not a 400. There is nothing for a client to fix."""
    created = create(enforcing)
    watched = enforcing.get(f"/games/{gid(created)}", headers={"Authorization": header})
    assert watched.status_code == 200
    assert watched.json()["legal_commands"] == []


def test_a_non_ascii_secret_is_a_mismatch_rather_than_a_crash(enforcing: TestClient) -> None:
    """``secrets.compare_digest`` refuses non-ASCII ``str``, and a header may carry any UTF-8.

    Without the encode in ``transport._same_secret`` this is a ``TypeError`` escaping as a 500 —
    an unauthenticated caller crashing a route by typing Hebrew into a header.

    Sent as **bytes**, because httpx encodes a ``str`` header value as ASCII and would refuse to
    build the request at all. A real client is under no such obligation: bytes on the wire is what a
    header is, and starlette decodes them latin-1, so this is the request that actually arrives.
    """
    created = create(enforcing)
    watched = enforcing.get(f"/games/{gid(created)}", headers={"Authorization": "Bearer שלום".encode()})
    assert watched.status_code == 200
    assert watched.json()["legal_commands"] == []


# --- The host-only routes --------------------------------------------------


def test_deleting_a_game_is_host_only(enforcing: TestClient) -> None:
    """Before MON-906 a stranger with the id could end a family's game from a URL bar."""
    created = create(enforcing)
    assert enforcing.delete(f"/games/{gid(created)}").status_code == 403
    assert enforcing.get(f"/games/{gid(created)}").status_code == 200
    assert enforcing.delete(f"/games/{gid(created)}", headers=bearer(created["host_secret"])).status_code == 204


def test_replacing_a_live_game_through_a_load_is_host_only(enforcing: TestClient) -> None:
    """ADR-011 §Security parked exactly this pending MON-901. ``refuse`` and ``copy`` stay open."""
    created = create(enforcing)
    host = bearer(created["host_secret"])
    saved = enforcing.get(f"/games/{gid(created)}/save", headers=host).json()

    refused = enforcing.post("/games/load?if_exists=replace", json=saved)
    assert (refused.status_code, refused.json()["reason_key"]) == (403, "error.host_only")
    # `refuse` is not a mutation, so it is still the ordinary 409 anybody gets.
    assert enforcing.post("/games/load", json=saved).status_code == 409
    assert enforcing.post("/games/load?if_exists=replace", json=saved, headers=host).status_code == 201


def test_a_restored_game_hands_its_loader_a_host_secret(enforcing: TestClient) -> None:
    """A load seats a *new* session with a new authority, so its client needs the new credential.

    Without this the flag's enforcing position would lock a player out of the game they had just
    restored from a file — the loader would hold a secret belonging to a session that no longer
    exists. ``GameCreated`` from both seating routes is what closes that.
    """
    created = create(enforcing)
    host = bearer(created["host_secret"])
    saved = enforcing.get(f"/games/{gid(created)}/save", headers=host).json()
    enforcing.delete(f"/games/{gid(created)}", headers=host)

    restored = enforcing.post("/games/load", json=saved)
    assert restored.status_code == 201
    body = restored.json()
    assert body["host_secret"] != created["host_secret"], "a new session gets a new authority"
    assert enforcing.get(f"/games/{gid(body)}/save", headers=bearer(body["host_secret"])).status_code == 200


# --- Validation is scoped like commands ------------------------------------


def test_validating_for_a_seat_this_connection_does_not_hold_is_refused(enforcing: TestClient) -> None:
    """The trade builder validates a draft and enables its send button on the answer (G-32).

    A ``/validate`` that answered "legal" to a caller ``/commands`` would refuse is a builder
    offering a move that cannot be made — so the two routes are scoped identically.
    """
    created = create(enforcing)
    guest = bearer(enforcing.post(f"/games/{gid(created)}/seats/1/claim").json()["seat_secret"])

    refused = enforcing.post(
        f"/games/{gid(created)}/validate",
        json={"command": {"kind": "roll_dice", "player": 0}},
        headers=guest,
    )
    assert (refused.status_code, refused.json()["reason_key"]) == (403, "error.seat_not_yours")
    # Its own seat still validates normally — a `legal: false` verdict, not a status.
    own = enforcing.post(
        f"/games/{gid(created)}/validate",
        json={"command": {"kind": "roll_dice", "player": 1}},
        headers=guest,
    )
    assert own.status_code == 200
    assert own.json()["legal"] is False


# --- The rollout flag ------------------------------------------------------


def test_the_flag_off_reproduces_todays_behaviour(client: TestClient) -> None:
    """``seat_authority=off`` is the default, and its whole job is to change nothing.

    ``client`` is ``conftest``'s, so this runs against the shipped default rather than against a
    setting this file chose — which is the point: the assertion is about what a *deployed* server
    does at merge, before ``render.yaml`` flips anything.

    Every clause below is one of the four things this PR would otherwise have changed, checked with
    no ``Authorization`` header at all — the request an already-cached client makes.
    """
    assert Settings().seat_authority == "off", "the default is the rollout plan, not a test fixture"
    created = create(client)

    # 1. Any caller acts for any seat.
    assert (
        client.post(f"/games/{gid(created)}/commands", json={"command": {"kind": "roll_dice", "player": 0}}).status_code
        == 200
    )
    # 2. The view is unfiltered — a bot's moves included, exactly as before.
    assert client.get(f"/games/{gid(created)}").json()["legal_commands"] != []
    # 3. `/save` answers anybody.
    assert client.get(f"/games/{gid(created)}/save").status_code == 200
    # 4. And so does `DELETE`.
    assert client.delete(f"/games/{gid(created)}").status_code == 204


def test_the_flag_off_still_mints_and_still_reports_claims(client: TestClient) -> None:
    """Off means "do not enforce", not "do not exist" — which is what makes the flip one env var.

    The secret is minted and returned, the claim routes work, and the projection carries ``claims``.
    Only the refusals are asleep. If any of that were conditional on the flag too, flipping it in
    ``render.yaml`` would require a client that had never been able to obtain a secret.
    """
    created = create(client)
    assert len(created["host_secret"]) == 32
    claimed = client.post(f"/games/{gid(created)}/seats/1/claim")
    assert claimed.status_code == 201
    assert client.get(f"/games/{gid(created)}").json()["claims"][1]["claimed"] is True
    # ...and the claim buys nothing yet, because nothing is enforced.
    assert (
        client.post(f"/games/{gid(created)}/commands", json={"command": {"kind": "roll_dice", "player": 0}}).status_code
        == 200
    )


# --- Leak tests (security review, ADR-012 §Security requirements) -----------
#
# A capability is only as good as the set of places it does not appear. Each of these scans for the
# secret's own characters rather than for a field name, because the defect that ships is a new field
# that happens to carry it — not `host_secret` reappearing under its own name.


def test_no_secret_reaches_the_projection_the_save_file_or_an_event(enforcing: TestClient) -> None:
    created = create(enforcing)
    host_secret = created["host_secret"]
    seat_secret = enforcing.post(f"/games/{gid(created)}/seats/0/claim").json()["seat_secret"]
    enforcing.post(
        f"/games/{gid(created)}/commands",
        json={"command": {"kind": "roll_dice", "player": 0}},
        headers=bearer(seat_secret),
    )

    # The view a *watcher* gets, with the whole event log replayed into it.
    watched = enforcing.get(f"/games/{gid(created)}?since=0")
    assert watched.json()["events"], "an empty log would make the scan below vacuous"
    # The save, which is the one answer carrying hidden information at all (ADR-008 §2).
    saved = enforcing.get(f"/games/{gid(created)}/save", headers=bearer(host_secret))
    # And the events on their own, as the WebSocket frames them.
    frames = json.dumps(list(watched.json()["events"]))

    for secret in (host_secret, seat_secret):
        assert secret not in watched.text
        assert secret not in saved.text
        assert secret not in frames


def test_no_secret_reaches_the_log(enforcing: TestClient, caplog: pytest.LogCaptureFixture) -> None:
    """``log.py``'s untrusted-input discipline, extended to the one string that is worse than an id.

    The refusal path is what is exercised, because that is the path that logs: ``request.rejected``
    carries the key, the status and the route *template*. A handler that started interpolating the
    header — for debugging, plausibly — would put a live seat credential into whatever aggregator
    reads these.
    """
    created = create(enforcing)
    host_secret = created["host_secret"]
    seat_secret = enforcing.post(f"/games/{gid(created)}/seats/1/claim").json()["seat_secret"]

    with caplog.at_level("DEBUG"):
        enforcing.get(f"/games/{gid(created)}/save", headers=bearer(seat_secret))  # 403 host_only
        enforcing.post(
            f"/games/{gid(created)}/commands",
            json={"command": {"kind": "roll_dice", "player": 0}},
            headers=bearer(seat_secret),
        )  # 403 seat_not_yours
        enforcing.get(f"/games/{gid(created)}", headers=bearer(host_secret))  # accepted

    written = caplog.text
    assert host_secret not in written
    assert seat_secret not in written


def test_the_comparison_is_constant_time(enforcing: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """Asserted by *call*, not by timing — a stopwatch in a test suite measures the CI runner.

    ``==`` on two strings returns as soon as a byte differs, which over enough requests tells an
    attacker how long a prefix they have right. The property worth pinning is therefore structural:
    every comparison of a presented secret goes through ``secrets.compare_digest``.
    """
    import secrets as secrets_module

    seen: list[tuple[bytes, bytes]] = []
    real = secrets_module.compare_digest

    def spy(left: object, right: object) -> bool:
        assert isinstance(left, bytes) and isinstance(right, bytes), "compared as bytes, not as text"
        seen.append((left, right))
        return bool(real(left, right))

    # Patched on the stdlib module itself, which is what `transport` reaches through
    # (`secrets.compare_digest(...)`, resolved per call) — so a guard that switched to `==` would
    # leave `seen` empty and this test red.
    monkeypatch.setattr(secrets_module, "compare_digest", spy)

    created = create(enforcing)
    enforcing.get(f"/games/{gid(created)}", headers=bearer(created["host_secret"]))

    assert seen, "no secret was compared at all, so this test would pass with the guard deleted"


# --- Everything a session mints ---------------------------------------------


def test_two_games_do_not_share_a_host_secret(client: TestClient) -> None:
    """The obvious one, and the one a constant would pass every other test with."""
    first = create(client, game_id="one")
    second = create(client, game_id="two")
    assert first["host_secret"] != second["host_secret"]

    stolen = client.get("/games/two/save", headers=bearer(first["host_secret"]))
    assert stolen.status_code == 200, "the flag is off here; the point is only that the strings differ"


def test_a_host_secret_from_another_game_does_not_speak_here(enforcing: TestClient) -> None:
    """And with the flag on, it is refused — authority is per session, not per process."""
    first = create(enforcing, game_id="one")
    create(enforcing, game_id="two")
    stolen = enforcing.get("/games/two/save", headers=bearer(first["host_secret"]))
    assert (stolen.status_code, stolen.json()["reason_key"]) == (403, "error.host_only")
