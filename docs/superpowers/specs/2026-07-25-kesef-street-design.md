# Kesef Street — Design Specification

- **Date**: 2026-07-25
- **Author**: Guy Flenner (with Claude Opus 5)
- **Status**: Approved · M0 implemented
- **Supersedes**: nothing

---

## 1. What we are building

A bilingual (English / Hebrew) property-trading board game for **2–6 players**, playing by
the **classic universal rules**, with an optional **Kids Mode**. Any seat can be a person or
a bot, so human-vs-human, human-vs-machine and six-humans all fall out of one mechanism.
Everyone plays on one screen, taking turns, the way a family plays at a table.

Two audiences, and they overlap more than they conflict: children who cannot yet read the
street names, and an adult who wants a game that plays correctly and looks good.

It is also, deliberately, a codebase worth reading. The rules are modelled the way a
non-trivial system should be modelled, and the reasons are written down.

### Success criteria

1. A parent and a six-year-old can finish a game in Hebrew, on one screen, without either of
   them being confused about whose turn it is or why they just paid ₪450.
2. Six seats, any mix of people and bots, no crashes, no illegal moves offered.
3. Switching English ↔ Hebrew mid-game mirrors the entire layout and changes nothing about
   the game.
4. The universal rules are correct — including auctions, mortgages, even-build, building
   shortage and bankruptcy chains — and the correctness is demonstrated by tests, not by
   playing it a few times.
5. `uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest` is
   green, and stays green.

### Explicitly out of scope for v1

Networked play across devices (ADR-006), accounts, persistence beyond a save file, mobile
apps, sound design beyond simple cues, custom board editing, and any use of the trademarked
product's name or artwork (§10).

---

## 2. Architecture

```
                        ┌──────────────────────────────────────────┐
                        │  packages/web   React 19 + Vite + TS     │
   browser ─────────────┤  Renders GameView. Owns NO rules.        │
                        │  i18next · dir=rtl|ltr · logical CSS     │
                        └───────────────┬──────────────────────────┘
                                        │  POST /games/{id}/commands
                                        │  WS   /games/{id}/ws   (events)
                        ┌───────────────┴──────────────────────────┐
                        │  packages/server   FastAPI               │
                        │  Sessions, serialization, fan-out.       │
                        │  Owns NO rules.                          │
                        └───────────────┬──────────────────────────┘
                                        │  apply(state, command)
                        ┌───────────────┴──────────────────────────┐
                        │  packages/engine   kesef-engine          │
                        │  PURE. No I/O. Deterministic. Keys only. │
                        │  board data · rules · bots · text driver │
                        └──────────────────────────────────────────┘
```

Three sentences carry the whole design:

1. **The engine is a pure reducer.** `apply(state, command) -> (state, events)`, with the RNG
   inside the state (ADR-002).
2. **The engine emits keys, never prose.** That is what makes Hebrew a catalogue rather than
   a code change (ADR-003).
3. **The engine says what is legal; the UI renders it.** No layer above the engine contains a
   rule (ADR-005).

### Why a reducer, concretely

| Capability | What it cost us |
|---|---|
| Save / load | nothing — `model_dump_json()` **is** the save file |
| Replay, reproducible bug reports | nothing — a seed plus a command list |
| Undo | nothing — keep the previous state |
| Bot lookahead | nothing — clone the state, play hypotheticals, discard |
| Networked play later | nothing — commands in / events out is a wire protocol |

That column is the argument. Each of those is a feature someone would otherwise have had to
build.

---

## 3. The engine

### 3.1 State

`GameState` is one frozen, fully serializable pydantic model. There is no hidden state
anywhere: no module globals, no clock, no `random` module.

