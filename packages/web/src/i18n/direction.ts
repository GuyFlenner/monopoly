/**
 * Which languages exist, what they are called, and which way they run.
 *
 * Split out of `index.ts` so it can be imported without dragging in the catalogues. `index.ts` calls
 * `i18next.init` with seven JSON bundles attached; anything importing it gets those bundles, which is
 * fine inside Vite and not fine anywhere else — Playwright's specs run under Node's TypeScript
 * loader, where a bare JSON import is an error ("needs an import attribute of type: json"). The e2e
 * helpers need to know that Hebrew is RTL and nothing else, and that is a fact about a language
 * rather than a fact about a resource bundle.
 *
 * `index.ts` re-exports everything here, so callers keep importing from `@/i18n` and nothing had to
 * learn a second path.
 */

export const LOCALES = ["en", "he"] as const;
export type Locale = (typeof LOCALES)[number];

/** Text direction per locale. The single source of truth for RTL. */
export const DIRECTION: Readonly<Record<Locale, "ltr" | "rtl">> = {
  en: "ltr",
  he: "rtl",
};

/**
 * Each language named in itself — endonyms, never "Hebrew".
 *
 * Not catalogue keys, deliberately: somebody looking for their own language must be able to find it
 * whatever the page is currently set to, so these must *not* change when the locale does.
 */
export const LOCALE_LABEL: Readonly<Record<Locale, string>> = {
  en: "English",
  he: "עברית",
};

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}
