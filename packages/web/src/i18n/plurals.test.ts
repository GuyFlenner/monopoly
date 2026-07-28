/**
 * Plural coverage, asked of the resolver rather than of a table (GAP G-41).
 *
 * Hebrew has a dual. English does not. So the two catalogues genuinely must *not* have the same
 * plural keys, and the question "does this key have all its forms" has a different answer per
 * language — `label.squares` needs `_one`/`_other` in English and `_one`/`_two`/`_other` in Hebrew.
 *
 * The only trustworthy source for which categories a language uses is `Intl.PluralRules`, because
 * that is what i18next calls at runtime to choose a suffix. A hardcoded list would be a second
 * opinion about CLDR, and CLDR moves: Hebrew's `many` category was **removed** from it, which is why
 * `test_locale_parity.py` used to carry a note asking for `_many` keys that would now be dead.
 *
 * `tests/test_locale_parity.py` owns the language-independent half — that both languages say
 * *something* about each base. This file owns the half that needs the resolver.
 */

import { describe, expect, it } from "vitest";

import { LOCALES, type Locale } from ".";
import boardClassicEn from "./locales/board-classic.en.json";
import boardClassicHe from "./locales/board-classic.he.json";
import commonEn from "./locales/common.en.json";
import commonHe from "./locales/common.he.json";

const CLDR_CATEGORIES = ["zero", "one", "two", "few", "many", "other"] as const;
type Category = (typeof CLDR_CATEGORIES)[number];

const CATALOGUES: Readonly<Record<Locale, readonly unknown[]>> = {
  en: [commonEn, boardClassicEn],
  he: [commonHe, boardClassicHe],
};

function flatten(payload: unknown, prefix = ""): string[] {
  if (typeof payload !== "object" || payload === null) {
    return [];
  }
  return Object.entries(payload).flatMap(([key, value]) => {
    const path = `${prefix}${key}`;
    return typeof value === "string" ? [path] : flatten(value, `${path}.`);
  });
}

function isCategory(value: string): value is Category {
  return (CLDR_CATEGORIES as readonly string[]).includes(value);
}

/** `label.squares_one` -> `["label.squares", "one"]`; a non-plural key -> `null`. */
function splitPlural(key: string): readonly [string, Category] | null {
  const at = key.lastIndexOf("_");
  if (at < 0) {
    return null;
  }
  const suffix = key.slice(at + 1);
  return isCategory(suffix) ? [key.slice(0, at), suffix] : null;
}

/** Every plural family in a language's catalogues: base -> the categories it defines. */
function pluralFamilies(locale: Locale): Map<string, Set<Category>> {
  const families = new Map<string, Set<Category>>();
  for (const catalogue of CATALOGUES[locale]) {
    for (const key of flatten(catalogue)) {
      const split = splitPlural(key);
      if (split === null) {
        continue;
      }
      const [base, category] = split;
      const existing = families.get(base) ?? new Set<Category>();
      existing.add(category);
      families.set(base, existing);
    }
  }
  return families;
}

/** The categories this language actually selects between, straight from the runtime. */
function requiredCategories(locale: Locale): Set<string> {
  return new Set(new Intl.PluralRules(locale).resolvedOptions().pluralCategories);
}

describe("plural categories", () => {
  it("agrees with the runtime that Hebrew has a dual and English does not", () => {
    // The premise the rest of this file rests on. If a future ICU changes it, this fails first and
    // names the reason, rather than the coverage tests failing with a confusing diff.
    expect(requiredCategories("en")).toEqual(new Set(["one", "other"]));
    expect(requiredCategories("he")).toEqual(new Set(["one", "two", "other"]));
  });

  it.each(LOCALES)("%s defines every category its plural resolver can ask for", (locale) => {
    const required = requiredCategories(locale);
    const gaps: string[] = [];
    for (const [base, defined] of pluralFamilies(locale)) {
      for (const category of required) {
        if (!defined.has(category as Category)) {
          gaps.push(`${base}_${category}`);
        }
      }
    }
    // A missing category is not a missing string — i18next asks the resolver for `two`, finds no
    // `_two` key, and falls back to the base or to English. In Hebrew that renders a singular for
    // a pair, which is the defect a count is there to prevent.
    expect(gaps, `plural forms ${locale} needs and does not have`).toEqual([]);
  });

  it.each(LOCALES)("%s defines no category its resolver will never ask for", (locale) => {
    const required = requiredCategories(locale);
    const dead: string[] = [];
    for (const [base, defined] of pluralFamilies(locale)) {
      for (const category of defined) {
        if (!required.has(category)) {
          dead.push(`${base}_${category}`);
        }
      }
    }
    // The other direction, and the one that catches stale CLDR knowledge: a `_many` key in Hebrew is
    // a string nobody will ever read, because Hebrew no longer has that category.
    expect(dead, `plural forms ${locale} defines but can never select`).toEqual([]);
  });
});
