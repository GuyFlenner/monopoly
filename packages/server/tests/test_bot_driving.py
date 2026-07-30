"""The server advancing bot seats (MON-304).

The claim this file has to establish is small and easy to get wrong: **a game seated with a computer
progresses without a client speaking for it.** Everything else is a consequence.

Before MON-304 the only thing that ever changed a game was a client posting a command, so a bot seat
was a seat the game waited on forever. The interesting failures are therefore not "the bot chose
badly" — that is MON-601's business — but "the game stopped", "the bot moved when it should not
have", and "the bot's moves did not reach anybody".
"""

from __future__ import annotations

# `Any` rather than `object` for decoded JSON. These helpers walk a response body whose shape the
# server's schemas already guarantee; typing it as `object` bought nothing but a cast at every
# subscript, which is noise that hides the assertions.
import asyncio
from typing import Any

from conftest import SESSION_TTL_SECONDS, minimal_state, new_game_payload, seat
from fastapi.testclient import TestClient

from kesef_engine.commands import TradeOffer, TradeSide
from kesef_engine.events import Event, TradeDeclined, TradeProposed, TurnStarted
from kesef_engine.primitives import BotLevel, PlayerId
from kesef_engine.state import GameState, PlayerKind, PlayerState, PropertyState
from kesef_server.api import _advance_bots
from kesef_server.bots import drive, seats_that_proposed_this_turn
from kesef_server.config import Settings
from kesef_server.sessions import SessionStore


def _refetch(client: TestClient, game_id: str) -> dict[str, Any]:
    """The game as it stands now, with `events` replayed from the start.

    Bot moves do **not** come back in the response to the human's command: they are driven in a
    background task so the human's own action returns immediately, and they reach a client the way
    every other event does — the WebSocket push, or a refetch from the cursor. Awaiting them inside
    the request is what made seating a bot turn game creation into a 3-second wait.

    Starlette's TestClient runs background tasks before handing back the response, so by the time a
    call returns here the bot has already moved and this refetch sees it. Convenient, and also the
    reason these tests are not racy.
    """
    response = client.get(f"/games/{game_id}?since=0")
    assert response.status_code == 200, response.json()
    body: dict[str, Any] = response.json()
    return body


def _bot(name: str, level: str = "easy") -> dict[str, Any]:
    return seat(name, is_bot=True, bot_level=level)


def _current(view: dict[str, Any]) -> int:
    state = view["state"]
    assert isinstance(state, dict)
    return int(state["current_player_id"])


def _kinds(view: dict[str, Any]) -> list[str]:
    """The event types in a view.

    Events arrive in the `{seq, event}` envelope the transport adds (G-34) — `seq` is a fact about
    this session's log and the engine, which has no session, must not invent one. So the type is one
    level in.
    """
    entries = view["events"]
    assert isinstance(entries, list)
    return [entry["event"]["type"] for entry in entries]


def _events_of_type(view: dict[str, Any], event_type: str) -> list[dict[str, Any]]:
    entries = view["events"]
    assert isinstance(entries, list)
    return [entry["event"] for entry in entries if entry["event"]["type"] == event_type]


def _play_human_turn(client: TestClient, game_id: str, player: int) -> dict[str, Any]:
    """Play a human seat's turn by taking its first legal command until it has none left.

    Not `roll_dice` then `end_turn`: landing on an unowned square puts the game in
    `AWAITING_PURCHASE_DECISION`, so `end_turn` is genuinely illegal and the server answers 422. The
    first version of these tests assumed the two-command turn and failed on exactly that — a useful
    reminder that a turn is a sequence the engine decides the shape of, not two posts.

    Stops at the human's own `end_turn`, and returns *that* response — which is the one carrying the
    bot's reply, because the server drives the bots inside the same request. Stopping on "the human has
    no legal commands" instead would never return: the bot hands control straight back, so the human
    always has something legal to do next.
    """
    view: dict[str, Any] = client.get(f"/games/{game_id}").json()
    for _ in range(30):
        offered = view["legal_commands"]
        assert isinstance(offered, list)
        mine = [command for command in offered if command["player"] == player]
        if not mine:
            return view
        # A turn-advancing command by preference, not simply the first legal one. Taking `mine[0]`
        # picked whatever the enumeration happened to list first — often `build_house`, which leaves
        # the phase unchanged, so the "turn" never ended and this helper ran out of iterations.
        order = ("roll_dice", "buy_property", "decline_purchase", "roll_for_jail", "end_turn")
        chosen = next(
            (c for kind in order for c in mine if c["kind"] == kind),
            mine[0],
        )
        response = client.post(f"/games/{game_id}/commands", json={"command": chosen})
        assert response.status_code == 200, response.json()
        view = response.json()
        if chosen["kind"] == "end_turn":
            return view
    raise AssertionError("the human's turn did not finish in 30 commands")