```
GameState
├─ schema_version, game_id, board_id, locale
├─ ruleset: Ruleset                  ← the flags this game is played under (ADR-004)
├─ rng: Rng(seed, counter, stream)   ← randomness is DATA
├─ players: tuple[PlayerState, ...]  ← 2..6; id, name, kind(human|bot+level), cash,
│                                      position, jail state, jail cards, bankrupt
├─ properties: tuple[PropertyState, ...]  ← always 40, index-aligned with the board
│                                           owner | houses (0-4, 5=hotel) | mortgaged
├─ phase: Phase                      ← the turn state machine (§3.3)
├─ current_player_id, dice(first, second, purpose), doubles_streak, turn_number
│    (Amended 2026-07-26 / MON-100: an *id*, not an index — every command and event names
│    players by id, and ids need not be contiguous. `doubles_streak` belongs to the turn,
│    not to a roll, so a card-driven rent roll cannot reset it. GAP G-10, G-19.)
├─ houses_remaining / hotels_remaining    ← the building shortage is a real rule
│    (Amended 2026-07-26 / MON-100: DERIVED from `ruleset.houses_available` minus the
│    buildings on the board, not stored. A stored copy could contradict a custom
│    ruleset, and the conservation invariant then had nothing to catch. GAP G-19.)
├─ interrupts: tuple[InterruptFrame, ...] ← a STACK: interrupts nest and queue (ADR-007).
│    AuctionFrame | DebtFrame | TradeFrame | CardFrame, each with its own resume phase.
│    (Amended 2026-07-26: the original "at most one interrupt is live at a time" was false
│    for these rules — card→debt→trade and estate auctions nest to depth ≥ 3. GAP G-1..G-9.)
├─ chance_deck / community_chest_deck     ← card ids in draw order
└─ free_parking_pot, winner, elimination_order, elapsed_seconds
```

`properties` is 40 long even though only 28 tiles can be owned. Wasting 12 slots buys O(1)
lookup with no index arithmetic, and index arithmetic is where off-by-ones live.

### 3.2 Randomness

`Rng` is counter-based **splitmix64**: state is `(seed, counter, stream)`, three integers.

- Serializes to nothing, resumes exactly, and any position in the stream is O(1) reachable.
- `stream` separates uses of one seed, so shuffling a deck cannot shift the dice sequence.
- `below(bound)` uses Lemire multiply-shift with rejection, so dice are free of modulo bias.
  Tested: distribution within 5% over 60 000 rolls, doubles within 1% of 1/6.

### 3.3 The turn state machine

```
AWAITING_ROLL ──roll──► MOVING ──► RESOLVING_TILE ──┬─► AWAITING_PURCHASE_DECISION ─┬─► AWAITING_END_TURN
      │                                             ├─► CARD_RESOLUTION ────────────┤
      │                                             ├─► (rent settled) ─────────────┤
   JAIL_DECISION                                    └─► (inert tile) ───────────────┘
                                                                                     │
              interrupts, re-entrant from several places:                            │
              AUCTION · DEBT_SETTLEMENT · TRADE_REVIEW ◄──────────────────────────────┘
                                                                          end turn ──► next player
```

- **Transient phases** (`MOVING`, `RESOLVING_TILE`, `CARD_RESOLUTION`) are resolved to
  completion inside `apply`; a caller never observes a state resting in one.
- **Interrupt phases** are the ones where the acting player is not necessarily the player
  whose turn it is — the whole reason the phase is explicit rather than inferred from a
  handful of booleans.
- **Portfolio phases** (`AWAITING_ROLL`, `AWAITING_END_TURN`) are when building, mortgaging
  and trading are allowed.

### 3.4 Commands and events

Closed discriminated unions, so adding a case without handling it is a type error.

**Commands** (17): `RollDice` · `EndTurn` · `BuyProperty` · `DeclinePurchase` · `PlaceBid` ·
`WithdrawFromAuction` · `BuildHouse` · `SellHouse` · `MortgageProperty` ·
`UnmortgageProperty` · `ProposeTrade` · `RespondToTrade` · `CancelTrade` · `PayJailFine` ·
`UseJailCard` · `RollForJail` · `DeclareBankruptcy`.

**Events** (21): `TurnStarted` · `DiceRolled` · `TokenMoved` · `CashChanged` · `RentCharged` ·
`PropertyAcquired` · `AuctionStarted` · `BidPlaced` · `BidderWithdrew` · `AuctionEnded` ·
`CardDrawn` · `SentToJail` · `LeftJail` · `BuildingChanged` · `MortgageChanged` ·
`TradeExecuted` · `TradeDeclined` · `DebtIncurred` · `PlayerBankrupted` · `PhaseChanged` ·
`GameEnded`.

