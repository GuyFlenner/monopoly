/**
 * The auction, and the two house rules a table may set for it (MON-712).
 *
 * ## Why this is an e2e and not three unit tests
 *
 * It already *is* three unit tests: the engine measures the floor
 * (`test_reducer_auction.py`), the server proves the amendment survives the wire
 * (`test_api.py`), and the setup screen proves the default reaches the request body
 * (`SetupScreen.test.tsx`). Each of them can pass while the feature does nothing, because the thing
 * that can break is the *seam*: a screen that posts `house_rules` a server ignores, a server that
 * applies them to a rule set the engine has already copied, a default that is right in a fixture and
 * absent in the built app. So this spec presses the real controls, against the real engine, and
 * reads a number off the real auction panel.
 *
 * ## The falsifier
 *
 * The central test runs the **same seeded deal twice**, changing one control, and asserts the floor
 * differs. That is what makes it a test of the setting rather than of the board: a hardcoded ₪60
 * would pass against an implementation that ignored the choice and always used the printed price,
 * and asserting "more than 1" would pass against one that opened every lot at the most expensive
 * deed on the board. Two runs, one difference.
 */

import { expect, test, type Page } from "@playwright/test";

import { skipAnimations, startGame } from "./helpers";

/** How many rolls to spend looking for a square the seat can decline. */
const MOVE_BUDGET = 40;

/**
 * Play until a purchase can be declined, then decline it.
 *
 * Declining is the only way to open an auction without a bankruptcy, and which square it happens on
 * is the deal's business — hence a loop rather than a fixture. Returns `false` if the budget runs
 * out, so a test can fail with "never reached an auction" rather than on a missing element.
 */
async function declineSomething(page: Page): Promise<boolean> {
  for (let move = 0; move < MOVE_BUDGET; move += 1) {
    const decline = page.locator('[data-command-kind="decline_purchase"]:visible');
    if ((await decline.count()) > 0) {
      await decline.first().click();
      // Declining is a terminal move, so the bar asks first (MON-405). The confirmation is its own
      // dialog and has to be answered before there is any auction to look at — which is also why
      // the tests below cannot simply assert "a dialog appeared".
      const proceed = page.locator('[data-confirm="proceed"]');
      await expect(proceed).toBeVisible();
      await proceed.click();
      return true;
    }
    for (const kind of ["roll_dice", "end_turn", "roll_for_jail", "pay_jail_fine"]) {
      const chit = page.locator(`[data-command-kind="${kind}"]:visible`);
      if ((await chit.count()) > 0) {
        await chit
          .first()
          .click({ timeout: 2_000 })
          .catch(() => undefined);
        break;
      }
    }
    // The bar is rebuilt from `legal_commands` after every command, so the next iteration reads a
    // fresh one; this waits for that rather than for a duration.
    await page
      .locator("#kesef-actions [data-command-kind]")
      .first()
      .waitFor({ state: "attached", timeout: 10_000 })
      .catch(() => undefined);
  }
  return false;
}

/** The floor the auction opened at, read off the bid field the panel builds from `min_bid`. */
async function openingFloor(page: Page): Promise<number> {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const field = dialog.locator('input[type="number"]');
  await expect(field).toBeVisible();
  return Number(await field.getAttribute("min"));
}

test.describe("a table that leaves the setup screen alone", () => {
  test("has no auction to be stolen from — declining leaves the square with the bank", async ({
    page,
  }) => {
    test.slow();
    // Nothing is pressed but the seat names: this is the game the owner's family actually gets.
    await startGame(page);
    await skipAnimations(page);

    expect(await declineSomething(page), "never reached a purchase decision").toBe(true);

    // Positive first — the game carried on — then the absence, so this cannot pass on a blank page.
    await expect(page.locator("#kesef-actions [data-command-kind]").first()).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByTestId("auction-place-bid")).toHaveCount(0);
  });
});

test.describe("a table that turns auctions on", () => {
  test("opens at the price on the card, not at 1 — the same deal, both ways", async ({ page }) => {
    test.slow();

    // The printed rule first: no reserve, so the floor is ₪1 whatever the square is worth.
    await startGame(page, { auctions: { enabled: true, minimum: "none" } });
    await skipAnimations(page);
    expect(await declineSomething(page), "never reached a purchase decision").toBe(true);
    const noReserve = await openingFloor(page);
    expect(noReserve).toBe(1);

    // The same seed, the same square, one control moved.
    await startGame(page, { auctions: { enabled: true, minimum: "list_price" } });
    await skipAnimations(page);
    expect(await declineSomething(page), "never reached a purchase decision").toBe(true);
    const reserved = await openingFloor(page);

    // A deed, so the printed price — the cheapest on the board is ₪60 and this is not it by accident:
    // it is the price of the square this deal declined, which the other run opened at ₪1.
    expect(reserved).toBeGreaterThan(noReserve);
    expect(reserved).toBeGreaterThanOrEqual(60);
  });
});

test.describe("the controls themselves", () => {
  test("offer the floor only once there is an auction, in Hebrew as well", async ({ page }) => {
    await page.goto("/");
    // The product opens in Hebrew, so this is the state a Hebrew-speaking parent actually meets —
    // and the assertions below are structural, so they say nothing about which words are used.
    await expect(page.locator("html")).toHaveAttribute("lang", "he");

    const off = page.locator('input[name$="-auctions"][value="off"]');
    await expect(off).toBeChecked();
    await expect(page.locator('input[name$="-auction-minimum"]')).toHaveCount(0);

    await page.locator('label:has(input[name$="-auctions"][value="on"])').click();
    // Two floors, and the one that stops the ₪1 steal is the one already chosen.
    await expect(page.locator('input[name$="-auction-minimum"]')).toHaveCount(2);
    await expect(page.locator('input[name$="-auction-minimum"][value="list_price"]')).toBeChecked();
  });
});
