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

> **Phase 0 amendments (2026-07-26).** The adversarial pre-build review
> (`docs/GAP_ANALYSIS.md`) found structural gaps; the fixes are folded into the items below
> and into ADR-007/ADR-008. Where an item cites a `G-nn`, the gap analysis holds the full
> reasoning. **MON-100 now precedes everything in E1.**

## E1 — Engine core · M1

**Goal: the game is winnable in the terminal.** No UI work starts here.

### MON-100 — State-model rework: interrupt frames, lots, projection fields
**Tier**: Fable · **Size**: L · **Depends on**: — · `state.py`, `phases.py`, `commands.py`, `events.py`

Implements ADR-007 and the engine half of ADR-008. Everything in E1/E2 builds on these
shapes; this lands first or gets retrofitted eleven times (GAP G-1..G-19).

- `interrupts: tuple[InterruptFrame, ...]` stack replaces `auction`/`pending_trade`/
  `pending_debt`; frames carry resume phases; validator ties `phase` to the top frame.
- `AuctionFrame`: `lot: TileLot | BuildingLot`, `reason`, stored `eligible` order, withdrawn
  set, `min_bid`/`max_bid`, lot queue. `DebtFrame`: `obligations` (N creditors), trigger
  reason, source tile — shortfall-as-data, cash never negative (`ge=0`). `CardFrame`:
  `(card_id, deck, step)`.
- `jail_cards` become deck-identified tuples (G-11). `DiceState.purpose`; `doubles_streak`
  moves to `GameState` (G-10). `grammatical_gender` on `PlayerState`, default `"n"` (G-42).
  `elimination_order`, `elapsed_seconds` (G-6). `PlayerKind.bot_level: BotLevel` and
  `is_bot` collapses to a property (G-19).
- `PORTFOLIO_PHASES` + `RAISING_PHASES` per GAP G-5. `CashChanged.counterparty` gains
  `"bank" | "free_parking_pot"` (G-60). Events added: `TradeProposed`, `TradeCancelled`,
  `DebtSettled`; `GameEnded.winner` optional with `final_standings` (G-16, G-13).
- Validation hardening: cross-validate `properties` against the board, enforce
  `SCHEMA_VERSION` (bump to 2), tie building stock to the ruleset, bounds everywhere (G-19).
- Round-trip tests over a *maximal* state and over every event/command union member.

### MON-101 — `legal_commands` and `is_legal`
**Tier**: Fable · **Size**: L · **Depends on**: MON-100 · `legality.py`

The most consequential function in the project (ADR-005).

- Returns concrete, parameterized commands (`BuildHouse(tile=16)`), not capability flags.
- Exhaustive per phase, including interrupt phases where the actor is not the current player.
- `PlaceBid` returned at the minimum legal bid; `ProposeTrade` not enumerated — validated
  through `is_legal`.
- **The three ADR-005 properties** (amended — the two-way statement was false against its own
  exceptions, G-61): soundness · completeness over the 15 enumerable kinds (rejection must be
  `IllegalCommandError` with a populated `reason_key`, not any crash) · `is_legal ⇔ apply`
  over an **unconstrained structural state generator** plus the replay generator, with a
  coverage floor: every `Phase` and `CashReason` observed or the run fails.

### MON-102 — Reducer dispatch, dice and movement
**Tier**: Fable · **Size**: L · **Depends on**: MON-101 · `reducer.py`, `rules/movement.py`

- **The cash ledger rule comes first** (G-60): every change to any player's cash is exactly
  one `CashChanged` with correct `delta`/`balance`/counterparty; no other event moves money;
  `RentCharged` is narration. Every money invariant depends on this landing before the other
  ten rule modules exist.
- `apply` dispatches on phase first, command kind second.
- Transient phases resolve fully before returning — a caller never sees `MOVING`.
- Doubles grant another roll; **three consecutive doubles go to jail and the third roll's
  movement does not happen**.
