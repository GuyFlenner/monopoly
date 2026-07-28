/**
 * i18n setup.
 *
 * The engine speaks only in keys, so this module is the *entire* language layer of the
 * product. Adding a language means adding a catalogue — no component changes, no engine
 * changes.
 *
 * Board tile names live in their own namespace per board (`board-classic`,
 * `board-israel`) rather than in `common`. That is what lets board choice and language be
 * independent: the Israeli board in English is `board-israel` + `en`.
 */

import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import { isolateForDirection } from "./bidi";

import boardClassicEn from "./locales/board-classic.en.json";
import boardClassicHe from "./locales/board-classic.he.json";
import boardIsraelEn from "./locales/board-israel.en.json";
import boardIsraelHe from "./locales/board-israel.he.json";
import cardsEn from "./locales/cards.en.json";
import commonEn from "./locales/common.en.json";
import commonHe from "./locales/common.he.json";

export const LOCALES = ["en", "he"] as const;
export type Locale = (typeof LOCALES)[number];

/** Text direction per locale. The single source of truth for RTL. */
export const DIRECTION: Readonly<Record<Locale, "ltr" | "rtl">> = {
  en: "ltr",
  he: "rtl",
};

export const LOCALE_LABEL: Readonly<Record<Locale, string>> = {
  en: "English",
  he: "עברית",
};

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/**
 * Every interpolated value, on its way into a sentence.
 *
 * The one transformation applied to all of them is bidi isolation (GAP G-43): a number or a Latin
 * name dropped into a Hebrew sentence reorders its neighbours on screen while being correct in the
 * DOM. See `bidi.ts` for why FSI/PDI and why it is conditional on direction.
 *
 * Values are stringified here rather than left to i18next's concatenation so that the isolation
 * decision sees the same text the player will. `null` and `undefined` become empty strings — a
 * missing param is a defect, but it is `missingInterpolationHandler`'s defect to report, and
 * printing "undefined" at a child while it is investigated is not an improvement.
 *
 * **Not a money formatter.** Amounts still interpolate bare. Deciding how currency renders (symbol,
 * placement, grouping) changes English output and wants a product decision, so it is deliberately
 * out of this function rather than smuggled into it.
 */
function formatInterpolated(value: unknown, lng: string | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  const direction = lng !== undefined && isLocale(lng) ? DIRECTION[lng] : "ltr";
  return isolateForDirection(text, direction);
}

/**
 * Apply a locale to the document.
 *
 * Setting `dir` on `<html>` mirrors the entire layout — provided every component used
 * logical CSS properties (`ms-*`, `me-*`, `start`, `end`) rather than physical ones. A
 * stray `ml-4` is a bug that is invisible in English and obvious in Hebrew.
 */
export function applyLocale(locale: Locale): void {
  const root = document.documentElement;
  root.lang = locale;
  root.dir = DIRECTION[locale];
  void i18next.changeLanguage(locale);
}

export const i18n = i18next.use(initReactI18next);

export async function initI18n(locale: Locale = "en"): Promise<void> {
  await i18n.init({
    lng: locale,
    fallbackLng: "en",
    defaultNS: "common",
    // "board-israel" was held out of this array until MON-503 supplied a verified
    // catalogue — a declared namespace with no resources would let the picker select an
    // unreadable board (GAP G-46). MON-503 landed both languages, read off the physical
    // board, so it is registered here like any other board namespace.
    //
    // "cards" is English-only on purpose: MON-206 shipped the 31 card texts, and MON-506
    // owns the Hebrew (31 strings needing a native speaker, tripwired in
    // tests/test_locale_parity.py). It is registered for *both* languages against the same
    // English resource so a Hebrew game shows the card in English rather than raising on a
    // missing key — the deck is unreadable without it, which is what MON-407 found.
    ns: ["common", "board-classic", "board-israel", "cards"],
    resources: {
      en: {
        common: commonEn,
        "board-classic": boardClassicEn,
        "board-israel": boardIsraelEn,
        cards: cardsEn,
      },
      he: {
        common: commonHe,
        "board-classic": boardClassicHe,
        "board-israel": boardIsraelHe,
        cards: cardsEn,
      },
    },
    interpolation: {
      escapeValue: false,
      // `alwaysFormat` is what makes the formatter below run at all: without it i18next calls
      // `format` only for interpolations that name one (`{{amount, currency}}`), and bidi isolation
      // must not be something a catalogue author has to remember per placeholder. It is a property
      // of *where the value lands*, not of the value, so the catalogues stay free of format specs —
      // which also keeps `{{name}}` matching the placeholder-parity check in
      // tests/test_locale_parity.py.
      alwaysFormat: true,
      format: (value, _format, lng) => formatInterpolated(value, lng),
    },
    // A missing key must be loud, not a `console.error` nobody watches (GAP G-F17). Both
    // the Vite dev server and a Vitest run should fail hard on it — `import.meta.env.DEV`
    // covers `npm run dev`, `MODE === "test"` covers the test runner, where DEV alone
    // cannot be relied on.
    saveMissing: import.meta.env.DEV || import.meta.env.MODE === "test",
    missingKeyHandler: (_lngs, ns, key) => {
      if (import.meta.env.DEV || import.meta.env.MODE === "test") {
        throw new Error(`[i18n] missing key: ${ns}:${key}`);
      }
    },
  });
  applyLocale(locale);
}
