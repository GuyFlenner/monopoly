# ADR-010 — The local build persists its own session

- **Status**: Accepted
- **Date**: 2026-08-03
- **Deciders**: Guy Flenner
- **Amends**: `packages/web/src/local/` only
- **Does not amend**: the engine, the server, the API contract, or anything above `src/local/`

## Context

The published game runs the engine in the browser (MON-805, ADR-001's split preserved). Sessions
live in `kesef_server.sessions`, which in that build is Python objects inside the tab's Pyodide
heap. Reload the tab and the heap is new.

Measured on the built artifact, `vite preview`, real Pyodide, in the configuration
`.github/workflows/deploy-pages.yml` publishes:

| Build | Reload with `?game=…` in the URL | What the player sees |
|---|---|---|
| Server (`uvicorn`) | rehydrates | the board, the log, the turn |
| **Local (Pages, the one that is deployed)** | **does not** | *"משהו השתבש — המשחק הזה לא קיים יותר. נסו שוב"* |

So the configuration nobody develops against rehydrates, and the configuration every player uses
loses the game. It is not a crash and there is nothing in the console: the session store answers a
truthful 404 for a game it has never heard of, the client renders that refusal correctly, and the
game is gone.

This is worse than it sounds for the audience this project is built for. A tablet reloads a
backgrounded tab on its own. A six-year-old presses things. The game that is lost is a family's
evening, and the only existing remedy — *Save the game to a file* — has to have been used
**before** the reload by somebody who anticipated it.

The Pages smoke did not catch it because it asserts the game id reaches the URL and then says, in a
comment, that this "is what makes a reload rehydrate rather than abandon". It never reloaded. That
sentence was true of the server build the author had in mind and false of the artifact under test.

## Decision

**In the local build only, the transport keeps the current game in `localStorage` and restores it
when the engine is asked for a game it does not have.**

Two rules, both inside `src/local/`:

1. After any request that may have changed a game — the three points `localFetch` already reports
   through `onMutation`, plus the end of the bot pump — take `GET /games/{id}/save` and write it to
   `localStorage`.
2. When `GET /games/{id}` answers 404 and storage holds a save for *that id*, `POST /games/load` it
   and answer the original request from the restored session.

## Why here and not somewhere more obvious

**Not in the engine.** Persistence is I/O, and the engine has none by construction (CLAUDE.md rule
3). A `GameState` is already serializable precisely so that somebody *else* can store it.

**Not in the server package.** `sessions.py` is shared by both builds. Teaching it about
`localStorage` would put a browser API in the process that runs under uvicorn.

**Not in the app layer.** `GameProvider` and `useGame` are deliberately unable to tell which build
they are in — that property is what let MON-805 ship without touching the UI. A reload-recovery
branch there would exist in the server build too, where it is wrong: uvicorn owns those sessions and
a second copy in the tab is a second source of truth.

**In `src/local/`** the fix is invisible to everything above it, applies exactly where the problem
is, and reuses machinery that already exists and is already tested: the save/load routes from
MON-704, and the `onMutation` seam that was put in for the bot pump.

## What it deliberately does not do

- **It does not restore the event log.** The save file is a `GameState`; the log belongs to the
  session, and `POST /games/load` starts a fresh one. After a reload the board, the money, the
  deeds and whose turn it is are all exactly right, and *"What's happened"* starts from the reload.
  Restoring it would mean putting the log in the save file — a contract change, in the API both
  builds share, for a panel that is a history rather than a state. Recorded as a limitation, and
  visible to the player as an empty log rather than a wrong one.
- **It does not become an autosave feature.** One game is kept — the one in play. A save browser is
  MON-704's file, which is explicit, portable and already there.
- **It does not touch the server build.** The wiring lives in `localApiClient`, which is the only
  thing that constructs this transport and which the server build never calls — `main.tsx` branches
  on `isLocalEngineBuild()` long before either client is built. The server build's transport is what
  it was, and `createLocalFetch` without an `onMissingGame` behaves exactly as it did, which is what
  every pre-existing test of that file asserts.

## Consequences

- A reload, a crashed tab, a backgrounded tablet and an accidental navigation all continue the game.
- One extra `saveGame` call into the interpreter per mutation. Measured against the built artifact
  under real Pyodide: **2 ms median** (min 2, max 19 over twelve runs) for a **4.2 KB** payload, next
  to the ~900 ms an easy bot's turn already takes. It is fired and not awaited, so it is off the path
  of the player's own move either way.
- A storage failure — private mode, a full quota — must never break a game that is working. The
  writes are best-effort and swallowed, the same discipline `board/motion.ts` and `sound/mute.ts`
  already use for preferences.
- `localStorage` is per-origin, so two tabs on the published site share one slot. The second tab to
  move wins the slot, and neither game breaks while both tabs stay open. Two simultaneous games in
  two tabs is not a use case this project has (hotseat is one screen, ADR-006); the alternative is
  keying by game id and growing without bound.
