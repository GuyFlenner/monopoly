# Accessibility audit — MON-703

**Date**: 2026-08-01 · **Against**: the feature-complete UI (all bots, Kids Mode + hints, save/load,
sound, empty/loading/error states, animation queue + CompareTray, replay viewer)
**Floor audited against**: `CLAUDE.md` §"Product and UX standards", spec §5.5, and the E4/E6 banner in
`docs/BACKLOG.md` — *axe clean · every interactive element ≥ 44 × 44 px at 320 px · keyboard operable ·
announcements routed through the MON-411 `<Announcer>`*.

This is an audit, so it is organised as **what was checked → what was found → what was done**. Nine
defects were found. Eight are fixed on this branch. One is a product decision and is deferred with a
named owner and a test pinning today's behaviour.

---

## 1. What was checked

| Surface | How | Where it lives now |
|---|---|---|
| axe, every screen and state, both locales, both rule sets | 26 axe runs against the **mounted app** with the `region` rule enabled | `packages/web/src/a11y/screens.axe.test.tsx` |
| axe, per component | the nine pre-existing fragment runs, unchanged | `expectAxeClean` call sites |
| A game by keyboard alone | Playwright, Tab/arrows/Enter/Escape only — no `.click()`, no `.focus()`, no coordinates | `packages/web/e2e/keyboard.spec.ts` |
| Focus never lost, focus always visible | asserted at every tab stop and after every activation | same file |
| 44 × 44 px at 320 px | every interactive element, not just `.target` opt-ins; setup (both locales), game screen, unfolded hint, pinned tray, open replay, kids game at the raised floor | `packages/web/e2e/targets.spec.ts` |
| Kids Mode's 56 px comfort scale | pre-existing `.target` sweep, plus the new all-controls sweep | `e2e/kids.spec.ts`, `e2e/targets.spec.ts` |
| Contrast, computed | every palette pair including the two building marks that were outside the theme | `packages/web/src/theme/contrast.test.ts` |
| CSS ↔ TS palette parity | the stylesheet is parsed and compared to the module the ratios are measured from | `packages/web/src/theme/surfaces.test.ts` |
| One live region, no component-local ones | pre-existing assertions over the mounted app, re-run in the kids tree | `src/App.test.tsx` |
| Hebrew catalogue coverage of every screen | `missingKeyHandler` throws under test, so each Hebrew screen render is also a catalogue check | `screens.axe.test.tsx` |

### Coverage the sweep adds, screen by screen

Setup: loaded (en + he), loading, empty, error. Game screen: universal (en + he), kids (en + he),
loading, failed first fetch, reconnection note, rejected command, open square with its rent
explanation, unfolded hint. Panels: auction (en + he), trade review (en + he), trade draft (en + he),
compare tray with two pinned dossiers (en + he), replay viewer with a log (en + he), populated event log.

---

## 2. Found and fixed

### F1 — The setup screen had no landmark at all
`region`, sixteen nodes. An unnamed `<form>` is not a landmark, so every fieldset, legend and control on
the first screen a player meets sat outside the landmark structure. `App.tsx`'s `<Frame>` already wrapped
this screen's *loading, empty and error* states in a `<main>`, which is how the gap survived review: the
three states nobody looks at were structured and the screen everybody starts on was not.
**Fixed**: `SetupScreen` renders a `<main>` around its form.

### F2 — `ModalDialog`'s title bar was a second `banner` landmark
`<header>` maps to **banner** unless a sectioning element encloses it, and `div[role="dialog"]` is not
one. So every panel in the product added a second banner (`landmark-no-duplicate-banner`), and the replay
— whose button lives in the chrome's own `<header>` — added a banner *inside* a banner
(`landmark-banner-is-top-level`). The dialog footer had the same problem with `contentinfo`.
**Fixed**: both are `<div>`s. The heading is still the dialog's accessible name via `aria-labelledby`,
which is what a screen reader announces on open; the landmark added nothing but noise.

