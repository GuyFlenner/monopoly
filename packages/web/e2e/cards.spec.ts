/**
 * The drawn card, in the language the game is being played in (MON-506, MON-709).
 *
 * ## Why this needs a browser
 *
 * The catalogue is checked by `tests/test_locale_parity.py` and the component by
 * `CardReveal.test.tsx`, and both can pass while a player still sees English: what neither can see
 * is the *built* app's resource registration. `i18n/index.ts` pointed both languages at the English
 * card resource for months, and every unit test was green throughout, because the unit tests load
 * the catalogue they are told to load. This one plays a real game and reads the card off the board.
 *
 * ## Catching something that is deliberately transient
 *
 * The card is a beat in the animation queue: it is up for `cardMs` and then gone. Polling for it
 * between rolls would be a race — and a spec that waited for it *before* rolling would be waiting
 * for a card that has not been drawn yet. So the page records every card text it ever renders,
 * through a `MutationObserver` installed before the first roll, and the assertions read the
 * recording. Nothing about the product is changed to make it observable.
 */

import { expect, test, type Page } from "@playwright/test";

import { skipAnimations, startGame } from "./helpers";

/** Rolls to spend looking for a Chance or Community Chest square. */
const MOVE_BUDGET = 60;

const HEBREW = /[֐-׿]/;
/** Latin letters only — digits are not a language, and a Hebrew card may quote a figure. */
const LATIN = /[A-Za-z]/;

/** Record every card text the board puts up, from now until the page navigates. */
async function recordCards(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __cards: string[] }).__cards = seen;
    const note = (): void => {
      const body = document.querySelector('[data-testid="card-reveal-text"]');
      const text = body?.textContent.trim();
      if (text !== undefined && text !== "" && seen[seen.length - 1] !== text) {
        seen.push(text);
      }
    };
    new MutationObserver(note).observe(document.body, { childList: true, subtree: true });
    note();
  });
}

async function recordedCards(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => (window as unknown as { __cards: string[] }).__cards);
}

/** Play quiet moves until at least one card has been drawn, or the budget runs out. */
async function playUntilACardIsDrawn(page: Page): Promise<boolean> {
  for (let move = 0; move < MOVE_BUDGET; move += 1) {
    if ((await recordedCards(page)).length > 0) {
      return true;
    }
    // Buying is skipped deliberately: a seat that spends its cash on squares goes bankrupt sooner,
    // and this spec wants turns rather than a game.
    for (const kind of [
      "roll_dice",
      "decline_purchase",
      "end_turn",
      "pay_jail_fine",
      "roll_for_jail",
    ]) {
      const chit = page.locator(`[data-command-kind="${kind}"]:visible`);
      if ((await chit.count()) === 0) {
        continue;
      }
      await chit
        .first()
        .click({ timeout: 2_000 })
        .catch(() => undefined);
      const proceed = page.locator('[data-confirm="proceed"]');
      if ((await proceed.count()) > 0) {
        await proceed.click({ timeout: 2_000 }).catch(() => undefined);
      }
      break;
    }
    await page
      .locator("#kesef-actions [data-command-kind]")
      .first()
      .waitFor({ state: "attached", timeout: 10_000 })
      .catch(() => undefined);
  }
  return (await recordedCards(page)).length > 0;
}

test("a Hebrew game deals Hebrew cards", async ({ page }) => {
  test.slow();
  await startGame(page, { locale: "he" });
  await skipAnimations(page);
  await recordCards(page);

  expect(await playUntilACardIsDrawn(page), "no card was drawn in the move budget").toBe(true);

  const cards = await recordedCards(page);
  for (const text of cards) {
    expect(text, `a card came up with no Hebrew in it: ${text}`).toMatch(HEBREW);
    // The falsifier for the whole of MON-506. Before it, `i18n/index.ts` registered the English
    // resource under `he`, so every card in a Hebrew game was an English sentence — and it was a
    // *successful* lookup, so nothing threw and no missing key was reported.
    expect(text, `a card came up in English inside a Hebrew game: ${text}`).not.toMatch(LATIN);
  }
});

test("an English game still deals English cards", async ({ page }) => {
  // The other half of the pair. A catalogue wired the wrong way round — Hebrew under `en` — would
  // satisfy the test above and break the English game, and neither is more likely than the other.
  test.slow();
  await startGame(page);
  await skipAnimations(page);
  await recordCards(page);

  expect(await playUntilACardIsDrawn(page), "no card was drawn in the move budget").toBe(true);

  for (const text of await recordedCards(page)) {
    expect(text, `an English game showed a card with no English in it: ${text}`).toMatch(LATIN);
    expect(text, `an English game showed Hebrew: ${text}`).not.toMatch(HEBREW);
  }
});
