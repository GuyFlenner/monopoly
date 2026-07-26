# @kesef-street/web

React 19 + Vite + TypeScript (strict) + Tailwind v4.

> **Not installed yet.** There is no `package-lock.json` and no `node_modules` in the repo
> at M0, so nothing here has been compiled. `npm install` happens at **MON-401**, and the
> CI web job stays skipped (not red) until the lockfile exists. Treat every file in this
> package as reviewed-by-eye, not verified.

```bash
npm install
npm run dev        # http://localhost:5173, proxying /api to the FastAPI server
```

## The one rule

**This package does not know the rules of the game.** It renders `GameView.legal_commands`
as buttons and posts commands back. It never decides whether a move is allowed, never
computes rent, and never infers whose turn it is from anything but the state it was given.
Every time a UI re-derives a rule, it eventually disagrees with the engine.

## Right-to-left

Hebrew is not a translation pass bolted on at the end; it is the reason for several
structural choices:

- `dir` is set on `<html>` from the active locale. That single attribute mirrors the whole
  layout, including the 11×11 board grid.
- **Logical CSS properties only.** `ms-*` / `me-*` / `ps-*` / `pe-*`, `start` / `end`,
  never `ml-*` / `left`. A physical property is a bug that only shows up in Hebrew.
- Numbers, money and dice stay LTR inside an RTL page — they get `dir="ltr"` explicitly.
- The board's travel direction is a **game** direction, not a reading direction: tokens move
  the same way round the board in both languages. Only the chrome mirrors.
- Board tile names come from the locale catalogue, so the Israeli board can be played in
  English and the classic board in Hebrew. Board choice and language are independent.

## Structure

```
src/
  api/        generated.ts (from the server's OpenAPI doc — committed, CI-verified)
              client.ts   thin fetch wrapper + TanStack Query hooks
  i18n/       i18next setup, locale catalogues (en, he)
  board/      Board grid, Tile, Token — pure presentation
  panels/     PlayerDossier, CompareTray, ActionBar, DiceTray, EventLog
  game/       useGame hook: the view, the command sender, the animation queue
  theme/      design tokens: colour groups, patterns, typography, spacing
```

## Design tokens

Colour groups carry **both** a colour and a pattern. That is one decision serving two
audiences: a six-year-old who cannot yet read "St. James Place" and a colourblind adult who
cannot tell the orange group from the red one. See `src/theme/groups.ts`.

## Accessibility floor (not aspirations — gates)

- Keyboard reachable: every action, including the auction and the trade builder.
- Visible focus ring on every interactive element, in both themes.
- `aria-live="polite"` narration for dice, movement, rent and cash changes.
- Contrast at least 4.5:1 for text, 3:1 for the board's non-text indicators.
- Hit targets at least 44×44 px — children's aim is worse than adults'.