- Passing GO pays salary. **Going to jail is not passing GO.**
- Backward movement ("go back three spaces") emits `TokenMoved(forward=False)`.
- Bankrupt seats are skipped and the turn auto-advances — a state whose current player is
  bankrupt must be unreachable (G-14).

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
- Deletes `test_cli.py::test_play_reports_that_it_is_not_ready_yet` and replaces it with a
  scripted-stdin test that plays a seeded 2-player game to a winner, asserting the winner's
  id and final cash (the MON-503 tripwire convention — every not-implemented assertion names
  the item that must delete it).

### MON-106 — `new_game` factory
**Tier**: Opus · **Size**: S · **Depends on**: MON-006

- Builds a valid opening state from seats + board + ruleset + seed.
- Shuffles both decks from separate RNG streams.
- Rejects fewer than 2 or more than 6 seats, and duplicate names.

### MON-107 — Golden-game test harness
**Tier**: Opus · **Size**: M · **Depends on**: MON-102, MON-106 *(re-pointed from MON-105 —
the harness needs `apply_all` and `new_game`, not the CLI; the regression net must be live
while MON-103/104 churn, G-F26)*

- Record `(seed, [commands])` → assert the **final state exactly** plus a projection of the
  event stream (`type`, `player`, principal amount) — full-sequence assertions maximize
  regeneration pressure (G-F25).
- At least three recorded games committed, one ending in bankruptcy.
- Silent regeneration is excluded **structurally**, not by instruction: the regenerator is a
  separate entry point not importable from tests; **CI runs `git diff --exit-code` on the
  goldens directory after pytest**; each golden records `schema_version`, seed, commands and
  the RNG counter cost constants (which get their own pinning test — a changed dice cost is
  a named failure, not a mystery golden shift).
- A committed `traps.json` maps each §3.6 trap to the golden and event index where it
  occurs, asserted by a test; collectively the goldens visit every `Phase` and `CashReason`.

### MON-108 — Inert and cashflow tiles
**Tier**: Opus · **Size**: M · **Depends on**: MON-102 · `rules/tiles.py`

Tax tiles, GO salary, Free Parking, Go-To-Jail and just-visiting had no owning module —
they would have been squeezed into whichever module the implementer was in (G-17).

- Income Tax and Luxury Tax charge per board data; **flat amounts only in v1** (the 10%
  option is an owner decision, GAP §7).