Events exist because state diffs lose history. `TokenMoved` carries `passed_go` and a
`forward` flag — the latter so "go back three spaces" animates backwards instead of
teleporting nearly all the way round the board.

### 3.5 Rule modules

The reducer dispatches; the rules live in `kesef_engine/rules/`, one module per area, so
"where is rent calculated" has exactly one answer:

`movement` · `purchase` · `rent` · `development` · `mortgage` · `auction` · `trade` · `jail` ·
`cards` · `insolvency` · `endgame`.

Each is a pure function of `(state, ...) -> (state, events)`.

### 3.6 The rules that are usually got wrong

Called out because they are where implementations quietly diverge from the real game:

1. **Rent on an undeveloped property doubles** when the owner holds the whole colour group.
2. **A mortgaged property charges no rent**, but still counts toward group completion.
3. **Even-build**: houses within a group may never differ by more than one, on the way up
   *and* on the way down.
4. **The building shortage is real.** 32 houses and 12 hotels. When they run out, they are
   out. *(Amended 2026-07-26: the "several players want the last house → auction it" clause
   is unrepresentable in a sequential reducer — contention has no representation when whoever
   sends `BuildHouse` first simply gets it. v1 ships first-come-first-served behind
   `Ruleset.building_shortage_auction = False`; the `BuildingLot` auction type exists in the
   model (ADR-007) so the full rule stays buildable. Owner decision recorded in
   `GAP_ANALYSIS.md` §7.)*
5. **Declining to buy triggers an auction** with **no reserve** — the property can go for ₪1,
   and the player who declined may bid.
6. **Bankruptcy chains.** Paying a player transfers everything to that player (mortgaged
   properties included, with the 10% fee due). Paying the bank sends the properties to
   auction. Either can cascade.
7. **Three consecutive doubles goes to jail** — and the third roll's movement does not happen.
8. **Jail is not a pause.** You still collect rent, build, and trade while in jail.
9. **Utility rent is 4× or 10× the dice roll**, not a fixed number — and if a card sends you
   to a utility, the roll is made specifically for the rent.
10. **Passing GO on the way to jail collects nothing** — going to jail is not passing GO.

### 3.7 Bots

A bot picks one command from the legal ones. It cannot cheat, because there is no other door.

- **easy** — random among legal moves, but always buys what it can afford. Loses cheerfully.
- **normal** — heuristics: keep a cash buffer, prefer completing groups, build to three
  houses (the best rent-per-currency-unit tier), accept trades that improve group completion.
- **hard** — those heuristics plus short Monte-Carlo rollouts through `apply` on cloned
  states. This is the payoff for the engine being pure and cheap to copy.

Bots draw randomness from `state.rng.fork(...)`, never a global, so a bot game is as
reproducible as a human one.

---

## 4. Server

Thin. FastAPI. Owns sessions, serialization and fan-out; owns no rules.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | liveness |
| `GET` | `/boards` | boards for the new-game screen |
| `GET` | `/rulesets` | both rulesets expanded, so the UI can *show* what Kids Mode changes |
| `POST` | `/games` | start a game → opening `GameView` |
| `GET` | `/games/{id}` | current `GameView` — poll and reconnect path |
| `POST` | `/games/{id}/commands` | apply one command; the only way a game changes |
| `DELETE` | `/games/{id}` | discard |
| `WS` | `/games/{id}/ws` | event stream, drives the animation queue |

`GameView = { board, state, legal_commands, events, event_cursor }` — a **projection**, not
the raw engine state (ADR-008): the board ships whole, derived values (`net_worth`, group
completion, dice totals) are promoted to real fields, and the RNG and deck order never leave
the server (deck *counts* do). The full `GameState` is reachable only as the save file.
Shipping `legal_commands` in the view is what keeps the UI rules-free (ADR-005); the
`validate` route exposes `is_legal` for the two non-enumerable command kinds. Errors are
`{reason_key, params}` so the engine's context survives to the catalogue sentence.

