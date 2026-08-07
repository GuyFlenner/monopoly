"""The two per-client bounds on the mutating routes (MON-905).

The defect these close is measurable rather than theoretical: fifty cheap ``POST /games`` filled
``max_sessions``, and because eviction is a four-hour idle sweep, every real player got
``error.server_at_capacity`` until it caught up. So the tests below are written as the *attack*
rather than as the feature — one client spending everybody's slots, one client spending its own
budget, and a second client that must remain unaffected in both cases. A rate limiter that refused
everybody equally would pass a test that only watched the first client fail.

Two things are held constant throughout and both are deliberate:

* **The clock is wound, never waited on.** ``ClientLimiter`` takes its clock the way ``SessionStore``
  does (see that module's docstring — this is the server's only clock discipline), so "the window
  expired" is an assertion rather than a sixty-second sleep.
* **Two clients are always two addresses.** ``TestClient(app, client=...)`` sets ``scope["client"]``,
  which is what the limiter identifies on. A suite that used one address could not tell a per-client
  bound from a global one.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from conftest import SESSION_TTL_SECONDS, FakeClock, new_game_payload
from fastapi.testclient import TestClient

from kesef_server.api import METERED_ROUTES, WS_EVENT_STREAM_PATH, app, get_settings, get_store
from kesef_server.config import Settings
from kesef_server.limits import UNKNOWN_CLIENT, WINDOW_SECONDS, ClientLimiter
from kesef_server.sessions import SessionStore

TOO_MANY_REQUESTS = 429
"""Spelled as a number, like ``test_api.py``'s 422: a status code does not need a name to be read."""

ALICE = ("198.51.100.7", 41000)
BOB = ("203.0.113.9", 41000)
"""Two documentation addresses (RFC 5737). Different clients means different *addresses* — that is
the whole thing the bounds are keyed on."""


@pytest.fixture(autouse=True)
def _clean_overrides() -> Iterator[None]:
    """Undo :func:`_clients`' wiring after every test here.

    The ``limiter`` fixture in ``conftest`` already restores ``app.state.limiter``; this is the other
    half, and it is autouse rather than part of the helper because the helper hands back two clients
    that a test uses for its whole body.
    """
    yield
    app.dependency_overrides.clear()


def _clients(store: SessionStore, limiter: ClientLimiter) -> tuple[TestClient, TestClient]:
    """Two callers at two addresses, sharing one server, one store and one limiter."""
    app.state.limiter = limiter
    app.dependency_overrides[get_store] = lambda: store
    # `bot_think_seconds=0` for the reason `conftest.settings` gives: nothing here is about the pause.
    app.dependency_overrides[get_settings] = lambda: Settings(bot_think_seconds=0)
    return TestClient(app, client=ALICE), TestClient(app, client=BOB)


# --- The rate ---------------------------------------------------------------


def test_one_client_that_runs_out_of_budget_is_refused_and_another_client_is_not() -> None:
    """The per-client half of Finding 1, stated as the attack it stops.

    Three creations allowed, the fourth refused with a key and a number of seconds — and Bob, who
    has spent nothing, is served throughout. Bob is the assertion that matters: a limiter that had
    accidentally been keyed on nothing at all would refuse the fourth request just the same, and
    only his 201 tells the two apart.
    """
    store = SessionStore(max_sessions=50, ttl_seconds=SESSION_TTL_SECONDS, clock=FakeClock())
    limiter = ClientLimiter(requests_per_minute=3, trust_forwarded_for=False, clock=FakeClock())
    alice, bob = _clients(store, limiter)

    for attempt in range(3):
        assert alice.post("/games", json=new_game_payload(game_id=f"a{attempt}")).status_code == 201

    refused = alice.post("/games", json=new_game_payload(game_id="a3"))
    assert refused.status_code == TOO_MANY_REQUESTS
    body = refused.json()
    assert body["reason_key"] == "error.too_many_requests"
    assert body["params"]["retry_after"] == int(WINDOW_SECONDS)

    assert bob.post("/games", json=new_game_payload(game_id="b0")).status_code == 201
    assert "a3" not in {session.state.game_id for session in store.all()}, "a refused request reached the store"