### F3 — `PlayerDossier` was a `region` landmark, up to five times on one page
A named `<section>` is a landmark. This card appears in the aside, up to three times in the compare tray,
and once inside a trade panel — and two of those name the *same seat*, so `landmark-unique` fired. Five
landmarks called "Ruti's properties" is not navigation.
**Fixed**: `role="group"`. Same accessible name, no place in the landmark list. Its inner `<header>`
became a `<div>` in the same change, because with the root no longer sectioning content that `<header>`
would have become a banner whenever the card is rendered inside a dialog — which is where the trade panel
puts it.

### F4 — Two page regions called "What's happened"
The replay viewer renders the game screen's own `<EventLog>`, so the same named region appeared twice.
`EventLog.tsx` already says in its own comments that "a second one with the same name is two landmarks for
one panel"; the composition had not been checked.
**Fixed**: `EventLog` takes a `titleKey`, defaulting to `log.title`; the replay passes the new
`replay.history` ("History up to here" / "היסטוריה עד כאן"), added to **both** catalogues. The new name is
also the more honest one — that log is the history up to the slider.

### F5 — The game screen's two sentences about failure were outside every landmark
The reconnection note and the rejected-command message were bare children of the chrome. A screen-reader
user navigating by landmark could never reach either.
**Fixed**: both moved inside `<main>`. Not the grid into a `<main>` — `<aside>` has to stay a *top-level*
landmark or `landmark-complementary-is-top-level` fires instead.

### F6 — The loading and error placeholders on an unarrived game, same problem
**Fixed**: wrapped in `<main>`, the same landmark the board uses; only one is ever on screen.

### F7 — Pressing an action chit handed the keyboard to `<body>` *(the big one)*
The action bar is rebuilt from `legal_commands` after every command — that is the ADR-005 design, and it
means rolling the dice removes the roll chit. Focus went with it, and from `<body>` the next Tab starts
again at the top of the page: a keyboard player pressed Roll and was silently returned to the language
switch, and a screen-reader user was told nothing at all, because nothing had focus to announce.

Two components in the package already carry a comment about this class of bug — `SkipMotionButton` uses
`aria-disabled` rather than `disabled` for it, `ModalDialog` guards its restore on the target still being
connected — which is the fix applied twice where somebody happened to think of it.

**Fixed** in `ActionBar`: focus lands on the bar's own `<section>`, which was already focusable for the
board's "skip to actions" link. A container rather than another chit, so the next Enter cannot send a move
nobody chose. Three guards: armed only by an activation, repairs only when focus was actually lost, spent
only by a repair. A dialog opened by the same command still wins, because `<ModalDialog>` is mounted later
in the tree and its focus effect therefore runs after.

### F8 — Changing screen handed the keyboard to `<body>`
Starting a game unmounts the whole setup screen; leaving one unmounts the whole game screen.
**Fixed**: new `src/a11y/screenFocus.ts` moves focus to the new screen's `<h1>` (marked with
`data-screen-heading`, `tabIndex={-1}`, never a tab stop). It fires only when the screen actually changed
*and* focus was actually lost, and never on first paint — a heading is the conventional landing place
because a screen reader announces it with its level, and the guards are what keep it from becoming a focus
thief. Five unit tests, four of which are about the guards.

### F9 — Two controls disabled themselves on the press that used them
Same family as F7, found while fixing it.

- `SetupScreen`'s start button was `disabled={!canSubmit}` where `canSubmit` included `!isSubmitting`, so
  the one press the button exists for dropped the keyboard. **Fixed**: re-entry is guarded inside
  `submit()`, where "already in flight" is actually known. The remaining condition is validation (a blank
  seat name), which no press of that button can cause.
- `SaveGameButton` was `disabled={saving}`. **Fixed**: `aria-disabled`, the pattern `SkipMotionButton`
  documents at length, with the double-download guarded in `download()`. Its test now asserts both halves
  — the button keeps focus, and a second press sends no second request.

### Also fixed, found in passing (not accessibility, but the audit's own foundations)

- **`e2e/helpers.ts` had never actually set a seed.** Its docstring promised "a fixed seed so the deal is
  the same every run"; the field had moved behind an `<details>` that is closed by default, so
  `isVisible()` was false and the fill was skipped in silence. Every spec in the directory has been
  playing an unseeded game. It now opens the disclosure and **asserts the value took**.
