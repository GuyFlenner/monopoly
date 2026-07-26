# Kesef Street — Backlog

Every item is sized, tiered and given acceptance criteria. **Tier** is the model that should
own it (see `CLAUDE.md`): pick by how expensive it would be to get subtly wrong. Rent maths is
expensive; a button label is not.

**Size**: S ≈ under an hour · M ≈ a focused session · L ≈ needs breaking down if it grows.

**The gate applies to every item**: `ruff check` + `ruff format --check` + `mypy` + `pytest`
green, and for web items `typecheck` + `lint` + `test` green. An item with a failing gate is
not done, however complete it looks.

---

## E0 — Bootstrap · M0 ✅ COMPLETE

| ID | Item | Status |
|---|---|---|
| MON-001 | uv workspace, three packages, Python 3.13, MIT licence | ✅ |
| MON-002 | ruff (120, `E,F,I,N,W,UP,B,C4,SIM,PTH`) + mypy strict + pydantic plugin + pytest | ✅ |
| MON-003 | CI: python gate, web gate (skipped until a lockfile exists), contract-drift job | ✅ |
| MON-004 | Agent guardrails: `command-guard.sh`, `edit-guardrail.sh`, `settings.json` | ✅ |
| MON-005 | Board data model, validation, loader, both board JSON files, 13 economic tests | ✅ |
| MON-006 | `Rng`, `GameState`, `Ruleset`, `Phase`, 17 commands, 21 events, API contract | ✅ |

---

## E1 — Engine core · M1

**Goal: the game is winnable in the terminal.** No UI work starts here.

### MON-101 — `legal_commands` and `is_legal`
**Tier**: Fable · **Size**: L · **Depends on**: — · `legality.py`

The most consequential function in the project (ADR-005).

- Returns concrete, parameterized commands (`BuildHouse(tile=16)`), not capability flags.
- Exhaustive per phase, including interrupt phases where the actor is not the current player.
- `PlaceBid` returned at the minimum legal bid; `ProposeTrade` not enumerated — validated
  through `is_legal`.
- **Property test**: every returned command is accepted by `apply`; every omitted command is
  rejected. Both directions, over generated states.

### MON-102 — Reducer dispatch, dice and movement
**Tier**: Fable · **Size**: L · **Depends on**: MON-101 · `reducer.py`, `rules/movement.py`

- `apply` dispatches on phase first, command kind second.
- Transient phases resolve fully before returning — a caller never sees `MOVING`.
- Doubles grant another roll; **three consecutive doubles go to jail and the third roll's
  movement does not happen**.
- Passing GO pays salary. **Going to jail is not passing GO.**
- Backward movement ("go back three spaces") emits `TokenMoved(forward=False)`.

### MON-103 — Purchase and decline
**Tier**: Opus · **Size**: M · **Depends on**: MON-102 · `rules/purchase.py`

- Buy at list price when funds allow; ownership and cash change atomically.
- Decline → auction when `auctions_enabled`, otherwise the tile stays with the bank.
- Insufficient funds is not a legal purchase, so it is never offered.

### MON-104 — Rent
**Tier**: Fable · **Size**: M · **Depends on**: MON-103 · `rules/rent.py`

The single most-often-wrong area. Each bullet is a named test.

- Property rent by house tier; **undeveloped rent doubles when the owner holds the whole
  group**.
- **A mortgaged property charges no rent** but still counts toward group completion.
- Railroads: 25 / 50 / 100 / 200 by count owned.
- Utilities: **4× or 10× the dice roll**, and when a card sends a player to a utility the roll
  is made for the rent.
- Owner is never charged their own rent. A bankrupt owner's tiles charge nothing.
- Every charge emits `RentCharged` with a `multiplier_note` key so the UI can explain it.

### MON-105 — `kesef play` text driver
**Tier**: Sonnet · **Size**: M · **Depends on**: MON-102, MON-104 · `cli.py`