def test_a_refusal_counts_down_as_the_window_drains() -> None:
    """``retry_after`` is the time until the *oldest* charge falls out, not a constant.

    A limiter answering a fixed sixty would pass the test above and lie to every client that waited:
    the window is a sliding one, so a caller forty seconds into it is twenty seconds away, not sixty.
    """
    clock = FakeClock()
    limiter = ClientLimiter(requests_per_minute=2, trust_forwarded_for=False, clock=clock)

    assert limiter.charge("a") is None
    clock.advance(10)
    assert limiter.charge("a") is None

    clock.advance(30)  # 40 s after the first charge
    assert limiter.charge("a") == 20

    clock.advance(15)  # 55 s after the first charge
    assert limiter.charge("a") == 5


def test_a_refused_request_does_not_extend_the_window() -> None:
    """Hammering the door must not lock it further.

    If a refusal were recorded, a client retrying every second would push its own oldest timestamp
    forward forever and never be let back in — a person who double-clicked would be shut out for a
    minute rather than for the second they had earned.
    """
    clock = FakeClock()
    limiter = ClientLimiter(requests_per_minute=1, trust_forwarded_for=False, clock=clock)

    assert limiter.charge("a") is None
    clock.advance(30)
    for _ in range(5):
        assert limiter.charge("a") == 30

    clock.advance(30)
    assert limiter.charge("a") is None, "the retries pushed the window along with them"


def test_the_sweep_forgets_timestamps_older_than_the_window() -> None:
    """Recovery *and* reclamation — the second half is what makes this a sweep rather than a reset.

    A limiter that let the client through again but kept its deque would be a permanent record of
    every address that ever called, which is the unbounded-growth defect ``subscriber_queue_size``
    and ``session_ttl_minutes`` exist to prevent one layer out. So this asserts both that Alice may
    call again and that she is no longer remembered at all.
    """
    clock = FakeClock()
    limiter = ClientLimiter(requests_per_minute=2, trust_forwarded_for=False, clock=clock)

    assert limiter.charge("alice") is None
    assert limiter.charge("alice") is None
    assert limiter.charge("alice") is not None
    assert len(limiter) == 1

    clock.advance(WINDOW_SECONDS)
    assert limiter.charge("bob") is None, "bob had spent nothing"
    assert len(limiter) == 1, "alice's expired timestamps were kept — only bob should be remembered"
    assert limiter.charge("alice") is None, "the window passed and alice was still refused"


def test_reading_and_playing_and_watching_are_never_metered() -> None:
    """Scope, asserted from the outside: the budget buys game *creations*, not turns.

    A rate limit that could refuse ``POST /games/{id}/commands`` would be a rule about how fast a
    six-year-old may play, and one that could refuse ``GET /games/{id}`` would punish precisely the
    client whose connection is already reconnecting. The budget here is one request wide, so any
    leak into an unmetered route shows up immediately.
    """
    store = SessionStore(max_sessions=50, ttl_seconds=SESSION_TTL_SECONDS, clock=FakeClock())
    limiter = ClientLimiter(requests_per_minute=1, trust_forwarded_for=False, clock=FakeClock())
    alice, _ = _clients(store, limiter)

    assert alice.post("/games", json=new_game_payload(game_id="g")).status_code == 201

    for _ in range(20):
        assert alice.get("/games/g").status_code == 200
        assert alice.get("/games/g/save").status_code == 200
        assert alice.get("/health").status_code == 200
        assert alice.post("/games/g/validate", json={"command": {"kind": "end_turn", "player": 0}}).status_code == 200
        with alice.websocket_connect(WS_EVENT_STREAM_PATH.format(game_id="g")):
            pass

    assert alice.post("/games", json=new_game_payload(game_id="h")).status_code == TOO_MANY_REQUESTS, (
        "the budget was spent by something unmetered, or never charged at all"
    )


# --- The share of the store -------------------------------------------------


def test_a_client_at_its_game_cap_is_refused_before_the_global_cap_is_reached() -> None:
    """The ordering the item is actually about.

    Alice may hold two games; the store may hold eight. Her third is refused with
    ``error.too_many_games`` while six slots stand empty — so the global cap is never reached, Bob
    is never told "the table is full" about a table Alice filled, and the 503 keeps meaning what it
    says. Reversed, the check would fire only *after* the store was full, which is the failure it
    exists to prevent, reported late and blamed on the wrong party.
    """
    store = SessionStore(
        max_sessions=8,
        ttl_seconds=SESSION_TTL_SECONDS,
        clock=FakeClock(),
        max_sessions_per_client=2,
    )
    alice, bob = _clients(store, _generous())

    assert alice.post("/games", json=new_game_payload(game_id="a0")).status_code == 201
    assert alice.post("/games", json=new_game_payload(game_id="a1")).status_code == 201

    refused = alice.post("/games", json=new_game_payload(game_id="a2"))
    assert refused.status_code == TOO_MANY_REQUESTS
    assert refused.json() == {"reason_key": "error.too_many_games", "params": {"limit": 2}}
    assert len(store) == 2, "the refused game took a slot anyway"

    assert bob.post("/games", json=new_game_payload(game_id="b0")).status_code == 201


