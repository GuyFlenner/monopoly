/**
 * The current locale, read from i18next rather than mirrored beside it.
 *
 * ## Why this is not `useState` in `App`
 *
 * It was, and that only worked while one control could change the language. MON-501 adds a second
 * one in the game's chrome, and two components each holding their own copy of "which language" is
 * the shape of bug where the setup screen's radio group still says English after the header's
 * switch moved the page to Hebrew.
 *
 * So there is exactly one source of truth — `i18next.language`, which is also the thing that
 * actually decides what `t()` returns — and this hook subscribes to it. Same reasoning as the
 * module-level store behind `SkipAnimationsToggle`: a setting reachable from two places must not be
 * stored in either of them.
 *
 * `useSyncExternalStore` rather than a `useEffect` + `setState` pair, because i18next can change
 * language between render and effect (any `applyLocale` call outside React does), and that gap is
 * a torn read the store API exists to close.
 */

import { useCallback, useSyncExternalStore } from "react";

import { applyLocale, i18n, isLocale, type Locale } from ".";

const FALLBACK: Locale = "en";

function subscribe(onChange: () => void): () => void {
  i18n.on("languageChanged", onChange);
  return () => {
    i18n.off("languageChanged", onChange);
  };
}

/**
 * Whatever i18next is resolving keys against, narrowed to a locale we ship.
 *
 * i18next reports things like `en-GB` when a browser asks for one, and `LOCALES` is the closed set
 * this product has catalogues for — so the value is narrowed rather than cast. A locale we do not
 * ship is reported as the fallback, which is what `t()` will be resolving against anyway.
 */
function readLocale(): Locale {
  // No `?? FALLBACK` before the narrowing: i18next types `language` as a string, and `isLocale`
  // rejects anything outside `LOCALES` — including the `undefined` the runtime can hand back before
  // `init()` resolves. One guard, not two, and the one that is actually load-bearing.
  return isLocale(i18n.language) ? i18n.language : FALLBACK;
}

/**
 * The current locale and a setter that changes the page's language.
 *
 * The setter is `applyLocale`, so `<html lang>` and `<html dir>` move with the catalogue — the
 * three are one decision and separating them is how a page ends up in Hebrew still reading
 * left-to-right.
 *
 * **It touches no game state.** Language lives in i18next and the document element; the game lives
 * in the engine and reaches this package as a projection cached by TanStack Query. Nothing here
 * invalidates that cache, which is what makes a mid-game switch safe rather than merely untested.
 */
export function useLocale(): readonly [Locale, (locale: Locale) => void] {
  const locale = useSyncExternalStore(subscribe, readLocale, () => FALLBACK);
  const setLocale = useCallback((next: Locale) => {
    applyLocale(next);
  }, []);
  return [locale, setLocale];
}
