/**
 * The same sentence, said more simply — Kids Mode's wording layer (MON-604).
 *
 * ## The mechanism, and why it is a prefix rather than a suffix
 *
 * Every key the product renders may have a simpler twin under `kids.`: `actionbar.label` beside
 * `kids.actionbar.label`, `action.buy_property` beside `kids.action.buy_property`. In a kids game
 * {@link useCopy} prefers the twin **where one exists** and falls back to the ordinary key where
 * none does, so the catalogue can be simplified one high-traffic label at a time without a single
 * component learning which labels have been done.
 *
 * A prefix rather than an `action.buy_property_kids` suffix for two reasons. It keeps the simple
 * wording in one readable block of the catalogue that a parent-facing reviewer can read end to
 * end, and it cannot collide with a plural form: `tests/test_locale_parity.py` compares keys by
 * their *plural base*, so a trailing `_kids` sits in exactly the space `_one` and `_other` use.
 *
 * ## Missing keys still throw, and that is why `exists` is asked first
 *
 * `missingKeyHandler` raises under dev and test by design (GAP G-F17). Asking `i18n.exists` before
 * reaching for the twin is what makes "there is no simpler wording for this one yet" the ordinary
 * case rather than a crash — the same guarded lookup the event log, the action bar and the dossier
 * all use for board-scoped square names.
 *
 * Namespaced keys (`board-classic:tile.classic.go`) are never twinned: `kids.board-classic:…`
 * would name a namespace that does not exist, so they are handed straight through. Square names
 * are proper nouns; there is no simpler word for Boardwalk.
 */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";

/**
 * A translate function. Structurally the board's `Translate`, so a `Copy` can be passed anywhere
 * one is wanted without a cast.
 */
export type Copy = (key: string, params?: Readonly<Record<string, string | number>>) => string;

/** The namespace the simpler wording lives under, inside `common`. */
export const KIDS_PREFIX = "kids.";

/** The simpler twin of a key, or `null` for a key that cannot have one. */
export function kidsKey(key: string): string | null {
  // A colon is i18next's namespace separator, and `kids.` is a key prefix, not a namespace.
  return key.includes(":") || key.startsWith(KIDS_PREFIX) ? null : `${KIDS_PREFIX}${key}`;
}

/**
 * Translate, preferring the simpler wording when a kids game is in play.
 *
 * @param kids `presentationFor(state.ruleset).kids`. `false` makes this exactly `t`.
 */
export function useCopy(kids: boolean): Copy {
  const { t, i18n } = useTranslation();
  return useCallback<Copy>(
    (key, params) => {
      const simple = kids ? kidsKey(key) : null;
      const chosen = simple !== null && i18n.exists(simple) ? simple : key;
      return t(chosen, params ?? {});
    },
    [kids, t, i18n],
  );
}
