# Audit: LLM-as-judge — whole-repo best-practices evaluation

**Date**: 2026-08-07
**Slug**: llm-judge
**Scope**: entire repo at `main` (277 commits, PRs #1–#55, 2026-07-25 → 2026-08-06); engine, server, web, tests, CI, docs, git/PR history
**Audit basis**: root `CLAUDE.md` (four non-negotiables, testing doctrine, UX gates), `.claude/CLAUDE.md` review checklist, ADR-001…011, `docs/GAP_ANALYSIS.md`, `docs/superpowers/specs/2026-07-25-kesef-street-design.md`, memory decisions
**Method**: five parallel exploration agents (engine · tests · web/UX/i18n · server/CI/security · history/backlog), findings spot-check verified against source before inclusion. Documentation-only session — no code changed.
**Status**: complete (two named sub-areas not read line-by-line — see Out of Scope)

---

## Verdict in one paragraph

This is a genuinely well-built codebase whose engineering discipline exceeds most professional projects: the four architectural non-negotiables are held *structurally* (not by convention), the test doctrine is enforced by mechanisms (mutation gate, property tests, hand-mutation verification, contrast computed in tests), and the process record shows adversarial review before code, corrections published openly, and decisions captured in eleven ADRs. The real gaps cluster in exactly one place: **the project outgrew its own security posture**. Everything was correctly scoped for local hotseat (ADR-006), but MON-805/MON-901/MON-727/MON-728 shipped real online play against a public API — and the deferred-until-MON-901 items (rate limiting, seat ownership, socket cursor reset, `/games` enumeration) were never picked back up, even though the ADRs themselves named MON-901 as the revisit trigger. Secondary gaps: a test-strength sweep the project's own retrospective asked for and never ran, a contrast gate blind to alpha-composited text, and a backlog whose status markers are stale in both directions.

## Best-practices scorecard

| Dimension | Grade | One-line evidence |
|---|---|---|
| Architecture & design | **A** | Reducer + in-state RNG bought save/load/replay/bots/networking for free (ADR-002); `legal_commands` = `filter(is_legal, candidates)` makes UI/engine drift impossible by construction |
| Engine code quality | **A** | 7,583 lines, zero `type: ignore`, zero `cast`, every model frozen, ~30% documentation density carrying decisions not noise; purity verified mechanically clean |
| Server code quality | **A−** | Zero rule-logic hits in 3,185 lines; total keyed-error shape (6 handlers incl. the two nobody remembers); every bound a documented setting — minus the security posture below |
| Web code quality | **A−** | Zero rules in the UI (tripwire-tested); best-in-class logical-CSS enforcement (lint config shared bytes with the test that proves it fires); five files >750 lines |
| Testing | **A−** | ~2,430 tests, mutation gate at 95.4% with survivors dispositioned individually, property tests with coverage floors, geometry asserted geometrically — minus the boundary sweep it asked itself for (Finding 3) |
| Security / operational readiness | **C+** | Correct for hotseat; **not yet correct for the online play that shipped** — no rate limit, no seat ownership, an enumeration endpoint, DELETE/replace usable by strangers (Findings 1, 4, 12) |
| Accessibility & i18n | **A−** | Single Announcer, 44/56px swept element-side at 320px, axe on every screen, bidi isolates at the interpolation seam, gender-free Hebrew by construction — minus the alpha-contrast blind spot (Finding 5) |
| CI/CD | **B+** | Both ruff gates separate, contract drift, goldens-unchanged on porcelain, nightly that refuses to pass on zero mutants — minus: Pyodide path tested only post-merge, no dependabot/npm-audit/bundle gate |
| Documentation | **A−** | Spec/ADRs/GAP analysis exemplary; runbook written from real symptoms — minus stale status markers in BACKLOG.md, ADR-007/008 still "Proposed", two contradicting entries |
| Process | **A−** | Adversarial gap analysis before code, red-first tests, corrections as public PRs (#31), thresholds fixed before results (G-62) — minus wip commits on main, 3 direct-to-main docs pushes, the stacked-PR #41 double merge |

## Pass summary — verified clean

| Rule | Result |
|---|---|
| Rules live only in the engine (CLAUDE.md rule 1) | ✅ zero executable rule decisions in server (3,185 ln) or web; three prior leaks (GroupHoldings, ruleset diff, seat_to_act) were refactored *into* the engine when found |
| Engine emits only i18n keys (rule 2) | ✅ enforced by `tests/test_key_contract.py` engine→catalogue; CLI/goldens exemption named in ADR-003 §7 — one shape-guard gap (Finding 14) |
| Engine deterministic & pure (rule 3) | ✅ zero `time`/`datetime`/`random`/`os`/`open`/`print` (outside exempt surfaces); all models frozen; clock caller-stamped; RNG counter-based and serialized |
| pydantic sole engine dependency | ✅ `packages/engine/pyproject.toml` declares exactly `pydantic>=2.9`; import scan clean |
| Logical CSS only (rule 4) | ✅ ESLint (string+template literals) + Stylelint + a test proving the selectors fire; grep found only non-directional utilities; board `dir="ltr"` pin is the documented exception |
| `legal_commands` ⇔ `apply` agreement (ADR-005) | ✅ structural (`filter(is_legal, …)`) plus soundness/completeness/oracle property tests with an in-test approval+rejection floor per command kind |
| Interrupt frames (ADR-007), GameView projection (ADR-008) | ✅ bidirectional phase⇔frame validator; no `rng`/decks in the view — but both ADRs still say "Proposed" (Finding 10) |
| Money/houses/even-build/negative-cash invariants | ✅ four ledger oracles, conservation not bounds, even-build both directions, `cash >= 0` unconditional (stronger than doctrine) |
| Goldens + CI protection | ✅ `git status --porcelain` on the goldens dir — stronger than `git diff --exit-code` (catches new untracked goldens) |
| Coverage floors | ✅ Python `fail_under = 90` + server 95% in CI; ❌ web has none (Finding 8) |
| Mutation gate | ✅ nightly, 80% floor, 95.4% last run, fails on zero mutants; scope excludes `reducer.py`/`state.py` (Finding 15) |
| Errors cross the wire as `{reason_key, params}` | ✅ six exception handlers; pydantic prose discarded; WS refusals are keyed close codes; reflected params truncated at 64 chars with the XSS boundary documented |
| Zustand UI-local only | ✅ one store: selection, panel, pins — no game state |
| One root Announcer | ✅ two regions in `App.tsx`, asserted globally — one deviation (Finding 7) |
| 44/56px targets, keyboard, reduced-motion | ✅ swept element-side at 320px in both locales; kids scale proven both directions; skip affordances everywhere |
| i18n parity, bidi, missing-key-throws | ✅ 10 parity tests incl. Hebrew-card-figures-vs-engine cross-check; FSI/PDI at the interpolation seam; `ENGLISH_ONLY_CATALOGUES` is empty (verified — not a live skip) |
| No secrets in source; guardrails | ✅ deployment holds zero secrets structurally; hook blocks all destructive verbs — `settings.json` mirror claim is false (Finding 13) |
| Trademark discipline | ✅ own name/art/board naming throughout; no branded strings found |

---

## Findings

*Severity reflects cost-to-leave, per the project's own standard: "pick the tier by how expensive it would be to get the thing subtly wrong."*

### 🔴 Finding 1 — Public unauthenticated API with no rate limit; one caller can deny service for four hours
`packages/server/src/kesef_server/api.py:308-358` · `config.py:16-19` · live at `kesef-street-api.onrender.com`

Fifty cheap `POST /games` calls fill `max_sessions=50`; eviction is idle-TTL (240 min) swept on access, so every real player gets `503 error.server_at_capacity` for hours. The repo already documented this failure happening *by accident* (`playwright.config.ts:88-105` — the e2e suite nearly filled the store during MON-707). `DELETE /games/{id}` and `POST /games/load?if_exists=replace` additionally let a stranger end a live game; ADR-011 §Security explicitly parked that "when MON-901 makes the API a network API" — **MON-901 has happened** (PRs #49–#51, #54, #55).
**Rule**: OWASP API4; ADR-011's own revisit trigger.
**Fix options**: **A — per-IP token bucket + `max_sessions_per_ip`** (zero-dep middleware dict swept like `_evict_idle`). Pro: no new dependency, can't leak into `browser.py`. Con: hand-rolled. Cost: S–M, server only. **B — slowapi**. Pro: battle-tested. Con: new dependency; must not reach the Pyodide import path (parity test will catch). Cost: S.
**Recommendation**: A — the parity-test constraint makes zero-dependency the safer shape here. → backlog **MON-905**.
**Blast radius**: server + one test file; no engine/web change.

### 🔴 Finding 2 — The ADR-011 socket limitation is now load-bearing, and its revisit trigger has fired
`docs/adr/011…md:113-128` · `sessions.py:204-220` · `packages/web/src/api/eventSocket.ts:36-41,161-188` · `eventQueue.ts:92-102`

A replaced/renumbered session leaves a reconnecting watcher silent at a stale cursor — accepted for one-tab hotseat with "Revisit trigger: MON-901". On Render's free tier, sleep/redeploy makes renumbering the *normal* case, not an edge. The fix's machinery already exists unused: `EventQueue.reset()` has **no production caller**. (The reconnect path itself is excellent — full-jitter backoff, cursor read at connect time, terminal-vs-retryable codes as data — so plain drops and mobile sleeps do recover.)
**Fix**: one `WS_CURSOR_RESET` close code (4409) on detach; client calls the existing `reset()` and reconnects at `since=0`. Amend ADR-011 to record the trigger fired. → **MON-907**, plus catalogue entries for the five WS close keys (`eventSocket.ts:28-33` says they're untranslated) → **MON-908**.
**Blast radius**: one close code, one client branch, one e2e case.

### 🔴 Finding 3 — The boundary sweep the project asked itself for was never run: five rejection-only `error.` boundaries remain
`packages/engine/tests/test_legality.py:202-208, 537-548, 568-572, 669-679` vs `legality.py:254, 289, 291, 451, 475`

`docs/BACKLOG.md:1248-1251` records the MON-722 lesson verbatim: every bank-stock/exact-cash edge had its rejection asserted and its approval not, and "it is cheap to look for elsewhere." The sweep wasn't run. Five boundaries where `<`→`<=` is unkillable today: BuyProperty at exactly the price, PayJailFine at exactly the fine, PlaceBid at exactly the ceiling and at exactly the bidder's balance, a trade offering exactly the party's balance — plus the mirror of MON-722's own last-hotel test: no fixture leaves exactly **one house** in the bank (`legality.py:330`). Neither the agreement property nor the goldens can catch these (the boundary moves identically for `is_legal` and `apply`).
**Rule**: CLAUDE.md "a test that cannot fail is not a test", applied the way MON-722 defined it.
**Fix**: six approving twins at exact equality, each verified red under the operator mutation — the discipline `BACKLOG.md:1229` already established. → **MON-729**.
**Blast radius**: one test file; next nightly's kill rate must not fall.

### 🟡 Finding 4 — `GET /games` enumerates every live game (id + player first names) on a public API, and nothing consumes it
`api.py:361-363` · `transport.py:153-163`

The 64-bit id entropy (`secrets.token_hex(8)`) is nullified by a route that lists all ids; an id is currently all that's needed to act in a game. No UI caller exists (`listGames` grep: only `src/api/` and `src/local/`).
**Fix**: delete (regenerate `openapi.json` + `generated.ts` same commit) or gate behind `Settings.expose_game_list=False`. Recommendation: delete. → **MON-909** (with CORS narrowing: `allow_methods`/`allow_headers` wildcards at `api.py:103-109` → the four verbs actually served).

### 🟡 Finding 5 — Alpha-layered text defeats the numeric contrast gate; several light-theme ratios land below 4.5:1
`DiceTray.tsx:212,225` · `SetupScreen.tsx:673,816,888` · `AuctionPanel.tsx:383` vs `theme/contrast.test.ts`

Composited over the shipped palette: `onTable@0.8` on the felt = **3.94:1**, `ink@0.6` on tile = **4.38:1**, `onTable@0.55` = **2.70:1**; `border-current/30` on the remove-player button = 1.91:1 as its only visual edge. The gate measures solid pairs only, so it reads green while the rendered pixels do not — the same failure shape the gate was built to end (the 1.41:1 comment it replaced).
**Rule**: CLAUDE.md UX gate "contrast ≥ 4.5:1 for text" — and the project's own standard that shipped numbers are measured numbers.
**Fix**: named solid muted-ink tokens, measured in the gate; ban `opacity-*` on non-disabled text via a grep-test like `logical-css.test.ts`. → **MON-743**. Related: arbitrary `oklch(…)` literals (setup CTA, dark card override) invisible to the gate → **MON-746**.

### 🟡 Finding 6 — Rent and bid figures bypass the MON-720 money formatter
`GameScreen.tsx:289-291` (bare `{quote.amount}`) · `AuctionPanel.tsx:277,292` (5xl bid figure and increments bare)

A player sees "Lowest you can bid: $10" beside a giant unlabelled "10". Owner decision MON-720 ("money says which money it is") applied per string — these strings missed it. **Fix**: route through `useMoney()` (already imported in GameScreen). → **MON-744**.

### 🟡 Finding 7 — One component-local `aria-live` region outside the root Announcer
`src/local/LocalEngineGate.tsx:91`

The rule ("to render an `aria-live` region of its own is a defect", `a11y/index.ts:5`) admits no exception; the mitigation is that the gate mounts before App/Announcer exist, so they never co-exist — which is also why `App.test.tsx:645` can't catch it. **Fix**: sanction it with a never-co-mount test + documented exception, or narrate through `useOptionalAnnounce`. → **MON-745**.

### 🟡 Finding 8 — The web suite (≈1,195 tests) has no coverage measurement at all
`packages/web/package.json` · `vite.config.ts` — no `coverage` key, `@vitest/coverage-v8` not installed

Against Python's 90% floor + server 95% + mutation gate, the web package can't even *report* coverage. Likely a formality given observed depth — which is the argument for pinning it. → **MON-731**.

### 🟡 Finding 9 — One genuinely vacuous test: the sound-wiring claim asserts only `not.toThrow()`
`App.test.tsx:673-700`

Titled "plays a cue for an event that arrives over the socket (MON-706)" and commented as proving GameScreen calls `useSoundCues` — deleting that call leaves it green. The only true instance found in ~2,430 tests; the injectable seam (`AudioPort`) already exists. **Fix**: assert a cue was requested for `dice_rolled`; verify by deleting the hook call and watching red. → **MON-730**.

### 🟡 Finding 10 — Backlog/ADR/spec status is stale in both directions
`docs/BACKLOG.md` (E1–E4: no ✅ on any item though all shipped in PRs #2–#8; MON-901 row says "deferred" after five PRs of delivery; MON-903 delivered under MON-805 but still "deferred"; MON-724 says "left open" though MON-725 closed it) · `docs/adr/007`, `008` (still "Proposed (awaiting owner review)" while load-bearing and cited by ~30 backlog entries) · spec §8 risk row (MON-503 still "blocked" — closed 07-28) · `DEPLOYMENT.md` §2 ("multi-device play: possible later" — §6.7 made it true)

Anyone counting open items off these files is wrong in both directions. The sync commits (`108230b` "every item that merged now says so") simply never reached these sections. **Fix**: one Sonnet documentation pass. → **MON-749**.

### 🟡 Finding 11 — The Pyodide/Pages path is tested only after merge
`.github/workflows/deploy-pages.yml:126-130` (push: main only) vs `ci.yml`

The only gate that runs real Pyodide + real wheels + real base path runs post-merge; the workflow's own header admits "everything else in CI can be green while this is broken." The last three merged features were `local/` work validated only at deploy time. The two escapes on record (MON-713 reload loss, the Pyodide `JsNull` regression) are both this exact seam. **Fix**: PR-triggered build-only job behind a path filter. → **MON-910**.

### 🟡 Finding 12 — Engine hygiene quartet (each small, each real)
1. **Duplicate pawn token answers with a coarse key** — `factory.py:82-91` has three keyed seating refusals; the fourth (`state.py:399` duplicate tokens) is developer prose that surfaces as `error.invalid_new_game`, the exact failure MON-418 existed to remove. → **MON-735**
2. **Bots hardcode the jail fine** — `bots/normal.py:433` uses `50` where `Ruleset.jail_fine` is configurable; both difficulty tiers inherit it; MON-712's house-rules mechanism is the road by which it stops being right. → **MON-736**
3. **`_estimated_rent` re-derives the rent ladder** — `bots/hard.py:305-337` duplicates tier/doubling/multiplier logic that `rules/rent.quote` (MON-420) now answers authoritatively. → **MON-737**
4. **"Card returns to the bottom of its own deck" written four times** — `jail.py:138`, `insolvency.py:547`, `cards.py:157` re-spell the Deck→field mapping; the read accessor exists, the write accessor doesn't. → **MON-738**

### 🟡 Finding 13 — `.claude/settings.json` deny-list is a strict subset of the hook, and the docs claim otherwise
`.claude/settings.json:42-51` vs `.claude/hooks/command-guard.sh:30-46`

`git filter-branch`/`filter-repo`, `git clean -fdx`, `gh repo edit --visibility`, `gh release delete`, catastrophic `rm -rf` are hook-only; `.claude/CLAUDE.md` says settings.json "mirrors these" — currently false. Belt-and-braces was the stated intent. → **MON-912**.

### ℹ️ Finding 14 — Nothing checks a `reason_key` is *shaped like* a key
`legality.py:107-108` · `tests/test_key_contract.py:71-79` — the guard regex-searches for `"error.…"` literals, so a hand-written `_no("It is not your turn")` would be invisible to it, satisfying mypy and the validator. A shape assertion on everything reaching `_no(...)` closes the one defect ADR-003 §3 names that the guard cannot see. → **MON-739** (Fable — it defines what rule 2 mechanically means).

### ℹ️ Finding 15 — Mutation scope excludes `reducer.py` and `state.py`
`packages/engine/pyproject.toml [tool.mutmut]` — the phase machine and the interrupt stack are the two things the design calls hardest, and they sit outside the only gate measuring test *strength*. `mutate_only_covered_lines=true` already bounds the cost. → **MON-732**.

### ℹ️ Finding 16 — Smaller hygiene (grouped)
- Stale docstrings: `endgame.py:22` + `test_reducer_endgame.py:6` cite a renamed function; `board.css.test.ts:14-18` claims the Playwright surface "does not exist" (it does, and makes the exact assertion the comment asks for). → **MON-740**
- `__init__.py` docstring example uses names not in `__all__` (`apply`, `legal_commands`). → **MON-740**
- `DECK_OF_TILE` not `Final` (its three siblings are). → **MON-740**
- Two mutable dict fields on frozen wire models (`RentQuote.note_params`, `LegalityResult.params`) — the one place "no mutation" is unenforced; a wire-shape decision. → **MON-741**
- Conditional `pytest.skip` on a fixed seed (`test_reducer_rent.py:179-185`) is always-live or always-dead and nothing says which; plus a shrink-guard for `ENGLISH_ONLY_CATALOGUES` (verified **empty today** — no live skip, mechanism deliberate). → **MON-734**
- `TODO(MON-412)` at `SetupScreen.tsx:62` — the only in-code TODO; points at a use site that never adopted the shipped tokens. → **MON-748**
- `bots/hard.py` (782 ln) carries four concerns; `GameScreen`/`SetupScreen`/`ActionBar` ~1,000 ln each. Split candidates, behaviour-preserving. → **MON-742**, **MON-747**
- No dependabot / `npm audit` / bundle-size gate (a ~450 kB figure exists in `DEPLOYMENT.md` to regress against). → **MON-911**
- `ci.yml` `gate` job's file-existence outputs are permanently true; a deleted lockfile now silently *skips* the web gate instead of failing.
- `/save` returns RNG + deck order to anyone with the id — deliberate for hotseat (ADR-008 §2), becomes a cheat channel online; folds into seat ownership (**MON-906**).
- AuctionPanel's cash-share confirm (`AuctionPanel.tsx:135-140`) is legitimate presentation but the closest thing to rule logic in the web package; `AuctionPanel.test.tsx:196` is the tripwire — keep it green.
- Process hygiene: ten `wip:` checkpoint commits preserved into main's history; three direct-to-main docs pushes (`871dfbc`, `3e30d72`, `a2ae8c9`) against the "every change flows through PR" rule; stacked PR #41 merged into #40's branch and got no independent CI.

---

## What was fixed and enhanced over time (evolution digest)

Full detail in the history agent's timeline; the arc in six lines:

1. **07-25/26 — Bootstrap + adversarial review before code.** GAP_ANALYSIS: 41 gaps, 4 root causes, verdict "MON-101 unbuildable as specced" → ADR-007/008 and MON-100 re-ordered the whole backlog pre-implementation.
2. **07-26/27 — Engine (E1+E2 in three days).** Invariant suite immediately found two real rule bugs (nearest-utility multiplier, debt outliving a leaving player).
3. **07-28 — Server + web + Hebrew.** PR #7 contains its own labelled review remediation (MAJOR 1–5); MON-501's cross-boundary test found 45 dead error keys blanking the refusal panel.
4. **07-29→08-01 — Bots.** Structural wall (split groups → nobody builds → capped games) resolved by ADR-009 rather than threshold-fitting; contest thresholds fixed before results existed.
5. **07-30→08-02 — Polish.** A11y audit found 9 defects (8 fixed); e2e helpers found to have never set a seed; auctions-off default came from a real Hebrew game with the owner's child.
6. **08-02→08-06 — Release + online.** Pages/Pyodide (with the Pages-token correction PR #31), mutation gate made real (94.2→95.4%, survivors dispositioned one at a time), Render API, shared-link online play — which is what makes Findings 1/2/4 due now.

## Recommended adjustments (priority order)

1. **MON-905 + MON-906 + MON-907** — the online-play hardening trio (rate limit, seat ownership, cursor reset). The product now advertises the path these protect.
2. **MON-729** — the boundary approval-twin sweep (one test file, directly extends MON-722's own discipline).
3. **MON-909** — delete `GET /games`, narrow CORS (smallest security win per line).
4. **MON-743 / MON-744** — contrast tokens + money formatting (user-visible, gate-integrity).
5. **MON-749** — status-sync documentation pass (cheap, restores the backlog as a source of truth).
6. Everything else per the backlog doc: `_drafts/judge-backlog-2026-08-07.md`.

## Out of scope (not audited this pass)

- `packages/server/src/kesef_server/schemas.py` projection classmethods (`from_*`) not read line-by-line — the MON-421 precedent says a rule leak could hide there; targeted pass recommended.
- `browser.py` lines 80–330 / 400–489 (`_answer`/`Reply` envelope, create/load handlers) — inferred healthy from the parity suite, not read.
- Running the full test suites (inventory and doctrine checked mechanically; suites not executed this session).
- Bot play *strength* beyond the recorded contest numbers; Hebrew wording quality (native-speaker read remains an open owner item).
- Actual load/latency behaviour of the live Render service.

---
*Produced by the LLM-judge session of 2026-08-07 (documentation-only). Companion backlog: `_drafts/judge-backlog-2026-08-07.md`.*