- **The play loop gave up on every bot's turn.** An empty action bar is what a bot's turn looks like, and
  the loop read it as "nothing to do" — so any game with a bot in it stopped on the bot's first turn. It
  now waits on the chits returning, drives by `data-command-kind` rather than by English labels (so one
  loop plays a game in either language), and answers auctions with a bounded number of presses.
- **The e2e suite was one spec away from filling the server's session store.** `max_sessions` defaults to
  50 and the TTL to 240 minutes, so nothing is reclaimed mid-run; the directory is past forty
  `startGame`s. Crossing the cap makes `POST /games` answer `error.server_at_capacity` and *every
  remaining test fail on a missing board* — which looks exactly like a broken setup screen, and is how an
  hour went missing while this audit was being written. `playwright.config.ts` now starts the test server
  with `KESEF_MAX_SESSIONS=400`.

---

## 3. Checked and clean — no change needed

- **Hit targets.** 21 controls on the setup screen, 19 on the game screen, 18 in a kids game; every one
  clears 44 × 44 px at 320 px, and the kids game clears 56 × 56. The sweep was verified to *bite* by
  raising the floor to 60/70 and watching it name all of them. Nothing needed resizing — the floor was
  genuinely met, including on the surfaces `kids.spec.ts` never saw (compare tray, replay controls, skip
  button, mute, hint disclosure), which had simply never been measured.
- **Contrast.** Every text pair clears 4.5:1 and every non-text pair 3:1, in both themes, as computed
  arithmetic rather than as a claim. The replay panel, the compare tray and the hint badge introduce **no
  new colours** — they use `--color-*` surfaces and the `--kesef-tone-*` action tones, both already in the
  measured table. The one genuine gap was the **building marks** (`#1f7a3d` / `#b3271f`), written twice
  each in CSS and named in no TypeScript module, so the suite had never seen them. They are now
  `BUILDING_MARK` in `theme/surfaces.ts`, shipped as `--color-house` / `--color-hotel`, held to the CSS↔TS
  parity test, and gated on greyscale separation from a card face. Deliberately **not** gated against the
  felt: a pip is never drawn on the felt, and gating it would force a colour change for a case that does
  not occur — the felt figures are reported in the measured table instead. The suite also asserts that the
  two marks *collide* in greyscale and are separated by **shape**, so nobody "improves the contrast" and
  removes the only channel a colourblind player has.
- **One live region.** Still exactly two `aria-live` nodes in the mounted app, both the `<Announcer>`'s,
  and no `role="status"`, `role="alert"` or `role="log"` anywhere — re-verified in the kids tree, where the
  hint speaks. Nothing added on this branch announces anything.
- **Dialog focus contract.** Focus moves in on open, is trapped, and returns to the control that opened it
  on Escape — asserted by keyboard, in a browser, for the replay panel.
- **Logical CSS.** No physical property was added. ESLint + Stylelint + `theme/logical-css.test.ts` remain
  the primary gates and are green.

---

## 4. Deferred — one item, with a test pinning today's behaviour

### D1 — Save then load in one sitting is refused (owner: MON-704 follow-up)

**What happens.** Leaving a game in the UI does not end it on the *server*: the session is still there,
holding that save's `game_id`. So uploading the file you just downloaded gets
`409 error.game_already_exists` from `api.py::_create`. A player who saves and then loads in the same
sitting cannot restore; the only way through today is a server that has forgotten the game.

**Why it is not fixed here.** The fix is a product decision, not an accessibility one, and there are at
least three defensible answers: a load *replaces* the live session with that id; a load *mints a new id*
and the file becomes a template; or the player is asked. Each has consequences for the URL, for a second
tab watching the same game, and for what "the same game" means. Choosing one inside an accessibility audit
would be the audit deciding a rule.

**Why it is not papered over.** `e2e/persistence.spec.ts` pins what is decided, in both languages: the
file is a real save (`schema_version`, the game id, the turn number, and the RNG that makes the game
reproducible — read off the downloaded bytes); the refusal is the server's own key rendered as a sentence
rather than a blank screen or a leaked key; the picker is still there afterwards, because the retry *is*
the picker; and a player who cannot restore can still start a game. When the product decision lands, those
assertions are the ones to flip.

