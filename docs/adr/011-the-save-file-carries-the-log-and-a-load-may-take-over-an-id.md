# ADR-011 — The save file carries the log, and a load may take over an id

- **Status**: Accepted
- **Date**: 2026-08-03
- **Deciders**: Guy Flenner
- **Amends**: ADR-008 §2 (the shape of `GET /games/{id}/save`), `kesef_server.sessions`,
  `POST /games/load` in both transports, `packages/web/src/game/` and `packages/web/src/local/`
- **Does not amend**: the engine — no rule, no state field, no `SCHEMA_VERSION` bump

## Context

Two findings from the post-sign-off sweep, filed as `docs/A11Y_AUDIT.md` **D1** and as the event-log
advisory in the 2026-08-03 checkpoint. They look unrelated and share one cause: **a save file is a
`GameState` and a session is more than a `GameState`.**

### D1 — save then load in one sitting is refused

Leaving a game in the UI does not end it on the server, so the session is still there holding that
save's `game_id`, and re-uploading the file the player just downloaded gets
`409 error.game_already_exists`. The only way through was a server that had forgotten the game.
`e2e/persistence.spec.ts` pinned that refusal in both languages and said, where it asserted it, that
the fix was a product decision.

It was three defensible answers — a load *replaces* the live session, a load *mints a new id* and the
file becomes a template, or the player is *asked* — with different consequences for the URL, for a
second tab, and for what "the same game" means. The audit did not pick one, because choosing inside
an accessibility audit would have been the audit deciding a rule.

### The event log did not survive a reload, or a load

ADR-010 restores the published build's session from `localStorage` by replaying MON-704's own
`GET /games/{id}/save` → `POST /games/load`. The board, the money, the deeds and the turn come back
exactly. *"What's happened"* starts empty, and so does the replay viewer's history.

The cause is one line of the session model: `Session.log` is not in `GameState`. `useGame` already
asks for `?since=0` on its first fetch, so **the client never needed changing** — it replays
whatever log the session has. A restored session's log was empty because the save had no log in it.

## Decision

### 1. The save file is an envelope: the state, plus the events that produced it

```jsonc
{
  "state":  { /* GameState, byte for byte what it was before */ },
  "events": [ /* engine Events, oldest first */ ]
}
```

`GET /games/{id}/save` returns this. `POST /games/load` accepts it — **and still accepts a bare
`GameState`**, which is every file saved before today: a document with no top-level `state` key is
read as the state itself with no events. `GameState` has no field called `state`, so the test is
unambiguous rather than a heuristic.

**The envelope carries bare `Event`s, not `LoggedEvent`s.** `seq` is assigned by the store and
nowhere else (`sessions.py` module docstring); a save that carried session-assigned numbers would be
asking the next session to honour them. The store stamps a restored log `1..N` exactly as it stamps a
live one.

**No second version field.** Whether a save loads is already decided by `state.schema_version`, and
the log is validated by the same models the live log is built from — an event shape this build does
not know refuses the whole file as `error.save_schema_mismatch`, which is the answer a stale save
already got. A `save_version` beside `schema_version` would be a second axis to keep in step, and the
first one to go stale.

### 2. A load whose id is live asks the player

`POST /games/load?if_exists=refuse|replace|copy`, defaulting to **`refuse`** — so the contract's
unchanged answer for an unchanged request is the same 409 it was yesterday, and the policy is a
*request* field rather than something inferred from the body.

| `if_exists` | What the store does | What the player chose |
|---|---|---|
| `refuse` (default) | `409 error.game_already_exists` | nothing yet — this is the first attempt |
| `replace` | the live session under that id is dropped and the file takes its place | "Replace the game in progress" |
| `copy` | a freshly minted id, the live game untouched | "Load as a separate game" |

The UI asks **only after the refusal**, because the refusal is the only moment the question exists:
`LoadSavedGame` keeps the parsed file, renders the two choices under the keyed error it already
rendered, and re-posts with the answer. Cancelling leaves the picker, which was already the retry.

`copy` rewrites only `state.game_id`, to a minted `game-<hex>` — the same spelling
`POST /games` mints, now in one place (`transport.minted_game_id`) instead of the three literals that
had accumulated. It is not derived from the file's id, because `GAME_ID_PATTERN` bounds both the
character set and the length and a derived id can fail either.

### 3. `SessionStore.update` takes the session, not the id

`replace` drops a live `Session` and puts a new one under its id. A bot driver that read the old
session before the replace and writes after it would otherwise append the old game's move to the new
game's log: `advance_bots_once` reads with `store.get(id)`, awaits a thinking delay, and wrote with
`store.update(id, …)`, which re-resolved the *id*. `Session.advance_lock` cannot help, because the
replacement carries a different lock.

So `update` now takes the `Session` the caller read. A write to a session that has since been
detached lands on an object nothing can reach and is collected — which is the correct outcome, and
three call sites is the whole cost.

## Consequences

### What a player gets

Saving and loading in one sitting works, in both languages, and the game that comes back has its
history: *"What's happened"* is populated and the replay slider covers the whole game rather than
starting at the reload. The published build gets both for free through ADR-010's snapshot, which
stores whatever `save_game` returned.

### What this deliberately does not do

