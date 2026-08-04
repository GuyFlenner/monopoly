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

### MON-304 — Bot turn driving ✅ **DONE**
**Tier**: Opus · **Size**: M · **Depends on**: MON-601, MON-303

**Delivered 2026-07-29.** `kesef_server/bots.py` — a loop around the same door a human uses: ask
`legal_commands`, hand the tuple to the bot, post what it returns through `apply`. No privileged
path, so "the bot cheated" is un-implementable rather than merely untrue. Driven after every command
and after game creation (seat one can be a computer). `drive` is an async **generator** so the caller
stores each step as it is yielded — batching the turn would make the thinking delay a pause with
nothing behind it.

**Two defects found by running it**, both invisible to any unit test of the pieces:

1. **The driver asked the wrong seat.** It acted for the first bot with anything legal, and mortgaging
   is legal *off-turn* — so seat 0 fidgeted with its portfolio for 200 steps while seat 1 never took
   its turn. It now acts only for the seat the engine is waiting on: the current player, or the actor
   the interrupt frame itself names.
2. **The easy bot worked against itself** (fixed in MON-601): `build_house, sell_house, build_house…`
   while solvent, and `mortgage, unmortgage, mortgage…` in debt settlement. Rule 3 now excludes
   dismantling while solvent and *spending* while in debt — the same rule, with the phase deciding
   which direction "undoing" points.

Worst case is now ~6 commands per turn, against 200 for a single turn before. `bot_think_seconds`
(0.6 s, zeroed in tests) and `bot_max_steps_per_call` (200) are settings. An all-bot game has no human
to hand back to, so it advances a chunk per request — a real limitation, recorded in a test rather
than a comment.

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

### MON-501 — i18n wiring and language switch ✅ **DONE** (PR #9)
**Tier**: Sonnet · **Size**: M · **Depends on**: MON-401

**Delivered 2026-07-28.** The cross-boundary test found 45 of the 50 `error.*` reason keys the
engine can return resolving against nothing *in either language* — invisible to a
catalogue-to-catalogue diff, and blanking `TradeBuilder`'s refusal panel, which renders
`t(verdict.reason_key)` with no `exists` guard. 90 keys renamed, 40 dead or duplicated ones
deleted, `ActionLabels.ts` and `BOT_LEVEL_KEYS` deleted as derivable, bidi isolation added, and
Hebrew written for **all 270 keys — `AWAITING_HEBREW` is deleted**, along with its rot tripwire.
The last 45 named a player and hung a verb off them, which is the real G-42 case; they are
gender-free now, using the technique Hebrew UI localization settled on (noun in the head position,
person as the object of a preposition). `grammatical_gender` still reaches the wire and adding
`_m`/`_f` pairs later is purely additive, but **no component knows a player's gender, because there
is no form to select between** — see `docs/MON-501_HEBREW_GENDER.md`. One criterion below was
corrected in flight: Hebrew's plural
categories are `one`/`two`/`other`, not `one`/`two`/`many` — CLDR removed `many` for Hebrew, and
`packages/web/src/i18n/plurals.test.ts` asks `Intl.PluralRules` rather than a hardcoded table.

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

### MON-502 — RTL audit ✅ **DONE**
**Tier**: Opus · **Size**: M · **Depends on**: MON-501, MON-403

**Delivered 2026-07-28.** Three criteria were already enforced and were verified rather than
rebuilt (the lint, the FSI/PDI isolates from MON-501, the pinned board). The fourth stood up
**MON-707's Playwright surface early** — `playwright.config.ts` and `e2e/` did not exist —
because the claim is geometric. Both mirror specs and the overflow spec are verified
non-vacuous by mutation: removing the `dir="ltr"` pin fails the first two by name, and forcing a
60 px tile height fails the third (329 against a 296 ceiling, the same shape as M4's 414/295).

**Correction to the last bullet below.** "Tile 0's rect is identical across locales" fails on a
*working* board: the game screen is two columns, so under `dir="rtl"` the side panel moves to the
inline-start edge and the board slides 22 rem with it — tile 0's viewport `x` moves 368 px, which
is the chrome mirroring *correctly*. The invariant is tile 0's offset **within the board grid**,
plus a second spec asserting squares 0 and 10 keep their order (a partial mirror that tile 0 alone
would miss). Asserting the viewport reading would have been "fixed" by un-mirroring the page.

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

### MON-503 — Israeli board name catalogue ✅ **DONE**
**Tier**: Sonnet · **Size**: S · **Depends on**: —

**Source: five high-resolution photographs of the physical licensed Kod Kod (קוד קוד) edition
(© 1935/2015 Hasbro, product code D-1591-1232-0000 250215), supplied by the owner on
2026-07-28, all four edges legible.** This replaces the 2026-07-26 web research (GAP §6),
which had cross-verified only 10 of 22 streets and left prices, the four station names and
one street (`t34`) unconfirmed. The photographs confirm all 22 streets, 4 railways, 2
utilities and every functional label verbatim, and correct `t34` to רח' מוריה (the research
had שד' מוריה). They also confirm that the shipped price ladder in
`packages/engine/src/kesef_engine/board/data/israel.json` already matches the physical
board's prices slot for slot — the ADR-003 §4 assumption is now verified, not just assumed.

- `board-israel.en.json` and `board-israel.he.json` filled, keyed `tile.israel.t00`–`t39`,
  transcribed verbatim from the photographs (including the two deliberate duplicate names
  and the geresh/quotation-mark punctuation).
- `board-israel` added to `CATALOGUES` in `tests/test_locale_parity.py`;
  `test_the_israeli_board_has_no_catalogue_yet` deleted.
- **Standing rule, unchanged**: never fill board data from memory or inference. A
  plausible-looking fabricated board is worse than a missing one, because nobody will
  re-check it.

### MON-504 — Hebrew typography ✅ **DONE**
**Tier**: Sonnet · **Size**: S · **Depends on**: MON-501

**Delivered 2026-07-29.** Heebo (Oded Ezer, SIL OFL 1.1) self-hosted as two variable `woff2`
subsets — Latin 30 kB, Hebrew 12 kB, weight 400–700 in one axis so bold costs no extra request.
`--font-sans` previously read `"Rubik", "Heebo", …` while the repo shipped **neither**, so the design
depended on what the player happened to have installed; it now names exactly the family served here.
The Hebrew size bump is one root-level `html[lang="he"] { font-size: 106.25% }` rather than a second
type scale, keyed off `lang` and not `dir` because it is the language whose x-height differs.

Two corrections found by testing. The e2e claim "the Hebrew face loads only once Hebrew is on screen"
is **false and should be**: the language picker labels itself with the endonym `עברית`, so Hebrew
glyphs are on the first frame — labelling it "Hebrew" is what would make the subset lazy, and is
exactly what a Hebrew reader cannot use. And MON-502's mirror assertion had to become a *fraction* of
the board, because the size bump widens the 22 rem side panel and shrinks the board column by 22 px;
mirroring still moves GO by 0.91 against a 0.01 tolerance, so the test lost no power.

- Heebo or Rubik, self-hosted, subset, `font-display: swap`.
- The type scale checked in both languages — Hebrew has no capitals and a different
  x-height, so a scale tuned on Latin text usually reads small.

### MON-506 — Hebrew card catalogue ✅ **DONE**
**Tier**: Sonnet · **Size**: S · **Depends on**: — · *(closed 2026-08-02)*

`packages/web/src/i18n/locales/cards.he.json` ships all 31 texts, and `i18n/index.ts` registers it
under `he` — the last namespace that pointed both languages at one English resource.

**Why this stopped being a blocker.** It was held on the reasoning MON-503 applies to the Israeli
board: invented game data reads fine and nobody re-checks it. That reasoning was right about the
board and wrong here, and the difference is worth writing down. The board's city names are *external
facts* — a translation cannot recover which streets a particular physical board prints, so only a
photograph could. The card texts are **this project's own English prose**, written for MON-206 and
deliberately not any published deck's wording (compare "Head straight to GO" with the phrasing the
branded product uses). Translating our own sentences is a catalogue job, not an invention.

