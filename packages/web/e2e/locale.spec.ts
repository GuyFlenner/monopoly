/**
 * What the product opens in, before anybody touches anything.
 *
 * This has its own file because `helpers.ts#startGame` switches to English so the other specs can
 * read English labels — which means none of them can see a regression in the *default*. A spec that
 * asserts a default must be the one spec that never changes it first.
 *
 * The default is Hebrew: the Israeli board is one of the two shipped boards, the whole of M5 exists
 * to serve that reader, and opening in English asks the majority audience to go and find a switch.
 */

import { expect, test } from "@playwright/test";

import { switchTo } from "./helpers";

test.describe("the language the app opens in", () => {
  test("is Hebrew, on the first paint, with no interaction", async ({ page }) => {
    await page.goto("/");

    // The document, the direction and the text, in that order — the three have to agree or the page
    // is half-switched. Checked on `<html>` rather than on a component because `applyLocale` is what
    // sets all three and this is the assertion that it ran at boot.
    await expect(page.locator("html")).toHaveAttribute("lang", "he");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("heading", { level: 1, name: "משחק חדש" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "New game" })).toHaveCount(0);
  });

  test("is still reachable in English from the setup screen", async ({ page }) => {
    // The other half of the decision: defaulting to Hebrew is only defensible if English is one
    // control away, in the language picker that is already on screen and already labelled "English".
    await page.goto("/");
    await switchTo(page, "en");

    await expect(page.getByRole("heading", { level: 1, name: "New game" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  });

  test("does not persist a choice across a reload", async ({ page }) => {
    // Recorded as the current behaviour rather than asserted as desirable. Nothing stores the locale,
    // so a reload returns to Hebrew — which is right for a shared family machine (the next player
    // gets the default, not the last player's choice) and wrong for one person who always plays in
    // English. If that becomes a complaint, the fix is a stored preference and this test is where the
    // change of mind gets recorded.
    await page.goto("/");
    await switchTo(page, "en");
    await page.reload();

    await expect(page.locator("html")).toHaveAttribute("lang", "he");
  });
});