Sessions are a process-local dict, capped (ADR-006). Errors return **i18n keys** as
`detail` — `error.game_not_found`, not a sentence.

### Contract generation

TypeScript types are generated from the OpenAPI document and **committed**; CI regenerates
and diffs them. A field renamed in Python becomes a TypeScript compile error rather than an
`undefined` in front of a player.

---

## 5. Web UI

React 19 · Vite 6 · TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
· Tailwind v4 · i18next · TanStack Query for server state · Zustand for UI-local state only.

### 5.1 Component structure

```
board/    Board (11×11 CSS grid) · Tile · Token · GroupBand
panels/   PlayerDossier · CompareTray · ActionBar · DiceTray · EventLog · TradeBuilder
          AuctionPanel · SetupScreen
game/     useGame() — the view, the command sender, the animation queue
theme/    tokens: colour groups + patterns + icons, typography, spacing
i18n/     i18next setup and catalogues
api/      generated.ts (from OpenAPI) + client.ts
```

The board is an 11×11 grid with tiles placed by index. **The board is the one component that
must NOT mirror** *(amended 2026-07-26 — the original "RTL mirroring is free" contradicted
§5.3: flipping the grid's inline axis reverses the visible direction of travel, so tokens
would circle clockwise in Hebrew and counter-clockwise in English)*. The grid container is
pinned `dir="ltr"` — the single deliberate, documented physical-direction exception in the
web package, carrying a visible lint-disable comment — and each tile's text content restores
the document direction. The chrome around the board mirrors normally. Playwright asserts this
**geometrically** (tile 0's bounding rect is identical across locales), not via the `dir`
attribute, which would be set and satisfied by the same line of code.

### 5.2 The flexibility the brief asked for

- **`PlayerDossier`** — one player's holdings, grouped by colour set, each set showing
  completion (`2 of 3`), houses, hotel, mortgaged flag, plus cash, net worth and jail cards.
- **`CompareTray`** — pins **1–3 dossiers side by side**. Two is the asked-for case; the
  component takes a list, so three costs nothing and the tray scrolls horizontally.
  In RTL the tray fills from the start edge, which `dir` handles for us.
- Any player's dossier is reachable at any time, including on another player's turn. Under
  the universal rules holdings are public information, so there is nothing to hide.

### 5.3 Right-to-left

Hebrew drives structure, not a late pass:

- `dir` on `<html>` from the locale. One attribute mirrors the layout.
- **Logical CSS properties only** — `ms-*`, `me-*`, `ps-*`, `pe-*`, `start`, `end`. A
  physical `ml-*` is a bug invisible in English and obvious in Hebrew. This is a review gate.
- Numbers, money and dice get explicit `dir="ltr"` inside an RTL page.
- **Token travel direction is a game direction, not a reading direction.** Tokens go the same
  way round the board in both languages; only the chrome mirrors.
- Hebrew type: Heebo or Rubik, self-hosted. Hebrew has no capitals and a different x-height,
  so the type scale is checked in both languages rather than assumed.

### 5.4 Design direction

Warm, tactile, not "corporate SaaS with a board on it". A child should want to touch it.
Chunky rounded tiles with a soft shadow, a felt-green table surface, physical-feeling dice
with a short tumble, money that animates as it moves rather than a number that jumps. Light
and dark themes both required — many families play in the evening.

### 5.5 Accessibility floor (gates, not aspirations)

- Colour groups carry **colour + pattern + icon**. Never colour alone. Railroads and
  utilities are themed the same way — six ownable tiles with no group is the same defect.
- Every **command kind carries an icon** (`theme/actions.ts`), and terminal commands
  (bankruptcy, final auction withdrawal, decline-into-auction) get a confirm step with a
  plain-language consequence. A pre-reader must be able to use every button.
- Six token identities are **shape + colour + icon**, reused verbatim in the turn indicator,
  dossier headers, board and auction list — "the triangle is playing" works without literacy.
- Every action keyboard-reachable, including the auction and trade builder. Modal panels use
  one shared `<Panel>` primitive: `role="dialog"`, `aria-modal`, focus trapped, restored on
  close, Escape closes (or announces why it cannot). The board is a single composite widget —
  one tab stop, arrow-key roving — never forty.
- **No interaction requires dragging, double-click, long-press, right-click, hover-only
  reveal, or multi-touch.** Selection is tap/click/Enter.
- Visible focus ring in both themes, contrast-tested against every surface it can sit on.
- One `<Announcer>` owns narration: a single polite region (dice, movement, rent, cash) and a
  single assertive region (turn and interrupt-phase changes — the moments the actor changes),
  fed by a serialized queue. Components never mount their own live regions; double-speak from
  competing regions is a defect.
- Contrast ≥ 4.5:1 text, ≥ 3:1 non-text indicators — **computed in a unit test**, both themes.
- Hit targets ≥ 44 × 44 px for every interactive element. On narrow viewports tiles are not
  tap targets (the arithmetic cannot work at 320 px / 11 columns); selection happens in
  dossier lists and a tile-detail sheet. A Playwright assertion measures every focusable at
  320 px.
- **Nothing blocks on an animation.** A player can always act, and always skip the flourish —
  via a persistent, focusable "skip animations" toggle plus Escape per animation; the DOM
  always renders the authoritative post-command state, with animation as decorative overlay.
  `prefers-reduced-motion` is honoured in the JS animation queue, not only in CSS.
- Kids Mode surfaces a suggested move and explains rent maths (`rent.note.*` keys exist
  precisely so an explanation is available in both languages), uses a `kids` catalogue
  namespace resolved ahead of `common` for simpler language, and every rent has a note key —
  including the plain base-rent case.
- These are **acceptance criteria on every UI item**, not an M7 audit finding. The M7 audit
  (MON-703) is the human/assistive-tech pass, not the first detection point.

---

## 6. Testing strategy

**Engine — three kinds, and a rule is not done until it has the ones that apply:**

1. **Unit tests** per rule, including the ten in §3.6 by name.
2. **Golden recorded games** — a fixed seed plus a command list, asserting the final state.
   These catch "we changed rent and something far away moved".
3. **Hypothesis invariants** *(restated 2026-07-26 — the original bullets were either
   unfalsifiable or false as written; GAP §4)*:
   - **the cash ledger**: every change to any player's cash is exactly one `CashChanged`
     event with correct `delta`, `balance` and counterparty (`PlayerId | "bank" |
     "free_parking_pot"`) — no other event moves money; `RentCharged` is narration. From it,
     four named checks: ledger consistency · paired transfers · per-player reconciliation ·
     money-supply accounting,
   - **building stock is conserved**: `houses_remaining` + houses on board equals
     `ruleset.houses_available` (same for hotels) — a conservation law, not a `≤ 32` bound a
     never-decremented counter would satisfy; both fields `ge=0`,
   - even-build holds as a state predicate after every command **and** as a legality
     property: `BuildHouse` is only offered at the group minimum, `SellHouse` only at the
     maximum (the sell direction is the half implementations get wrong; a hotel counts as 5),
   - cash is never negative (shortfalls are data in the `DebtFrame`, so this is a field
     constraint) and `DebtFrame` present ⇔ phase is `DEBT_SETTLEMENT`,
   - the three ADR-005 properties (soundness · enumerable completeness · `is_legal` oracle),
     with a coverage floor: the replay generator must observe every `Phase` and every
     `CashReason`, or the run fails — a green property test that never entered an auction
     proves nothing,
   - `legal_commands` is **non-empty unless `GAME_OVER`** — the single invariant that
     catches every deadlock,
   - interrupt depth is bounded and decreases on non-escalating commands; `GAME_OVER` ⇒ no
     live interrupts; bankrupt ⇒ not in jail, no cards, no tiles; the jail-card multiset is
     conserved,
   - a state round-trips through JSON unchanged — including a *maximal* state (live auction,
     pending trade with jail cards, debt, populated decks), and every one of the 21 event
     types and 17 command types round-trips through its discriminated union.

**Repo-level**: locale parity — same keys in every language, no empty values, matching
interpolation placeholders, and every board tile named in every language.

**Server**: httpx contract tests, including that error details are keys and not prose.

**Web**: Vitest + Testing Library for components; **Playwright** for one e2e smoke per
locale (start a 2-player game, roll, buy, end turn) plus an RTL layout assertion.

A test that still passes with the implementation deleted is documentation with a misleading
name. `/test-reviewer` exists to catch those.

---

## 7. Milestones

| # | Milestone | Done when |
|---|---|---|
| **M0** | **Bootstrap** ✅ | workspace, board data, state/command/event model, RNG, API contract, CI, full gate green |
| M1 | Engine core | dice, movement, purchase, rent, phases, `legal_commands`; **`kesef play` is winnable in the terminal** |
| M2 | Full universal rules | development, mortgages, auctions, trades, jail, cards, bankruptcy chains, endgame; invariants green |
| M3 | Server | game endpoints live, WebSocket events, TypeScript contract generated and diffed in CI |
| M4 | Web UI (English) | board, dice, dossier, buy/rent/build flows, a full game playable in a browser |
| M5 | Hebrew + RTL | locale switch, mirrored layout, Israeli board names from a verified source |
| M6 | Bots + Kids Mode | three difficulty levels, Kids Mode flags honoured throughout the UI |
| M7 | Polish | animations, sound cues, CompareTray, a11y audit, save/load, replay, Playwright e2e |
| M8 | Public release | README with a GIF, public GitHub repo, optional deploy |

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Universal-rule edge cases silently wrong | §3.6 is a named test checklist; hypothesis invariants; Fable reviews rule correctness specifically |
| Hebrew RTL degrades late | logical properties enforced as a review gate; Playwright asserts RTL layout from M5 |
| Israeli board names fabricated | **blocked on a verified source** (MON-503); a test asserts the catalogue's absence so it cannot be half-finished |
| Two languages / two toolchains drift | one generated, committed, CI-diffed contract |
| Scope creep into networked play | ADR-006 defers it explicitly; the seams that keep it cheap are already in place |
| A game too long for a child | Kids Mode target duration; net-worth tie-break |
| Animation-driven UI feels sluggish | nothing blocks on animation; every flourish skippable |

---

## 9. Decisions recorded

- **ADR-001** — Python engine + React web UI, in a uv workspace monorepo
- **ADR-002** — command/event reducer, RNG inside the state
- **ADR-003** — boards as data, i18n keys not prose, board independent of language
- **ADR-004** — one ruleset implementation, Kids Mode as feature flags
- **ADR-005** — `legal_commands` is the UI contract
- **ADR-006** — local hotseat for v1, networked play deferred but not designed out
- **ADR-007** — interrupts are a stack of frames, not a scalar phase *(Phase 0)*
- **ADR-008** — `GameView` is a projection, not the raw `GameState` *(Phase 0)*

---

## 10. Naming and trademarks

The genre's best-known product is a live trademark, and this repository is public. The
project therefore carries **its own name, its own artwork and its own board naming**, and
describes itself as an implementation of the widely played *ruleset*. The Atlantic City street
names on the `classic` board are real place names in Atlantic City, New Jersey.

Do not add the trademarked product's name, logo, mascot, card artwork or trade dress to this
repository — in code, docs, assets, or commit messages.

---

## 11. Current state (2026-07-25)

**Implemented and verified green** (`ruff check`, `ruff format --check`, `mypy --strict`,
89 tests, `pip-audit`):

- uv workspace, three packages, CI, agent guardrails, MIT licence
- both board JSON files, generated from one table, with 13 economic-invariant tests
- `Rng` with 12 tests including distribution and O(1) seek
- `GameState`, `Ruleset`, `Phase`, 17 commands, 21 events — all typed and validated
- API contract with schemas fixed; engine-backed routes declared and returning 501
- i18n scaffolding, English and Hebrew `common` catalogues, classic-board catalogues in both
  languages, locale-parity tests

**Deliberately not implemented**: `apply`, `legal_commands`, the rule modules, the bots, and
every React component. Those are M1–M6, specified above and itemised in `docs/BACKLOG.md`.

**Unverified**: everything in `packages/web` — there is no lockfile and no `node_modules` at
M0, so no TypeScript in this repo has been compiled. MON-401 is where that changes.