**What made it safe to write rather than merely plausible.** Every card has a machine-readable
effect beside it in `decks.py`, so the risk that actually matters — a card that states a figure the
engine will not apply, which is the game lying to a child — is checkable rather than believed.
`test_the_hebrew_card_catalogue_says_what_each_card_actually_does` asserts every `amount`,
`per_house` and `per_hotel` in `CARD_EFFECTS` appears in that card's Hebrew sentence; change 25 to
20 and it fails by name. Square names are taken verbatim from `board-classic.he.json`, so a card
names a square the way the board does. Register matches the rest of the Hebrew catalogue —
second-person plural, gender-free, the voice `hint.reason.*` established, which is also what let
MON-501 delete `AWAITING_HEBREW` without needing `grammatical_gender`.

Amounts were bare numerals, like every other Hebrew string in the product, while only the English
cards carried a `$` — which predated the decision that this repo had no currency formatter (GAP G-43).
**Closed by MON-720**: the owner chose `$50` and `50 ₪`, and every Hebrew card now names its currency
too, checked by `test_every_card_that_names_a_figure_names_its_currency`.

- `ENGLISH_ONLY_CATALOGUES` is now empty, so `cards` goes through every parity check.
- `e2e/cards.spec.ts` plays a real game in each language and asserts the card on the board is in
  that language — the seam no unit test can see, since `i18n/index.ts` registered the wrong resource
  for months with the whole suite green.
- A card the Hebrew deck is missing still degrades honestly: i18next falls back to English and
  `cardSurface.ts` marks the body `lang="en" dir="ltr"`, tested in `CardReveal.test.tsx`.

A native-speaker review is still welcome and is no longer blocking anything; the failure it would
catch is wording, and the failure that would matter is arithmetic, which is now gated.

---

## E6 — Bots and Kids Mode · M6

### MON-601 — Easy bot ✅ **DONE**
**Tier**: Sonnet · **Size**: S · **Depends on**: MON-101

**Delivered 2026-07-29.** `bots/easy.py`. Random among the legal commands, with one preference:
always buy. Affordability is not the bot's judgement — a `BuyProperty` in `legal` *is* the engine
saying it is affordable, since `legality.py` rejects the unaffordable case, so the rule reduces to
"if buying is offered, buy" and there is no arithmetic in the bot at all.