- GO salary on passing (with the movement module's "going to jail is not passing GO").
- Free Parking: pot fed and collected only when `free_parking_pot_enabled` (renamed from
  `free_parking_pot` — a bool and an int shared that name across two models); the pot's
  inputs are named here, in one place.
- Go-To-Jail tile sends without salary; the Jail tile itself is inert.

---

## E2 — Full universal rules · M2

### MON-201 — Development: houses, hotels, even-build, shortage
**Tier**: Fable · **Size**: L · **Depends on**: MON-104 · `rules/development.py`

- Build only on a fully owned, unmortgaged group, during a portfolio phase.
- **Even-build enforced going up and coming down** — never more than one house apart; the
  legality property (build only at group minimum, sell only at maximum) is tested per
  command, not just as a resting-state predicate; a hotel counts as 5 (G-§3.3).
- Hotel at the fifth house, returning four houses to the bank.
- **Supply is hard and conserved**: `houses_remaining` + on-board == `ruleset.houses_available`
  (same for hotels) — the conservation form, not a `≤ 32` bound. Selling returns stock. Half
  price on sale.
- Demolishing a hotel is explicit (`SellHouse.demolish_hotel` or `SellHotel`): dropping to
  four houses requires four in the bank; the empty-bank case (drop to zero, half price for
  all five levels) is a named test — it is exactly what a debtor hits in `DEBT_SETTLEMENT`
  during a shortage (G-B3b).
- **v1 divergence, decided at Phase 0 (GAP §7)**: scarce buildings are first-come-first-served;
  `Ruleset.building_shortage_auction = False` documents it. The `BuildingLot` auction type
  exists in the model so the full rule stays buildable.

### MON-202 — Mortgages
**Tier**: Opus · **Size**: M · **Depends on**: MON-201 · `rules/mortgage.py`

- Mortgage for half the printed price; **buildings must be sold off the group first**.
- Unmortgage at mortgage value **+ 10%**.
- No rent while mortgaged; group completion still counts.
- Disabled entirely when `mortgages_enabled` is false (Kids Mode).

### MON-203 — Auctions
**Tier**: Fable · **Size**: L · **Depends on**: MON-103 · `rules/auction.py`

- **No reserve** — a property can sell for 1. The player who declined may bid.
- Bidding order from the declining player; withdrawal is final. Bank-triggered auctions
  (estate lots) order clockwise from the left of the debtor — they have no decliner (G-15).
- Everyone withdrawing leaves the property with the bank.
- A bid above the bidder's cash is not legal, so it is never offered — but a bidder **may
  sell buildings or mortgage on their bid turn** to raise cash (`RAISING_PHASES`); without
  that, auction prices are systematically low and the no-reserve trap is exploitable (G-B1a).
- Termination is specced, not implied: the standing high bidder is skipped; the last active
  bidder wins at their standing bid; minimum increment ₪1 over `high_bid`; zero-cash players
  are eligible but may only withdraw (G-15).
- Also used for bank-triggered auctions from MON-201 and MON-207 (multi-lot queues, ADR-007);
  an auction lot with fewer than two eligible bidders is **voided**, and endgame evaluates
  only after all interrupts drain — the two-player bankruptcy deadlock (G-8).

### MON-204 — Trading
**Tier**: Opus · **Size**: L · **Depends on**: MON-202 · `rules/trade.py`

- **Who may trade, and when (design decision, Phase 0 exploration; encoded by MON-101):**
  `ProposeTrade` is legal for **any solvent player** whenever the phase is a portfolio
  phase (`AWAITING_ROLL`, `AWAITING_END_TURN`, `JAIL_DECISION`) — portfolio actions wait
  for a quiet phase, not for your turn — and for the **debtor only** during
  `DEBT_SETTLEMENT` (MON-207). Never during `AUCTION` (a live auction cannot be paused
  by a trade review) or `TRADE_REVIEW` (one pending trade at a time). The same
  any-solvent-player rule applies to Build/Sell/Mortgage/Unmortgage in portfolio phases,
  matching the official "houses may be bought, and unimproved properties dealt, between
  turns" reading.
- Cash, properties and jail cards on either side; executed atomically or not at all.
- Cannot trade a property with buildings on its group; mortgaged properties transfer with
  their obligation.
- `simplified_trades` (Kids Mode) limits each side to one item.
- Recipient accepts or rejects; the proposer may cancel while pending.

### MON-205 — Jail
**Tier**: Opus · **Size**: M · **Depends on**: MON-102 · `rules/jail.py`

- Enter via the tile, a card, or three doubles.
- Leave by fine, card, or rolling doubles; **compulsory fine after `max_jail_turns`**.
- **Release by doubles moves the rolled total and does NOT grant another roll**;
  `doubles_streak` is not incremented by jail rolls — the most commonly mis-implemented jail
  rule, now a named test (G-12).
- The compulsory fine with insufficient cash escalates to `DEBT_SETTLEMENT`; a player who
  goes bankrupt while jailed leaves no dangling `in_jail` (invariant: bankrupt ⇒ not in
  jail, no cards, no tiles).
- **Jail is not a pause**: rent is still collected, and building and trading still allowed —
  `JAIL_DECISION` is a portfolio phase (G-5).

### MON-206 — Chance and Community Chest
**Tier**: Opus · **Size**: L · **Depends on**: MON-102 · `rules/cards.py`

- Full standard decks as **data** with i18n key ids (the `cards.*` catalogue namespace lands
  with the deck data, G-F2), shuffled from a dedicated RNG stream; drawn cards go to the
  bottom.
- Movement cards, pay/collect cards, per-building repair cards, advance-to-nearest cards,
  and the two keepable Get Out of Jail cards — deck-identified, returning to the bottom of
  **their own** deck on use or forfeit (G-11).
- Multi-step cards suspend into a `CardFrame` when an effect opens a debt (advance-and-pay-
  double, utility rent roll) and resume where they stopped; "pay each player" creates one
  `DebtFrame` with N obligations (G-7, G-9).
- A movement card that passes GO pays salary; being *sent to jail* by a card does not.
- Every card's effect is a named test.

### MON-207 — Insolvency and bankruptcy chains
**Tier**: Fable · **Size**: L · **Depends on**: MON-202, MON-203 · `rules/insolvency.py`

- A debt beyond cash enters `DEBT_SETTLEMENT`: sell buildings, mortgage, or trade to raise
  it (`RAISING_PHASES` — build and unmortgage stay forbidden while insolvent, G-5).
  Shortfall-as-data: cash never goes negative; the `DebtFrame` holds outstanding obligations.
- **The debtor may concede at any point** — `DeclareBankruptcy` is legal during
  `DEBT_SETTLEMENT` even when the estate could raise the debt (the "raise cash *or*
  declare bankruptcy" model `phases.py` documents; encoded by MON-101). Kids Mode UX puts
  the confirm step (MON-412 terminal-command class) in front of it.
- Multi-creditor debts ("pay each player") settle in turn order from the debtor; on
  bankruptcy with several creditors, the estate divides **proportionally to claim** — the
  rule now has an owner (G-7).
- Bankruptcy **to a player** transfers everything including mortgaged properties; the
  mortgage-fee model follows the official rule — receiver pays 10% at transfer or defers and
  pays the full 10% again on unmortgage (`CashReason.MORTGAGE_TRANSFER_FEE`); the fee can
  open a nested `DebtFrame`, and the same rule applies to trades (owner sign-off in GAP §7,
  G-13). Jail cards transfer to the creditor.
- Bankruptcy **to the bank** sends properties to a queued multi-lot auction, buildings back
  to stock, jail cards to the bottoms of their decks.
- **Cascades resolve**: the transfer itself can bankrupt the recipient; a game can end with
  no solvent survivor (`GameEnded.winner` is optional, `reason="no_survivors"`).
- Pending trades involving a bankrupted party are voided with `TradeCancelled(by="system")`.
- The four money invariants (ledger, paired transfers, reconciliation, supply) hold
  throughout — the invariant test covers this specifically.

### MON-208 — Endgame
**Tier**: Opus · **Size**: M · **Depends on**: MON-207 · `rules/endgame.py`

- Last solvent player wins; endgame evaluates only after all interrupts drain (G-8).
- `target_duration_minutes` (Kids Mode) ends the game on net worth. **The clock arrives via
  `EndTurn.elapsed_seconds`, caller-stamped — the engine has no access to a clock**, and the
  path is now reachable: `GameState.elapsed_seconds` accumulates it (G-6). A mortgaged
  property contributes zero to net worth — decided here, cited in the `net_worth` docstring.
- `GameEnded` carries `final_standings` with explicit player ids (elimination order breaks
  bankrupt ties — all bankrupts have net worth 0) so a results screen needs no maths (G-B5).

### MON-209 — Hypothesis invariants
**Tier**: Fable · **Size**: L · **Depends on**: MON-207

The invariant list is restated in full in spec §6 (Phase 0 — the original bullets were
either unfalsifiable or false as written, G-60/G-61). Headlines:

- the four named money invariants over the `CashChanged` ledger,
- building stock **conservation** (not a bound), fields `ge=0`,
- even-build as state predicate **and** per-command legality property,
- `DebtFrame` ⇔ `DEBT_SETTLEMENT`; cash a `ge=0` field constraint,
- the three ADR-005 properties, dual generators (replay + unconstrained structural), with a
  phase/reason **coverage floor** asserted,
- **`legal_commands` non-empty unless `GAME_OVER`** — the deadlock catcher,
- interrupt depth bounded and decreasing; `GAME_OVER` ⇒ no frames; bankrupt holds nothing;
  jail-card multiset conserved,
- maximal-state and full-union JSON round-trips.

Plus the mechanism the doctrine was missing (G-F36): **mutation testing** (`mutmut`) over
`rules/` and `legality.py`, kill-rate ≥ 80%, in the nightly job — the only mechanical answer
to "would this test fail if the implementation were wrong". Coverage floor
`--cov-fail-under=90` lands in CI with this item.

---

## E3 — Server · M3

### MON-301 — Game endpoints
**Tier**: Opus · **Size**: M · **Depends on**: MON-106, MON-101

- `POST /games`, `GET /games/{id}` (with `?since=` cursor), `POST /games/{id}/commands`,
  `POST /games/{id}/validate` and `GET /games/{id}/save` fully implemented (ADR-008).
- Falsifiably stated (G-F20): for each route a behavioural test asserts a 2xx and a named
  `GameView` field; the route-inventory test (exhaustive `EXPECTED_PATHS` /
  `EXPECTED_SCHEMAS` constants) still passes; `packages/server/src` coverage ≥ 95%.
- An illegal command returns **422 as `{reason_key, params}`** — the engine's context
  survives to the catalogue sentence, never prose (G-33).
- Session cap and unknown-game paths return key-based errors; duplicate `game_id` raises.

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

> **Every E4/E6 item carries the same a11y acceptance criteria** (spec §5.5, G-E4): axe
> clean · every interactive element ≥ 44×44 px at 320 px · keyboard operable · announcements
> routed through the MON-411 `<Announcer>`, never a component-local live region. MON-703
> remains the human/AT pass, not the first detection point.

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
- An empty draft (nothing on either side) is engine-legal (MON-101 resolution 5) but the
  send button stays hidden until at least one side carries an item — no nothing-for-nothing
  spam, especially in Kids Mode.
- Honours `simplified_trades` in Kids Mode.
- Shows both sides' dossiers while building — the compare case, in situ.

### MON-411 — `<Announcer>` and the narration queue
**Tier**: Opus · **Size**: M · **Depends on**: MON-402 · *(new at Phase 0, G-54)*

- One component at the root owning exactly one `aria-live="polite"` region (dice, movement,
  rent, cash) and one assertive region (turn changes, interrupt-phase entries — the moments
  the actor changes), fed by a **serialized queue** from `useGame`.
- MON-404 and MON-407 render visually only and depend on this item — two live regions
  announcing the same roll is double-speak, and it was about to be built twice.
- Movement/cash narration keys (`a11y.moved`, `a11y.passed_go`, …) exist in both locales —
  `TokenMoved` already carries all the data; nothing consumed it.

### MON-412 — Theme foundations: patterns, tokens, action icons
**Tier**: Opus · **Size**: M · **Depends on**: MON-401 · *(new at Phase 0, G-50/51/52, B2/B3/B4)*

- `theme/patterns.tsx`: eight SVG pattern defs, each legible at 12 px and 200 px — the file
  `groups.ts` references but which did not exist; `dark_blue` gets a real pattern (`solid`
  is the absence of one); no two groups share a pattern, asserted.
- Icons become silhouette-distinct inline SVG (🍊 vs 🍎 is the exact deutan/protan collision
  the icon channel exists to fix), always `aria-hidden`, name from `nameKey`.
- `TileTheme` extends to railroads and utilities (`group.railroad`/`group.utility` keys).
- Six token identities: shape + colour + icon, one source of truth reused by board, turn
  indicator, dossiers, auction list.
- `theme/actions.ts`: `ACTION_THEME` per command kind — icon, tone, and a
  reversible/consequential/**terminal** class (terminal ⇒ confirm step); coverage-tested
  against the command union from `generated.ts`.
- Contrast is **computed in a Vitest test** for all pairs, both themes: text ≥ 4.5:1,
  non-text ≥ 3:1 against the named reference surface (the claimed 3:1 measured 1.4:1, G-B1).

---

## E5 — Hebrew and RTL · M5

### MON-501 — i18n wiring and language switch
**Tier**: Sonnet · **Size**: M · **Depends on**: MON-401

- `initI18n` wired in `main.tsx`; switching locale sets `lang` and `dir` on `<html>`.
- Language switchable **mid-game** with no effect on game state — asserted by a Vitest case,
  not assumed (G-F20 web).
- A missing key **throws** in dev and test (a `console.error` nobody watches is not loud,
  and the handler was disabled under Vitest by construction, G-F17).
- Catalogue keys are `snake_case` matching the engine (ADR-003 §6); the cross-boundary test
  asserts every engine/server-emitted key — including every displayed enum member and every
  `action.<command_kind>` — resolves in every catalogue (G-40, G-F21/F22). The parity test
  canonicalises CLDR plural and gender-context suffixes so correct Hebrew is mergeable
  (G-41), asserts Hebrew is not a copied-English catalogue (G-F17-locale), and forbids
  Hebrew-letter/`{{` adjacency (morphology never crosses an interpolation boundary, G-F8).

### MON-502 — RTL audit
**Tier**: Opus · **Size**: M · **Depends on**: MON-501, MON-403

- **Zero physical CSS properties** in `packages/web` — enforced by lint that actually covers
  the real cases (G-45): ESLint over string literals **and template literals**, Stylelint
  with logical-property enforcement over CSS files, and the transform/scroll patterns
  (`translate-x-*`, `origin-*`, `scrollLeft`) in the deny list. The lint is the **primary**
  RTL gate; Playwright is secondary.
- Numbers, money and dice explicitly `dir="ltr"`, via FSI/PDI isolates in the i18next
  formatters (G-43) — `t()` alone cannot carry a `dir` attribute.
- Token travel direction unchanged by locale: the board grid is pinned `dir="ltr"` — the one
  documented physical-direction exception, with a visible lint-disable (spec §5.1, G-44).
- Playwright asserts the mirrored layout **geometrically** — panel positions flip; tile 0's
  rect is identical across locales (the `dir` attribute would be set and satisfied by the
  same line of code, G-F32). The `he` smoke asserts a Hebrew string present and an English
  string absent.

### MON-503 — Israeli board name catalogue 🚧 **BLOCKED**
**Tier**: Sonnet (human input required) · **Size**: S · **Depends on**: —

**Research done (2026-07-26, GAP §6); still blocked on owner confirmation.** The classic
licensed edition's structure is multi-source verified (8 cities × 22 streets, Eilat → Tel
Aviv, Dizengoff priciest; utilities and functional labels confirmed); 10 of 22 streets are
cross-verified, 12 are single-source (Hebrew Wikipedia), and **prices and the four station
names are unverifiable online** — our own price ladder stays, stated as original game data.
Do not fill the remaining names from memory or inference: a fabricated board looks right and
will never be re-checked.

- Owner confirms the 12 single-source streets (a photo of a physical board suffices), or
  supplies their own list; sources cited in the PR description.
- Fill `board-israel.en.json` and `board-israel.he.json`, keyed `tile.israel.t00`–`t39`.
- Add `board-israel` to `CATALOGUES` in `tests/test_locale_parity.py` and delete
  `test_the_israeli_board_has_no_catalogue_yet`.

### MON-504 — Hebrew typography
**Tier**: Sonnet · **Size**: S · **Depends on**: MON-501

- Heebo or Rubik, self-hosted, subset, `font-display: swap`.
- The type scale checked in both languages — Hebrew has no capitals and a different
  x-height, so a scale tuned on Latin text usually reads small.

### MON-506 — Hebrew card catalogue 🚧 **BLOCKED**
**Tier**: Sonnet (human input required) · **Size**: S · **Depends on**: —

MON-206 shipped 31 Chance/Community Chest card ids as engine data (`decks.py`) and M4 gave
them an English catalogue (`cards.en.json`); the Hebrew side is deliberately not attempted
here. 31 cards of flavour text need a native-speaker pass, not a plausible machine guess — a
fabricated catalogue would read fine and never be re-checked, the same reasoning MON-503
applies to the Israeli board (cross-reference MON-503).

- Source or author 31 Hebrew card strings, one per id in `CHANCE_CARD_IDS` /
  `COMMUNITY_CHEST_CARD_IDS`, matching the mechanics each id's `CARD_EFFECTS` entry encodes
  (amount, repairs schedule, destination tile) — reviewed by a native speaker.
- Confirm gender and plural forms before writing: several cards address the holder directly
  and several pay or charge "every other player," and Hebrew agreement differs by number and
  gender. The catalogue may need i18next context per the grammatical-gender and CLDR-plural
  gaps already tracked for `common` (GAP_ANALYSIS.md §5, G-41/G-42) — the same canonicalising
  parity logic MON-501 adds should cover `cards` too rather than a second scheme.
- Create `packages/web/src/i18n/locales/cards.he.json` with exactly the keys in
  `cards.en.json`.
- Delete `test_the_hebrew_card_catalogue_has_no_catalogue_yet` in `tests/test_locale_parity.py`
  and remove `"cards"` from `ENGLISH_ONLY_CATALOGUES` — the parity machinery then compares
  `cards` like any other bilingual catalogue.

---

## E6 — Bots and Kids Mode · M6

### MON-601 — Easy bot
**Tier**: Sonnet · **Size**: S · **Depends on**: MON-101

- Random among legal commands, but always buys what it can afford.
- Deterministic from `state.rng.fork(...)` — never a global RNG.

### MON-602 — Normal bot
**Tier**: Opus · **Size**: M · **Depends on**: MON-601

- Cash buffer, group completion preference, builds to three houses, sane trade evaluation.
- **Wins ≥ 60 of fixed seeds 1–100 against the easy bot** (binomial α=0.05 critical value is
  59 — the threshold is stated *before* the test exists, G-62); draws count against the
  challenger; the harness caps games at 500 turns scored by net worth, with ≤ 5 capped games
  allowed — a bot that cannot close out a game is itself a failure.

### MON-603 — Hard bot
**Tier**: Fable · **Size**: L · **Depends on**: MON-602

- Heuristics plus short Monte-Carlo rollouts on cloned states.
- Wins ≥ 60/100 against the normal bot **and** ≥ 60/100 against the easy bot (transitivity is
  asserted, not assumed); same 500-turn harness cap.
- The per-move budget is **deterministic** — a cap on rollouts and `apply` calls asserted on
  counters; wall-clock is a reported metric, never a pass/fail assertion (the canonical flaky
  test, G-F30). The suite runs under a `slow` marker in the nightly job, not the PR gate.

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
MON-100 ─► MON-101 ─► MON-102 ─► MON-103 ─► MON-104 ─► MON-105  (M1: winnable in the terminal)
                          └─► MON-107 (goldens live from here) · MON-108 (tiles)
                                     │
                                     ├─► MON-201 ─► MON-202 ─► MON-204
                                     ├─► MON-203 ──────┐
                                     ├─► MON-205       ├─► MON-207 ─► MON-208 ─► MON-209  (M2)
                                     └─► MON-206 ──────┘
MON-106 ─┬─► MON-301 ─► MON-302 ─► MON-303 ─► MON-304                                     (M3)
         │                  │
MON-401 ─┴─► MON-402 ─► MON-403 ─► MON-404 / 405 / 406 / 407 / 408 / 409 / 410            (M4)
                 └─► MON-501 ─► MON-502 / 504     (M5, and MON-503 / MON-506 are blocked on a source / a Hebrew pass)
MON-601 ─► MON-602 ─► MON-603 · MON-604 ─► MON-605                                        (M6)
```

**Parallelism**: MON-401 and MON-402 need only the *contract*, not the rules, so the entire
web foundation can be built alongside E1/E2. That is why the API schemas were fixed at M0.
