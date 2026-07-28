/**
 * Bidi isolation for interpolated values (GAP G-43).
 *
 * ## The defect
 *
 * `t()` returns a string. A string cannot carry `dir="ltr"` on part of itself, so when a value is
 * interpolated into a sentence running the other way, the Unicode bidirectional algorithm reorders
 * the seam between them — and it does so by *rendering*, so the text is correct in the DOM and wrong
 * on screen. The classic shapes:
 *
 * - `"יצא 3 ו-5, סך הכול 8."` — three numbers in an RTL sentence with neutral characters (spaces,
 *   commas, the hyphen) between them. The neutrals take the paragraph direction and the digit runs
 *   get shuffled relative to them, so a player reads the wrong total.
 * - `"Ruti paid 200"` inside Hebrew — a Latin name is a strong-LTR run, and the punctuation next to
 *   it flips sides.
 * - `"רותי paid 200"` inside *English* — the same defect mirrored. Isolation is not an RTL feature.
 *
 * ## The fix
 *
 * U+2068 FIRST STRONG ISOLATE and U+2069 POP DIRECTIONAL ISOLATE around the value. FSI tells the
 * algorithm to work out the run's direction from its own first strong character and to treat the
 * whole thing as one neutral object in the surrounding text — which is exactly the guarantee wanted:
 * the value reads correctly internally and does not reorder its neighbours.
 *
 * FSI rather than LRM/RLM marks (which patch one seam and leave the other) or LRE/PDF embeddings
 * (deprecated, and they force a direction rather than detecting it). "First strong" is what lets one
 * formatter serve both a number and a name without being told which it got.
 *
 * ## Why it is conditional
 *
 * Only values whose direction *differs* from the page's are isolated. Two reasons, and neither is
 * performance: an isolate around a value that already runs the page's way changes nothing on screen,
 * and these are invisible characters that land in `textContent` — so wrapping unconditionally would
 * put them into every assertion in the suite for no gain. Isolating on difference keeps English
 * output byte-identical unless a Hebrew value is interpolated into it, which is the case that
 * actually needs it.
 */

/** U+2068. Opens a run whose direction is read off its own first strong character. */
const FSI = "⁨";
/** U+2069. Closes the innermost isolate. */
const PDI = "⁩";

/**
 * Hebrew, Arabic, Syriac, Thaana and their presentation forms — the strong-RTL blocks.
 *
 * Written as `\u` escapes rather than literal characters, for two reasons. A literal range is
 * unreadable in a diff when the characters themselves reorder it, and the block boundaries are not
 * what they look like: Arabic Presentation Forms-B ends at U+FEFC, and U+FEFF just past it is the
 * byte-order mark — whitespace rather than a letter, which a range written to the end of the block
 * would silently swallow. ESLint flags exactly that as irregular whitespace, and it is right to.
 */
const RTL_STRONG = /[\u0590-\u05FF\u0600-\u07BF\uFB1D-\uFDFF\uFE70-\uFEFC]/;

/**
 * Latin, Greek, Cyrillic and the digits — strong-LTR, plus the numerals that behave as an LTR run.
 *
 * Digits are included deliberately. They are "weak" rather than strong to the algorithm, which is
 * precisely why they are the common failure: a weak run takes its direction from its neighbours, so
 * two numbers separated by a comma in a Hebrew sentence are the textbook reordering case.
 */
const LTR_STRONG = /[A-Za-z0-9\u0370-\u03FF\u0400-\u04FF]/;

export type Direction = "ltr" | "rtl";

/**
 * Whether a value needs isolating inside a sentence running in `direction`.
 *
 * Reports `false` for a value with no directional content at all (`"—"`, `""`, `"…"`): there is
 * nothing to reorder, and an isolate would be two invisible characters with no job.
 */
export function needsIsolation(value: string, direction: Direction): boolean {
  return direction === "rtl" ? LTR_STRONG.test(value) : RTL_STRONG.test(value);
}

/** Wrap in FSI…PDI unconditionally. Exported for tests and for callers that already decided. */
export function isolate(value: string): string {
  return `${FSI}${value}${PDI}`;
}

/**
 * Isolate a value if the surrounding direction calls for it, otherwise return it unchanged.
 *
 * Already-isolated values are left alone, so a value that passed through a nested `$t()` is not
 * wrapped twice.
 */
export function isolateForDirection(value: string, direction: Direction): string {
  if (value.startsWith(FSI) && value.endsWith(PDI)) {
    return value;
  }
  return needsIsolation(value, direction) ? isolate(value) : value;
}

/**
 * Strip every isolate character. For tests that assert on rendered text.
 *
 * Exported from the module that adds them, so there is one place that knows which characters are
 * involved — a test with a hand-written `.replace(/⁨/g, "")` would be a second copy of that
 * knowledge, and the one that goes stale.
 */
export function stripIsolates(value: string): string {
  return value.replaceAll(FSI, "").replaceAll(PDI, "");
}