**The design decision worth knowing** is where the randomness comes from. `state.rng.fork(stream)`
resets the counter to zero, which is not enough: building draws no randomness, so a bot offered
"build here / build there / end turn" gets the same index every time and pours every house onto one
square while looking random. That would also make MON-602's ≥ 60/100 threshold meaningless, since it
is measured against this bot. The stream is therefore derived from a cheap fingerprint of the
position (turn, the seat's cash and position, the option count) — chosen for what each field varies
with, not for entropy. `choose` stays a pure function of `(state, player, legal)`.

Eleven tests, and two of them fail on the naive `fork` — including the observable form of the
collapse, that more than one square in a completed group gets a house. Also pinned: the bot never
returns a command outside the tuple it was handed, and consulting it does not move `state.rng`, so a
bot's presence cannot change the dice a human sees.

**Not yet playable against a human.** MON-304 (the server advancing a bot seat without a client
command) depends on this item and is still open — the setup screen already offers computer seats and
`SeatConfig.bot_level` already reaches the wire, but nothing drives them.

- Random among legal commands, but always buys what it can afford.
- Deterministic from `state.rng.fork(...)` — never a global RNG.

### MON-602 — Normal bot ✅ **DONE**
**Tier**: Opus · **Size**: M · **Depends on**: MON-601

**Delivered 2026-07-30 (PR #18), by option 1 — ADR-009.** A bot may return a constructed
`ProposeTrade`, validated by `is_legal`/`apply` like anybody's draft; drivers ration it to one
proposal per seat per turn (a stateless bot re-proposing into an unchanged position would loop
forever — the guard is verified non-vacuous: stubbing it loops 40k commands on seed 3). Final
contest: **74/100 wins, 0 draws, 0 capped** (was 69/12), turns max 501→206 — games end because
rent gets big, not because the clock ran out. The contest is asserted in the suite, not reported
in prose. The server drives `normal` seats. The section below records the blocked state and the
three options as they stood, for the decision history.

**Progress 2026-07-29.** The harness (`packages/engine/tests/tournament.py`) and the bot
(`bots/normal.py`) are written. Measured over the stated 100 games:

> **69/100 wins** (needed 60), 0 draws, **12 capped** (max 5), turns min/median/max 22/114/501

So it **clears the strength bar and fails the capped-game gate** — and the gate is right to fail it.

**The cause is structural, not a tuning problem.** Dumping a capped game's final position shows why:

```
seed 9: turn 501
  normal: cash=5712 net= 8222 owns=12 houses=0
  easy:   cash=7694 net=10874 owns=16 houses=0
  brown [0,1]  light_blue [1,0,1]  pink [1,0,1]  orange [1,0,1]
  red [1,0,0]  yellow [0,0,1]     green [1,0,1]  dark_blue [0,1]
```

**Every colour group is split, so neither side can build — `houses=0` for both.** Rents stay at their
printed value, both bots bank GO salaries faster than they lose small rents, and the game cannot be
decided. Two things were tried and neither helped: allowing building past three houses (69→72 wins,
capped 16→13) and making group valuation opponent-aware so cash stops going into unwinnable groups
(no change to capping). The remaining fix is not a score tweak.

**The only mechanism that un-splits a group is trading, and a bot cannot propose one.** `Bot.choose`
promises to return a command from the `legal` tuple, and `ProposeTrade` is *never* enumerated in
`legal_commands` — ADR-005's documented exception, because the offer space is unbounded. So trades are
structurally unreachable to every bot, and MON-602's own fourth criterion ("sane trade evaluation") is
implemented only as *responding*.

**Decision needed** — three options, none of which should be taken silently:

1. **Amend the `Bot` protocol** so a bot may return a constructed `ProposeTrade` even though it is not
   enumerated, with `apply` validating it as it validates everything else. Cleanest fix to the real
   problem; touches a documented contract, so it wants an ADR note.
2. **Run the contest with more than two seats**, where a group is likelier to end up concentrated. Cheap
   to try, but it changes the stated contest after seeing results, which is the G-62 trap.
3. **Accept capping as a legitimate outcome** and raise `MAX_CAPPED`. Honest only if the reasoning above
   is recorded — the threshold was fixed in advance precisely so it would not move to fit a result.

Recommendation: **option 1.** The others make the measurement agree with the bot rather than making the
bot able to finish a game, and "a bot that cannot close out a game is itself a failure" is the right
standard to keep.

- Cash buffer, group completion preference, builds to three houses, sane trade evaluation.
- **Wins ≥ 60 of fixed seeds 1–100 against the easy bot** (binomial α=0.05 critical value is
  59 — the threshold is stated *before* the test exists, G-62); draws count against the
  challenger; the harness caps games at 500 turns scored by net worth, with ≤ 5 capped games
  allowed — a bot that cannot close out a game is itself a failure.

### MON-603 — Hard bot ✅ **DONE**
**Tier**: Fable · **Size**: L · **Depends on**: MON-602

**Delivered 2026-08-01 (PR #24).** `HardBot` subclasses `NormalBot` via three named seams; adds a
threat-scaled reserve, denial bids priced into willingness-to-pay, rent-priced trade scepticism,
and short rollouts (`ROLLOUTS_PER_MOVE=6`, `MAX_APPLY_CALLS_PER_MOVE=78`, asserted on counters;
wall-clock reported, never asserted). Contests: **80/100 vs normal, 89/100 vs easy, 0 capped**.
An ablation pins that the search matters (heuristics-only drops to 15/30). Rollout randomness
forks `state.rng` per (fingerprint, candidate, sample) — the dice stream itself is asserted
untouched. Contests run under the `slow` marker in the nightly lane; the empty-lane tolerance is
removed.

- Heuristics plus short Monte-Carlo rollouts on cloned states.
- Wins ≥ 60/100 against the normal bot **and** ≥ 60/100 against the easy bot (transitivity is
  asserted, not assumed); same 500-turn harness cap.
- The per-move budget is **deterministic** — a cap on rollouts and `apply` calls asserted on
  counters; wall-clock is a reported metric, never a pass/fail assertion (the canonical flaky
  test, G-F30). The suite runs under a `slow` marker in the nightly job, not the PR gate.

### MON-604 — Kids Mode in the UI ✅ **DONE**
**Tier**: Opus · **Size**: M · **Depends on**: MON-405

**Delivered 2026-07-31 (PR #23).** `game/presentation.ts` draws the line: reading a ruleset flag
to decide whether to *draw* is presentation; what may be *sent* stays the engine's. Auction and
mortgage affordances were already command-driven (absent, not disabled) — the one real defect was
a confirm sentence promising an auction that Kids Mode disables, now flag-selected in both
locales. One `[data-comfort="kids"]` rule raises every target 44→56 px; `useCopy` prefers
`kids.*` twins (13, both locales, infinitive Hebrew — gender-free); `TurnBanner` gives a
pre-reader shape+colour+icon+name. A live auction interrupt still mounts its panel — hiding a
phase the engine is in would strand the table.

- Auction and mortgage affordances **absent, not disabled** — an unreachable button is
  clutter to a child.
- Larger targets, simpler language, a visible turn indicator a pre-reader can follow.

### MON-605 — Hints ✅ **DONE**
**Tier**: Opus · **Size**: M · **Depends on**: MON-604

**Delivered 2026-07-31 (PR #23).** `panels/hints.ts` ranks the 17 command kinds by a static,
compile-time-covered preference (never picks between accept/decline — that's strategy);
`suggest` returns the very object from `legal_commands` so the ActionBar marks it by identity.
`HintPanel` has deliberately no button — a shortcut would bypass MON-412's terminal-command
confirm. Rent maths folds out from `RentQuote`'s own figures under MON-420's `rent.note.*`
sentences; the panel multiplies nothing. Prominent in kids games, folded elsewhere.

- Ranks the legal commands and highlights one, with a reason from the catalogue.
- Explains rent maths on demand using `rent.note.*` — in both languages.
- **The hint system holds no rule knowledge of its own.** It ranks what it is given.

---

## E7 — Polish · M7

| ID | Item | Tier | Size | Status |
|---|---|---|---|---|
| MON-701 | Animation queue: events drive animations; nothing blocks input; all skippable; `prefers-reduced-motion` honoured | Opus | L | ✅ PR #27 |
| MON-702 | CompareTray: pin 1–3 dossiers side by side, horizontal scroll, RTL-correct | Opus | M | ✅ PR #27 |
| MON-703 | Accessibility audit against the §5.5 floor; axe clean; a full game by keyboard alone | Opus | M | ✅ PR #30 — 9 defects found, 8 fixed, 1 deferred as a product decision; `docs/A11Y_AUDIT.md` |
| MON-704 | Save / load to a file — `GameState` already serializes, so this is UI plus a schema-version check | Sonnet | S | ✅ PR #22 — `POST /games/load` validates `SCHEMA_VERSION` as a keyed 422; load reachable even from error frames, since a save carries its own board |
| MON-705 | Replay viewer: step through a recorded game's events | Opus | M | ✅ PR #26 — pure client accumulator that copies only facts events assert |
| MON-706 | Sound cues (dice, cash, purchase, jail) with a mute that persists | Sonnet | S | ✅ PR #22 — Web Audio synth, one subscription beside the Announcer's; `rent_charged` deliberately un-cued (its `cash_changed` twin already sounds) |
| MON-707 | Playwright e2e: one smoke per locale plus an RTL layout assertion | Opus | M | ✅ PR #30 — 54 specs, both locales, RTL geometry, kids, trade, keyboard, 44 px sweep, persistence, auctions, cards |
| MON-709 | The drawn card, held up on the board long enough to read | Opus | M | ✅ PR #33 — a beat in MON-701's queue; skippable, non-blocking, deck legible without colour. Reduced motion keeps the card and drops only the motion; a reload's replay drops the card instead |
| MON-710 | Houses and hotels as figures rather than coloured blocks | Opus | M | ✅ PR #34 — pitched cottage against flat stepped block, asserted from the path data; the four fills are measured against the face they stand on, which the old CSS literals never were |
| MON-711 | Action prominence, owned-only dossier, and turns that end themselves | Opus | M | ✅ PR #35 — owner's UX asks from the first playable build; `docs/UX_ACTION_PROMINENCE.md` |
| MON-708 | Empty, loading and error states for every screen | Sonnet | S | ✅ PR #22 — one `EmptyState`/`LoadingState`/`ErrorState` set; added the missing retry on a game screen's failed first fetch |

---

## E8 — Release · M8

| ID | Item | Tier | Size | Status |
|---|---|---|---|---|
| MON-801 | README with a real gameplay GIF in both languages | Sonnet | S | ✅ PR #20 — `README.md` + `README.he.md`, real captured gameplay GIFs per locale (245/254 KB, inter-frame transparency to pass the 500 KB hook honestly) |
| MON-802 | Create the public GitHub repo and push — **human runs this**; the guard blocks agents from repo visibility changes | human | S | ✅ — `GuyFlenner/monopoly`, public, everything flows through PRs |
| MON-803 | Optional deploy: static web + server on a free tier, or a single container | Opus | M | superseded by MON-805 — the owner made online play a requirement, and the serverless static form won |
| MON-804 | `CONTRIBUTING.md` and issue templates | Sonnet | S | ✅ PR #20 — bug template leads with seed + command list, because games are reproducible by design |

### MON-805 — Online play at a public URL (GitHub Pages, engine in-browser) ✅ **DONE** (PRs #25, #29, #31)
**Tier**: Fable design / Opus build · **Size**: L · **Depends on**: everything playable · *(added
2026-07-30 — owner requirement: play from a URL with GitHub hosting the source, no IDE, no local
run; keeping the repo private must stay possible)*

- The engine and the server's pure modules (sessions, schemas, bots — none import FastAPI) run
  in the browser via Pyodide; `kesef_server/browser.py` is the transport for a browser with no
  server, kept honest by a parity test against the HTTP routes.
- The web client plugs a local transport into `ApiClient`'s injectable `fetch`/`createSocket` —
  the UI cannot tell which transport it is on, and still holds zero rules.
- `VITE_ENGINE=local` selects it; wheels are built in CI and installed by micropip;
  `.github/workflows/deploy-pages.yml` publishes to GitHub Pages (owner enables Pages once:
  Settings → Pages → Source: GitHub Actions).
- **Private-repo option** (owner asked): GitHub Pro unlocks private-repo Pages; or CI pushes the
  built site to a separate public deploy repo; or Cloudflare Pages / Netlify / Vercel build from
  a private repo — all free. `docs/DEPLOYMENT.md` walks through each.

### MON-806 — One bot driver per game at a time ✅ **DONE**
**Tier**: Fable · **Size**: S · *(found 2026-07-30 by MON-801's capture rig, fixed same day, PR #21)*

Every command queued `_advance_bots` as a background task, so two quick commands gave one game
two drivers, and the read-one-step-write loop raced its twin: same position read twice, same
move computed twice, same events appended twice — reproduced over pure HTTP, 14 repeated
signatures in a 62-event log. `Session.advance_lock` serializes drivers (the lock lives on the
session because its lifetime *is* the game's); the latecomer re-reads a finished position and
leaves. A skip-if-running flag would have been cheaper and wrong — the running driver may have
already decided "nothing to do" from the position *before* the command that queued the second
task. Both regression tests fail on the unfixed code; the race test needs a 1 ms think delay
because a coroutine that never yields cannot race.

### MON-712 — Auctions off by default, configurable, with a reserve price ✅ **DONE** (PR #37)
**Tier**: Fable design / Opus build · **Size**: M · *(added 2026-08-02 — owner, from a Hebrew game
played with his child)*

**The report.** Declining a property opens the official no-reserve auction, so the child bid ₪1,
won, and did it again every turn. A parent who does not want the auction has no way to turn it off,
and a parent who does want it has no way to stop a ₪1 steal.

**What already exists.** `Ruleset.auctions_enabled` (default `True`, off in Kids Mode) and a
hardcoded floor: `rules/auction.py` opens every lot with `min_bid=1  # no reserve (spec §3.6 trap
5)`, and `legality.minimum_bid` is `max(frame.min_bid, high_bid + 1)`. So a reserve is a `min_bid`
the opener chooses, not new machinery. What is missing is the *reach*: `CreateGameRequest` takes
only a `RulesetName`, so the setup screen can pick `universal` or `kids` and nothing else.

**Shape.**

1. **Engine** — a reserve setting on `Ruleset` (`auction_minimum: "none" | "list_price"`), read by
   `open_auction` for a `TileLot`'s floor. A `BuildingLot` names no tile, so it keeps ₪1.
   `Ruleset.universal()` stays faithful to the printed rules: it is what the test suite and the
   goldens mean by *correct*, and the product's default is a **setup** default, not a redefinition
   of the official rule set.
2. **Server** — per-game house-rule overrides on top of the named rule set. A contract change:
   regenerate `openapi.json` and `packages/web/src/api/generated.ts`.
3. **Web** — visible toggles on the setup screen, **auctions off by default**. No gating code is
   needed for the auction affordance itself: the UI renders `legal_commands`, so with auctions off
   the phase never opens and the panel never appears. `RuleDiff` then shows "auctions: off" as a
   stated divergence, which is the transparency a parent sitting down deserves.

**Why a reserve rather than only a switch.** An increment rule would not help — the ₪1 *first* bid
is the exploit. With the floor at the printed price the auction stops being a discount and becomes
"does anyone else want it at the sticker price, in turn order?", and a square nobody wants at that
price stays with the bank, which is the same outcome as auctions off. The no-reserve rule remains
available for players who want the printed game.

**What landed.** `AuctionMinimum` (`none` | `list_price`) on `Ruleset`, defaulting to the printed
rule; `auction.opening_floor` reads it per *lot*, so an estate queue prices a ₪60 deed and a ₪400
deed separately rather than carrying the first one's floor. `HouseRules` on `NewGameRequest`, a
closed set of fields with `extra="forbid"` — an open patch over `Ruleset` would have let a client
award itself 500 houses — applied as an amendment, so a kids game keeps everything Kids Mode changed.
The setup screen owns the product default and states the divergence on screen.

Two consequences worth knowing. A reserve applies to a **bankruptcy** estate too, so a lot nobody
will pay list price for returns to the bank instead of selling cheap; that is the same rule read
consistently, and the setting is opt-in. And a bidder who cannot reach the floor is offered no bid at
all — only the withdrawal, plus the selling and mortgaging that `AUCTION` already allows (G-B1a).

The golden games shifted by exactly eight lines, all of them `"auction_minimum": "none"`, proven
before regeneration.

### MON-713 — A reload must not lose the game ✅ **DONE** (ADR-010)
**Tier**: Opus · **Size**: S · *(found 2026-08-03 by probing the published artifact)*

**The defect.** In the deployed build the engine runs in the tab, so a session is Python objects in
the Pyodide heap. Reload and the heap is new: the store answers a truthful 404 for the game the URL
names, and the player is shown *"המשחק הזה לא קיים יותר"*. No crash, nothing in the console, and the
game gone. The **server** build rehydrates from the same URL, so the configuration nobody plays was
fine and the configuration everybody plays was not.

**How it hid.** The Pages smoke asserted the game id reaches the URL and said in a comment that this
"is what makes a reload rehydrate rather than abandon" — a true sentence about the server build,
written next to an artifact where it was false, and never tested because the spec never reloaded.
That is the general lesson worth keeping: the deployed configuration had **one** smoke test while
the development configuration had fifty-four.

**The fix** is ADR-010: inside `src/local/` only, snapshot the game to `localStorage` after every
mutation and after the bot pump, and restore it when a plain `GET /games/{id}` 404s. It reuses
MON-704's save/load routes and MON-805's `onMutation` seam; nothing above `src/local/` changes, and
the server build is untouched.

**Measured on the artifact**: 2 ms median per snapshot, 4.2 KB payload, against ~900 ms for an easy
bot's turn.

**Known limitation, stated rather than hidden**: the event log does not survive, because the log
belongs to the session and the save file is a `GameState`. After a reload the board, the money, the
deeds and the turn are exactly right and *"What's happened"* starts fresh. Restoring it would be a
contract change in the API both builds share. — **fixed by MON-715**, which made that contract change.

---

### MON-714 — A load whose game is still live asks the player ✅ **DONE** (ADR-011)
**Tier**: Opus · **Size**: M · *(`docs/A11Y_AUDIT.md` D1, deferred 2026-08-01 as a product decision;
decided by the owner 2026-08-03)*

**The defect.** Leaving a game in the UI does not end its session, so re-uploading the file you just
downloaded was refused with `409 error.game_already_exists`. A player who saved and then loaded in one
sitting could not restore; the only way through was a server that had forgotten the game.

**Why it was deferred rather than fixed.** Three defensible answers — a load *replaces* the live
session, a load *mints a new id* and the file is a template, or the player is *asked* — with different
consequences for the URL, for a second tab, and for what "the same game" means. The audit filed it
instead of deciding it, and pinned the refusal in both languages so that whoever decided would have to
flip a test rather than discover a behaviour.

**The decision** is *ask* (ADR-011). `POST /games/load?if_exists=refuse|replace|copy`, defaulting to
`refuse`, so the unchanged request still answers the 409 it always did; `LoadSavedGame` keeps the parsed
file, renders the two answers under the keyed refusal it already rendered, and re-posts with the answer.
Cancelling clears both, and the picker underneath was always the retry.

**Why not the other two.** A silent `replace` is one store method and no UI, and it ends a game in
progress with no warning when the file is older than the table — for an audience that includes
six-year-olds pressing things, one extra press is the only defence for the case they did not mean.
Always minting an id never destroys anything and makes "continue this game" quietly produce a
*different* game: a new URL, a save file whose id no longer names it, and a session per attempt against
`max_sessions`.

**One correctness fix came with it**: `SessionStore.update` takes the `Session` the caller read rather
than the id, because a bot driver reads a session, awaits a thinking delay, and writes — and a replace
in that window would have appended the old game's move to the new game's log. `Session.advance_lock`
could not have prevented it; the replacement holds a different lock.

---

### MON-715 — The event log travels in the save file ✅ **DONE** (ADR-011)
**Tier**: Opus · **Size**: M · *(the limitation MON-713 shipped with, stated in its own entry above)*

**The defect.** `Session.log` is not a `GameState` field, so a save file could not carry it. A restored
game came back with its board, money, deeds and turn exactly right and *"What's happened"* empty — and
because ADR-010's reload insurance restores through the same save/load routes, that was true of every
reload in the published build, not only of a file a player chose.

**The fix.** `GET /games/{id}/save` answers a `SaveFile` — `{state, events}` — and `POST /games/load`
accepts it. The events are bare engine `Event`s: `seq` is assigned by the store and nowhere else, so a
restored log is stamped `1..N` exactly as a live one is. **A bare `GameState` still loads**, which is
every file saved before today, and every `localStorage` slot written by the build before it.

**No client change was needed to deliver it**, which is the pleasing part: `useGame` already asks for
`?since=0` on its first fetch, so the UI replays whatever log the session has. It had nothing to replay.

**Measured, and only what was actually measured.** A four-seat game on the classic board, seed 7,
played forward by the same rule the parity harness uses:

| Turn | Events in the log | Envelope | State only |
|---|---|---|---|
| 1 | 3 | 4.8 KB | 4.5 KB |
| 6 | 71 | 10.7 KB | 4.4 KB |
| 12 | 132 | 16.0 KB | 4.4 KB |
| 13 | 144 | 17.4 KB | 4.4 KB |

So the state is flat and the log grows at roughly **0.9 KB per turn**. At turn 13 a save is **3.4 % of
the 512 KB `max_save_bytes` ceiling**; a game would have to run into the hundreds of turns to reach it,
and one that did answers `error.save_too_large` on the way back in — the existing guard doing its job
rather than a new failure. Serializing the whole envelope costs **0.14 ms median** (max 0.32 ms) in
CPython.

**Not re-measured**: the 2 ms snapshot figure ADR-010 took on the built artifact under Pyodide. What
changed on that path is the size of the JSON string it carries — four times larger at turn 12 — and
this entry does not claim a new number for it. The artifact is still covered for *correctness* by
`e2e-pages/local-engine.spec.ts`, which now asserts the log survives a real reload.

---

## E7b — What the owner found playing it (M8)

Four asks from one evening's play, 2026-08-04, batched because they are all *defaults and comfort* and
none of them touches a rule. Every one is a change to what a family gets **without pressing anything**.

### MON-716 — The Israeli board is the default ✅ **DONE**
**Tier**: Opus · **Size**: S

The picker offered `classic` first because `available_boards()` sorted alphabetically and the setup
screen takes `boards[0]`. For a game called *רחוב הכסף* that opens in Hebrew, that is the wrong board to
hand a family who presses nothing.

Fixed in the **engine**, not the UI: `PREFERRED_BOARDS` puts Israel at the head of the list and the
docstring states what the head means. `SetupScreen.tsx` already refused to hardcode an id ("the list of
boards is the server's to decide"), so the coupling was documented before it was load-bearing — and it
is now pinned from both sides, including a web test with a two-board fixture that would catch anybody
"simplifying" the component into `find(id === "classic")`.

### MON-717 — A Hebrew table starts on the masculine ✅ **DONE**
**Tier**: Opus · **Size**: S

The seat gender defaulted to `"n"` (them/they) in every language. Hebrew conjugates every verb in the
narration by the subject's gender, and "them" is the one option a Hebrew sentence cannot use gracefully,
so a Hebrew setup screen now offers the masculine.

**This amends an earlier decision, deliberately and on the owner's word.** `SeatConfig` documents
*"`n` is the neutral fallback, never the masculine"* (owner decision 5, GAP G-42). That sentence is
still true of the *fallback* — a seat nobody chose for, in a language nobody chose — and what changed is
the *default offered on a Hebrew screen*, where the control is visible and two presses change it per
seat. The English default is unchanged and is asserted, so the amendment cannot quietly widen.

### MON-718 — No confirm for a decline that costs nothing ✅ **DONE**
**Tier**: Opus · **Size**: S

*"בטוחים? אף אחד לא קונה את המשבצת בתור הזה…"* stood in front of the commonest action in the game to
warn about a consequence that, with auctions off, does not exist: the square simply stays unsold and the
next player to stop there may buy it.

So `requiresConfirmation` takes the ruleset. With auctions **on** the dialog stays — a mis-tap really
can hand the deed to somebody for a pound — and with auctions off, which is this product's default
(MON-712), declining goes straight through. `ACTION_THEME` still classes the command `terminal`, because
that is its cost when there is an auction to lose the tile to; the ruleset is applied at the one
predicate every caller already went through, so a chit's dashed rim and the dialog cannot disagree.

Two things fell out of it: the `_no_auction` consequence sentence is now unreachable and was **deleted
from both catalogues** rather than left as dead text, and `Hint.terminal` moved to the static
`TERMINAL_COMMANDS` — a hint asking "may I offer a shortcut?" wants the cost of the action, which no
ruleset makes cheaper to get wrong.

### MON-719 — A card stays up long enough to read, and the table decides ✅ **DONE**
**Tier**: Opus · **Size**: M

The dwell was 1800 ms, chosen as 1.5 × the `<Announcer>`'s step so a card was still on screen when the
polite region finished saying it. Sound reasoning, and still too short to *read* two sentences aloud to
a six-year-old — the owner could not finish a Chance card before it left.

The default is now **5 s**, and the table sets it in seconds on the setup screen (2–15). It is a
`localStorage` preference beside the mute and motion switches, **not** on the create-game request: how
long a card is *shown* belongs to whoever is looking at the screen, so a save restored on another device
must not carry somebody else's reading speed. `useAnimationQueue` reads it itself, the way it already
reads the motion preference, so the replay viewer honours it without being told.

**One consequence, stated rather than discovered:** two cards in one batch are now 10 s, which exceeds
the animation budget, so a burst of draws compresses and drops the superseded card — the behaviour the
compression ladder already documented for three or more. Three tests that had been relying on the old
tempo to stay uncompressed now say so explicitly, which is a better test than the one it replaced.

### MON-720 — Money says which money it is ✅ **DONE**
**Tier**: Opus · **Size**: M · *(the last advisory from `docs/A11Y_AUDIT.md`; decided by the owner 2026-08-04)*

**The defect.** Eighteen English *cards* said `$50`, because a card is prose somebody wrote. Every figure
the UI *computed* — cash, rent, a bid, a net worth, a price on a square — was a bare number, in both
languages. So a child read "pay $50" on a card and watched a bare 50 leave their pile: the game
contradicting itself about its own currency. The Hebrew cards said `50`, naming no currency at all.

**Why it waited.** `i18n/index.ts` said so where the interpolation formatter lives: *"Not a money
formatter. Amounts still interpolate bare. Deciding how currency renders (symbol, placement, grouping)
changes English output and wants a product decision."* GAP G-43. The owner made it: **`$50` in English,
`50 ₪` in Hebrew.**

**The shape of the fix.** A `money` format spec, named **per string** rather than per placeholder — and
the catalogue is what proves that has to be so: `{{minimum}}` is money in `error.bid_too_low` and a
number of *players* in `error.too_few_players`. Only the sentence knows. 32 placeholders carry the spec
in each language; the figures that never reach a sentence (a dossier's cash, a price on a square) get
the same answer from `useMoney()`.

Three things worth knowing:

* **The shekel sits after the figure, with a non-breaking space** — `50 ₪` — so a 320 px column cannot
  split the pair across a line. Written as ` `, because an invisible code point in source is one
  nobody reviewing a diff can see.
* **Thousands are grouped by hand** (`$1,500`), not by `toLocaleString`: a figure that is `1,500` in one
  browser and `1 500` in another is a figure a bug report cannot be trusted about.
* **`Intl` currency formatting is deliberately not used** — it prints `50.00 ₪`, and this game has no
  agorot. The reasoning is in `money.ts`.

**What it cost:** 22 unit assertions and 3 e2e assertions that had pinned bare numbers now pin the
symbol. The parity check needed teaching too: `_placeholders` matched only `{{name}}`, so a format spec
would have made it stop seeing all 32 money placeholders — a test that still passes and no longer looks.

---

### MON-721 — Declining a purchase hands the dice on ✅ **DONE**
**Tier**: Opus · **Size**: S · *(owner, 2026-08-04, immediately after MON-718 removed the confirm)*

*"If I chose not to purchase, end the turn; the next click should be the next player rolling."* The same
request MON-711 answered for a *purchase*, from the other side — and it needed a different mechanism.

**A decline emits no events.** With auctions off, `rules/purchase.py::_decline` returns `(state, ())`:
the state unchanged, the log untouched. So MON-711's committed-log trigger cannot see a decline at all.
The other half of that same fact is what makes acting immediately safe: the perceptibility argument
behind the log trigger is about not dropping a purchase's own beat, cue and sentence, and a decline has
none of the three to drop.

So `endTurnAfterDecline` reads the **response** to the decline and asks it the question the other path
asks the log: is `end_turn` in `legal_commands`, for this seat? Same one rule — *the command is an
element of the engine's own list, never one we constructed* — and therefore the same two things it must
never start checking: **auctions** (declining with auctions on opens an interrupt, during which
`end_turn` is simply not offered, so the lookup fails on its own) and **doubles** (`post_move_phase`
decides; after doubles `end_turn` is not in the list either). Both are covered by tests that would go
red if somebody "helpfully" added a ruleset check.

The e2e assertion is *"no `end_turn` chit, and a `roll_dice` one"*, which holds whichever way the deal
went — an ordinary roll ends the turn, doubles re-rolls — so it cannot be flaky about the dice.

---

## E4b — Contract gaps found while building the UI (M4)

Each was found by a component that then had to work around it. Every workaround is either
a passive-voice sentence, a translation at the render boundary, or a client-side diff — i.e.
a place where the UI is doing something the engine or the projection should do. **Tier**:
Opus unless noted · **Size**: S each unless noted.

> **Status 2026-07-31: every row below is ✅ DONE.** MON-416 and MON-422 closed in M4's
> follow-up session; the remaining eight (413/414/415/417/418/419/420/421) landed together in
> PR #19, each fix deleting the workaround that had reported it. The one golden shift
> (MON-414's `player` on `mortgage_changed`) was proven to be exactly 24 lines before the
> official regeneration — the discipline held.

| ID | Gap | Found by | Fix |
|---|---|---|---|
| MON-413 | **`BuildingChanged` cannot say "hotel"** — it carries `tile`, `houses`, `delta` but no building level, so the log says "building". Saying "hotel" in the client would encode "five houses is a hotel" in TypeScript. | MON-407 | Add `level`/`kind` to the event. |
| MON-414 | **`MortgageChanged` carries no player**, so the log cannot name who mortgaged and renders in the passive voice. | MON-407 | Add `player`. |
| MON-415 | **`rent.note.full_group_doubled` interpolates a raw `ColorGroup`** (`note_params={"group": group.value}`), so the client translates an engine enum at the render boundary; its catalogue sentence also wants a `{{name}}` the event does not carry. | MON-407 | Send a key, not a value; add the missing param. |
| MON-416 ✅ **DONE** | **Spec §5.5's "every rent has a note key, including the plain base-rent case" was unmet** — `_property_rent` emitted `note_keys=()` unless the whole-group doubling applied, so the commonest rent in the game (the printed figure on a lone unimproved square) was the only charge with no reason attached. The utility, railroad and card paths always explained themselves. Fixed 2026-07-29: exactly one note in every case, chosen by which rule produced the number — `rent.note.base`, `rent.note.with_houses` (with the count, because the tier ladder is why the figure jumped), `rent.note.with_hotel` ("a hotel" is what a child sees, not "five houses"), and the existing doubling note. The cases are ordered, not independent: a built square is never *also* group-doubled, since the doubling compensates for having no houses. Tested four ways plus an invariant over 40 seeded games asserting no rent any path can produce is ever unexplained — which is what catches a fifth rent path added without a note. Goldens unaffected: they record a reduced event projection (`amount`, `player`, `type`). |
| MON-417 | **`/rulesets` returns raw flags** (G-36 still open), so MON-408 diffs the two rulesets client-side and maintains its own `ruleset.<field>` label map. | MON-408 | `RulesetView` with `label_key` + `differs_from_universal` per flag; deletes both client-side pieces. |
| MON-418 | **"At least two players" surfaces as `error.malformed_request`** because the constraint is a pydantic `min_length` on the seats field, so the screen cannot tell a parent *what* is wrong. Duplicate names get the barely-better `error.invalid_new_game`. | MON-408 | Keyed errors from the factory (it raises bare `ValueError` today — see the M3 note in `errors.py`). |
| MON-419 | **`BoardSummary` has no `catalogue_ready`** (G-46 still open), so the picker can offer the Israeli board whose tile keys resolve to nothing and which paints blanks. | MON-408 | Add the flag; filter the picker; server test. |
| MON-420 | **`TileView` carries no effective current rent** — the multipliers live in private `rules/rent.py::_property_rent`, so MON-405/406's "explain this rent" screen has nothing to render. **Size M.** | M3 review | Engine accessor `state.rent_due(tile, *, payer_id) -> RentQuote \| None` carrying the fields `RentCharged` already does, so quote and charge share one shape; utilities need the throw. |
| MON-421 | **`GroupHoldings` computes 3 of its 6 numbers by server-side arithmetic**, the third copy of the `properties[i].owner == player` predicate. | M3 review | `state.group_holdings(player, group)` in the engine; the projection becomes a pure copy. |
| MON-422 ✅ **DONE** | **`TradeBuilder` had no review side.** Fixed 2026-07-29: an optional `frame` prop selects review mode, which renders the pending offer read-only — both sides' cash, named properties and jail cards — with accept and decline in the panel footer. `respond_to_trade` carries `frame.offer.recipient`, **not** the acting seat: a review interrupts the proposer's turn, so reading "current player" would have made accept fail for the very player looking at it. Draft mode is untouched and is still the default. The App test that covered this previously asserted the *builder's* heading on a review frame and passed while the recipient saw two empty trays — a green test describing the bug. It now reads the offer's actual cash figures and named square off the screen, and `e2e/trade.spec.ts` drives the whole propose → review → answer round trip against a real engine. That spec also surfaced a pre-existing wart: `panel === "trade"` stayed set after sending, so the builder reopened over the board the moment the interrupt resolved and answering appeared to do nothing. Sending now closes the panel. |

Not filed as items because they are already owned: the catalogue's remaining camelCase leaves
(G-40 → MON-501), Hebrew for every English-only key added in M4 (MON-501/506), and the
MON-901 network-play exposures listed in the M3 review.

---

## E10 — What the mutation gate found (M8)

### MON-722 — The tests the mutation gate says are weakest 🟡 **PARTLY DONE**
**Tier**: Fable (insolvency) / Opus (legality) · **Size**: M · *(found 2026-08-04, by MON-209's gate
running for the first time)*

The gate passes — **3270/3471 = 94.2%**, against an 80% floor, in 87 minutes — and *where* it does not
pass is worth more than the headline. 201 mutants survived across 67 functions, in two clusters:

| Survivors | Function | Why it matters |
|---|---|---|
| 17 | `rules.insolvency._void_claims_of` | |
| 9 | `rules.insolvency._without_claims_of` | The bankruptcy chain: a bug here is worst and hardest to |
| 6 | `rules.insolvency._tile_value` | notice, because a creditor's claims being voided slightly |
| 5 | `rules.insolvency._charge_mortgage_transfer_fees` | wrong is invisible until a game is reconstructed by hand |
| 13 | `legality._build_house` | |
| 11 | `legality._trade_side` | The even-build and estate rules — the predicates that decide |
| 7 | `legality._sell_house` | which buttons exist |
| 6 | `legality._unmortgage` | |
| 8 | `legality._sort_key` | **The order `legal_commands` comes back in.** `ActionBar` renders it verbatim, so this is button order on screen, and nothing asserts it |
| 7 | `rules.cards._apply_step` | |
| 6 | `rules.rent.charge` | |
| 6 | `rules.turns.advance_turn` | |

**What this is not.** It is not a reason to raise the threshold, and not a licence to write tests until
the number moves: a mutant killed by an assertion nobody would have written is a test that exists to
satisfy a tool. The two clusters are worth attention because they are *where the rules are hardest* —
MON-207's chains and MON-201's even-build — not because 94.2% offends.

**Where to start**: `_sort_key` is the cheapest and the most visibly wrong to leave — it is user-facing
order with no assertion behind it. The insolvency cluster is the valuable one and wants the Fable tier,
since a wrong claim-voiding rule is exactly the class of bug this project's golden games exist to catch.

The full survivor list is in the `mutmut-results` artifact of any nightly run.

#### What was done, 2026-08-04 — and how each test was checked

Three assertions, each **verified by hand-mutating the implementation and watching the test go red**.
That step is the whole discipline here: the first version of the ordering test passed and killed
*nothing*, which is precisely the failure this item is about, and only the check found it.

| Test | Kills |
|---|---|
| `test_the_order_groups_by_kind_across_seats_rather_than_by_seat` | swapping `kind`/`player` in `_sort_key`; dropping `kind` |
| `test_the_order_within_one_kind_and_seat_follows_the_parameter` | dropping `detail` |
| `test_a_debt_owed_to_a_leaving_creditor_loses_only_that_creditors_share` | keeping every obligation; voiding the wrong side of `!=`; dropping the frame whole |

Two findings from doing it:

* **The ordering test needed two seats to be falsifiable at all.** With one player, "sorted by kind
  then actor" and "sorted by actor then kind" produce identical output — so the single-seat version
  asserted a tautology. `ActionBar` renders this order verbatim, so it is button order on screen.
* **One survivor is a genuinely *equivalent* mutant.** Dropping `variant` from `_sort_key` cannot change
  the output of any state this engine can build: `_candidates` already yields `False` before `True` for
  one tile and `sorted` is stable. It is unkillable by observing behaviour, and it is recorded as such
  rather than chased. Dropping `detail`, which looks equally equivalent, is *not* — with `detail` gone
  the variant dominates and the tiles interleave. Both answers came from measurement, and one of them
  contradicted the prediction written here first.

#### One flake found on the way, and fixed

`test_soundness_every_enumerated_command_is_accepted_by_apply` failed once in a full-suite run and then
passed six times in isolation. Not a soundness bug, and the six clean runs are what prove it rather than
luck: hypothesis saves a failing example and replays it first, so no saved example means `apply` never
raised — which leaves the two **run-level** assertions after `check()`, the ones outside `@given`.

The coverage floor is a statement about a distribution: the test's own comment says *"the rarest floor
kind lands 5-25 times per run"*, and a floor of five is zero often enough to matter. So the property is
now `derandomize=True`. A gate that fails for reasons unrelated to the code under test costs more than a
fresh seed buys, because the first response to a flaky gate is to stop reading it — and the exploration
is not lost: the same 600 structurally-generated states still exercise soundness every run, the goldens
replay real games, and every other property in the file stays random.

Pre-existing, and unrelated to this session's changes; tripped by chance while re-running the suite.

#### What is deliberately left

The **legality-predicate cluster** (`_build_house` 13, `_trade_side` 11, `_sell_house` 7,
`_unmortgage` 6) and the remaining **insolvency** survivors. Left open on purpose rather than run to
zero, for the reason stated above: a mutant killed by an assertion nobody would otherwise have written
is a test that exists to satisfy a tool. These four predicates are covered by unit tests, the golden
games and the `legal_commands`/`apply` agreement property; what the survivors say is that some of their
*boundary* arithmetic (even-build edges, group completeness, mortgage interactions) is asserted less
tightly than the happy path. That is worth a deliberate session at the Fable tier with the rules open,
not a sweep.

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
                 └─► MON-501 ─► MON-502 / 504     (M5; MON-503 and MON-506 both done)
MON-601 ─► MON-602 ─► MON-603 · MON-604 ─► MON-605                                        (M6)
```

**Parallelism**: MON-401 and MON-402 need only the *contract*, not the rules, so the entire
web foundation can be built alongside E1/E2. That is why the API schemas were fixed at M0.
