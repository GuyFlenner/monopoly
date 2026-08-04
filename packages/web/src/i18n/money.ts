/**
 * Money, on screen (MON-720, GAP G-43).
 *
 * The one thing the i18n layer deliberately refused to decide until now. `index.ts` said so where the
 * interpolation formatter lives: *"Not a money formatter. Amounts still interpolate bare. Deciding how
 * currency renders (symbol, placement, grouping) changes English output and wants a product decision."*
 * The owner made it on 2026-08-04: **`$50` in English, `50 ₪` in Hebrew.**
 *
 * Until then the product was inconsistent with itself rather than merely plain: eighteen English
 * *cards* said `$50` because a card is prose somebody wrote, while every figure the UI computed — cash,
 * rent, a bid, a net worth — was a bare number. So a child read "pay $50" on the card and watched 50
 * leave their pile.
 *
 * ## The symbol is per locale, not per game
 *
 * There is one board, one economy and one set of prices; what changes is the language it is described
 * in. So this is a **presentation** table keyed by locale, not a field on the game, and nothing here
 * reaches the engine — the engine's amounts are integers and stay integers (ADR-003 §6: the engine
 * returns keys and numbers, never prose).
 *
 * That also means the same saved game shows `$50` to an English speaker and `50 ₪` to a Hebrew one,
 * which is the intended reading of "the same table, described twice".
 *
 * ## Why the placement differs, and why it is not a `toLocaleString`
 *
 * English puts the sign first and Hebrew puts it last, which is the convention in each. `Intl`
 * *can* do this — `new Intl.NumberFormat("he-IL", {style: "currency", currency: "ILS"})` — and is not
 * used, for two reasons:
 *
 * 1. It prints `‏50.00 ₪` with two decimal places, and this game has no agorot: every amount in the
 *    engine is a whole number of units. Suppressing the decimals costs the same options object this
 *    table costs, and then the *grouping* is still locale data that can change under the product
 *    between browser versions.
 * 2. `en` here is not `en-US`. The catalogue is a language, not a region, and asking `Intl` for
 *    currency forces a region choice that nothing else in the product makes.
 *
 * Grouping is applied by hand for the same reason: `1,500` is worth having on a dossier, and it is one
 * line of code whose output does not depend on which ICU the browser shipped.
 */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { isLocale, type Locale } from "./direction";

/**
 * The symbol each language prints, and which side of the figure it sits on.
 *
 * A `Record<Locale, …>` so adding a language is a compile error here rather than a bare number in
 * front of a player — the same coverage trick `LOCALE_LABEL` and `ACTION_THEME` use.
 */
export const CURRENCY: Readonly<
  Record<Locale, { readonly symbol: string; readonly before: boolean }>
> = {
  en: { symbol: "$", before: true },
  he: { symbol: "₪", before: false },
};

/**
 * The space between a Hebrew figure and its shekel sign: **non-breaking**.
 *
 * `50` and the sign are one token to a reader and must not be split across a line, which a plain
 * space permits and which a narrow phone column makes likely — this product commits to 320 px.
 * Testing Library and Playwright both normalise it to a space when matching text, so it is invisible
 * to the assertions and visible in the layout, which is the right way round.
 *
 * Written as an escape rather than as the character. eslint would in fact allow the literal here —
 * `no-irregular-whitespace` defaults to `skipStrings: true` — and that is the argument *for* the
 * escape rather than against it: a rule that cannot see a character is a rule that cannot tell you
 * when it is wrong, and an invisible code point in source is one nobody reviewing a diff can see.
 */
const NBSP = "\u00a0";

/**
 * One amount, as the given language writes it.
 *
 * Negative amounts keep the sign in front of the digits in both languages (`-$50`, `50-₪` would be
 * wrong): the minus belongs to the number. Nothing in the product currently renders a negative
 * amount — the engine forbids negative cash outside `DEBT_SETTLEMENT`, and a debt is rendered as a
 * positive figure it *owes* — so this is defensive rather than a feature, and it is tested as such.
 */
export function formatMoney(amount: number, locale: Locale): string {
  const { symbol, before } = CURRENCY[locale];
  // The sign leads the *whole* figure, symbol included: `-$50`, never `$-50`. The first draft of this
  // put it between the symbol and the digits, which its own test caught.
  const sign = amount < 0 ? "-" : "";
  const digits = grouped(Math.abs(Math.trunc(amount)));
  return before ? `${sign}${symbol}${digits}` : `${sign}${digits}${NBSP}${symbol}`;
}

/**
 * Thousands separated by commas, by hand.
 *
 * `toLocaleString()` would do it and would do it differently depending on the browser's ICU data and
 * the resolved region — a figure that is `1,500` in one browser and `1 500` in another is a figure a
 * screenshot in a bug report cannot be trusted about. A comma is also what the Hebrew locale uses, so
 * there is nothing to branch on.
 */
function grouped(whole: number): string {
  return whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * A formatter bound to the language the page is in.
 *
 * For the figures that never pass through a catalogue sentence — a dossier's cash, a net worth, a
 * price on a square. Those are rendered as a bare number by a component, so *something* has to tell
 * them the symbol, and a hook is how every other cross-cutting presentation fact in this package
 * arrives (`useCopy`, `useMotionPreference`, `useCardDwellPreference`).
 *
 * Read from i18next rather than passed down, so a language switch re-renders the figures with it.
 * `i18n.language` can be a tag i18next resolved (`en-GB`), so it is narrowed through `isLocale`
 * rather than cast — an unrecognised language falls back to English, which is what `fallbackLng`
 * already promises for its text.
 */
export function useMoney(): (amount: number) => string {
  const { i18n } = useTranslation();
  const language = i18n.language;
  return useCallback(
    (amount: number) => formatMoney(amount, isLocale(language) ? language : "en"),
    [language],
  );
}
