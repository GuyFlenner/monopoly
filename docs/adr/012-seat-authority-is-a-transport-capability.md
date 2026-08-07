# ADR-012 — Seat authority is a transport capability, not an engine rule

- **Status**: Proposed (awaiting owner review — this is an authority model over who may speak
  for a seat, which is an owner decision; the design is `_drafts/design-mon-906-seat-ownership.md`)
- **Date**: 2026-08-07
- **Deciders**: Guy Flenner
- **Amends**: the unauthenticated surface of `POST /games/{id}/commands`, `GET /games/{id}/save`,
  `DELETE /games/{id}` and `POST /games/load?if_exists=replace`; the `POST /games` response shape.
- **Does not amend**: ADR-002 (the engine stays identity-free), ADR-005 (`legal_commands` is
  still a pure function of the state — the *projection* filters, the engine does not),
  ADR-011's save-file shape (no credential ever serializes).

## Context

ADR-006 scoped v1 to one screen, and every route was deliberately unauthenticated: the store was
"process-local to one hotseat screen", and ADR-011 §Security explicitly parked the authority
question — `if_exists=replace` "belongs on the same list as every other route when MON-901 makes
the API a *network* API rather than a transport for one tab."

MON-901 happened. The API is live on Render, the published site follows shared `?game=` links to
it (MON-727), and the setup screen sends games there for people elsewhere (MON-728). The
2026-08-07 audit measured the consequence: two browser contexts on one link can each act for
either seat; any joiner can read `/save` — the RNG counter and the full deck order, i.e. every
future roll and card — and any stranger holding an id can `DELETE` the game or `replace` it.

Nothing in the game's *rules* can express this, because it is not a rule of the game. "May this
player build here" is engine law; "is this connection allowed to speak as this player" is
identity, and the engine has none — no clock, no I/O, no caller.

## Decision

Authority is a **capability secret held by the transport**, resolved per request to a *speaker*:

- `POST /games` mints a `host_secret`, returned once in a new `GameCreated` envelope.
- `POST /games/{id}/seats/{player}/claim` mints a `seat_secret` for one unclaimed human seat;
  first come, first served; the host can release a claim. Bot seats are never claimable.
- A request's `Authorization: Bearer` secret resolves to **Host** (speaks for every unclaimed
  human seat — hotseat unchanged), **Seat(p)** (exactly seat *p*), or **Spectator** (full view,
  empty `legal_commands`, no mutations). Enforcement lives in `transport.py`, shared by the HTTP
  and Pyodide transports, so the two cannot drift; the local build mints an authority and hands
  its own client the host secret, making the hotseat path the same code path.
- `/save`, `DELETE`, and `replace` require the host secret. The engine is not touched.
- Secrets: `secrets.token_hex(16)`, compared with `compare_digest`, never logged, never in a
  URL, never in `GameView`, a `SaveFile`, or an event.
- Rollout behind `Settings.seat_authority` (`off` at merge; flipped in `render.yaml` once the
  secret-sending client is deployed), so an old cached client never meets an enforcing API.

## Rationale

The alternative that looks simpler — stamping a credential into `GameState` so `apply` enforces
it — was rejected because it breaks the two guarantees this repo is built on. `legal_commands`
would become caller-dependent, which quietly invalidates the ADR-005 property suite (soundness
and completeness are stated over the state alone), and the credential would serialize into
exactly the artifacts it must never appear in: the save file, the `/save` response, the golden
games. Redacting it back out would re-create the transport layer anyway, with the engine dirtied
for nothing. Accounts/cookies were rejected as a product-scope change (`PROJECT_BRIEF.md` puts
accounts out of scope) that buys nothing over a capability for a link-invited family game.

The name is **secret**, not token — `SeatConfig.token` is already the pawn identity (MON-412's
six token identities), and an authority credential that shares its name is a review hazard.

## Consequences

- The audit's headline repro fails closed: a guest claiming seat 1 cannot act for seat 0, and
  the refusal is a keyed 403 (`error.seat_not_yours`) the UI can narrate in both languages.
- The RNG/deck cheat channel closes (`/save` host-only); stranger-`DELETE`/`replace` closes.
- Hotseat is byte-identical: one screen, one host secret, every human seat playable.
- Authority dies with the process, like the session store it lives in. A redeploy forgets who
  owned what — the same volatility the game itself has today; DEPLOYMENT §6.2's restart
  measurement decides whether either is worth persisting.
- A lost host secret is unrecoverable in v1, same class as a lost save file.
- `GameView` gains a `claims` projection (`[{player, claimed}]` — never the secrets) so a join
  screen can show who's taken; the contract regenerates.
- Two UX questions stay with the owner (design doc §Open questions): whether watch and join
  should be *different* invitations, and whether host-secret recovery is ever a feature.

## Alternatives considered

1. **Engine-held credentials** — rejected above; breaks ADR-002/ADR-005 and leaks into saves.
2. **Accounts / cookie sessions** — product-scope change, CORS-credentialed complexity on a
   static Pages origin, friction the audience doesn't want; rejected.
3. **Do nothing / rely on unguessable ids** — the id is *shared by design* (the link is the
   invitation), so id secrecy cannot distinguish the two people it was shared with; and
   `GET /games` (until MON-909 removes it) enumerates ids anyway. Rejected.