def _seat_of(view: dict[str, Any], player_id: int) -> dict[str, Any]:
    state = view["state"]
    assert isinstance(state, dict)
    players = state["players"]
    assert isinstance(players, list)
    found = next(player for player in players if player["id"] == player_id)
    assert isinstance(found, dict)
    return found


class TestABotSeatDoesNotStallTheGame:
    def test_a_bot_in_seat_one_has_already_moved_by_the_time_the_game_is_returned(self, client: TestClient) -> None:
        """The opening view is never a game waiting on a computer.

        A game whose first seat is a bot used to be returned mid-bot-turn, so the board appeared
        before anybody had touched it and then did nothing. `create_game` now drives the bots before
        it answers.
        """
        response = client.post("/games", json=new_game_payload(seats=[_bot("Robo"), seat("Ruti")]))
        assert response.status_code == 201
        created = response.json()
        assert _seat_of(created, 0)["is_bot"] is True

        # The creation response is the game as created — the bot's turn is not waited for. What matters
        # is that it happened: refetching shows the table now waiting on the human.
        view = _refetch(client, created["state"]["game_id"])
        assert _current(view) == 1, "the bot never took its opening turn"
        assert view["events"], "the bot's opening turn produced no events at all"

    def test_ending_a_human_turn_hands_over_and_comes_back(self, client: TestClient) -> None:
        """The round trip a hotseat game is made of."""
        created = client.post("/games", json=new_game_payload(seats=[seat("Ruti"), _bot("Robo")])).json()
        game_id = created["state"]["game_id"]
        assert _current(created) == 0, "a human in seat one should be asked first"

        _play_human_turn(client, game_id, player=0)

        # The human handed over; the bot took its turn in the background and handed back.
        view = _refetch(client, game_id)
        assert _current(view) == 0, "the game should be back with the human, not parked on the bot"
        kinds = _kinds(view)
        assert "turn_started" in kinds, f"the bot's turn is not in the log: {kinds}"

    def test_two_bots_play_each_other_without_any_client_command(self, client: TestClient) -> None:
        """The strongest form of the claim: nobody speaks for either seat.

        With every seat a bot, the *creation* request has to carry the game as far as the bots can
        take it. If the driver only woke one bot per call, this game would stop after one turn and
        there would be no human command to restart it — so this is the test that a bot handing over to
        another bot keeps going.
        """
        response = client.post("/games", json=new_game_payload(seats=[_bot("A"), _bot("B")]))
        assert response.status_code == 201
        view = _refetch(client, response.json()["state"]["game_id"])

        # An all-bot game has no human to hand back to, so the background task runs to
        # `bot_max_steps_per_call`
        # and logs that it did. That is the intended behaviour rather than a defect: the cap is what
        # keeps a request finite, and the product's modes are human-vs-human and human-vs-bots. An
        # all-bot game therefore advances a chunk per request, which is a real limitation and is
        # recorded here rather than in a comment nobody reads.

        turns = _events_of_type(view, "turn_started")
        assert len(turns) > 1, f"only {len(turns)} turn(s) played — the bots did not hand over"


