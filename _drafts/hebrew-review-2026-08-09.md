# Hebrew localization review — 2026-08-09 (research-based, replaces the owner's manual read)

Produced by a web-research pass against the repo's own register rules
(`docs/MON-501_HEBREW_GENDER.md`, `tests/test_locale_parity.py`) and generic public Hebrew
usage (sources at the end). The Israeli board catalogue is verified ground truth and was not
second-guessed. Trademark discipline held: generic terminology was researched; no licensed
edition's prose was consulted or copied.

## Verdict counts

| Scope | OK | Minor | Wrong | Absent |
|---|---:|---:|---:|---:|
| Recently-added `error.*` | 2 | 3 | 0 | 3 (`seat_not_yours`/`seat_taken`/`host_only` — MON-906 in flight) |
| `setup.where*` (MON-728) | 5 | 0 | 0 | 0 |
| `build.*` (MON-725) | 3 | 1 | 0 | 0 |
| `cards.he.json` (31) | 17 | 10 | 4 | 0 |
| Found outside scope | — | 2 | 2 | — |
| **Total** | **27** | **16** | **6** | **3** |

`setup.where*` was judged the best-written recent addition — idiomatic, register-perfect,
nothing to change. Of the 10 "minor" cards, 6 are minor only in language: their real defect is
the hardcoded square name (MON-752).

## Must-fix (implemented by MON-753 unless noted)

1. **Both `get_out_of_jail_free` cards**: `חופשית` → free-of-charge sense needs `בחינם`
   (`חופשי` = unrestricted — the catalogue itself already distinguishes: `חניה חופשית` is
   correct, `יציאה חופשית` is not); `בית הסוהר` → `הכלא` (21 existing `כלא` uses incl. the
   card's own inventory label); `עד שתצטרכו` → `עד שתצטרכו אותו`.
   → `כרטיס יציאה מהכלא, בחינם. שמרו אותו עד שתצטרכו אותו, או העבירו אותו בעסקה.`
2. **Both `go_to_jail` cards**: `בית הסוהר` → `כלא`; `בלי לעצור בהתחלה` is genuinely ambiguous
   ("without stopping at first") → carrier-noun form `במשבצת {{go}}` (see MON-752 shapes).
3. **`setup.card_seconds_hint`** names both decks wrongly (`קלף סיכוי או קופה`) →
   `קלף הזדמנות או קופת קהילה` (matches `deck.chance`/`deck.community_chest`; `סיכוי` is the
   wrong word for this sense of chance).
4. **`error.too_many_requests`** is ungrammatical at the two most common values
   (`בעוד 1 שניות`; dual for 2) → CLDR plurals `_one` (`בעוד שנייה`) / `_two` (`בעוד שתי
   שניות`) / `_other`. The English has the `1 seconds` half of the same bug → `_one` there too.
5. **`log.sent_to_jail_tile`** hardcodes the classic square `'לך לכלא'` — wrong on the Israeli
   board (`לכלא`). Same defect class as the cards, but in `common.he.json`.
6. **The six square-naming cards** → MON-752's interpolation, shapes below.

## MON-752 — interpolated sentence shapes (Hebrew word-order reasoning)

- **`אל {{square}}`, never `ל{{square}}`** — glue-free (`test_no_hebrew_word_is_glued...`),
  already the catalogue's pattern (`a11y.moved`, `log.token_moved*`), and works for all value
  shapes: `אל שדרות אילינוי` / `אל רח' דיזנגוף` / `אל הטיילת`.
- **`עברתם את {{go}}`, not `דרך {{go}}`** — the Israeli GO is `דרך צלחה`, so `דרך דרך צלחה`
  stutters; `עבר את X` is idiomatic and gender/word-initial-agnostic. Also replaces the
  pronoun `דרכה`, which silently assumed the GO name is feminine.
- **`במשבצת {{go}}`** — the carrier-noun pattern: `ב` attaches to `משבצת`, the value sits in
  apposition; also fixes the §2 ambiguity as a side effect.
- **Never interpolate the jail square** — `היישר אל מעבר` (Israel `t30` context) doesn't
  survive as a destination; `כלא` stays the fixed term, matching `tile_kind.jail`.
- `{{go}}` resolves from the ACTIVE board (`tile.classic.go` vs `tile.israel.t00`), and the
  Reading-trip `{{square}}` from the tile at the effect's index on the active board — which is
  why `צאו לנסיעה אל {{square}}` beats a `רכבת {{name}}` form (the Israeli value already
  contains רכבת).

| Key | Hebrew shape |
|---|---|
| `chance.advance_to_illinois_avenue` / `advance_to_st_charles_place` | `התקדמו אל {{square}}. אם עברתם את {{go}} בדרך, אספו את המשכורת.` |
| `chance.advance_to_boardwalk` | `התקדמו אל {{square}}.` |
| `chance.trip_to_reading_railroad` | `צאו לנסיעה אל {{square}}. אם עברתם את {{go}} בדרך, אספו את המשכורת.` |
| `chance.advance_to_go` | `התקדמו היישר אל {{go}}. אם עברתם שם בדרך, אספו את המשכורת.` |
| `community_chest.advance_to_go` | `לכו היישר אל {{go}}. אם עברתם שם בדרך, אספו את המשכורת.` |
| both `go_to_jail` | `היישר לכלא. בלי לעצור במשבצת {{go}} ובלי משכורת בדרך.` |

## Endorsed minors (take with MON-753)

- `error.session_replaced`: `מתעדכנים מההתחלה` collides with the GO square's name →
  `משחק שמור נטען במקום המשחק הזה. טוענים אותו מחדש מתחילתו.`
- `error.too_many_games`: clipped ending → `...סגרו אחד לפני שפותחים משחק נוסף.`
- `chance.elected_chairman`: plural predicate noun makes one player "chairmen" →
  `נבחרתם לתפקיד יושב ראש הדירקטוריון. שלמו 50 ₪ לכל שחקן אחר.`
- `advance_to_nearest_utility`/`_railroad`: doubled `בעלים` → `לבעליו` / `לבעליה`.

## Deliberate divergences — recorded, keep as-is

- `משכנתא` over the Academy's normative `משכנתה` (common usage wins; spelling-only; consistent
  across six keys). Now a recorded decision, not an oversight.
