# M6 kickoff — bots and Kids Mode

**Written**: 2026-07-29, at the end of the session that merged PR #17.
**Read with**: `docs/BACKLOG.md` E6, `CLAUDE.md`, and the two files named in §2.

`main` is at the PR #17 merge: **946 Python tests, 679 web tests, 20 Playwright specs**, all gates
green. M0–M5 are complete and a full game plays in a browser in both languages, human vs human, with
mid-game language switching and self-hosted Hebrew type.

---

## 1. The one decision blocking progress

**MON-602 is written and does not pass its own gate.** Measured over the stated 100 games:

> 69/100 wins (needed 60), 0 draws, **12 capped** (max 5), turns min/median/max 22/114/501

It beats the easy bot comfortably and **cannot finish 12 games**. That is not a tuning problem, and
two attempts to tune it out failed (building past three houses: 69→72 wins, 16→13 capped;
opponent-aware group valuation: no change to capping). Dumping a capped position shows the cause:

```
seed 9, turn 501:  normal owns 12, easy owns 16, houses = 0 for BOTH
every colour group split:  brown [0,1]  light_blue [1,0,1]  pink [1,0,1]  red [1,0,0] ...
```

Every colour group is split, so **neither side can ever build**. Rents stay at their printed value,
both bots bank GO salaries faster than they lose rent, and the game is undecidable.

**The only thing that un-splits a group is a trade, and no bot can propose one.** `Bot.choose`
promises to return a command from the `legal` tuple, and `ProposeTrade` is never enumerated in
`legal_commands` — ADR-005's documented exception, because the offer space is unbounded. So trades
are structurally unreachable to every bot, and MON-602's own fourth criterion ("sane trade
evaluation") is implemented only as *responding*.

Three options, written up in the MON-602 backlog entry:

1. **Amend the `Bot` protocol** so a bot may return a constructed `ProposeTrade` even though it is
   not enumerated, with `apply` validating it as it validates everything else. Fixes the actual
   problem; touches a documented contract, so it wants an ADR note. **Recommended.**
2. Run the contest with more than two seats. Cheap, but it changes the stated contest after seeing
   results — the G-62 trap.
3. Raise `MAX_CAPPED`. Honest only if the reasoning is recorded; the threshold was fixed in advance
   precisely so it would not move to fit a result.

**Do not pick one silently.** Ask the owner, then implement.

## 2. Read these two files before touching a bot

* `packages/engine/src/kesef_engine/bots/easy.py` — its docstring records two defects that only
  appeared when two bots played each other, and both are traps a new bot can fall into: a
  `state.rng.fork()` whose randomness collapses when the dice have not moved, and a bot that undoes
  its own moves (build/sell while solvent, mortgage/unmortgage in debt).
* `packages/engine/tests/tournament.py` — the contest rules, and why every seed is played from both
  seats.

Also worth knowing: `GameState.seat_to_act` answers "which seat is the game blocked on". Use it. The
first bot driver asked "which seat has a legal command" instead, and because mortgaging is legal
off-turn, one bot mortgaged and unmortgaged its own property for 200 moves while the other never
took a turn.

## 3. What is done that you might not expect

* **MON-304 is done and bots stream.** A bot's moves are driven in a FastAPI background task, so a
  human's command returns immediately and the bot's turn arrives over the WebSocket, spaced by
  `bot_think_seconds` (0.6 s, zeroed in tests). An earlier version awaited the bot inside the
  request; seating a bot turned game creation into a 3-second wait.
* **`normal` and `hard` are seatable but only `easy` is driven.** `kesef_server/bots.py` treats an
  unimplemented level as "no bot drives this seat", so the game waits rather than crashing. There is
  a test asserting that, and it should flip when MON-602 lands.
* **MON-416 and MON-422 are done** (every rent explains itself; the trade panel can show a pending
  offer with accept/decline in the panel).

## 4. Remaining work, in dependency order

| Item | Note |
|---|---|
| **MON-602** | Blocked on §1. The harness and bot exist; 26 unit tests cover the bot's opinions. |
| MON-603 | Hard bot: heuristics + Monte-Carlo rollouts. Deterministic per-move budget asserted on counters — wall-clock is a reported metric, never a pass/fail. Runs under a `slow` marker, not the PR gate. |
| MON-604 | Kids Mode in the UI: auction and mortgage affordances **absent, not disabled**. |
| MON-605 | Hints: ranks legal commands, explains rent from `rent.note.*`. Holds no rule knowledge. |
| E7 (MON-701..708) | Eight polish items. MON-707 is partly done — `playwright.config.ts` and `e2e/` exist with 20 specs. |
| E8 | Release. |
| **MON-506** | **Blocked on the owner**: 31 Hebrew card texts. Hebrew games show English cards by design. |
| E4b leftovers | MON-413/414/415/417/418/419/420/421 — quality gaps, none breaking. MON-418 is the most user-visible ("at least two players" surfaces as a generic malformed-request error). |

## 5. Process notes that cost time this session

* **Run every CI step locally before pushing.** Two failures came from steps I had skipped:
  `npm run format:check` (distinct from lint) and **`pytest --cov`** (a 90% floor — a new module with
  no tests sinks it). The full local gate is:

  ```bash
  uv run ruff check . && uv run ruff format --check . && uv run mypy
  uv run pytest --cov --cov-report=term-missing
  uv run pytest packages/server/tests -q --cov=kesef_server --cov-fail-under=95
  uv run pip-audit
  cd packages/web && npm run typecheck && npm run lint && npm run format:check \
    && npm run test -- --run && npm run build && npx playwright test
  ```

* **A route docstring change is an API contract change.** FastAPI publishes docstrings as the OpenAPI
  `description`, which flows into the committed `packages/web/src/api/generated.ts`. Two CI failures
  came from this. Regenerate with the version CI pins:

  ```bash
  uv run python -m kesef_server.openapi > openapi.json
  npx --yes openapi-typescript@7.13.0 openapi.json -o packages/web/src/api/generated.ts
  ```

* **Check what a PR actually merged.** PR #16 merged an older commit than the branch tip, so a fix
  the owner needed silently never reached `main`. `git merge-base --is-ancestor <sha> origin/main`
  answers it.

* **Measure before tuning.** Every bot defect this session was found by running two bots against each
  other and dumping the position, not by reading the code. Three fixes were "obvious" and wrong.

## 6. Manual testing

```bash
uv run uvicorn kesef_server.api:app --reload   # :8000
cd packages/web && npm run dev                 # :5173
```

Opens in Hebrew; English is one click away in the picker on both screens. Human vs human is complete.
Human vs **easy** bot works and is worth watching for the 0.6 s pacing. Seating `normal` or `hard`
leaves that seat waiting, by design.

If something looks broken, **restart uvicorn first** — a stale server against a fresh frontend was
the leading suspect for a "clicked and nothing happened" report this session, and it was never
reproduced with matching versions.
