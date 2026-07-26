# Gap Analysis — Phase 0 (critique before build)

- **Date**: 2026-07-26
- **Method**: six independent adversarial explorations, each reading the code rather than the
  docs, per `FABLE_KICKOFF.md` §3 — (1) rule completeness, (2) state model, (3) API contract,
  (4) i18n/RTL, (5) test-strategy honesty, (6) accessibility and child-usability.
- **Verdict**: M0's craftsmanship is real — the reducer shape, the RNG design, the board data
  and its tests, the `legal_commands` contract — but the design has **structural gaps that make
  MON-101 unbuildable as specced**. Every one is cheap to fix now and expensive after E1.

**Severity**: `blocker` = the specced rules cannot be implemented correctly on these shapes ·
`major` = will produce a wrong game or an unfalsifiable gate · `minor` = awkward but workable.

---

## 0. The four root causes

Almost every blocker below is one of these four, seen from a different angle:

| # | Root cause | Findings it explains |
|---|---|---|
| R1 | **Interrupts are modelled as one scalar `phase` plus three nullable slots**, but the specced rules nest interrupts to depth ≥ 3 and queue auctions. The spec's "at most one interrupt is live at a time" (§3.1) is false for its own rules. | G-1..G-5, G-20 |
| R2 | **Derived state never crosses the wire.** `GameView` ships the raw `GameState`; everything useful (`board`, `net_worth`, group completion, dice total) is a `@property` pydantic silently drops. | G-30..G-36 |
| R3 | **Every enforcement mechanism checks one side of a boundary against itself.** The locale test compares en↔he, never engine→catalogue. The CSS lint reads string literals, not templates or CSS. The server test pins the key the server sends, not that anyone can resolve it. The RTL assertion would be set and satisfied by the same line of code. | G-40..G-44, G-60..G-63 |
| R4 | **The a11y floor is prose owned by nobody** — the only enforcement is an audit at M7, after every screen has shipped. | G-50..G-56 |

---

## 1. Rules and state model (explorations 1 + 2, convergent)

### Blockers