- **A live WebSocket watcher of a replaced game stops receiving events.** Its session is detached, so
  nothing fills its mailbox; the socket stays open until the client closes it. This is exactly what
  `DELETE /games/{id}` has always done to a watcher, so `replace` inherits a known limitation rather
  than inventing one — and the published build has no cross-tab socket at all, because each tab is
  its own server.

  **Examined on 2026-08-04 and deliberately accepted, not merely deferred.** The obvious fix — a close
  code meaning "your view is no longer this game", so the watcher reconnects — is *worse than the
  limitation on its own*, and the reason is the cursor. A reconnecting client re-opens with its own
  high-water mark (`queue.cursor`), and `Session.events_since` returns only entries **above** it. A
  replaced session's log restarts at `seq 1`, so a watcher sitting at 12 reconnects and receives
  silence: the same quiet socket, with a reconnect loop in front of it. Doing it properly means the
  close reason must *reset* the client's cursor, which means clearing the animation queue's high-water
  and its log — a protocol change plus a change to the queue's public surface.

  That machinery is what ADR-006 says waits for networked play, and it belongs there: a second tab
  watching a hotseat game is a development affordance, not a product feature. **Revisit trigger:
  MON-901.** Until then the honest position is a stated limitation rather than a half-built resync.
- **After a `copy`, the game that was left is no longer the one `localStorage` insures** in the
  published build: the next mutation snapshots the copy. Both games are live in the tab; only one has
  reload insurance.
- **The save is bigger, and the log is what grows.** Measured on a four-seat game, seed 7: the state
  stays at 4.4 KB and the envelope goes from 4.8 KB at turn 1 to 16.0 KB at turn 12 — about 0.9 KB a
  turn, or 3.4 % of the 512 KB `max_save_bytes` ceiling by turn 13. A game long enough to exceed that
  ceiling answers `error.save_too_large` on the way back in, which is the existing guard rather than a
  new failure. The table is in MON-715 in `docs/BACKLOG.md`, and it says which figures were *not*
  re-measured: ADR-010's 2 ms artifact snapshot is one of them.

### What the artifact taught us: JS `null` is not Python `None`

Every unit test, both transports' parity suite and the whole dev-server e2e suite were green while the
**published build had lost its reload insurance**. Pyodide stopped translating JS `null` to Python
`None` — since 0.28 it arrives as a distinct `JsNull` — so `bridge.loadGame(payload, null)` handed the
facade an object for which `raw is None` is false. `_if_exists` read that as a *typo* and answered
`422 error.malformed_request`; `restoreGame` treated the refusal as "the engine refused this save",
dropped the slot, and a reload was back to *"this game no longer exists"* — the exact bug ADR-010 was
written to fix.

Three things follow, and all three are in the diff:

1. **An absent optional argument is omitted, never passed as `null`** (`local/engine.ts`). That is the
   only spelling of "not given" both languages agree on. The same hazard was already latent on
   `?since=`, where the value is `URLSearchParams.get`'s own `null`, and it is fixed in the same place.
2. **The insurance says when it cannot do its job.** Both halves of the snapshot/restore pair swallow
   every failure by design — a working game must not stop working because it could not be written down
   — and that silence is what let this reach the artifact. They now `console.warn` the cause, and the
   Pages spec asserts no such warning appeared. `warn`, not `error`, so a diagnostic can never fail a
   page that is fine.
3. **`bridgeTo` has its own test** (`local/engine.test.ts`), asserting *arity*. Every other test in the
   package drives a fake bridge, so the mapping between the bridge and the facade was the one seam
   nothing exercised — the same shape of gap MON-713's own entry describes.

### Security

Two things were checked, and one of them was a defect in this change's own first draft.

- **`if_exists=replace` grants no authority that did not already exist.** It ends a live game from an
  unauthenticated request — and so does `DELETE /games/{game_id}`, which has been there since MON-301.
  Replace is `DELETE` + `load` in one call, against a store that is process-local to one hotseat
  screen. It belongs on the same list as every other route when MON-901 makes the API a *network*
  API rather than a transport for one tab, and it does not widen today's exposure.

- **A save must not be able to raise `RecursionError`.** The first draft of `SaveFile.from_json` read
  `json.loads(raw)` in order to branch on whether a `state` key was present, which is the plainest way
  to write it and hands the route a 500: Python's JSON parser recurses per nesting level, so 3000
  nested brackets — six kilobytes, well inside `max_save_bytes` — escaped the handler's
  `except (ValidationError, ValueError, EngineError)` as a traceback. That is the same shape of defect
  the MON-100 review found in this very route when a `BoardDataError` escaped the same clause.
  pydantic-core parses without Python recursion and reports its depth limit as an ordinary
  `ValidationError`. Both transports are pinned by a test at 3000 levels.

- **The log is validated, not trusted.** A restored log is parsed against the same `Event` union the
  live log is built from, so a file cannot inject a shape the narration or the animation queue would
  then be handed. An unknown event type refuses the whole file as `error.save_schema_mismatch`.

### Why not the two answers we did not take

- **Silent `replace`** is one store method and no UI, and it is the behaviour of every "open a file"
  in the world. It also ends a game in progress with no warning when the file is older than the table,
  and the audience includes six-year-olds pressing things. A prompt is one extra press for the case
  the player meant and the only defence for the case they did not.
- **Always minting a new id** never destroys anything, and makes "continue this game" quietly produce
  a *different* game — a new URL, a save file whose id no longer names it, and a session per attempt
  against `max_sessions`. It is the right answer to "use this as a template" and the wrong one to the
  question the player was asking.