class TestItOnlyMovesForBots:
    def test_an_all_human_game_produces_no_bot_moves(self, client: TestClient) -> None:
        # The regression that would be worst: the driver playing a human's turn for them. A game with
        # no bots must come back exactly as it did before MON-304.
        response = client.post("/games", json=new_game_payload(seats=[seat("Ruti"), seat("Dan")]))
        game_id = response.json()["state"]["game_id"]
        view = _refetch(client, game_id)
        assert view["events"] == []
        assert _current(view) == 0

        game_id = view["state"]["game_id"]
        rolled = client.post(f"/games/{game_id}/commands", json={"command": {"kind": "roll_dice", "player": 0}}).json()
        # Still the human's turn: nothing advanced past them.
        assert _current(rolled) == 0

    def test_a_bot_never_acts_for_a_human_seat(self, client: TestClient) -> None:
        """No command in a bot-driven game is ever attributed to the human.

        The driver picks seats by `player.kind.bot_level`, and this is the assertion that it does. A
        driver that looped over `legal_commands` without filtering by seat would happily play the
        human's turn, and every other test in this file would still pass.
        """
        created = client.post("/games", json=new_game_payload(seats=[seat("Ruti"), _bot("Robo")])).json()
        game_id = created["state"]["game_id"]

        # Hand over, then read *only* what happened afterwards. Refetching from zero would include the
        # human's own purchases, which is what the first version of this assertion tripped over — the
        # events were seat 0's, and correctly so, because the human bought those squares.
        handover = _play_human_turn(client, game_id, player=0)
        cursor = handover["event_cursor"]
        after = client.get(f"/games/{game_id}?since={cursor}")
        assert after.status_code == 200, after.json()
        view = after.json()

        # Everything from here belongs to the bot's turn. Seat 0 may still *receive* money — rent, a
        # GO salary — but nothing in this window may be seat 0 *spending*, because that would mean the
        # driver played the human's seat.
        cash_events = [event for event in _events_of_type(view, "cash_changed") if event.get("player") == 0]
        for event in cash_events:
            # A human seat can legitimately receive money during a bot's turn — rent it is owed. What it
            # must never do is *pay* for something the bot chose, so the sign is what matters.
            assert event["delta"] > 0, f"seat 0 spent money during the bot's turn: {event}"


class TestUnknownLevelsDoNotBreakAGame:
    def test_a_level_this_server_has_no_bot_for_leaves_the_seat_waiting(self, client: TestClient) -> None:
        """`hard` is seatable on the wire before MON-603 exists.

        `BotLevel` accepts all three, so a client can seat a level this server cannot drive. The
        honest outcome is a seat that waits — not a crash, and not a game silently played by the wrong
        bot. This said `normal` until MON-602 landed; when MON-603 lands there is no level left to
        assert on and the test goes with it, which is the intended end state rather than a gap.
        """
        response = client.post("/games", json=new_game_payload(seats=[_bot("Brainy", level="hard"), seat("Ruti")]))
        assert response.status_code == 201
        view = response.json()

        # Nothing was driven, so the game is still waiting on seat 0 — and it is still a valid game.
        view = _refetch(client, view["state"]["game_id"])
        assert _current(view) == 0
        assert view["events"] == []
        assert view["legal_commands"], "the seat should still have legal moves, just nobody to play them"

    def test_a_normal_bot_seat_is_driven(self, client: TestClient) -> None:
        """The flip side, and the reminder that MON-602 landed.

        `normal` was in `BotLevel` and absent from the driver's table for two milestones, so a seat
        asking for it waited forever. Same claim as the easy bot's opening-turn test, made against the
        level that used to be the one nothing spoke for.
        """
        response = client.post("/games", json=new_game_payload(seats=[_bot("Brainy", level="normal"), seat("Ruti")]))
        assert response.status_code == 201
        view = _refetch(client, response.json()["state"]["game_id"])
        assert _current(view) == 1, "the normal bot never took its opening turn"
        assert view["events"], "the normal bot's opening turn produced no events at all"