- `מפעל` for utility (loose but coherent; ripple > gain).
- `הבשיל/ה` for financial maturity (clearer than `הגיע לפדיון` for the audience; consistent ×3).
- `build.checking` (`בודקים…`) vs `trade.checking` (`בודק…`) voice flip — noted; normalize to
  the impersonal plural only when someone is in the file anyway.
- `קופה` carries three senses (player cash / community fund / parking pot) — low risk in
  context; recorded so it isn't rediscovered.

## Owner decisions still needed (NOT implemented)

1. **`action.*` button labels are masculine-singular imperatives** (~25 keys: `בנה בית`,
   `קנה את המשבצת`, … and the unambiguously gendered `אני נפרש`). Too systematic to be an
   accident, so not treated as a defect — but it contradicts `MON-501_HEBREW_GENDER.md` as
   written, and the repo already demonstrates the gender-free alternative (`kids.action.*`
   infinitives: `לקנות`, `לשלם {{amount}} ולצאת`). Either write the convention into the gender
   doc, or move `action.*` to infinitives. **Filed as MON-755.**
2. **Deck labels on the Israeli board** (`card_reveal.label` says `קלף הזדמנות` while the
   board square says `הפתעה`/`תיבת המזל`) — board catalogue is ground truth; the reveal needs
   board-scoped deck naming or square-based naming. **Filed as MON-754.**

Sources: he.wikipedia משחק_לוח · wikibooks דמקה · ynet L-4242562 (משכנתא/משכנתה, Academy
rulings) · Academy of the Hebrew Language (final-א feminines) · ynet L-3530140 (חינם vs חופשי)
· milog דמי_שכירות · Reverso synonyms הזדמנות.