- Prompts the current player with numbered legal commands; bots play themselves.
- `--seed` prints the seed so any game is reproducible.
- **Acceptance: a 2-player game can be played to a winner in the terminal.** This is M1's
  definition of done.

### MON-106 — `new_game` factory
**Tier**: Opus · **Size**: S · **Depends on**: MON-006

- Builds a valid opening state from seats + board + ruleset + seed.
- Shuffles both decks from separate RNG streams.
- Rejects fewer than 2 or more than 6 seats, and duplicate names.

### MON-107 — Golden-game test harness
**Tier**: Opus · **Size**: M · **Depends on**: MON-105

- Record `(seed, [commands])` → assert the final state and event sequence.
- At least three recorded games committed, one ending in bankruptcy.
- A helper that regenerates goldens **only** on an explicit flag, never automatically —
  a self-updating golden test asserts nothing.

---

## E2 — Full universal rules · M2

### MON-201 — Development: houses, hotels, even-build, shortage
**Tier**: Fable · **Size**: L · **Depends on**: MON-104 · `rules/development.py`

- Build only on a fully owned, unmortgaged group, during a portfolio phase.
- **Even-build enforced going up and coming down** — never more than one house apart.
- Hotel at the fifth house, returning four houses to the bank.
- **32 houses / 12 hotels are a hard supply.** Selling returns stock. Half price on sale.
- When supply is short and more than one player wants the last building, it is auctioned.

### MON-202 — Mortgages
**Tier**: Opus · **Size**: M · **Depends on**: MON-201 · `rules/mortgage.py`

- Mortgage for half the printed price; **buildings must be sold off the group first**.
- Unmortgage at mortgage value **+ 10%**.
- No rent while mortgaged; group completion still counts.
- Disabled entirely when `mortgages_enabled` is false (Kids Mode).

### MON-203 — Auctions
**Tier**: Fable · **Size**: L · **Depends on**: MON-103 · `rules/auction.py`

- **No reserve** — a property can sell for 1. The player who declined may bid.
- Bidding order from the declining player; withdrawal is final.
- Everyone withdrawing leaves the property with the bank.
- A bid above the bidder's cash is not legal, so it is never offered.
- Also used for bank-triggered auctions from MON-201 and MON-207.

### MON-204 — Trading
**Tier**: Opus · **Size**: L · **Depends on**: MON-202 · `rules/trade.py`

- Cash, properties and jail cards on either side; executed atomically or not at all.
- Cannot trade a property with buildings on its group; mortgaged properties transfer with
  their obligation.
- `simplified_trades` (Kids Mode) limits each side to one item.
- Recipient accepts or rejects; the proposer may cancel while pending.

### MON-205 — Jail
**Tier**: Opus · **Size**: M · **Depends on**: MON-102 · `rules/jail.py`

- Enter via the tile, a card, or three doubles.
- Leave by fine, card, or rolling doubles; **compulsory fine after `max_jail_turns`**.
- **Jail is not a pause**: rent is still collected, and building and trading still allowed.

### MON-206 — Chance and Community Chest
**Tier**: Opus · **Size**: L · **Depends on**: MON-102 · `rules/cards.py`

- Full standard decks as **data** with i18n key ids, shuffled from a dedicated RNG stream;
  drawn cards go to the bottom.
- Movement cards, pay/collect cards, per-building repair cards, advance-to-nearest cards,
  and the two keepable Get Out of Jail cards.
- A movement card that passes GO pays salary; being *sent to jail* by a card does not.
- Every card's effect is a named test.

### MON-207 — Insolvency and bankruptcy chains
**Tier**: Fable · **Size**: L · **Depends on**: MON-202, MON-203 · `rules/insolvency.py`

- A debt beyond cash enters `DEBT_SETTLEMENT`: sell buildings, mortgage, or trade to raise it.
- Bankruptcy **to a player** transfers everything, including mortgaged properties and the 10%
  fee due.
- Bankruptcy **to the bank** sends properties to auction and buildings back to stock.
- **Cascades resolve**: the transfer itself can bankrupt the recipient.
- Money conservation holds throughout — the invariant test covers this specifically.

