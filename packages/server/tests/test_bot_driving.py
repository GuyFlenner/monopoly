"""The server advancing bot seats (MON-304).

The claim this file has to establish is small and easy to get wrong: **a game seated with a computer
progresses without a client speaking for it.** Everything else is a consequence.

Before MON-304 the only thing that ever changed a game was a client posting a command, so a bot seat
was a seat the game waited on forever. The interesting failures are therefore not "the bot chose
badly" — that is MON-601's business — but "the game stopped", "the bot moved when it should not
have", and "the bot's moves did not reach anybody".
"""

from __future__ import annotations

from conftest import new_game_payload, seat
from fastapi.testclient import TestClient


def _bot(name: str, level: str = "easy") -> dict[str, object]:
    return seat(name, is_bot=True, bot_level=level)


def _current(view: dict[str, object]) -> int:
    state = view["state"]
    assert isinstance(state, dict)
    return int(state["current_player_id"])


def _kinds(view: dict[str, object]) -> list[str]:
    """The event types in a view.

    Events arrive in the `{seq, event}` envelope the transport adds (G-34) — `seq` is a fact about
    this session's log and the engine, which has no session, must not invent one. So the type is one
    level in.
    """
    entries = view["events"]
    assert isinstance(entries, list)
    return [entry["event"]["type"] for entry in entries]


def _events_of_type(view: dict[str, object], event_type: str) -> list[dict[str, object]]:
    entries = view["events"]
    assert isinstance(entries, list)
    return [entry["event"] for entry in entries if entry["event"]["type"] == event_type]


def _play_human_turn(client: TestClient, game_id: str, player: int) -> dict[str, object]:
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
    view: dict[str, object] = client.get(f"/games/{game_id}").json()
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


def _seat_of(view: dict[str, object], player_id: int) -> dict[str, object]:
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
        view = response.json()

        # The bot has played, so the table is now waiting on the human.
        assert _current(view) == 1
        assert _seat_of(view, 0)["is_bot"] is True
        # And its moves are in the response, so a client that never opened a socket still saw them.
        assert view["events"], "the bot's opening turn produced no events in the creation response"

    def test_ending_a_human_turn_hands_over_and_comes_back(self, client: TestClient) -> None:
        """The round trip a hotseat game is made of."""
        created = client.post("/games", json=new_game_payload(seats=[seat("Ruti"), _bot("Robo")])).json()
        game_id = created["state"]["game_id"]
        assert _current(created) == 0, "a human in seat one should be asked first"

        view = _play_human_turn(client, game_id, player=0)

        # The human handed over; the bot took its turn inside that last request and handed back.
        assert _current(view) == 0, "the game should be back with the human, not parked on the bot"
        kinds = _kinds(view)
        assert "turn_started" in kinds, f"the bot's turn is not in the response: {kinds}"

    def test_two_bots_play_each_other_without_any_client_command(self, client: TestClient) -> None:
        """The strongest form of the claim: nobody speaks for either seat.

        With every seat a bot, the *creation* request has to carry the game as far as the bots can
        take it. If the driver only woke one bot per call, this game would stop after one turn and
        there would be no human command to restart it — so this is the test that a bot handing over to
        another bot keeps going.
        """
        response = client.post("/games", json=new_game_payload(seats=[_bot("A"), _bot("B")]))
        assert response.status_code == 201
        view = response.json()

        # An all-bot game has no human to hand back to, so this call runs to `bot_max_steps_per_call`
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
        view = response.json()
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

        # Hand over and let the bot run.
        view = _play_human_turn(client, game_id, player=0)

        # Every event the bot's turn produced belongs to seat 1 or to nobody in particular. Seat 0's
        # only appearances would have to come from a command the human posted, and the last one was
        # `end_turn`.
        cash_events = [event for event in _events_of_type(view, "cash_changed") if event.get("player") == 0]
        for event in cash_events:
            # A human seat can legitimately *receive* money during a bot's turn — rent, for instance.
            # What it must never do is pay for something the bot chose, so the reason is what matters.
            assert event.get("reason") in {"rent", "go_salary", "free_parking_pot", None}, event


class TestUnknownLevelsDoNotBreakAGame:
    def test_a_level_this_server_has_no_bot_for_leaves_the_seat_waiting(self, client: TestClient) -> None:
        """`normal` and `hard` are seatable on the wire before MON-602/603 exist.

        `BotLevel` accepts all three, so a client can seat a level this server cannot drive. The
        honest outcome is a seat that waits — not a crash, and not a game silently played by the wrong
        bot. When MON-602 lands, this test's expectation flips and that is the reminder to update it.
        """
        response = client.post("/games", json=new_game_payload(seats=[_bot("Brainy", level="normal"), seat("Ruti")]))
        assert response.status_code == 201
        view = response.json()

        # Nothing was driven, so the game is still waiting on seat 0 — and it is still a valid game.
        assert _current(view) == 0
        assert view["events"] == []
        assert view["legal_commands"], "the seat should still have legal moves, just nobody to play them"
