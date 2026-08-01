/**
 * The two things every spec in this directory needs: a started game, and a language.
 *
 * Kept deliberately thin. An e2e helper that grows assertions of its own becomes a place where a
 * test passes because the helper was lenient, and the whole point of this surface is that it
 * measures rather than infers.
 */

import { expect, type Locator, type Page } from "@playwright/test";

import { DIRECTION, type Locale } from "../src/i18n/direction";

/** A rectangle, as Playwright reports it. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Start a two-player game and wait for the board.
 *
 * Driven through the real setup screen rather than by seeding a URL, because "can a person get from
 * the setup form to a board" is itself a claim worth checking once per run — and because the game id
 * only exists after the POST, so there is nothing to seed.
 *
 * A fixed seed so the deal is the same every run. The rest of these specs measure geometry, and
 * geometry should not depend on which square a token happens to be standing on.
 */
export async function startGame(
  page: Page,
  options: { readonly ruleset?: "universal" | "kids" } = {},
): Promise<void> {
  await page.goto("/");

  // The product opens in **Hebrew** (see `main.tsx`), so a spec that reads English labels has to ask
  // for English first. Done here rather than in each spec because it is a property of the app, not of
  // any one test — and asserted on its own in `locale.spec.ts`, so switching here cannot hide a
  // regression in what the app opens in.
  await switchTo(page, "en");

  const names = page.getByLabel("Name");
  await expect(names.first()).toBeVisible();
  await names.nth(0).fill("Ruti");
  await names.nth(1).fill("Dan");

  // The rule set, when a spec cares which one. Selected by the input's `value` — the engine's own
  // `RulesetName` — rather than by the visible label, which is translated and would tie the choice
  // to the language this helper has just changed. Same reason as `switchTo`'s locale radio below.
  if (options.ruleset !== undefined) {
    await page.locator(`label:has(input[name$="-ruleset"][value="${options.ruleset}"])`).click();
  }

  // Numeric, because the field is `type="number"` — the engine's RNG is seeded from an integer that
  // is part of the serialized state (ADR-002), not from a free-text label.
  const seed = page.getByLabel("Seed");
  if (await seed.isVisible()) {
    await seed.fill("424242");
  }

  await page.getByRole("button", { name: "Start the game" }).click();
  await expect(page.getByTestId("board-grid")).toBeVisible();
}

/**
 * Switch the page's language and wait until the document agrees.
 *
 * Waits on `<html lang>` and `<html dir>` because `changeLanguage` is a promise: without the wait a
 * measurement taken straight afterwards can read the previous render. This is a *precondition*, not
 * an assertion — the specs that matter measure boxes, since a check on `dir` would be satisfied by
 * the same line of `applyLocale` that sets it (G-F32).
 */
export async function switchTo(page: Page, locale: Locale): Promise<void> {
  // The product has two locale controls on two screens, and this helper has to work on both. The
  // game chrome carries `<LocaleSwitch>` (a button group); the setup screen carries a form radio,
  // because a language choice made while filling in a form belongs to the form. Both write through
  // `useLocale`, so whichever is on screen produces the same result — which is the property that
  // makes trying one and falling back to the other sound rather than sloppy.
  const chromeSwitch = page.getByTestId(`locale-${locale}`);
  if ((await chromeSwitch.count()) > 0) {
    await chromeSwitch.click();
  } else {
    // The setup screen's radios are real inputs kept `sr-only` inside a clickable `<label>`, so that
    // arrow keys work and the focus ring lands on the card a player can see. `.check()` fails their
    // actionability for exactly that reason — the input has no box. Clicking the label is what a
    // person does, and it is what activates the input.
    //
    // Selected by the input's `value`, which is the locale code, rather than by the visible endonym:
    // the group's legend is itself translated, so a name-based lookup would depend on the language
    // this call is trying to change.
    await page.locator(`label:has(input[name$="-locale"][value="${locale}"])`).click();
  }
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
  await expect(page.locator("html")).toHaveAttribute("dir", DIRECTION[locale]);
}

/** A locator's box, failing loudly rather than returning null. */
export async function rectOf(locator: Locator): Promise<Rect> {
  const box = await locator.boundingBox();
  expect(box, "element has no box — it is not laid out").not.toBeNull();
  return box as Rect;
}

/**
 * Measure the same element in both languages, in one page.
 *
 * Returns `[english, hebrew]`. The order matters: English first, so a test that fails has the
 * baseline in the left-hand side of the diff.
 */
export async function inBothLocales<T>(
  page: Page,
  measure: () => Promise<T>,
): Promise<readonly [T, T]> {
  await switchTo(page, "en");
  const english = await measure();
  await switchTo(page, "he");
  const hebrew = await measure();
  return [english, hebrew];
}