### MON-208 — Endgame
**Tier**: Opus · **Size**: M · **Depends on**: MON-207 · `rules/endgame.py`

- Last solvent player wins.
- `target_duration_minutes` (Kids Mode) ends the game on net worth. **The clock is passed in
  as a turn count or a caller-supplied timestamp — the engine has no access to a clock.**
- `GameEnded` carries every player's final net worth, so a results screen needs no maths.

### MON-209 — Hypothesis invariants
**Tier**: Fable · **Size**: L · **Depends on**: MON-207

After **any** legal command sequence:

- money is conserved across all `CashChanged` flows,
- houses ≤ 32 and hotels ≤ 12 at every step,
- even-build never violated,
- no negative cash outside `DEBT_SETTLEMENT`,
- `legal_commands` ⇔ `apply` agreement,
- every state round-trips through JSON unchanged.

---

## E3 — Server · M3

### MON-301 — Game endpoints
**Tier**: Opus · **Size**: M · **Depends on**: MON-106, MON-101

- `POST /games`, `GET /games/{id}`, `POST /games/{id}/commands` fully implemented.
- Every 501 test in `test_api.py` becomes a behavioural test rather than being deleted.
- An illegal command returns **422 with the engine's `reason_key`**, never a sentence.
- Session cap and unknown-game paths return key-based errors.

### MON-302 — OpenAPI export and TypeScript generation
**Tier**: Sonnet · **Size**: S · **Depends on**: MON-301

- `python -m kesef_server.openapi` writes the document to stdout.
- `packages/web/src/api/generated.ts` committed; the CI `contract` job diffs a fresh
  generation and fails on drift.

### MON-303 — WebSocket event stream
**Tier**: Opus · **Size**: M · **Depends on**: MON-301

- `WS /games/{id}/ws` pushes each command's events.
- A late or reconnecting client can replay from the session's append-only log.
- Disconnects do not affect game state.

### MON-304 — Bot turn driving
**Tier**: Opus · **Size**: M · **Depends on**: MON-601, MON-303

- When the current seat is a bot, the server advances it without a client command.
- A configurable "thinking" delay, so a bot's turn is watchable rather than instant.
- Bot events stream like any others; the UI needs no special case.

---

## E4 — Web foundation · M4 (English only)

### MON-401 — Frontend bootstrap
**Tier**: Sonnet · **Size**: M · **Depends on**: —

- `npm install`, commit `package-lock.json` — **this is what activates the CI web gate**.
- eslint (with `jsx-a11y`), prettier, vitest + Testing Library, `src/test/setup.ts`.
- `npm run dev` serves, `npm run build` builds, `npm run typecheck` clean.
- Tailwind v4 configured with the design tokens from `src/theme/`.

### MON-402 — API client and `useGame`
**Tier**: Opus · **Size**: M · **Depends on**: MON-302, MON-401

- Typed client over `generated.ts`; TanStack Query for the view, mutation for commands.
- WebSocket subscription feeding an event queue.
- `useGame()` exposes `{ state, legalCommands, send, events }` — **and nothing that computes
  a rule**.

### MON-403 — Board
**Tier**: Opus · **Size**: L · **Depends on**: MON-401

- 11×11 CSS grid, tiles placed by index, side labels rotated correctly.
- Colour band + **pattern + icon** per group (`src/theme/groups.ts`).
- Ownership markers, house/hotel pips, mortgage indicator.
- Responsive from a 320 px phone to a desktop; the board never causes horizontal page scroll.

### MON-404 — Tokens and dice
**Tier**: Opus · **Size**: M · **Depends on**: MON-403

- Up to six distinguishable tokens; multiple tokens on one tile do not overlap illegibly.
- Dice roll animation with a real result, skippable, honouring `prefers-reduced-motion`.
- `aria-live` announcement of every roll.

### MON-405 — ActionBar
**Tier**: Opus · **Size**: M · **Depends on**: MON-402

