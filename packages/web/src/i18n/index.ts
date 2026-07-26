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

import boardClassicEn from "./locales/board-classic.en.json";
import boardClassicHe from "./locales/board-classic.he.json";
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
    // "board-israel" stays out of this array until MON-503 supplies its catalogue —
    // a declared namespace with no resources would let the picker select an unreadable
    // board (GAP G-46).
    ns: ["common", "board-classic"],
    resources: {
      en: { common: commonEn, "board-classic": boardClassicEn },
      he: { common: commonHe, "board-classic": boardClassicHe },
    },
    interpolation: { escapeValue: false },
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
