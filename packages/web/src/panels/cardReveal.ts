/**
 * The three decisions the card surface makes, as pure functions (MON-709).
 *
 * Which glyph a deck wears, which sentence a figure gets, and — the one that earns a file of its own —
 * **which language the card's text turned out to be in**. All three are tables and predicates over
 * values the event stream already carried, testable without a DOM, in the shape `EventLogLines.ts`
 * and `a11y/narration.ts` established.
 *
 * Nothing here reads a rule, and nothing here writes a sentence: every string below is a catalogue
 * key.
 */

import type { Deck } from "@/animation";
import { needsIsolation, type Direction } from "@/i18n/bidi";
import { DIRECTION, isLocale, type Locale } from "@/i18n/direction";
import type { DeckIconName } from "@/theme";

/**
 * The glyph per deck. `Record<Deck, …>`, so adding a third deck is a compile error rather than a
 * blank corner.
 *
 * Colour is not in this table at all, and that is the point: the two decks are told apart by outline
 * here, by border style in the component, and by their own names in words. Any one of the three is
 * enough on its own, which is the standard this project holds colour groups to (spec §5.4).
 */
export const DECK_ICON: Readonly<Record<Deck, DeckIconName>> = {
  chance: "spark",
  community_chest: "chest",
};

/**
 * The sentence for the figure a card moved, by the sign of the figure.
 *
 * Grammar, not arithmetic — the same call `narrate` makes for `cash_changed`. The sign is the
 * engine's; this only picks which of two catalogue keys says it out loud. `null` for a figure of
 * `null`: a card that moved no money gets no line, rather than a line reading "0".
 */
export function figureKey(delta: number | null): string | null {
  if (delta === null || delta === 0) {
    return null;
  }
  return delta > 0 ? "card_reveal.gained" : "card_reveal.paid";
}

/**
 * The `lang` and `dir` the card's own text needs, or `null` when it is already the page's language.
 *
 * ## Why this exists
 *
 * `cards.he.json` does not exist. MON-506 owns it — 31 card texts need a native speaker, and this
 * repo's standing rule is that invented game data is worse than missing data, because a fabricated
 * catalogue reads fine and nobody re-checks it. So in a Hebrew game today the card body is **English
 * text inside an RTL page**, and that is a fact to be marked up rather than a fact to be hidden.
 *
 * Unmarked, it fails twice. A screen reader keeps its Hebrew voice and pronounces English words with
 * Hebrew phonetics, which is closer to noise than to a sentence; and the bidi algorithm resolves the
 * paragraph as RTL, so the card's trailing punctuation jumps to the wrong end of a line that is
 * otherwise entirely LTR. `lang="en" dir="ltr"` on the body fixes both, and it is exactly the class of
 * defect that looks perfect to a sighted English speaker reviewing the diff.
 *
 * ## Why the *text* is inspected, and not i18next
 *
 * Asking i18next which language it resolved from would be the obvious answer, and it cannot work
 * here: `i18n/index.ts` deliberately registers the English `cards` resource under `he` as well, so a
 * Hebrew game shows the card in English instead of throwing on a missing key. There is therefore no
 * miss to observe — from i18next's side the Hebrew lookup *succeeded*.
 *
 * What is left is the only honest observable: the text itself. Hebrew prose necessarily contains
 * Hebrew letters, so the script the string is written in answers the question — and it keeps answering
 * it correctly the day `cards.he.json` lands, with no code change and no flag to remember to flip.
 * That self-closing property is the reason this is a script test rather than a hardcoded `lang="en"`.
 *
 * RTL is checked **first** and deliberately: `$50` and `10` are strong-LTR runs to the bidi
 * algorithm, so a Hebrew card mentioning a figure contains both scripts. Asking "any Hebrew at all?"
 * gets that case right; asking "any Latin at all?" would mark a Hebrew card as English for the sake
 * of its numerals.
 *
 * @param text the resolved card text, exactly as it will be rendered.
 * @param locale whatever i18next reports as the current language. An unknown value is treated as
 * LTR, which is the same fallback `formatInterpolated` makes.
 */
export function cardBodyLanguage(
  text: string,
  locale: string,
): { readonly lang: Locale; readonly dir: Direction } | null {
  // `needsIsolation(value, "ltr")` asks "does this contain strong RTL", and vice versa. Reused rather
  // than re-derived so the script ranges live in exactly one place — see `i18n/bidi.ts` on why the
  // Hebrew and Arabic block boundaries are not what they look like.
  const script: Direction | null = needsIsolation(text, "ltr")
    ? "rtl"
    : needsIsolation(text, "rtl")
      ? "ltr"
      : null;
  if (script === null) {
    // Digits and punctuation only. There is no language in it to declare, and no reordering to fix.
    return null;
  }
  const page = isLocale(locale) ? DIRECTION[locale] : "ltr";
  if (script === page) {
    return null;
  }
  return script === "rtl" ? { lang: "he", dir: "rtl" } : { lang: "en", dir: "ltr" };
}
