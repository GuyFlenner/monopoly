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
├─ current_player_index, dice, turn_number
├─ houses_remaining / hotels_remaining    ← the building shortage is a real rule
├─ auction / pending_trade / pending_debt ← at most one interrupt is live at a time
├─ chance_deck / community_chest_deck     ← card ids in draw order
└─ free_parking_pot, winner
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
   out, and if several players want the last house, the rules require it to be auctioned.
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

`GameView = { state, legal_commands, events }`. Shipping `legal_commands` in the view is what
keeps the UI rules-free (ADR-005).

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

The board is an 11×11 grid with tiles placed by index. Because it is a grid rather than
absolute positions, RTL mirroring is free.

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

- Colour groups carry **colour + pattern + icon**. Never colour alone.
- Every action keyboard-reachable, including the auction and trade builder.
- Visible focus ring in both themes.
- `aria-live="polite"` narration of dice, movement, rent and cash changes.
- Contrast ≥ 4.5:1 text, ≥ 3:1 non-text indicators. Hit targets ≥ 44 × 44 px.
- **Nothing blocks on an animation.** A player can always act, and always skip the flourish.
- Kids Mode surfaces a suggested move and explains rent maths (`rent.note.*` keys exist
  precisely so an explanation is available in both languages).

---

## 6. Testing strategy

**Engine — three kinds, and a rule is not done until it has the ones that apply:**

1. **Unit tests** per rule, including the ten in §3.6 by name.
2. **Golden recorded games** — a fixed seed plus a command list, asserting the final state.
   These catch "we changed rent and something far away moved".
3. **Hypothesis invariants**, which must hold after *any* legal command sequence:
   - money is conserved (total cash + bank flows balance),
   - houses ≤ 32 and hotels ≤ 12 at all times,
   - even-build is never violated,
   - no player holds negative cash outside `DEBT_SETTLEMENT`,
   - `legal_commands` and `apply` agree in both directions (ADR-005),
   - a state round-trips through JSON unchanged.

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