- Renders **one button per legal command**, labelled from the i18n catalogue.
- Zero rule logic. A command the engine did not offer cannot be represented.
- Keyboard reachable, 44 px minimum targets, disabled state never lies.

### MON-406 — PlayerDossier
**Tier**: Opus · **Size**: M · **Depends on**: MON-403

- Holdings grouped by colour set with completion (`2 of 3`), houses, hotel, mortgage flag.
- Cash, net worth, jail cards, in-jail and bankrupt states.
- Reachable for **any** player at any time, including on someone else's turn.

### MON-407 — EventLog
**Tier**: Sonnet · **Size**: S · **Depends on**: MON-402

- Human-readable history from the event stream, translated from keys.
- Scrollable, newest first, with an `aria-live` region for the latest entry only.

### MON-408 — SetupScreen
**Tier**: Opus · **Size**: M · **Depends on**: MON-402

- 2–6 seats, each named, human or bot with a difficulty.
- Board, ruleset and language pickers; **Kids Mode shows what it changes**, sourced from
  `/rulesets` rather than hardcoded prose.
- Optional seed field for a reproducible game.

### MON-409 — AuctionPanel
**Tier**: Opus · **Size**: M · **Depends on**: MON-203, MON-405

- Bidding order, current high bid and bidder, who has withdrawn.
- Bid entry constrained to legal amounts; a child can see whose turn it is to bid.

### MON-410 — TradeBuilder
**Tier**: Opus · **Size**: L · **Depends on**: MON-204, MON-406

- Two-sided draft: cash, properties, jail cards; validated live via `is_legal`.
- Honours `simplified_trades` in Kids Mode.
- Shows both sides' dossiers while building — the compare case, in situ.

---

## E5 — Hebrew and RTL · M5

### MON-501 — i18n wiring and language switch
**Tier**: Sonnet · **Size**: M · **Depends on**: MON-401

- `initI18n` wired in `main.tsx`; switching locale sets `lang` and `dir` on `<html>`.
- Language switchable **mid-game** with no effect on game state.
- A missing key fails loudly in development.

### MON-502 — RTL audit
**Tier**: Opus · **Size**: M · **Depends on**: MON-501, MON-403

- **Zero physical CSS properties** in `packages/web` — add a lint rule so it stays that way.
- Numbers, money and dice explicitly `dir="ltr"`.
- Token travel direction unchanged by locale.
- Playwright asserts the mirrored layout.

### MON-503 — Israeli board name catalogue 🚧 **BLOCKED**
**Tier**: Sonnet (human input required) · **Size**: S · **Depends on**: —

**Blocked on a verified source for the Israeli edition's city list.** Do not fill these
names from memory or inference: a fabricated board looks right and will never be re-checked.

- Ask the owner for the city list, or cite a verifiable source in the PR description.
- Fill `board-israel.en.json` and `board-israel.he.json`, keyed `tile.israel.t00`–`t39`.
- Add `board-israel` to `CATALOGUES` in `tests/test_locale_parity.py` and delete
  `test_the_israeli_board_has_no_catalogue_yet`.

### MON-504 — Hebrew typography
**Tier**: Sonnet · **Size**: S · **Depends on**: MON-501

- Heebo or Rubik, self-hosted, subset, `font-display: swap`.
- The type scale checked in both languages — Hebrew has no capitals and a different
  x-height, so a scale tuned on Latin text usually reads small.

---

## E6 — Bots and Kids Mode · M6

### MON-601 — Easy bot
**Tier**: Sonnet · **Size**: S · **Depends on**: MON-101

- Random among legal commands, but always buys what it can afford.
- Deterministic from `state.rng.fork(...)` — never a global RNG.

### MON-602 — Normal bot
**Tier**: Opus · **Size**: M · **Depends on**: MON-601

- Cash buffer, group completion preference, builds to three houses, sane trade evaluation.
- **Beats the easy bot over 100 seeded games** — asserted as a test, not assumed.

