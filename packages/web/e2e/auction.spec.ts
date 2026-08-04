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
 *
 * `confirms` says which game this is, and is asserted rather than tolerated (MON-718). With auctions
 * on, declining can hand the deed to somebody else and the bar asks first (MON-405). With auctions
 * off there is nothing to lose — the square stays unsold — so the dialog is gone, and a helper that
 * merely *coped* with either would let it come back unnoticed on the table that does not want it.
 */
async function declineSomething(page: Page, confirms: boolean): Promise<boolean> {
  for (let move = 0; move < MOVE_BUDGET; move += 1) {
    const decline = page.locator('[data-command-kind="decline_purchase"]:visible');
    if ((await decline.count()) > 0) {
      await decline.first().click();
      const proceed = page.locator('[data-confirm="proceed"]');
      if (confirms) {
        await expect(proceed).toBeVisible();
        await proceed.click();
      } else {
        await expect(proceed, "a table with no auctions was asked to confirm").toHaveCount(0);
      }
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

    expect(await declineSomething(page, false), "never reached a purchase decision").toBe(true);

    // Positive first — the game carried on — then the absence, so this cannot pass on a blank page.
    await expect(page.locator("#kesef-actions [data-command-kind]").first()).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByTestId("auction-place-bid")).toHaveCount(0);
  });

  test("hands the dice on by itself when a purchase is declined", async ({ page }) => {
    test.slow();
    /*
      The owner's second ask about declining (2026-08-04): *"if I chose not to purchase, end the turn;
      the next click should be the next player rolling."* The decision is a unit test
      (`autoEndTurn.test.ts`); what needs a browser is the *sequence* — two commands posted from one
      press, the second built from the first's response.

      The assertion is deliberately "no `end_turn` chit, and a `roll_dice` one", because that holds
      **both** ways the engine can answer and so cannot be flaky about the deal:

      * an ordinary roll — the turn ends, the next seat is at `AWAITING_ROLL`;
      * doubles — `end_turn` was never offered, and the same seat rolls again.

      Either way the player is never left holding an "I'm done" button after saying "no thanks", which
      is the whole of what was asked for.
    */
    await startGame(page);
    await skipAnimations(page);

    expect(await declineSomething(page, false), "never reached a purchase decision").toBe(true);

    const actions = page.locator("#kesef-actions");
    await expect(actions.locator('[data-command-kind="roll_dice"]')).toBeVisible();
    await expect(
      actions.locator('[data-command-kind="end_turn"]'),
      "the player was left to press end-turn after declining",
    ).toHaveCount(0);
  });
});

test.describe("a table that turns auctions on", () => {
  test("opens at the price on the card, not at 1 — the same deal, both ways", async ({ page }) => {
    test.slow();

    // The printed rule first: no reserve, so the floor is ₪1 whatever the square is worth.
    await startGame(page, { auctions: { enabled: true, minimum: "none" } });
    await skipAnimations(page);
    expect(await declineSomething(page, true), "never reached a purchase decision").toBe(true);
    const noReserve = await openingFloor(page);
    expect(noReserve).toBe(1);

    // The same seed, the same square, one control moved.
    await startGame(page, { auctions: { enabled: true, minimum: "list_price" } });
    await skipAnimations(page);
    expect(await declineSomething(page, true), "never reached a purchase decision").toBe(true);
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
