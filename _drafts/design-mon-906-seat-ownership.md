# Design: MON-906 — Seat ownership: a connection speaks for a seat

**Status**: design for review — no implementation in this PR
**Tier**: 3 (authority model over the ADR-005 contract; expensive to get subtly wrong)
**ADRs invoked**: ADR-002, ADR-005, ADR-006, ADR-008, ADR-011 · **proposes ADR-012**
**Provenance**: `_drafts/audit-llm-judge-2026-08-07.md` Findings 1/2/16; `docs/DEPLOYMENT.md` §6.8;
`docs/UX_ACTION_PROMINENCE.md` §7.4; ADR-011 §Security ("belongs on the same list … when MON-901
makes the API a network API" — MON-901 has happened).

---

## What changes

- **Files (server)**: `sessions.py` (a `SeatAuthority` beside the log), `transport.py` (the
  speaker model + enforcement, view filtering), `api.py` (claim/release routes, `Authorization`
  reads, protected routes), `schemas.py` (`GameCreated`, `SeatClaimed`, `SeatClaimView`),
  `browser.py` (same surface, same enforcement), `config.py` (`seat_authority` rollout flag),
  `errors.py` (three new keyed refusals).
- **Files (web)**: `api/client.ts` (secret storage + `Authorization` header), `game/` (claim flow,
  403 rendering), a minimal seat-picker on the join path (MON-728's screen), catalogues
  (`error.seat_not_yours`, `error.seat_taken`, `error.host_only` — en + he).
- **New endpoints**: `POST /games/{id}/seats/{player}/claim`, `DELETE /games/{id}/seats/{player}/claim`
  (host-only unstick). **Changed**: `POST /games` responds `GameCreated`; `GET .../save`, `DELETE
  /games/{id}`, `POST /games/load?if_exists=replace` become host-only; `GameView` gains `claims`.
- **Engine**: **untouched**. Not one line.
- **Contract**: `openapi.json` + `generated.ts` regenerate in the implementing commit (CI drift job).

## Why

The published site now starts and joins real online games (MON-727/728) against a public API, and
nothing knows which seat a connection speaks for: two windows on one `?game=` link can each act for
either player, any joiner can read `/save` (the RNG and full deck order — a cheat channel), and any
stranger with the id can `DELETE` the game or `replace` it via load. All three were deliberately
parked by ADR-011 §Security pending MON-901; the trigger fired.

## Design options & trade-offs

#### Option A — Capability secrets held by the transport (Session-level)
- **What**: creating a game mints a `host_secret`; claiming a seat mints a `seat_secret` for that
  `PlayerId`. Secrets live on the `Session` (process memory, beside the log and the advance lock),
  never in `GameState`, never in a save file, never in a `GameView`. Requests carry the secret in
  an `Authorization: Bearer` header; the transport resolves it to a **speaker** — Host, Seat(p),
  or Spectator — and enforces before the engine is consulted.
- **Pro**: identity stays out of the engine and out of every serialized artifact, so ADR-002's
  purity and ADR-011's save-file shape are untouched; the enforcement point is the same
  `transport.py` both transports already share, so hotseat and browser builds cannot drift.
- **Con**: authority does not survive an API restart (a Session is process-local) — a redeploy
  forgets who owned what. Acceptable: the *game* does not survive a restart either (DEPLOYMENT.md
  §6.2's open measurement question), and MON-907's cursor-reset work is where restart semantics
  get decided.
- **Cost**: ~6 server files, 3 web seams, 2 new routes, one flag; no migration of stored data
  (there is none).

#### Option B — Ownership recorded in the engine state (`PlayerState` carries a credential)
- **What**: `new_game` stamps a per-seat credential into `GameState`; `apply` refuses commands
  whose credential mismatches.
- **Pro**: survives restarts for free (a save carries it) and both transports enforce it with
  zero transport code.
- **Con**: breaks the project's deepest boundary twice over — "who may speak" is not a game rule
  (rule 1 is about *legality*, and `legal_commands` would now depend on the caller, poisoning
  ADR-005's soundness property and every golden), and the secret would be serialized into exactly
  the artifacts (`/save`, save files on disk, event logs) it must never appear in. Redacting it
  back out of `SaveFile` re-creates Option A's transport layer anyway, with the engine dirtied
  for nothing.
- **Cost**: engine + schema + goldens churn, ADR-002/ADR-005 amendments, and a redaction layer.

#### Option C — Accounts / cookie sessions
- **What**: a sign-in, server-side sessions, cookies.
- **Pro**: the industry-standard shape; enables kick/ban/rejoin-by-identity.
- **Con**: `PROJECT_BRIEF.md` puts accounts explicitly out of scope; cookies force
  `allow_credentials=True` CORS onto a Pages-hosted static origin; and the product's join model
  *is* "the link is the invitation" — an account adds friction for six-year-olds and buys nothing
  a capability secret doesn't.
- **Cost**: largest by far; product-scope change needing the owner, not a backlog item.

**Chosen**: **Option A** — the Con that tipped it is B's: a caller-dependent `legal_commands`
would quietly destroy the ADR-005 property suite, which is the project's most load-bearing
guarantee. A restart-forgetting authority matches a restart-forgetting store.

**Accepted trade-offs (all material)**: (1) authority is lost on API restart — bounded by the
store's own volatility, revisited with DEPLOYMENT §6.2's measurement; (2) a leaked link + a
claimed-late seat allows seat-squatting by a stranger until the host releases it — bounded by
64-hex-char unguessable game ids and the host-only release route; (3) spectators are anonymous
and unlimited (within `max_subscribers_per_game`) — events remain public by design, since all
hidden information already lives only in `/save`, which this design closes.

**Naming note**: `token` is taken — `SeatConfig.token` is the pawn identity (one of the six token
identities, MON-412). The credential is a **secret** everywhere: `host_secret`, `seat_secret`.
Confusing the two in code review is a real hazard; the name difference is deliberate.

## The model

```mermaid
sequenceDiagram
    participant H as Host browser
    participant G as Guest browser
    participant T as transport.py (both transports)
    participant E as engine (untouched)
    H->>T: POST /games
    T-->>H: GameCreated{host_secret, view}
    H->>G: share ?game=<id>  (the link is the invitation)
    G->>T: POST /games/{id}/seats/1/claim
    T-->>G: SeatClaimed{seat_secret, view(speaker=Seat 1)}
    G->>T: POST commands {RollDice player=1} + Bearer seat_secret
    T->>T: speaker_for(secret) → Seat(1); require player==1 ✓
    T->>E: is_legal / apply (engine law, unchanged)
    G->>T: POST commands {BuildHouse player=0} + Bearer seat_secret
    T-->>G: 403 error.seat_not_yours {player: 0}  (never reaches the engine)
    H->>T: POST commands {... player=0 or any unclaimed human seat} + Bearer host_secret
    T->>E: ✓ (host speaks for every unclaimed human seat — hotseat unchanged)
```

**Speaker resolution** (the whole model in five lines):

| Secret presented | Speaks for |
|---|---|
| the session's `host_secret` | every **unclaimed human** seat (hotseat unchanged) + host-only routes |
| a `seat_secret` for player *p* | exactly seat *p* |
| none / unknown | **Spectator** — full board/state view, empty `legal_commands`, no mutations |

- Bot seats are never claimable and never host-actable — the server drives them (MON-304), and
  `seatedCommands.ts` already drops their estate moves client-side; the server now refuses them too.
- Claiming: any holder of the game id may claim any unclaimed **human** seat (first come, first
  served). Claiming a claimed seat → `409 error.seat_taken {player}`. The host may release a claim
  (`DELETE .../claim`, host-only) to unstick a lost secret; release voids the old secret.
- The **local/Pyodide transport mints an authority too** and hands the host secret straight to its
  own client — one code path, zero behavioural difference, and `test_browser_parity.py` keeps both
  transports honest.
- `GET /games/{id}` (the view): `legal_commands` filtered to the speaker's seats. `claims` is added
  so the join screen can render who's taken: `[{player, claimed}]` — never the secrets.
- WS event stream: unchanged, spectator-readable. Events are public information by ADR-008's
  self-containment rule; everything hidden already lives only in `/save`.

## Constraints

- **Must not break**: engine purity (no engine diff at all); ADR-005 property suite untouched;
  hotseat UX byte-identical (local transport + one-screen online host); `test_browser_parity.py`
  extended, not weakened; ADR-011 save-file shape (no secret in a save).
- **Must satisfy**: a guest can never act for a seat it did not claim (the audit's headline
  repro: two contexts on one link, cross-seat move refused); `/save`, `DELETE`, `replace`
  host-only; all refusals keyed in both catalogues.
- **Security requirements**: secrets minted with `secrets.token_hex(16)` (128 bits); compared
  with `secrets.compare_digest`; never logged (log.py's untrusted-input discipline — the
  `Authorization` header joins ids on the never-interpolate list); never in a URL (header only —
  URLs land in logs and browser history); never in `GameView`, `SaveFile`, or any event.
- **CORS coordination**: `allow_headers` must include `Authorization` — lands with or after
  MON-909's narrowing, not against it.
- **Rollout flag**: `Settings.seat_authority: "off" | "enforce"` (default `off` at merge,
  flipped in `render.yaml` once the client that sends secrets is deployed — see Rollout).

## Method signatures (Developer)

```python
# sessions.py
@dataclass
class SeatAuthority:
    host_secret: str
    seat_secrets: dict[int, str] = field(default_factory=dict)  # PlayerId -> secret; claimed only

def mint_authority() -> SeatAuthority: ...          # secrets.token_hex(16) per credential

# transport.py — the single enforcement point, shared by api.py and browser.py
class Speaker:  # discriminated union: Host | Seat(player: int) | Spectator
    ...
def speaker_for(held: Session, secret: str | None) -> Speaker: ...   # compare_digest inside
def require_seat(held: Session, secret: str | None, player: int) -> None: ...  # 403 error.seat_not_yours
def require_host(held: Session, secret: str | None) -> None: ...               # 403 error.host_only
def claim_seat(held: Session, player: int) -> str: ...   # 409 error.seat_taken; refuses bot seats
def release_seat(held: Session, player: int) -> None: ...  # host precondition checked by caller
def view(held: Session, events: tuple[LoggedEvent, ...] = (), *, speaker: Speaker) -> GameView: ...
```

```python
# schemas.py
class SeatClaimView(BaseModel):
    player: int
    claimed: bool                      # never the secret

class GameCreated(BaseModel):
    host_secret: str                   # returned once, at creation, nowhere else
    view: GameView

class SeatClaimed(BaseModel):
    seat_secret: str
    view: GameView
# GameView gains: claims: tuple[SeatClaimView, ...]
```

```typescript
// api/client.ts — secrets ride an injectable store, mirroring ADR-010's localStorage pattern
export interface SecretStore {                       // localStorage-backed: kesef.secret.<gameId>
  get(gameId: string): string | undefined;
  set(gameId: string, secret: string): void;
}
// ApiClient sends `Authorization: Bearer <secret>` on every /games/{id} request when present.
claimSeat(gameId: string, player: number): Promise<GameView>;  // stores the returned secret
```

## Test strategy

- **Unit (server)** — `test_seat_authority.py`: claim happy path; double-claim 409 with key;
  bot-seat claim refused; wrong-seat command 403 `error.seat_not_yours` **before** the engine is
  consulted (assert no event appended); host acts for unclaimed seats; seat secret refused on
  host-only routes; spectator gets the view with empty `legal_commands` and is refused mutations;
  release voids the old secret; flag `off` reproduces today's behaviour bit-for-bit.
- **Leak tests** (security-relevant paths, flag for `/security-researcher`): the serialized
  `GameView`, the `SaveFile` body, every logged line (caplog scan), and every event JSON contain
  no secret substring; secrets compared via `compare_digest` (assert by call, not by timing).
- **Parity** — `test_browser_parity.py`: every new interaction through both transports; the
  browser transport's host client holds its own secret invisibly.
- **Web** — client stores/sends the secret; a 403 renders its keyed sentence in both locales;
  the join screen renders `claims` and claiming stores the secret.
- **e2e** — `online.spec.ts`: **two contexts, one link; guest claims seat 1; guest attempting a
  seat-0 move is refused and the board shows no change; host still plays every unclaimed seat.**
  This assertion is the item's definition of done — today it fails (the move succeeds).
- **Edge cases**: claim after the seat's player went bankrupt (allowed — dossiers stay public,
  the engine offers nothing anyway); two simultaneous claims for one seat (the store is
  single-threaded per event loop; first write wins, second gets 409); host secret lost (no
  recovery in v1 — recorded limitation, same class as a lost save file); `validate` route scoped
  like `commands` so the TradeBuilder's live validation matches what sending would do.
- **Performance**: no target — one dict lookup and a constant-time compare per request.

## Test skeletons (Tier 3)

```python
async def test_a_guest_cannot_act_for_a_seat_it_did_not_claim(client) -> None:
    """AC: cross-seat command is refused with a key, and the engine never sees it."""
    created = (await client.post("/games", json=TWO_HUMANS)).json()
    claim = (await client.post(f"/games/{gid(created)}/seats/1/claim")).json()
    response = await client.post(
        f"/games/{gid(created)}/commands",
        json={"command": {"kind": "roll_dice", "player": 0}},
        headers={"Authorization": f"Bearer {claim['seat_secret']}"},
    )
    assert response.status_code == 403
    assert response.json()["reason_key"] == "error.seat_not_yours"  # FAILS until require_seat exists
    assert (await client.get(f"/games/{gid(created)}")).json()["event_cursor"] == created["view"]["event_cursor"]

async def test_the_host_still_plays_every_unclaimed_seat(client) -> None:
    """AC: hotseat unchanged — the creator speaks for all unclaimed human seats."""
    created = (await client.post("/games", json=TWO_HUMANS)).json()
    ok = await client.post(
        f"/games/{gid(created)}/commands",
        json={"command": {"kind": "roll_dice", "player": 0}},
        headers={"Authorization": f"Bearer {created['host_secret']}"},
    )
    assert ok.status_code == 200  # FAILS until speaker_for maps host -> unclaimed seats

async def test_a_save_is_host_only_and_carries_no_secret(client) -> None:
    """AC: the RNG/deck cheat channel is closed, and the credential never serializes."""
    created = (await client.post("/games", json=TWO_HUMANS)).json()
    assert (await client.get(f"/games/{gid(created)}/save")).status_code == 403  # FAILS until require_host
    saved = await client.get(
        f"/games/{gid(created)}/save", headers={"Authorization": f"Bearer {created['host_secret']}"}
    )
    assert created["host_secret"] not in saved.text  # FAILS if authority ever enters the save
```

```typescript
test("a guest cannot move the host's piece (two contexts, one link)", async ({ browser }) => {
  // AC (audit headline): today this move SUCCEEDS; done means it is refused and narrated.
  const host = await browser.newContext();          // creates game, holds host secret
  const guest = await browser.newContext();         // follows ?game=, claims seat 1
  // ... claim seat 1 in guest, then attempt seat 0's offered action from the guest context
  await expect(guestSeatZeroAction).toBeHidden();   // FAILS until the view filters by speaker
});
```

## Migration / rollout

1. **PR 1 (client-compatible)**: server mints authority and *accepts* secrets but `seat_authority`
   defaults `off` (enforcement skipped); client learns to store/send secrets and render the new
   403s; contract regenerated. Old cached clients keep working.
2. **PR 2 (flip)**: `render.yaml` sets `KESEF_SEAT_AUTHORITY=enforce` once the Pages deploy that
   sends secrets is live. One env var, instantly revertible.
3. No stored data migrates — sessions are process-local and die with the deploy.
4. ADR-012 (this PR) records the decision; ADR-011's parked list points here.

## Open questions for the owner (HITL — do not implement past them silently)

1. **Spectator link = claim link?** This design says yes (one link, claim-first-come). If the
   owner wants "watch" and "join" to be different invitations, the claim route grows a second
   secret and the share screen a second button — a UX decision, not an engineering one.
2. **Should a lost host secret be recoverable?** v1 says no (same as a lost save). If that bites,
   the recovery is a product feature, not a patch.

## Out of scope here

MON-905 (rate limiting) and MON-907 (cursor reset) are siblings, not parts — they compose with
this design but neither depends on its shapes. The seat-picker's visual design follows the join
screen MON-728 built and is the implementing PR's concern.