def _split_groups(*, seat_one_level: BotLevel | None = None) -> GameState:
    """A board where one swap un-splits two colour groups, with a normal bot in seat 0.

    The position ADR-009 exists for: seat 0 holds all of light blue but one and seat 1 holds that one,
    and the reverse for pink. Neither can build, and the normal bot's answer is to propose the swap.
    """
    players = (
        PlayerState(id=0, name="Brainy", kind=PlayerKind(bot_level=BotLevel.NORMAL), token="token.0", cash=1500),
        PlayerState(id=1, name="Ruti", kind=PlayerKind(bot_level=seat_one_level), token="token.1", cash=1500),
    )
    base = minimal_state(players=players)
    ours = [tile.index for tile in base.board.tiles if tile.group is base.board.tile(6).group]
    theirs = [tile.index for tile in base.board.tiles if tile.group is base.board.tile(11).group]
    owners: dict[int, PlayerId] = dict.fromkeys(ours[:-1], 0) | {ours[-1]: 1}
    owners |= dict.fromkeys(theirs[:-1], 1) | {theirs[-1]: 0}
    properties = tuple(
        PropertyState(owner=owners[index]) if index in owners else prop for index, prop in enumerate(base.properties)
    )
    return GameState(**{**dict(base), "properties": properties})


def _offer_from(proposer: PlayerId) -> TradeOffer:
    return TradeOffer(proposer=proposer, recipient=1 - proposer, give=TradeSide(), receive=TradeSide())


class TestOneTradeProposalPerSeatPerTurn:
    """ADR-009's driver guard, which is the loop a bot proposing trades brings with it.

    A bot is a pure function of the position and a declined offer puts the position back to essentially
    what it was, so an unguarded driver would re-offer the identical swap forever — and against a human
    seat that is a Decline button that summons the same trade straight back. `tournament.py` enforces
    the same rule for the contest.
    """

    async def test_a_bot_seat_opens_the_swap(self) -> None:
        # The premise for everything below: this position really does provoke an offer.
        steps = [step async for step in drive(_split_groups(), think_seconds=0, max_steps=1)]
        assert [step.command.kind for step in steps] == ["propose_trade"]

    async def test_a_seat_that_has_already_proposed_is_not_asked_again(self) -> None:
        steps = [
            step async for step in drive(_split_groups(), think_seconds=0, max_steps=1, traded_seats=frozenset({0}))
        ]
        assert steps, "the seat should still move, just not with another offer"
        assert steps[0].command.kind != "propose_trade"

    async def test_only_one_offer_survives_a_multi_step_call(self) -> None:
        """Two bots, so the offer is answered inside the same `drive` call and control comes back.

        This is the branch that carries the permission forward within one call — `_advance_bots` drives
        one step at a time, but nothing about the driver may depend on that.
        """
        steps = [
            step async for step in drive(_split_groups(seat_one_level=BotLevel.EASY), think_seconds=0, max_steps=12)
        ]
        first_turn = [step for step in steps if step.state.turn_number == steps[0].state.turn_number]
        proposals = [step for step in first_turn if step.command.kind == "propose_trade"]
        assert len(proposals) == 1, [step.command.kind for step in first_turn]

    async def test_the_permission_refills_when_the_turn_advances(self) -> None:
        """A call long enough to cross a turn boundary must not carry the ban across it.

        Seeded with seat 0's permission already spent, so the only way an offer appears at all is the
        reset — which is also why the step budget is generous: the turn has to actually move.
        """
        steps = [
            step
            async for step in drive(
                _split_groups(seat_one_level=BotLevel.EASY),
                think_seconds=0,
                max_steps=60,
                traded_seats=frozenset({0}),
            )
        ]
        assert len({step.state.turn_number for step in steps}) > 1, "the call never reached a second turn"
        proposals = [(step.state.turn_number, step.player) for step in steps if step.command.kind == "propose_trade"]
        assert proposals, "no offer was made after the turn advanced, so the reset is unproven"
        assert len(proposals) == len(set(proposals)), f"a seat proposed twice in one turn: {proposals}"

    def test_the_log_is_what_remembers_across_requests(self) -> None:
        """Why the fact is read off the log rather than kept in the driver.

        A proposal to a human ends the `drive` call: the next one happens in the *next HTTP request*,
        after the human has answered, so a driver-local memory would have reset by then and the offer
        would come straight back. The log has not forgotten, and this is the case that matters — a
        proposal and a decline with no `TurnStarted` between them.
        """
        log: list[Event] = [
            TurnStarted(player=0, turn_number=4),
            TradeProposed(offer=_offer_from(0)),
            TradeDeclined(offer=_offer_from(0)),
        ]
        assert seats_that_proposed_this_turn(log) == frozenset({0})

    def test_a_new_turn_refills_the_permission(self) -> None:
        log: list[Event] = [
            TradeProposed(offer=_offer_from(0)),
            TurnStarted(player=1, turn_number=5),
        ]
        assert seats_that_proposed_this_turn(log) == frozenset()

    def test_an_empty_log_has_spent_nothing(self) -> None:
        assert seats_that_proposed_this_turn([]) == frozenset()

    def test_each_seat_has_its_own_permission(self) -> None:
        # Trading is legal off-turn, so two seats can both have proposed inside one turn. Collapsing
        # them to a single "somebody proposed" flag would silence the second bot for no reason.
        log: list[Event] = [
            TurnStarted(player=0, turn_number=9),
            TradeProposed(offer=_offer_from(0)),
            TradeProposed(offer=_offer_from(1)),
        ]
        assert seats_that_proposed_this_turn(log) == frozenset({0, 1})


