/**
 * The property card's fold, measured where it can be (owner feedback, 2026-07-29).
 *
 * The complaint was that the card left no room for the history beside it. `PlayerDossier.test.tsx`
 * asserts the `<details>` starts closed, which is the fact jsdom can answer — jsdom implements
 * `<details>` but applies none of the UA stylesheet that hides a closed one, so its children report as
 * visible either way. The claim that actually matters is spatial: **the log gets more room**, and only
 * a layout engine can settle that.
 */

import { expect, test } from "@playwright/test";

import { rectOf, startGame } from "./helpers";

test.describe("the property card's deed list", () => {
  test("is folded away on arrival, and the log is taller for it", async ({ page }) => {
    await startGame(page);

    const deeds = page.getByTestId("deed-spine").first();
    const summary = page.locator('[data-testid="player-dossier"] summary').first();

    // Closed: the deed rows are in the DOM and not painted.
    await expect(deeds).toBeHidden();

    // What folding actually buys, measured rather than assumed. The first version of this test
    // asserted the log got *taller*, and it does not: the log is sized by its content (125 px either
    // way) and the column simply grows, so the deed list pushes the history **down the page** rather
    // than squeezing it. Folding moves the history up toward the viewport, which is the thing the
    // feedback was about — "room for the history" means reaching it without scrolling past the card.
    const log = page.getByRole("region", { name: "What's happened" });
    const folded = await rectOf(log);

    await summary.click();
    await expect(deeds).toBeVisible();
    const unfolded = await rectOf(log);

    expect(
      folded.y,
      "folding the deed list should bring the history closer to the top, not leave it where it was",
    ).toBeLessThan(unfolded.y);
  });

  test("keeps cash and net worth on screen while folded", async ({ page }) => {
    await startGame(page);

    // The reason only the deed list folds. These are what a player checks between moves; the deed
    // list is the part that grows through the game and squeezes the log out of the column.
    await expect(page.getByTestId("dossier-cash")).toBeVisible();
    await expect(page.getByTestId("dossier-net-worth")).toBeVisible();
    await expect(page.getByTestId("deed-spine").first()).toBeHidden();
  });

  test("opens from the keyboard", async ({ page }) => {
    await startGame(page);

    // A native `<summary>` is focusable and responds to Enter with no handler of our own. Asserted
    // because the alternative implementation — a div with an onClick — would pass every other test in
    // this file and fail this one, and a child who cannot use a mouse is exactly who this is for.
    const summary = page.locator('[data-testid="player-dossier"] summary').first();
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("deed-spine").first()).toBeVisible();
  });
});
