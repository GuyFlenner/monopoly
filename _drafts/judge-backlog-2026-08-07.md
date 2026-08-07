# Judge backlog — 2026-08-07

Gap items from the LLM-judge audit (`_drafts/audit-llm-judge-2026-08-07.md`). Same conventions
as `docs/BACKLOG.md`: **Tier** is the model that should own the item, picked by how expensive
it would be to get subtly wrong; **Size** S ≈ under an hour · M ≈ a focused session · L ≈ break
it down. The standard gate applies to every item (`ruff check` + `ruff format --check` + `mypy`
+ `pytest`; web items add `typecheck` + `lint` + `test -- --run`). Every item names how to
**verify** it — an item whose fix cannot be watched failing is not done.

Numbering: MON-729…749 continue the feature series; MON-905…912 extend the E9 online series
(the server agent's numbering, kept). Finding numbers reference the audit doc.

---

## J1 — Online-play hardening (do first: the product now advertises this path)

### MON-906 — Seat ownership: a connection speaks for a seat · **L · Fable** · Finding 1/16
The one genuinely open design question, already named in `DEPLOYMENT.md` §6.8 and
`UX_ACTION_PROMINENCE.md` §7.4. Closes with it: `/save` becomes host-only (it leaks RNG + deck
order to any joiner today), and `DELETE` / `if_exists=replace` authority (parked by ADR-011
§Security pending MON-901, which has fired).
- **AC**: a joiner is offered only its own seat's commands; a command for another seat is
  refused with a key; `/save` and `DELETE` require the host credential; hotseat (one screen,
  many seats) is unchanged.
- **Verify**: two browser contexts on one `?game=` link; attempting a move for the other seat
  fails — today it succeeds. `e2e/online.spec.ts` gains exactly that assertion.

### MON-905 — Rate limit + per-client cap on mutating routes · **M · Opus** · Finding 1
Zero-dependency per-IP token bucket middleware (`{ip: deque[timestamp]}` swept like
`_evict_idle`) on `POST /games`, `POST /games/load`, `DELETE /games/{id}`; new
`Settings.max_sessions_per_client` and `Settings.requests_per_minute` in `config.py`'s
docstring-with-a-reason style. Refusal: `429 {reason_key: "error.too_many_requests",
params: {retry_after}}` in both catalogues.
- **Verify**: a test posts `max_sessions_per_client + 1` games from one client and asserts the
  last is refused *before* the global cap; a second client is unaffected.
  `test_browser_parity.py::test_the_browser_transport_imports_no_web_framework` stays green.
  Loop-`curl` the live service; `/health` still answers.

### MON-907 — Close the ADR-011 cursor-reset gap · **S · Opus** · Finding 2
`WS_CURSOR_RESET = 4409` close code when a socket's session is detached; on it, the client
calls the already-existing (and currently caller-less) `EventQueue.reset()` and reconnects at
`since=0`. Amend ADR-011: the revisit trigger fired.
- **Verify**: server test — subscribe, `store.replace`, assert close 4409. Client test —
  `queue.reset()` ran and the next open carried `since=0`. Remove the `reset()` call and
  confirm the test goes red. e2e: replace-mid-watch leaves the watcher current, not silent.

### MON-908 — WebSocket close keys in both catalogues · **S · Sonnet** · Finding 2
Five keys (`error.game_not_found`, `error.too_many_watchers`, `error.watcher_too_slow`,
`error.malformed_request`, + MON-907's) in `en`+`he`; `GameScreen.tsx:590-594` renders the
specific refusal instead of collapsing five causes into `status.offline`. Closes the note at
`eventSocket.ts:28-33`. Hebrew strings join the standing owner-read queue.
- **Verify**: each close code renders its own sentence in both locales; `locale.spec.ts`
  covers one.

### MON-909 — Delete `GET /games`; narrow CORS · **S · Sonnet** · Findings 4, 16
No UI caller exists; the route enumerates every live game id + player names on a public API.
`allow_methods=["GET","POST","DELETE","OPTIONS"]`, `allow_headers=["Content-Type"]`.
- **Verify**: `curl <api>/games` → 404; preflight reports exactly the four verbs, asserted in
  `test_api.py`; `openapi.json` + `generated.ts` regenerated same commit so the contract job
  stays green.

## J2 — Test-strength follow-through

### MON-729 — Boundary approval-twin sweep · **S · Opus** · Finding 3
The sweep `docs/BACKLOG.md:1248-1251` asked for. Six approving twins at exact equality:
BuyProperty at exactly the price, PayJailFine at exactly the fine, PlaceBid at exactly
`max_bid`, PlaceBid at exactly the bidder's balance, a trade offering exactly the party's
balance, BuildHouse with exactly one house in the bank.
- **Verify**: hand-mutate each operator (`<`→`<=`, `>`→`>=`, `< 1`→`< 2`) and watch the named
  test go red — record mutation + red test in the item, the MON-722 way. Next nightly kill
  rate must not fall.

### MON-730 — Make the sound-wiring test assert the wiring · **S · Sonnet** · Finding 9
`App.test.tsx:673`: assert a cue was *requested* for the socket's `dice_rolled` (the
`AudioPort` seam exists), not `not.toThrow()`.
- **Verify**: delete the `useSoundCues` call from `GameScreen`; test goes red.

### MON-731 — Web coverage measurement + floor · **S · Sonnet** · Finding 8
`@vitest/coverage-v8`; `test.coverage.thresholds` in `vite.config.ts` at measured-total minus
one point of slack (the `fail_under = 90` reasoning); CI unit-test step runs `--coverage`.
- **Verify**: `npm run test -- --run --coverage` reports a TOTAL and fails when the threshold
  is raised above it.

### MON-732 — Mutation scope includes `reducer.py` · **M · Fable** · Finding 15
The phase machine and interrupt stack are the design's self-declared hardest parts and sit
outside the only test-strength gate. `mutate_only_covered_lines=true` already bounds cost.
- **Verify**: one dispatched nightly completes inside `timeout-minutes` with wall-clock
  recorded; ≥80% still passes; new survivors dispositioned one at a time per the MON-722
  precedent — no threshold moves.

### MON-734 — Stale-test hygiene triple · **S · Sonnet** · Finding 16
(a) Replace `test_reducer_rent.py:179-185`'s fixed-seed conditional `pytest.skip` with an
assertion; (b) correct `board.css.test.ts:14-18` to cite `e2e/rtl.spec.ts:169`; (c) assert
every `ENGLISH_ONLY_CATALOGUES` entry genuinely lacks its `he` file (set is empty today —
the guard prevents a translated catalogue lingering in the allowlist).
- **Verify**: `uv run pytest -rs` shows zero unexplained skips; both suites green.

### MON-910 — Pages/Pyodide artifact gate on the PR path · **S · Sonnet** · Finding 11
PR-triggered build-only job (wheels + manifest + `npm run test:e2e:pages`, no deploy steps)
behind a path filter on `packages/web/src/local/**`, wheels, `browser.py`.
- **Verify**: a PR breaking the real-base-path boot is red before merge; a docs-only PR does
  not trigger the job.

## J3 — Engine hygiene

### MON-735 — Duplicate pawn token becomes a keyed refusal · **S · Sonnet** · Finding 12.1
`InvalidSeatingError("error.duplicate_tokens", token=…)` beside the name check; key in both
catalogues.
- **Verify**: factory test asserts the reason key; server test asserts `POST /games` answers
  it (not `error.invalid_new_game`); `tests/test_key_contract.py` green.

### MON-736 — Bots read the ruleset, not constants · **S · Opus** · Finding 12.2
`bots/normal.py:433` reads `state.ruleset.jail_fine`; sweep bot modules for other bare
literals shadowing `Ruleset` fields.
- **Verify**: two states differing only in `jail_fine` (50 vs 400), cash between them → the
  bot's choice differs; reverting the fix turns it red. `pytest -m slow` win rates unchanged.

### MON-737 — `_estimated_rent` delegates to `rules.rent.quote` · **M · Opus** · Finding 12.3
`bots/hard.py:305-337` keeps only the average-dice stand-in for the amountless utility quote.
- **Verify**: property test — `_estimated_rent(state, i) == (quote.amount or multiplier ×
  average)` for every ownable tile over ≥3 golden mid-game states; `pytest -m slow` win rate
  within noise.

### MON-738 — One writer for "card returns to the bottom of its own deck" · **S · Sonnet** · Finding 12.4
`GameState.with_deck(...)` / `deck_bottom(...)` beside the existing read accessor; route
`jail.py:138`, `insolvency.py:547`, `cards.py:157` through it.
- **Verify**: `grep -rn "chance_deck\|community_chest_deck" packages/engine/src` matches only
  `state.py` + `factory.py`; goldens unchanged (the real proof the refactor preserves
  behaviour).

### MON-739 — Guard that a `reason_key` is shaped like a key · **S · Fable** · Finding 14
Test asserting every literal reaching `_no(...)` / `IllegalCommandError` /
`InvalidSeatingError` matches `^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$`; amend ADR-003 §7: the
exemption is enforced both directions (keys resolve; non-keys are refused). Fable because it
defines what rule 2 *mechanically means*.
- **Verify**: change any `_no("error.x")` to `_no("It is not your turn")` — new test red;
  today the suite stays green.

### MON-740 — Docstring/export hygiene sweep · **S · Sonnet** · Finding 16
`endgame.py:22` + `test_reducer_endgame.py:6` name `close_command`; `__init__.py` exports
`apply`, `legal_commands`, `GameState`, `Command`, `Event` and cites the ADR-003 §7 carve-out;
`DECK_OF_TILE` becomes `Final`.
- **Verify**: `grep -rn "resolve_after_command" .` empty; a test resolves every name in the
  `__init__` docstring example off the package root; gate green.

### MON-741 — Decide the mutable-dict wire fields · **M · Fable** · Finding 16
`RentQuote.note_params` / `LegalityResult.params` are the only mutable-typed fields on frozen
models, and they cross the wire — a recorded decision: immutable pair-tuples vs documented
residual mutability. ADR-008-adjacent wire-shape call.
- **Verify**: whichever is chosen, `test_key_contract.py` green; if the shape changes, the CI
  contract job and web `tsc --noEmit` both pass.

### MON-742 — Split `bots/hard.py` (782 ln, four concerns) · **M · Opus** · Finding 16
`bots/valuation.py` (estimate helpers, shared with normal) + `bots/search.py` (Budget, meter,
fingerprint, rollouts) + `hard.py` (policy only); no module over ~400 lines.
- **Verify**: behaviour-preserving — `test_bot_hard.py`, `mypy`, and `pytest -m slow` win
  rates move not at all.

## J4 — Web / UX

### MON-743 — Muted-ink tokens: composite alpha into the contrast gate · **M · Fable** · Finding 5
Named solid tokens (`--color-ink-muted`, `--color-on-table-muted`, …) replace `opacity-*` on
non-disabled text (`DiceTray.tsx:212,225`, `SetupScreen.tsx:673,816,888`,
`AuctionPanel.tsx:383`, `border-current/30` edges); each measured ≥ 4.5:1 (text) / 3:1
(non-text) in `contrast.test.ts` against its named surface, both themes.
- **Verify**: gate extended to the new tokens; a grep-test (the `logical-css.test.ts`
  pattern) refuses new `opacity-[1-8][05]` on text outside `disabled:`; visual check both
  themes.

### MON-744 — Money formatting on rent readout + auction figures · **S · Sonnet** · Finding 6
`SquareRent` amount and `AuctionPanel` current bid/increments through `useMoney()`.
- **Verify**: unit tests assert `$10` / `10 ₪` per locale; `auction.spec.ts` text assertions
  updated; grep shows no bare money figure rendered from a projection.

### MON-745 — Sanction or remove the LocalEngineGate live region · **S · Sonnet** · Finding 7
Either a never-co-mount test + documented exception in `Announcer.tsx`, or narrate through
`useOptionalAnnounce`.
- **Verify**: a test asserts `[aria-live]` count is 0 in the gate's subtree once
  `phase === "ready"`; `App.test.tsx:645` still passes.

### MON-746 — Fold arbitrary `oklch(…)` literals into measured surfaces · **M · Opus** · Finding 5
Setup CTA (`SetupScreen.tsx:628`) and the repeated dark card override into
`@theme`/`surfaces.ts`, drift-checked and contrast-measured like the rest.
- **Verify**: `grep "oklch(" src/**/*.tsx` clean of classNames; `surfaces.test.ts` +
  `contrast.test.ts` cover the new entries; screens visually unchanged.

### MON-747 — Split `GameScreen` / `SetupScreen` into siblings · **M · Opus** · Finding 16
Extract `SquareRent`/`TurnSummary`/chrome from `GameScreen` (1,001 ln); seat-row editor and
ruleset diff list from `SetupScreen` (973 ln). Rationale comments travel with their code.
- **Verify**: no behaviour change — unit + e2e green, each extracted file ≤300 non-comment
  lines.

### MON-748 — Retire `TODO(MON-412)` in SetupScreen · **S · Sonnet** · Finding 16
`SetupScreen.tsx:62` — the repo's only in-code TODO; adopt the six shipped token identities
from `@/theme/tokens` at that use site.
- **Verify**: grep `TODO(` in `packages/` returns nothing; setup seat rows render the same
  identities the board/dossier use.

## J5 — Process / CI / docs

### MON-749 — Status-sync documentation pass · **S · Sonnet** · Finding 10
One commit: E1–E4 items get their ✅ + PR numbers; MON-901 row rewritten as in-flight with
what shipped and what remains (seat ownership, restart question); MON-903 marked
superseded-by-MON-805 (the MON-803 treatment); MON-724's "left open" tail points at MON-725;
ADR-007/008 flipped to Accepted with delivery dates; spec §8 MON-503 risk row closed;
`DEPLOYMENT.md` §2 multi-device row points at §6.7.
- **Verify**: grep BACKLOG.md for unmarked E1–E4 ids returns none; no doc contradicts another
  on the items listed; a fresh "open items" count off BACKLOG.md matches this document + E9.

### MON-911 — Dependabot + `npm audit` + bundle-size floor · **S · Sonnet** · Finding 16
`.github/dependabot.yml` (pip, npm, github-actions; grouped weekly); `npm audit
--audit-level=high` in the web job; nightly `dist/` size assertion against `DEPLOYMENT.md`'s
~450 kB figure.
- **Verify**: Dependabot opens a grouped PR; a deliberate 200 kB import turns the size job
  red.

### MON-912 — Make `settings.json` actually mirror the hook · **S · Sonnet** · Finding 13
Add the five hook-only patterns to `permissions.deny` (filter-branch/filter-repo, clean
-fdx, repo-visibility, release-delete, rm -rf), or amend `.claude/CLAUDE.md` to say the hook
is authoritative. Adding is better — belt-and-braces was the stated intent.
- **Verify**: `git clean -fdx` is refused twice (hook + permission); the CLAUDE.md claim is
  true as written.

---

## Delegation plan (per the CLAUDE.md tiering: Fable plans/reviews, Opus implements, Sonnet fills)

| Tier | Items | Character |
|---|---|---|
| **Fable** (design/contract) | MON-906, MON-732, MON-739, MON-741, MON-743 (token design; a Sonnet can apply) | authority models, gate semantics, wire shapes |
| **Opus** (logic) | MON-905, MON-907, MON-729, MON-736, MON-737, MON-742, MON-746, MON-747 | rule-adjacent or behaviour-preserving-under-measurement |
| **Sonnet** (mechanical) | MON-908, MON-909, MON-730, MON-731, MON-734, MON-910, MON-735, MON-738, MON-740, MON-744, MON-745, MON-748, MON-749, MON-911, MON-912 | catalogues, config, docs, single-seam tests |

Suggested batching for delegation: J5's Sonnet items (MON-749, 911, 912) are risk-free
starters; J2 (MON-729/730/731/734) is one coherent "test-strength" PR series; J1 must be
sequenced MON-906 (design) → 905/907 → 908/909.

## Open owner decisions (not backlog items — need the owner, not a model)

1. **Hebrew copy reads**: MON-725's four strings, MON-728's five, MON-908's five-to-be, and
   the standing MON-506 native-speaker read. Wording only — arithmetic is test-gated.
2. **Should an online game survive an API restart?** `DEPLOYMENT.md` §6.2 says answer with a
   measurement of how often it bites; MON-907's telemetry (4409 counts) can supply it.
3. **MON-902 (third board)**: the pattern is proven; wants a verified source per the MON-503
   standing rule before anything is scheduled.
4. **MON-904 (tournament mode)**: `tournament.py` already exists as machinery; open as a
   product question, not an engineering one.
