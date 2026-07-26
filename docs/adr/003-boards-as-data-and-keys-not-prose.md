# ADR-003 — Boards are data, names are i18n keys, and board choice is independent of language

- **Status**: Accepted
- **Date**: 2026-07-25
- **Deciders**: Guy Flenner

## Context

The game must ship in English and Hebrew. The Hebrew edition of this genre traditionally
replaces the Atlantic City streets with Israeli cities, so "add Hebrew" is not only a
translation job — it is a second board.

The naive approach is a `Board` class per edition with the names in the source, and a
translation lookup wherever a name is displayed. That produces two problems that only show
up late: English leaks into the rules layer, and the board and the language become welded
together so you cannot play the Israeli board in English.

## Decision

1. **Boards are JSON data**, validated on load (`packages/engine/src/kesef_engine/board/data/`).
   Two ship: `classic` and `israel`.
2. **Tile names are i18n keys, never literals.** `tile.classic.boardwalk`,
   `tile.israel.t07`. The engine never resolves them; the web catalogues do.
3. **The engine emits no prose at all** — errors are `error.not_your_turn`, rent
   explanations are `rent.note.full_group_doubled`. The only free text in the engine is a
   player's typed name.
4. **The two boards are economically identical, slot for slot** — same prices, rents, house
   costs and mortgage values, enforced by a test.
5. **Board and language are separate choices.** Israeli board in English, classic board in
   Hebrew: both valid. Tile catalogues are per-board namespaces (`board-classic`,
   `board-israel`), loaded independently of the `common` catalogue.

Board data is generated from one table so the two boards cannot drift.

## Alternatives considered

**Names in the source with a translation layer at the display site.** Rejected: it puts
English in the engine and makes "which language is the board in" a question with no clean
answer.

**Different economics per board** (Israeli cities priced to local flavour). Rejected: it
would fork the ruleset, doubling the balance testing for a cosmetic gain.

**Descriptive keys for the Israeli board** (`tile.israel.tel_aviv`). Rejected for now,
because we do not yet have a verified city list and the key would then encode a guess. The
Israeli board therefore uses **positional** keys (`tile.israel.t07` is whatever occupies
slot 7), which are correct today and stay correct when the names arrive.

## Consequences

- Adding a language is adding a catalogue. No engine change, no component change.
- Adding a board is adding a JSON file and a catalogue.
- A missing translation is caught by a test (`tests/test_locale_parity.py`) rather than by a
  child seeing `tile.israel.t07` on screen. The same test checks that interpolation
  placeholders match across languages, since `{{amount}}` in one and `{{sum}}` in the other
  renders a literal brace.
- **Known gap:** the Israeli board has no name catalogue yet. It must come from a verified
  source, not from a plausible guess — a fabricated board would look right and never be
  re-checked. Tracked as **MON-503**, and asserted as absent by a test so it cannot be
  quietly half-finished.