class TestOverlappingAdvanceCalls:
    """Two queued `_advance_bots` tasks for one game must not double-apply a move (MON-806).

    Every request that can change a game queues `_advance_bots` as a background task, so two
    requests in quick succession give the same game two drivers. Each driver's loop re-reads the
    session and applies **one** step per iteration — so between one driver's read and its write,
    the other driver reads the *same* position, computes the *same* move, and `store.update`
    appends the same events twice. Found by a screen-capture rig over pure HTTP: 14 repeated
    event signatures in a 62-event log, including two identical `property_acquired` for one tile.

    The `await` on the thinking delay inside `drive` is what lets the interleave happen
    deterministically here — each driver yields the loop exactly where the race lives, between
    read and write. That is also why this test runs with a 1 ms think delay rather than the
    suite's usual zero: `drive` skips the `await` entirely at zero, and a coroutine that never
    yields cannot race. Production always has a positive delay (0.6 s), so the test's shape is
    the honest one.
    """

    @staticmethod
    def _bot_opening(game_id: str) -> GameState:
        # Seat 0 is an easy bot about to take the opening turn; seat 1 is a human, so the drive
        # has a natural stopping point and the run is bounded.
        return minimal_state(
            game_id=game_id,
            players=(
                PlayerState(id=0, name="Bot", kind=PlayerKind(bot_level=BotLevel.EASY), token="token.0", cash=1500),
                PlayerState(id=1, name="Human", kind=PlayerKind(), token="token.1", cash=1500),
            ),
        )

    async def test_two_overlapping_calls_apply_each_move_once(self) -> None:
        config = Settings(bot_think_seconds=0.001)
        raced = SessionStore(max_sessions=8, ttl_seconds=SESSION_TTL_SECONDS)
        raced.create(self._bot_opening("raced"))
        baseline = SessionStore(max_sessions=8, ttl_seconds=SESSION_TTL_SECONDS)
        baseline.create(self._bot_opening("baseline"))

        await asyncio.gather(
            _advance_bots(raced, "raced", config),
            _advance_bots(raced, "raced", config),
        )
        await _advance_bots(baseline, "baseline", config)

        # Same seed, same bot, zero think time: the raced game must record exactly the moves the
        # single-driver game records — nothing repeated, nothing lost. Comparing whole events is
        # deliberate; a looser "no adjacent duplicates" check would miss an interleave that
        # replays a stretch of turn rather than one move.
        raced_events = [entry.event for entry in raced.get("raced").log]
        baseline_events = [entry.event for entry in baseline.get("baseline").log]
        assert raced_events == baseline_events

    async def test_a_call_for_a_deleted_game_is_a_quiet_no_op(self) -> None:
        # DELETE /games/{id} can land between a command's response and its queued advance task
        # running. The task finding nothing is not an error; before MON-806 it raised.
        config = Settings(bot_think_seconds=0)
        store = SessionStore(max_sessions=8, ttl_seconds=SESSION_TTL_SECONDS)
        store.create(self._bot_opening("gone"))
        store.delete("gone")
        await _advance_bots(store, "gone", config)
