# kesef-server

FastAPI + WebSocket transport over `kesef-engine`.

```bash
uv run uvicorn kesef_server.api:app --reload
# → http://127.0.0.1:8000/docs
```

## What it owns

Sessions, serialization, and event fan-out. **It owns no rules.** If a conditional here
starts to look like a rule (`if player.cash < rent`), it belongs in the engine.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | liveness |
| `GET` | `/boards` | boards for the new-game screen |
| `GET` | `/rulesets` | both rulesets, expanded, so the UI can show what Kids Mode changes |
| `POST` | `/games` | start a game, returns the opening `GameView` |
| `GET` | `/games/{id}` | current `GameView` — the poll and reconnect path |
| `POST` | `/games/{id}/commands` | apply one command; the only way a game changes |
| `DELETE` | `/games/{id}` | discard a game |
| `WS` | `/games/{id}/ws` | event stream for animation (MON-303) |

A `GameView` bundles the state, **the legal commands**, and the events that produced it.
Shipping the legal commands is what keeps the UI rules-free: it renders the buttons it is
handed rather than re-deriving them and drifting out of step with the engine.

Routes that return **501** already have their request and response schemas fixed. That is
deliberate — the frontend generates its TypeScript from this app's OpenAPI document, so the
contract can be agreed and the UI built while the engine is still being implemented.

## Contract generation

```bash
uv run python -m kesef_server.openapi > openapi.json     # MON-302
npx openapi-typescript openapi.json -o packages/web/src/api/generated.ts
```

`generated.ts` is gitignored and regenerated in CI, so a field renamed in Python becomes a
TypeScript compile error rather than an `undefined` at runtime.