def test_closing_a_game_returns_its_slot_to_the_client_that_held_it() -> None:
    """The cap is a count of what is live, not a lifetime quota.

    Without this, a household that played three games in an evening would be locked out of the
    fourth by two games nobody was in — which is the same complaint as the bug, addressed to the
    people the fix was for.
    """
    store = SessionStore(
        max_sessions=8,
        ttl_seconds=SESSION_TTL_SECONDS,
        clock=FakeClock(),
        max_sessions_per_client=1,
    )
    alice, _ = _clients(store, _generous())

    assert alice.post("/games", json=new_game_payload(game_id="a0")).status_code == 201
    assert alice.post("/games", json=new_game_payload(game_id="a1")).status_code == TOO_MANY_REQUESTS
    assert alice.delete("/games/a0").status_code == 204
    assert alice.post("/games", json=new_game_payload(game_id="a1")).status_code == 201


def test_loading_a_save_is_charged_to_the_client_that_uploaded_it() -> None:
    """``POST /games/load`` seats a game exactly as ``POST /games`` does, so it is counted the same.

    Left uncounted it would be the whole bound's back door: the body is bigger and the route is
    slower, so it is the *better* one to flood with.
    """
    store = SessionStore(
        max_sessions=8,
        ttl_seconds=SESSION_TTL_SECONDS,
        clock=FakeClock(),
        max_sessions_per_client=1,
    )
    alice, bob = _clients(store, _generous())

    assert alice.post("/games", json=new_game_payload(game_id="a0")).status_code == 201
    save = alice.get("/games/a0/save").json()
    save["state"]["game_id"] = "a1"

    refused = alice.post("/games/load", json=save)
    assert refused.status_code == TOO_MANY_REQUESTS
    assert refused.json()["reason_key"] == "error.too_many_games"

    assert bob.post("/games/load", json=save).status_code == 201, "bob's own first game was refused"


def test_a_store_with_no_per_client_cap_counts_nobody() -> None:
    """``max_sessions_per_client=None`` is "no cap", not a number in disguise.

    This is the browser transport's store (MON-805): one caller, its own tab, nothing to divide the
    store between. A default hidden in the store would be a second copy of the setting, free to
    drift from ``Settings.max_sessions_per_client`` — and the drift would show up as a Pyodide tab
    refusing to open its owner's fourth game.
    """
    store = SessionStore(max_sessions=8, ttl_seconds=SESSION_TTL_SECONDS, clock=FakeClock())
    alice, _ = _clients(store, _generous())

    for attempt in range(6):
        assert alice.post("/games", json=new_game_payload(game_id=f"a{attempt}")).status_code == 201
    assert store.held_by(ALICE[0]) == 6


def test_the_owning_client_never_reaches_the_wire() -> None:
    """``Session.client_id`` is transport bookkeeping, and a save file must not carry an address.

    ADR-008 §2 is that "the JSON is the save file"; an address in it would be handed to whoever the
    file was next mailed to, and it confers nothing anyway — the cap counts, it does not authorise.
    """
    store = SessionStore(max_sessions=8, ttl_seconds=SESSION_TTL_SECONDS, clock=FakeClock())
    alice, _ = _clients(store, _generous())

    assert alice.post("/games", json=new_game_payload(game_id="g")).status_code == 201
    assert store.held_by(ALICE[0]) == 1, "the creator was not recorded at all"

    for document in (alice.get("/games/g").text, alice.get("/games/g/save").text):
        assert ALICE[0] not in document
        assert "client_id" not in document


# --- Who the client is ------------------------------------------------------