### MON-603 — Hard bot
**Tier**: Fable · **Size**: L · **Depends on**: MON-602

- Heuristics plus short Monte-Carlo rollouts on cloned states.
- Beats the normal bot over 100 seeded games; a per-move time budget it never exceeds.

### MON-604 — Kids Mode in the UI
**Tier**: Opus · **Size**: M · **Depends on**: MON-405

- Auction and mortgage affordances **absent, not disabled** — an unreachable button is
  clutter to a child.
- Larger targets, simpler language, a visible turn indicator a pre-reader can follow.

### MON-605 — Hints
**Tier**: Opus · **Size**: M · **Depends on**: MON-604

- Ranks the legal commands and highlights one, with a reason from the catalogue.
- Explains rent maths on demand using `rent.note.*` — in both languages.
- **The hint system holds no rule knowledge of its own.** It ranks what it is given.

---

## E7 — Polish · M7

| ID | Item | Tier | Size |
|---|---|---|---|
| MON-701 | Animation queue: events drive animations; nothing blocks input; all skippable; `prefers-reduced-motion` honoured | Opus | L |
| MON-702 | CompareTray: pin 1–3 dossiers side by side, horizontal scroll, RTL-correct | Opus | M |
| MON-703 | Accessibility audit against the §5.5 floor; axe clean; a full game by keyboard alone | Opus | M |
| MON-704 | Save / load to a file — `GameState` already serializes, so this is UI plus a schema-version check | Sonnet | S |
| MON-705 | Replay viewer: step through a recorded game's events | Opus | M |
| MON-706 | Sound cues (dice, cash, purchase, jail) with a mute that persists | Sonnet | S |
| MON-707 | Playwright e2e: one smoke per locale plus an RTL layout assertion | Opus | M |
| MON-708 | Empty, loading and error states for every screen | Sonnet | S |

---

## E8 — Release · M8

| ID | Item | Tier | Size |
|---|---|---|---|
| MON-801 | README with a real gameplay GIF in both languages | Sonnet | S |
| MON-802 | Create the public GitHub repo and push — **human runs this**; the guard blocks agents from repo visibility changes | human | S |
| MON-803 | Optional deploy: static web + server on a free tier, or a single container | Opus | M |
| MON-804 | `CONTRIBUTING.md` and issue templates | Sonnet | S |

---

## E9 — Deferred (not v1)

| ID | Item | Why deferred |
|---|---|---|
| MON-901 | Networked play, one device per player | ADR-006 — the seams exist; the scope does not fit v1 |
| MON-902 | Further boards (city or family-custom) | boards are data, so this is cheap once M5 proves the pattern |
| MON-903 | Engine in the browser via Pyodide, no server | possible because the engine is pure; not needed |
| MON-904 | Tournament / statistics mode across many bot games | the golden-game harness is most of the machinery |

---

## Dependency spine

```
MON-101 ─► MON-102 ─► MON-103 ─► MON-104 ─► MON-105  (M1: winnable in the terminal)
                                     │
                                     ├─► MON-201 ─► MON-202 ─► MON-204
                                     ├─► MON-203 ──────┐
                                     ├─► MON-205       ├─► MON-207 ─► MON-208 ─► MON-209  (M2)
                                     └─► MON-206 ──────┘
MON-106 ─┬─► MON-301 ─► MON-302 ─► MON-303 ─► MON-304                                     (M3)
         │                  │
MON-401 ─┴─► MON-402 ─► MON-403 ─► MON-404 / 405 / 406 / 407 / 408 / 409 / 410            (M4)
                 └─► MON-501 ─► MON-502 / 504     (M5, and MON-503 is blocked on a source)
MON-601 ─► MON-602 ─► MON-603 · MON-604 ─► MON-605                                        (M6)
```

**Parallelism**: MON-401 and MON-402 need only the *contract*, not the rules, so the entire
web foundation can be built alongside E1/E2. That is why the API schemas were fixed at M0.
