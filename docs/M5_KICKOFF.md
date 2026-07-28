# M5 kickoff — Hebrew and RTL

**Written**: 2026-07-28, at the end of the session that finished M4 (PR #8 merged).
**Read this with**: `docs/BACKLOG.md` E5, `docs/GAP_ANALYSIS.md` §3, `docs/adr/003`, spec §5.3.

M0–M4 are merged. `main` is at the PR #8 merge: **878 Python tests, 646 web tests**, all
gates green, and a game plays end to end in a browser in English.

---

## 1. What M5 actually is

Four items — MON-501 (i18n wiring + locale switch), MON-502 (RTL audit), MON-504 (Hebrew
typography), and **MON-506** (the Hebrew card catalogue, still blocked on a native speaker).
MON-503 is **done**: the owner photographed the physical licensed board and all 40 tiles are
in, both languages.

But the real work of M5 is not those four items. It is the **translation debt** M1–M4
deliberately accumulated, and one convention mismatch that has been live since M0.

## 2. The translation debt, precisely

`tests/test_locale_parity.py` holds `AWAITING_HEBREW` — a union of **eight named frozensets**,
one per item that added English-only keys, each with the reason written down and a rot
tripwire that fails if a key gains Hebrew (or stops existing) and nobody removes it:

| Set | Owner | Roughly what |
|---|---|---|
| `_NARRATION_AWAITING_HEBREW` | MON-411 | the `<Announcer>`'s spoken sentences |
| `_EVENT_LOG_AWAITING_HEBREW` | MON-407 | ~46 log sentences + the enum labels they interpolate |
| `_SETUP_AWAITING_HEBREW` | MON-408 | the setup screen and the 18 `ruleset.*` flag labels |
| `_BOARD` | MON-403 | board chrome, tile kinds, spoken square descriptions |
| `_DICE` | MON-404 | the dice tray and the animation switch |
| `_AUCTION_AND_TRADE` | MON-409/410 | 41 keys across both panels |
| `_PANELS` | MON-405/406 | action labels, the confirm step, dossier additions |
| `_APP_SHELL` | integration | connection status, retry, errors |

**Roughly 250 keys.** Do not fabricate them. The reason is written into every set's docstring
and it is not stylistic: **Hebrew conjugates the verb to the subject's gender** (GAP G-42).
`רותי עבר` is wrong to every Hebrew speaker, and wrong in a children's game is worse than
absent. `grammatical_gender` already exists on `PlayerState` and on `SeatConfig` (owner
decision 5) and reaches the wire — it is there precisely so i18next context can select the
right form.

**Owner decision needed before MON-501 starts.** Three options were put to the owner:
1. the model drafts everything and the owner corrects it;
2. **(recommended)** the owner supplies the ~40 narration sentences that need gender
   agreement, the model does the mechanical rest;
3. gender-neutral phrasing everywhere, revisited later.
The owner has not chosen yet. Option 3 is a safe placeholder that unblocks work, but it must
be *chosen*, not defaulted into.

## 3. The convention mismatch (G-40) — do this first

The engine emits `snake_case` i18n keys. Parts of the catalogue still define `camelCase`
leaves, so those keys **resolve against nothing**. Known live examples:
`rent.note.fullGroupDoubled` vs the engine's `rent.note.full_group_doubled`;
`error.noHousesLeft` vs `error.no_houses_left`; every `action.*` key matches **no** command
kind, which is why `packages/web/src/panels/ActionLabels.ts` exists as a hand-written
`kind → key` map with a coverage test.

ADR-003 §6 makes `snake_case` normative. MON-501 renames the catalogue leaves to match, and
that deletes `ActionLabels.ts` outright — a test in that file asserts the map is still
non-derivable and names the file to delete when it flips. **The durable fix** is the
cross-boundary test ADR-003 §6 specifies: every key literal the engine and server can emit,
including every displayed enum member, must resolve in every catalogue. Without it this class
of defect returns within a week.

## 4. RTL — the traps already found, so nobody rediscovers them

- **The board must NOT mirror** (spec §5.1 as amended, G-44). `dir="rtl"` flips the grid's
  inline axis, which would reverse the visible direction of travel — tokens circling
  clockwise in Hebrew, counter-clockwise in English. The board grid is pinned `dir="ltr"`,
  the single sanctioned exception, with a banner comment saying not to "fix" it. MON-502's
  Playwright assertion must be **geometric** (tile 0's rect identical across locales), never
  a check on the `dir` attribute — that would be set and satisfied by the same line of code.
- **The physical-CSS lint is already hardened** (MON-412): it covers template literals, not
  just string literals; transforms (`translate-x-*`, `origin-*`); `scrollLeft`; inline style
  objects; and **Stylelint** now parses `.css`, which ESLint never did. Do not weaken it.
  MON-502's "zero physical properties" criterion is largely already enforced — verify rather
  than rebuild.
- **Bidi isolation is unsolved** (G-43). `t()` returns a string and cannot carry
  `dir="ltr"`, `escapeValue: false` is set, and `<Trans>` is unused. Numbers and Latin names
  inside Hebrew sentences will scramble. The planned fix: FSI/PDI Unicode isolates applied by
  i18next formatters, plus `<Trans>` only where real styling is needed. **There is still no
  money formatter anywhere** — amounts interpolate bare today.
- **Morphology must never cross an interpolation boundary** (G-F8). The Hebrew catalogue
  currently glues a definite article and a feminine suffix onto a translated colour name
  (`ה{{group}}ה`), which is wrong for three of eight groups (pink needs `הוורודה`,
  light_blue is a noun, dark_blue is two words). Same defect shape as `ל{{owner}}` producing
  `להבנק` instead of `לבנק`. Add per-form fields, do not inflect across `{{}}`.
- **Hebrew plurals need CLDR forms** (`one/two/many/other`) and the parity test canonicalises
  suffixes so they are mergeable (G-41 fixed at Phase 0) — but no key uses them yet.

## 5. Also true, and easy to trip over

- `cards` is registered for **both** languages against the **English** resource on purpose:
  MON-206 shipped 31 card texts, MON-506 owns the Hebrew, and a Hebrew game showing an
  English card beats raising on a missing key. `ENGLISH_ONLY_CATALOGUES` in the parity test
  encodes that, with a tripwire asserting `cards.he.json` is still absent.
- **A missing key throws** in dev and test (G-F17) — deliberately. Expect renames to fail
  loudly, which is the point.
- Owner decision 4 stands: **no niqqud**. Do not add diacritics to any catalogue.

## 6. Epic E4b is waiting (MON-413..422)

Ten contract gaps the UI surfaced, each a place a component compensates for the engine or the
projection: `BuildingChanged` cannot say "hotel"; `MortgageChanged` carries no player so the
log speaks in the passive voice; `/rulesets` returns raw flags so the Kids diff is computed
client-side; "at least two players" arrives as a coarse `error.malformed_request`; no
effective current rent for the "explain this rent" screen; and **MON-422** — `TradeBuilder`
has no review side, so a recipient cannot see the offer in the panel built to show it.

Most are one-line engine additions and each **removes** a workaround from the UI. A single
focused pass would make the client simpler. Not required for M5.

## 7. The process lesson from M4 — worth applying immediately

The board was overflowing its container **at every viewport width**: the bottom edge
staircased off-screen, tiles collapsing to the height of their own labels. 646 passing tests
never saw it, because **jsdom has no layout engine**.

Root cause, for the record: `role="row"` elements are real boxes (deliberately —
`display:contents` breaks row semantics), which made each a nested grid declaring no
`grid-template-rows`; the implicit track sized to content, the children's `block-size: 100%`
was cyclic against it, and with no explicit track there was no ceiling on auto-placement — so
the descending column order of the bottom edge opened a fresh implicit row per square.

**Therefore: bring MON-707's Playwright surface forward.** It is currently scheduled last in
M7. There is no `playwright.config.ts` and no `e2e/` directory yet, despite `test:e2e` being
scripted and `@playwright/test` installed. Every UI milestone from here should end with a
real browser pass, not only a test run. `packages/web/src/board/board.css.test.ts` records
what the geometric assertion should be (`scrollHeight <= clientHeight + 1` on the board grid
at 320 px).

## 8. How to run M5

Same shape that worked for M2 and M4: **fan out in isolated worktrees with disjoint file
ownership, merge one at a time, then one adversarial review gate for the whole milestone.**
Note that the infrastructure dropped agents roughly every ten minutes during this session, so
brief agents to **commit after each item** — a stall then costs one step, not the epic.

A workable split once the owner's translation decision lands:
- **A**: MON-501 — the `snake_case` rename + the cross-boundary parity test + the locale
  switch and mid-game language change. This is the critical path; everything else waits on
  the rename.
- **B**: MON-504 — Hebrew typography (Heebo or Rubik, self-hosted, subset, `font-display:
  swap`), and the type scale checked in **both** languages, since Hebrew has no capitals and
  a different x-height, so a scale tuned on Latin text reads small.
- **C**: MON-502 — the RTL audit and its geometric Playwright assertions. Pairs naturally
  with standing up `playwright.config.ts`, which §7 argues should happen now anyway.
- **MON-506** stays blocked until the owner supplies or approves Hebrew card text.

**Definition of done for M5** (from the kickoff brief): the same game playable in Hebrew,
mirrored, with the language switchable mid-game and no effect on game state.