| ID | Gap | Where | Fix |
|---|---|---|---|
| G-1 | **No interrupt continuation.** `phase` is a scalar; an interrupt records nowhere to return to. Debt-during-auction, trade-during-debt (MON-207 allows trading to raise cash), and TRADE_REVIEW from a portfolio phase are unexpressible; a save mid-interrupt cannot resume. | `state.py:123`, `phases.py:15-17` | Replace the three nullable slots with `interrupts: tuple[InterruptFrame, ...]` — a stack of tagged frames (`Auction`/`Debt`/`Trade`/`Card`), each carrying its own resume phase. Keep derived `.auction`/`.pending_debt` properties. Delete the "at most one interrupt" sentence from spec §3.1. |
| G-2 | **Interrupts nest to depth ≥ 3 from specced rules alone**: card → unpayable rent → debt → trade to raise cash → declined → debt → bankruptcy → estate auction → 10% fee debt on the recipient. | `state.py:132-134`, MON-207 | Same fix as G-1. Add MON-209 invariant: interrupt depth bounded and decreasing on non-escalating commands. |
| G-3 | **`AuctionState` cannot express two of the three required auction kinds.** Subject is always a `TileIndex` — the building-shortage auction (trap #4) auctions a *house*; bankruptcy-to-bank auctions an ordered *queue* of N tiles. Why-the-auction-started is stored nowhere, and the continuation differs per cause. | `state.py:86-93` | `AuctionState.lot: TileLot \| BuildingLot`, `reason: AuctionReason` (declined / bankruptcy / shortage), `eligible: tuple[PlayerId,...]` stored (today it exists only on the `AuctionStarted` event and is lost on reload), plus an auction queue in the interrupt frame. |
| G-4 | **The building-shortage auction is unrepresentable, not merely unimplemented.** No lot type, no command to express *wanting* a building, and no way to detect contention in a sequential reducer — first `BuildHouse` simply wins. The rule has no home: `development` owns the shortage, `auction` owns bidding, nobody owns the lot. | trap #4, MON-201/203 | **Owner decision** (§6 of the kickoff): (a) declare-intent model — `BUILDING_CLAIM` phase + building lots; or (b) documented divergence — first-come-first-served, `Ruleset.building_shortage_auction: bool = False`, and trap #4's second sentence deleted. Recommendation: **(b) for v1** — the claim-window mechanic is heavy for a hotseat game and (a) remains buildable later on the G-3 lot type. |
| G-5 | **`DEBT_SETTLEMENT` and `JAIL_DECISION` are not portfolio phases — two spec self-contradictions.** MON-207 says a debtor may sell/mortgage/trade; `PORTFOLIO_PHASES` forbids all three, making every debt instantly fatal. Trap #8 says a jailed player builds and trades; a jailed player's turn never visits a portfolio phase. | `phases.py:66-67` | Two frozensets: `PORTFOLIO_PHASES` (+ `JAIL_DECISION`) and `RAISING_PHASES` (`DEBT_SETTLEMENT`, and the bidder's turn during `AUCTION`): sell/mortgage/trade allowed, build/unmortgage not. MON-101 acceptance names both. |
| G-6 | **The Kids-Mode clock can never fire.** `target_duration_minutes` exists; no state field, no command carries time; `apply` is the only entry point. `GameEnded.reason="time_limit"` is dead code. | `ruleset.py:55`, `commands.py` | `EndTurn.elapsed_seconds: int \| None` (caller-stamped; engine stays clock-free) + `GameState.elapsed_seconds`. Also pin `turn_number` semantics (per player-turn). |
| G-7 | **Multi-creditor debt is unrepresentable.** The standard "pay each player ₪50" card creates five simultaneous debts; `DebtState` holds one creditor. | `state.py:96-102`, MON-206 | `DebtInterrupt.obligations: tuple[Obligation, ...]`; settle in turn order; MON-207 owns the multi-creditor bankruptcy division rule explicitly. |
| G-8 | **Two-player bankruptcy-to-bank deadlocks.** Endgame-first → frozen game with a live auction and no legal command; auction-first → the sole survivor bids ₪1 pointlessly. | MON-207/208 | Spec the ordering: endgame evaluates after interrupts drain; an auction lot with < 2 eligible bidders is voided. MON-209 invariant: `GAME_OVER ⇒ no live interrupts`. |
| G-9 | **`CARD_RESOLUTION` is transient but a card can create an unpayable debt mid-effect** — the card's identity and unfinished half (advance-and-pay-double, utility rent roll) are lost. | `phases.py:60` | `CardInterrupt(card_id, deck, step)` frame (part of G-1); ship `pending_card` in the view so the UI keeps the card face-up during the debt dialog. |

### Major

| ID | Gap | Where | Fix |
|---|---|---|---|
| G-10 | One `dice` slot can't hold a movement roll and a card-driven rent roll (trap #9); a rent roll would destroy `doubles_streak` (trap #7) or emit a lying `DiceRolled`. `RollForJail` doubles must *not* re-roll but `is_doubles` reads true. | `state.py:71-83` | `DiceState.purpose: Literal["move","jail","rent"]`; move `doubles_streak` to `GameState` (it is a property of the turn); `DiceRolled.purpose` mirrors it. |
| G-11 | Jail cards are a count, not identities — the engine can't return a used card to the bottom of *its own* deck; deck composition silently corrupts, breaking determinism and goldens. Bankruptcy transfer of jail cards is owned by nobody. | `state.py:59` | `jail_cards: tuple[Deck, ...]` on `PlayerState` and `TradeSide`; MON-209 invariant: jail-card multiset conserved; `PlayerBankrupted` gains `cash_transferred` + `jail_cards_transferred`. |
| G-12 | Doubles-out-of-jail is specced nowhere; a literal MON-102 reading grants an extra roll (wrong — move, no re-roll). Compulsory-fine-with-no-cash path unspecced. | MON-205 | Explicit MON-205 bullets for both; MON-209 invariant: `bankrupt ⇒ not in_jail ∧ no cards ∧ no tiles`. |
| G-13 | Mortgaged-property transfer fee (trade *and* bankruptcy): who pays the 10%, when, and what if they can't — unspecced; no `CashReason` for it. Immediate-fee model enables creditor-side cascade the event set forbids (`GameEnded.winner` non-optional, no "no survivors"). | MON-204/207, §3.6 #6 | **Deferred-fee model**: the receiver owes the 10% only on unmortgaging — matches the official rule's alternative and makes creditor cascade impossible by construction. `CashReason.MORTGAGE_TRANSFER_FEE` for the immediate half-fee the official rule charges at transfer... **Owner decision**: official dual-fee vs deferred-only. Recommendation: official (charge the standard 10% at transfer *or* defer per the printed rule) — but pick in §3.6 #6, not in code review. |
| G-14 | Bankrupt current player → stuck game with empty `legal_commands` — the worst failure mode for a UI driven entirely by `legal_commands`. | `state.py:124` | MON-102: bankrupt seats auto-advance. **MON-209 gains the single deadlock-catching invariant: `legal_commands(state)` is non-empty unless `phase is GAME_OVER`.** |
| G-15 | Auction termination underspecced: skip the standing high bidder? end at one active bidder? min increment (`gt=0` only)? zero-cash eligibility? Bank-triggered auctions have no declining player to order from. | MON-203 | Four MON-203 bullets: order stored on `AuctionState`; high bidder skipped; last active bidder wins at standing bid; min increment ₪1; zero-cash players eligible to withdraw only. |
| G-16 | No `TradeProposed`, `TradeCancelled`, or `DebtSettled` events — the WS stream never carries an offer, replay can't reconstruct `pending_trade`, cancellation is invisible. Pending trades aren't voided on bankruptcy. | `events.py` | Add the three events; system-void a pending trade when a party goes bankrupt or named holdings change. |
| G-17 | **Rules with no home**: tax tiles, GO salary, free parking, go-to-jail tile, inert jail. Will be squeezed into whichever module the implementer is in. | `rules/__init__.py` | New **MON-108 — inert and cashflow tiles** (`rules/tiles.py`), listed with its ID. |
| G-18 | `DebtState.amount` semantics ambiguous (gross vs overdraft — `DebtIncurred` carries both `amount` and `shortfall`, implying opposite models); two implementers will pick differently and the invariant passes either way. | `state.py:96-102` | Pin the **shortfall-as-data** model: cash never goes negative; `amount` is the outstanding gross; drop `shortfall` from the event (derivable). See G-42. |
| G-19 | State validation holes: hotel on GO validates; `owner=99` validates; `mortgaged+houses` validates; `schema_version` documented as a load guard and never checked; `bot_level: str` accepts `"banana"` while `BotLevel` enum exists; `houses_remaining=32` default silently contradicts a custom ruleset. | `state.py` | Extend `GameState._check` (cross-validate vs board, tie stock to ruleset, interrupt⇔phase, winner⇔GAME_OVER); enforce `SCHEMA_VERSION`; type `bot_level: BotLevel \| None`; collapse redundant `is_bot` to a property; bounds on dice/position/bids. |

### Minor (recorded, fix opportunistically)

Concession unreachable (`GameEnded.reason="concession"` but no resign path) · Income-Tax 10% option undecided (declare flat-only for v1) · free-parking pot inputs unspecced + `free_parking_pot` bool/int name collision (rename ruleset flag `free_parking_pot_enabled`) · `elimination_order` missing (standings unrepresentable — all bankrupts tie at 0) — *promoted into the G-1 state rework* · docstring says 18 wasted slots, is 12 · `None`-as-bank sentinel → `PlayerId | Literal["bank"]` · duplicate token/name checks missing.

---

## 2. API contract (exploration 3)

### Blockers

| ID | Gap | Where | Fix |
|---|---|---|---|
| G-30 | **No board data on any endpoint** — tiles, names, groups, prices, rent tables absent from the wire. `Board` is a `@property` pydantic drops; no `GET /boards/{id}`. MON-403/405/406/407/410 cannot render. `theme/groups.ts` is currently unreachable code. | `schemas.py:47-57` | Add `board: Board` to `GameView` (one line — `Board` is already a frozen serializable model, ~4 KB, static per game). |
| G-31 | **`net_worth` and group completion are computed server-side and not shipped** — the dossier would re-implement the valuation rule (mortgaged ⇒ 0) and `owns_whole_group`. The exact `if cash < rent` failure mode, one layer up. | `state.py:191-206` | `net_worth` as a `computed_field` on `PlayerState`; per-player `group_holdings` roll-up on the view (`{group, owned, total, complete, houses, mortgaged_count}`) — also feeds MON-605 hints with zero rule knowledge. |
| G-32 | **No route exposes `is_legal`** — `TradeBuilder` (MON-410) is specced to validate drafts live, and `legality.py` explicitly delegates trades to `is_legal`. The UI's options are speculative-422-as-validation or reimplementing trade rules. | `api.py` | `POST /games/{id}/validate` → `{legal, reason_key, params}`. Non-mutating. Schema fixed now so MON-410 keeps its parallelism. |
| G-33 | **No error schema** — `IllegalCommandError` carries `reason_key` **and context params**; the API returns a bare `detail` string and drops the params. `error.insufficient_funds` can never say how much short. | `errors.py:23-26`, `api.py:128` | `ErrorResponse{reason_key, params}` + exception handler + `responses={422: ...}` declared so it reaches `generated.ts`. |
| G-34 | **No event sequence numbers, no cursor, and the WS route is not even declared** — reconnect replay (MON-303) has no `?since=`, duplicate events are indistinguishable (animation queue will replay/drop), and MON-402 has no typed WS contract to build against. | `sessions.py:34`, `api.py` | `seq: int` on the event envelope (session-assigned), `event_cursor` on `GameView`, `GET /games/{id}?since=`, declare the WS route. |

### Major

| ID | Gap | Fix |
|---|---|---|
| G-35 | **Secrets on the wire**: full deck order + RNG seed ship in every `GameView` — a devtools cheat channel now, a real one when MON-901 lands. | `GameView` carries a projection: `deck_counts`, no `rng`. Full `GameState` moves to `GET /games/{id}/save` (the save-file path). |
| G-36 | Events are not self-contained: `RentCharged` has the note key but none of the numbers (`{{houses}}`, `{{count}}`, dice total, group); a log entry from turn 3 rendered against turn-20 state shows wrong numbers. `multiplier_note` is singular; rent can need two notes. `AuctionState` lacks `min_bid`/`max_bid` (UI would compute bidder's cash = a rule in TS). `/rulesets` has no label keys and `setup.kidsExplainer` is the hardcoded prose MON-408 forbids. `DiceState.total`, debt `shortfall`, `final_net_worth` positional alignment. | Self-containment audit on all 21+ events (each carries every param its catalogue sentence needs); `note_keys: tuple` + `note_params`; `min_bid`/`max_bid` on `AuctionState`; `RuleFlag{field, label_key, value, differs_from_universal}` from `/rulesets`; `GameEnded.final_standings` with explicit player ids. |

---

## 3. i18n and RTL (exploration 4)

### Blockers

| ID | Gap | Where | Fix |
|---|---|---|---|
| G-40 | **Engine emits snake_case keys; the catalogue defines camelCase.** Nothing resolves — `error.game_not_found` vs `error.gameNotFound`, `rent.note.full_group_doubled` vs `fullGroupDoubled` — and `test_api.py:72` pins the unresolvable form. Found independently by three explorations. | catalogues vs `events.py`/`api.py` | **snake_case everywhere** (it is in the Accepted ADR-003 and the server contract). Rename catalogue leaves. Add the one test that fixes this class forever: every key literal in engine+server resolves in every catalogue. |
| G-41 | **The parity test's set-equality forbids correct Hebrew.** Hebrew CLDR plurals (`_one/_two/_many/_other`) and gender context suffixes (`_m/_f`) are "extra keys in Hebrew" → CI fails on the correct catalogue. | `test_locale_parity.py:42-48` | Canonicalise CLDR/context suffixes before comparing; assert each language supplies exactly its own category set. |
| G-42 | **Hebrew gender agreement is impossible**: all event verbs are masculine (`רותי עבר` — wrong for every Hebrew speaker, in a children's game); `PlayerState` has no gender field, so the web layer can't fix it either. An engine + contract + save-schema change — the most expensive finding in the review if deferred to M5. | `common.he.json`, `state.py:47-61` | `grammatical_gender: Literal["m","f","n"] = "n"` on `PlayerState` **now** (default keeps all tests green); optional pronoun picker on the setup screen; i18next context in `he`; neutral fallback phrasing, never the masculine. |
| G-43 | **No bidi isolation mechanism.** `t()` returns a string and can't carry `dir="ltr"`; `escapeValue: false`; no `<Trans>`. `"קנה ב-{{price}}"` renders the hyphen on the wrong side; Latin names in Hebrew sentences scramble. | `i18n/index.ts` | FSI/PDI Unicode isolates applied by i18next formatters (`{{price, money}}`); `<Trans>` where real styling is needed; a Vitest assertion that no `he` render yields an un-isolated digit run. Plus `formatMoney` via `Intl.NumberFormat` — no currency plan exists anywhere today. |
| G-44 | **The spec contradicts itself on RTL**: §5.1 "mirroring is free" vs §5.3 "token travel direction unchanged". `dir=rtl` flips the grid's inline axis — tokens travel clockwise in Hebrew, counter-clockwise in English. The `Board` **needs** `dir="ltr"`. | spec §5.1 vs §5.3 | The board grid container is pinned `dir="ltr"` — the one deliberate, documented physical-direction exception; tile content restores document dir. §5.1 rewritten. Playwright asserts **geometry** (tile-0 rect identical across locales), not the `dir` attribute. |
| G-45 | **The physical-CSS lint misses most real violations**: template literals (the normal way to write React classes), CSS files (no Stylelint), inline styles, transforms (`translate-x-*` never mirrors — the highest-probability real M5 bug), scroll geometry. | `eslint.config.js:25-33` | Extend the selector to `TemplateElement`; add Stylelint with logical-properties enforcement wired into `npm run lint` + CI; extend the pattern list; the G-44 exception carries a visible `eslint-disable` comment. |
| G-46 | **`board-israel` is a declared namespace with no resources, and the board is already in `/boards`** — selecting it paints 40 raw keys. The guard test asserts a file is absent, not that the board is unreachable. | `i18n/index.ts:60`, `api.py:68-82` | Drop the ns entry; `catalogue_ready: bool` on `BoardSummary`, picker filters on it, server test pins it. |

### Major

Missing plural forms everywhere (`{{houses}}` can never pluralize — rename to `count`) ·
Hebrew adjective agreement by concatenation, wrong for 3 of 8 groups (`הוורודה`) — per-group
`definiteFeminine` field + a test forbidding `}}`-Hebrew adjacency · `ל{{owner}}` → `להבנק` ·
`card.*` namespace doesn't exist (32 cards coming) · missing-key handler is `console.error`,
DEV-only, and disabled under Vitest — make it throw in dev+test · no `kind→action-key` mapping
(`action.*` names match zero of 17 command kinds; `respond_to_trade`/`cancel_trade` unlabelled)
— rename keys to `action.<command_kind>` so the lookup is mechanical, coverage-tested from
`generated.ts` · nine enums + 13 of 21 event types have no catalogue keys (the auction is
entirely silent; `GameEnded.reason` is the final screen) · zero RTL tests; `playwright.config.ts`
doesn't exist · cli.py prose exemption written nowhere — ADR-003 amendment.

---

## 4. Test strategy (exploration 5)

### Blockers

| ID | Gap | Fix |
|---|---|---|
| G-60 | **"Money is conserved" has no oracle.** No bank is modelled; GO mints, taxes burn; `CashChanged.counterparty: PlayerId \| None` cannot distinguish the bank from the free-parking pot (identical events). Whether rent emits `RentCharged`+2×`CashChanged` or `RentCharged` alone is unspecified — a conservation test satisfiable by emitting *fewer* events is worse than no test. | `counterparty: PlayerId \| Literal["bank","free_parking_pot"]`. **The ledger rule becomes MON-102's first acceptance criterion**: every cash change is exactly one `CashChanged` with correct `delta`/`balance`/counterparty; no other event moves money; `RentCharged` is narration. Replace the one invariant bullet with four named ones: ledger consistency · paired transfers · per-player reconciliation · money-supply accounting. |
| G-61 | **`legal_commands ⇔ apply` as stated is false** — `legality.py` itself exempts `PlaceBid` (min only) and `ProposeTrade` (not enumerated); the property as written fails against a *correct* implementation and will be weakened under pressure. And the state generator is self-referential: a `RuleBasedStateMachine` reaches states *via* `legal_commands`, so a too-narrow `legal_commands` hides exactly the omission class the test exists to catch. | Three named properties: soundness · completeness over the 15 enumerable kinds · `is_legal ⇔ apply-accepts` over an **unconstrained structural generator** (reachability is irrelevant when both sides see the same state). Coverage floor via `hypothesis.event()`: every `Phase` and `CashReason` observed, or the test fails. `pytest.raises(IllegalCommandError)` specifically — a crash must not count as a rejection. |
| G-62 | **"Beats the easy bot over 100 games" is unfalsifiable** — no threshold; whoever writes the test picks the number after running it. And no termination guarantee: the universal ruleset has no turn cap, so two declining bots hang the suite; MON-603's Monte-Carlo in the default gate is ~4×10⁷ applies — hours. | Binomial criterion in the backlog: **≥ 60 wins over fixed seeds 1–100** (α=0.05 critical value is 59), draws count against the challenger; harness-level 500-turn cap, ≤ 5 capped games; per-move budget asserted on *counters*, wall-clock reported not asserted; `slow` marker + nightly job. |

### Major

Existing tests that survive implementation deletion: the JSON round-trip (never serializes a
discriminated union — no `dice`/`auction`/`trade`/`debt` ever round-tripped; the `Event` union
with 21 members has never been dumped in any test), the ruleset constants snapshots
(rename; real coverage = "the flag changes the outcome" tests at MON-201/202/203),
`test_games_list_starts_empty` (the store is provably always empty) · `schema_version`
documented as the load guard, enforced never · goldens excluded from silent regeneration by
*instruction* only — make it structural: regenerator not importable from tests, **CI runs
`git diff --exit-code` on the goldens dir after pytest**, goldens record seed/commands/RNG-costs/
rule-hash, and a committed `traps.json` maps each §3.6 trap to the golden+event where it occurs ·
no test pins the RNG counter cost of `roll_dice` (silent golden blast radius) · the 501 tests
are deletable at MON-301 (exhaustive `EXPECTED_PATHS`/`EXPECTED_SCHEMAS` constants; coverage
floor) · **a verbatim-English Hebrew catalogue is 100% green** — add not-a-copy test with an
`IDENTICAL_BY_DESIGN` allowlist + ≥90% Hebrew-codepoint check · e2e "roll, buy, end turn" is
non-deterministic — pin the seed so the first roll lands on a purchasable tile; the `he` smoke
must assert a Hebrew string present *and* an English string absent · doctrine "a test that
cannot fail is not a test" has no mechanism — mutation testing (`mutmut`) over `rules/` +
`legality.py`, kill-rate ≥ 80% as an M2 exit criterion, nightly · `--cov-fail-under=90` now
(engine is models+data; this is achievable) · `--strict-markers` + marker registry · delete
dead `monopoly_engine/`/`monopoly_server/` empty dirs.

---

## 5. Accessibility and child-usability (exploration 6)

### Blockers

| ID | Gap | Fix |
|---|---|---|
| G-50 | **The entire command surface is text** — 15 action labels, zero icons; a pre-reader cannot use a single button. | `theme/actions.ts`: `ACTION_THEME` per command kind — icon + shape + tone + a reversible/consequential/**terminal** class (terminal commands get a confirm step: bankruptcy, final withdrawal, decline-into-auction). Coverage-tested against the command union. MON-405 AC: every button renders icon + text. |
| G-51 | **Whose-turn has no non-textual channel and tokens have no identity system.** "Six distinguishable tokens" — distinguishable by what? | Six token identities = **shape + colour + icon**, reused verbatim in turn indicator, dossier headers, board tokens, auction list. MON-604 AC: "the turn indicator is identifiable with all text removed." |
| G-52 | **Railroads and utilities carry no band, pattern or icon at all** (`group=None`) — six ownable tiles identified by text alone. | `TileTheme` keyed `ColorGroup \| "railroad" \| "utility"`; `group.railroad`/`group.utility` catalogue keys (missing today). |
| G-53 | **44×44px targets on a 320px 11-column board is arithmetically impossible** (~29px tiles). | Spec decision: tiles are *not* tap targets below a breakpoint — selection happens in dossier lists (48px rows) with a tile-detail sheet; Playwright asserts every focusable ≥ 44px at 320px. |
| G-54 | **Two independent `aria-live` regions announce the same event** (MON-404 dice + MON-407 log) — double-speak; movement and cash narration are in the floor but in no backlog item. | New **MON-411 `<Announcer>`**: one polite + one assertive region at the root, a serialized queue fed from `useGame`; DiceTray/EventLog render visually only; `PhaseChanged` interrupts (the actor changes — the game's most confusing moment) get assertive announcement + focus move. |

### Major

`dark_blue`'s pattern is `solid` (= no pattern; degrades to colour-alone) · `patterns.tsx`
referenced but absent and owned by no item → **MON-403a pattern set**, 8 SVG defs legible at
12px and 200px, greyscale + CVD snapshot review in MON-703 · 🍊 vs 🍎 is the exact deutan/protan
collision the icons exist to fix — silhouette-distinct inline SVG, `aria-hidden`, name from
`nameKey` · band contrast vs near-white tile face measured at 1.4–1.7:1 against a claimed 3:1 —
computed contrast test in Vitest, both themes · **nothing forbids drag** — §5.5 gains: "no
interaction requires dragging, double-click, long-press, hover-only reveal, or multi-touch" ·
bid entry: increment buttons primary, warn > 50% cash, confirm ≥ 90% · no focus-trap/dialog
plan → one shared `<Panel>` primitive (`role="dialog"`, trap, restore, Escape) · 40 tiles = 40
tab stops → board is a composite widget (one tab stop, arrow roving, skip-to-actions first) ·
a11y AC added to **every** E4/E6 item, not just the M7 audit · "skippable" has no mechanism →
persistent "skip animations" toggle (persisted) + Escape; `useReducedMotion()` in the JS queue,
not CSS alone · Kids "simpler language" has no mechanism → `kids` namespace overlay resolved
ahead of `common` · **owner decisions (see §7): niqqud and verb gender.**

**Verified no-gap**: Kids Mode engine flags are real (`auctions_enabled=False` etc. match
ADR-004 exactly); auctions are turn-ordered with no timer — the time-pressure hazard is
designed out; the `legal_commands` contract makes "disabled buttons never lie" structural.

---

## 6. MON-503 — Israeli board names (research completed 2026-07-26)

Web research (authorized by the owner) found and cross-checked the classic **licensed Israeli
edition** (Kodkod, Hasbro's Israeli licensee):

- **Verified structure** (3+ independent sources — Hebrew Wikipedia, Ynet, TheMarker, Timeout,
  Mako coverage of the 2024 "visit every tile" press challenge): 8 Israeli cities × 22 streets,
  one city per colour group, cheapest = Eilat (רח' אילות, שד' התמרים), most expensive =
  Tel Aviv, with **רח' דיזנגוף** as the priciest tile. Utilities: חברת החשמל, חברת המים.
  GO = דרך צלחה · Jail = כלא · Free Parking = חניה · Chance = הפתעה · Community Chest = תיבת המזל.
- **Cross-verified streets (10 of 22)**: Tiberias (הירדן, העצמאות, הגליל), Ramat Gan
  (ז'בוטינסקי, אבא הלל, ביאליק), Tel Aviv (אלנבי, דיזנגוף), Eilat (partial), plus Income Tax.
- **Single-source only (Hebrew Wikipedia)**: the Beer Sheva, Netanya, Jerusalem and Haifa
  street trios; Property Tax tile.
- **UNVERIFIED — will not be used**: purchase prices and rents (no source, any era); the four
  station names; colour-group assignments (inferred from board order only).
- A second, fully photo-verified board exists (the ~1986 unlicensed "Mischakei Yetzira"
  edition) but is an obscure knockoff with an irregular layout — historical colour only.

**Recommendation to the owner**: adopt the classic licensed list (List A in the research
report); ship only after one more confirmation of the 12 single-source streets (a photo of a
physical board suffices); since the real edition's *numbers* are unverifiable, keep our own
classic price ladder as original game data and say so in the board file's comment. MON-503
stays **blocked** on the owner's confirmation — the sourced list and full source URLs are in
the PR discussion for this document.

---

## 7. Owner decisions — RESOLVED 2026-07-26

Presented per kickoff §6; answered by the owner the same day:

1. **Building-shortage auction** (G-4): **skip in v1** — first-come-first-served,
   `Ruleset.building_shortage_auction = False`, `BuildingLot` stays in the model.
2. **Mortgage transfer fee** (G-13): **full official rule** — receiver pays 10% at transfer
   or defers and pays the full 10% again on unmortgage.
3. **Income Tax** (G-17-minor): **flat ₪200 only** in v1.
4. **Hebrew niqqud** (G-A7): **no niqqud** — plain Hebrew in all catalogues.
5. **Hebrew verb gender** (G-42): **yes** — per-seat pronoun choice at setup, i18next
   context, neutral fallback; `grammatical_gender` lands in MON-100.
6. **Kids Mode trading**: **stays on by default, with a setup toggle to turn it off** —
   `trading_enabled` becomes visible in the SetupScreen (MON-408) for any ruleset.

---

## 8. What was explicitly clean

So the silence is not ambiguous: the reducer + in-state RNG architecture (every exploration
leaned on it) · board data files and their economic tests (the strongest test file in the
repo) · command parameterization (`BuildHouse(tile=16)`) · `TradeOffer` contents · hotseat
visibility model · `phases.py` as an explicit enum · `TokenMoved.forward/passed_go` ·
`tile.israel.tNN` positional keys (deliberate, ADR-003) · en↔he parity of what exists ·
`groups.ts` template-literal key typing (the strongest i18n enforcement in the repo — copy it) ·
fixed-seed statistical RNG tests · the 422 schema-rejection tests · the MON-503 absence
tripwire (the pattern to copy for every not-yet-implemented assertion).