**Accessibility impact**: none. The refusal is announced and rendered like every other keyed failure, and
nothing about it is unreachable. It is recorded here because the audit found it and burying it would be
worse than reporting it in the wrong document.

---

## 5. What remains

Nothing else. Every rule axe can answer in jsdom is clean on every screen and state in both locales and
both rule sets; the 44 px floor is measured on every interactive element rather than on the ones that
opted in; every colour in the product is in the computed-contrast table; a meaningful stretch of a game is
played by keyboard alone with focus asserted at every step; and the two `<Announcer>` regions are still
the only live regions in the document.

Two things are **out of jsdom's reach by construction** and are answered elsewhere on purpose, which is
worth restating so a future reader does not mistake them for gaps:

- `color-contrast` is disabled in every axe run, because jsdom computes no colours. It is answered
  numerically in `theme/contrast.test.ts`, against named reference surfaces.
- `region` is disabled in the nine *component* runs, because a fragment has no shell. It is enabled in the
  26 *screen* runs, which is what this audit added.

---

## 6. Test inventory added by this audit

| File | Tests | What it pins |
|---|---|---|
| `src/a11y/screens.axe.test.tsx` | 26 | axe over every screen and state, both locales, both rule sets, `region` enabled |
| `src/a11y/screenFocus.test.tsx` | 5 | focus on a screen change, and the three guards that keep it from stealing focus |
| `src/panels/ActionBar.test.tsx` (added) | 3 | focus after a press that removes the pressed chit |
| `src/theme/contrast.test.ts` (added) | 6 | the building marks: greyscale separation, the deliberate collision, the shape channel in both stylesheets |
| `src/theme/surfaces.test.ts` (added) | 1 | `--color-house` / `--color-hotel` CSS↔TS parity |
| `src/game/SaveGameButton.test.tsx` (rewritten) | 1 | the save button keeps focus and does not double-send |
| `e2e/keyboard.spec.ts` | 2 | a stretch of a game by keyboard alone; activation never loses focus |
| `e2e/targets.spec.ts` | 3 | 44 px (and 56 px) over every interactive element at 320 px |
| `e2e/smoke.spec.ts` | 4 | MON-707's full chain, per locale |
| `e2e/persistence.spec.ts` | 5 | the save file is real; the mute survives a reload; D1's current behaviour |

**Totals after this branch**, with `origin/main` merged in (MON-805's local engine, MON-503's group
names, and MON-709/710/711): **75 Vitest files / 1316 tests, 49 Playwright tests**, the latter run end
to end against the real stack — uvicorn plus Vite — rather than against a fake edge.

## 7. The building marks were superseded before this branch merged — resolved

MON-710 landed first and did the same job better: it replaced the two coloured blocks with house and
hotel **silhouettes**, moved the fills to `theme/buildings.css` where they vary by theme, and gates
them on the non-text floor against the card face *plus* greyscale separation from each other.

So §3's building-mark paragraph describes a rescue rather than the current code. It is left standing
because the rescue is the part that mattered: those colours were literals in two stylesheets and named
in no TypeScript module, which is why nothing had ever measured them and why nobody knew `#1f7a3d`
reads at 2.53:1 on a dark card. Naming them is what made the measurement possible, and the measurement
is what MON-710 then acted on.

`BUILDING_MARK`, `BUILDING_MARK_CSS_VAR` and the `--color-house` / `--color-hotel` tokens are **gone**
from this branch as of the merge; `BUILDING_FILL` in `theme/buildings.tsx` is the one owner of a
building's colour, and `contrast.test.ts` measures it per theme. One behavioural difference is worth
recording: this audit asserted that the two marks *collide* in greyscale and are separated by shape,
because two same-sized rectangles had no other channel. MON-710's figures are separated by silhouette
**and** clear 24 greyscale steps from each other, so the collision assertion was not merely moved — it
stopped being true, in the good direction.