def test_the_forwarded_header_is_ignored_unless_the_setting_says_otherwise() -> None:
    """Default off, because in front of nothing the header is written by the caller.

    Trusting it unconditionally would hand any script an identity generator: one header per request
    and both bounds become decoration. So with the setting off, two different ``X-Forwarded-For``
    values are the same client — the socket's peer — and the second request is refused.
    """
    limiter = ClientLimiter(requests_per_minute=1, trust_forwarded_for=False, clock=FakeClock())
    assert limiter.identify(peer="10.0.0.1", forwarded_for="1.1.1.1") == "10.0.0.1"
    assert limiter.charge(limiter.identify(peer="10.0.0.1", forwarded_for="1.1.1.1")) is None
    assert limiter.charge(limiter.identify(peer="10.0.0.1", forwarded_for="2.2.2.2")) is not None


def test_the_forwarded_header_names_the_client_when_the_setting_is_on() -> None:
    """And with the setting on, two players behind one edge are two clients.

    The other direction is just as load-bearing: behind Render every request arrives from the edge's
    address, so refusing the header would put every player in the world in one bucket and the first
    thirty of them would spend everybody's budget.
    """
    limiter = ClientLimiter(requests_per_minute=1, trust_forwarded_for=True, clock=FakeClock())
    assert limiter.identify(peer="10.0.0.1", forwarded_for="1.1.1.1") == "1.1.1.1"
    assert limiter.charge(limiter.identify(peer="10.0.0.1", forwarded_for="1.1.1.1")) is None
    assert limiter.charge(limiter.identify(peer="10.0.0.1", forwarded_for="2.2.2.2")) is None


def test_a_trusted_header_is_read_from_the_nearest_hop() -> None:
    """The entry the trusted proxy itself wrote, not the one the caller chose.

    A proxy appends the address it received the request *from*, so everything left of the last entry
    is caller-supplied text. Reading the leftmost — the usual "the original client is first" — would
    mean that even with the setting on, prefixing a fresh fake address to every request mints a fresh
    identity, which is the exact hole the setting was supposed to close.
    """
    limiter = ClientLimiter(requests_per_minute=1, trust_forwarded_for=True, clock=FakeClock())
    spoofed = "9.9.9.9, 8.8.8.8, 198.51.100.7"
    assert limiter.identify(peer="10.0.0.1", forwarded_for=spoofed) == "198.51.100.7"
    assert limiter.identify(peer="10.0.0.1", forwarded_for="  198.51.100.7  ") == "198.51.100.7"


def test_a_caller_with_no_readable_address_shares_one_bucket() -> None:
    """Unidentifiable is not a free pass.

    Giving an unnamed caller its own allowance would make "unnamed" the cheapest thing to be. One
    shared bucket is the conservative direction, and the empty header case matters because a proxy
    that sets ``X-Forwarded-For:`` with nothing after it must not read as an identity either.
    """
    limiter = ClientLimiter(requests_per_minute=1, trust_forwarded_for=True, clock=FakeClock())
    assert limiter.identify(peer=None, forwarded_for=None) == UNKNOWN_CLIENT
    assert limiter.identify(peer=None, forwarded_for="  ,  ") == UNKNOWN_CLIENT


# --- The document -----------------------------------------------------------


def test_every_metered_route_declares_the_429_it_can_answer() -> None:
    """A status the document does not mention is one the generated client cannot branch on (G-33).

    Read off :data:`METERED_ROUTES` rather than off a second hand-written list, so a route added to
    the bound without its declaration fails here instead of reaching the UI as an unhandled failure
    where a keyed sentence belongs.
    """
    document = app.openapi()
    missing = [
        (method, path)
        for method, path in sorted(METERED_ROUTES)
        if "429" not in document["paths"][path][method.lower()]["responses"]
    ]
    assert not missing, f"metered routes whose 429 is undeclared: {missing}"


def test_an_unmetered_route_does_not_advertise_a_429() -> None:
    """The mirror, so the test above cannot be satisfied by declaring it everywhere.

    ``GET /games/{game_id}`` cannot answer 429 — saying it could would teach a client to handle a
    refusal that never arrives, and would quietly hide the day somebody metered a read.
    """
    document = app.openapi()
    assert "429" not in document["paths"]["/games/{game_id}"]["get"]["responses"]


def _generous() -> ClientLimiter:
    """A limiter that will not interfere — for the tests that are about the *session* cap.

    The two bounds are independent, and a test of one that could be tripped by the other would fail
    for a reason its name does not mention.
    """
    return ClientLimiter(requests_per_minute=10_000, trust_forwarded_for=False, clock=FakeClock())
