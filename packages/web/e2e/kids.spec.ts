/**
 * Kids Mode, measured in a real browser (MON-604, MON-605).
 *
 * Two of this item's acceptance criteria are not assertable under jsdom, and they are the two that
 * would go wrong quietly:
 *
 * 1. **The comfort scale actually reaches the controls.** `--kesef-target` is set by one attribute
 *    on an ancestor and read by the `.target` utility, which means the whole thing depends on the
 *    cascade and on Tailwind having emitted the utility at all. jsdom computes no layout, so a
 *    Vitest test can only assert that the *attribute* is present — which is exactly what would still
 *    pass if the CSS rule were deleted. Here the boxes are measured.
 * 2. **The bigger targets still fit a 320 px phone.** Raising every control by 12 px is the kind of
 *    change that pushes a row past the viewport, and a horizontal scrollbar on a child's tablet is
 *    the failure. `rtl.spec.ts` guards this for the universal rule set; this guards the variant with
 *    the larger boxes in it, which is the one that can regress it.
 *
 * The auction and mortgage assertions are here as well, because *absent* is a claim about the whole
 * rendered page rather than about any one component, and each is paired with a positive check — a
 * page that failed to load would satisfy every "is not present" on its own.
 */

import { expect, test, type Page } from "@playwright/test";

import { KIDS_TARGET_PX, MIN_TARGET_PX } from "../src/theme/surfaces";
import { startGame } from "./helpers";

/** Every control the game screen renders, as boxes. `.target` is the class that carries the floor. */
async function controlBoxes(page: Page): Promise<readonly { w: number; h: number }[]> {
  return page.locator(".target:visible").evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return { w: box.width, h: box.height };
    }),
  );
}

test.describe("Kids Mode steps the comfort scale up", () => {
  test("grows every control past the 44 px floor, on both axes", async ({ page }) => {
    await startGame(page, { ruleset: "kids" });

    const boxes = await controlBoxes(page);
    expect(boxes.length, "no `.target` controls on screen at all").toBeGreaterThan(3);
    for (const box of boxes) {
      // Both axes: a 56 px-tall control 20 px wide passes a naive height check and still cannot be
      // hit by a six-year-old, which is the whole reason `.target` sets both.
      expect(box.h, "a control is shorter than the kids target").toBeGreaterThanOrEqual(
        KIDS_TARGET_PX - 0.5,
      );
      expect(box.w, "a control is narrower than the kids target").toBeGreaterThanOrEqual(
        KIDS_TARGET_PX - 0.5,
      );
    }
  });

  test("leaves the universal rule set on the 44 px floor", async ({ page }) => {
    // The other half of the claim: if the property were declared globally rather than scoped, a full
    // game would have grown too and the test above would still pass.
    await startGame(page, { ruleset: "universal" });

    const boxes = await controlBoxes(page);
    expect(boxes.length).toBeGreaterThan(3);
    for (const box of boxes) {
      expect(box.h).toBeGreaterThanOrEqual(MIN_TARGET_PX - 0.5);
    }
    expect(
      Math.min(...boxes.map((box) => box.h)),
      "a full game is already using the kids scale",
    ).toBeLessThan(KIDS_TARGET_PX);
  });

  for (const locale of ["en", "he"] as const) {
    test(`still fits a 320 px phone in ${locale}`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 900 });
      await startGame(page, { ruleset: "kids" });
      if (locale === "he") {
        await page.getByTestId("locale-he").click();
        await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
      }

      const document = await page.evaluate(() => ({
        scrollWidth: window.document.documentElement.scrollWidth,
        clientWidth: window.document.documentElement.clientWidth,
      }));
      expect(
        document.scrollWidth,
        "the bigger targets pushed the page sideways",
      ).toBeLessThanOrEqual(document.clientWidth + 1);
    });
  }
});

test.describe("Kids Mode leaves the sharp edges out", () => {
  test("offers no auction or mortgage affordance anywhere on the page", async ({ page }) => {
    await startGame(page, { ruleset: "kids" });

    // Positive first, so the absences below cannot be satisfied by a blank screen.
    await expect(page.getByTestId("board-grid")).toBeVisible();
    await expect(page.locator("[data-command-kind]").first()).toBeVisible();

    for (const kind of ["mortgage_property", "unmortgage_property", "place_bid"]) {
      await expect(page.locator(`[data-command-kind="${kind}"]`)).toHaveCount(0);
    }
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // Absent, not disabled — an unreachable button is clutter to a child.
    await expect(page.locator("[data-command-kind][disabled]")).toHaveCount(0);
  });

  test("shows whose turn it is with a piece as well as a name", async ({ page }) => {
    await startGame(page, { ruleset: "kids" });
    const banner = page.getByTestId("turn-banner");
    await expect(banner).toHaveAttribute("data-kids", "true");
    await expect(banner).toContainText("Ruti");
    await expect(banner.locator("svg path").first()).toBeVisible();
  });

  test("opens the hint and marks the move it names (MON-605)", async ({ page }) => {
    await startGame(page, { ruleset: "kids" });

    await expect(page.getByTestId("hint-panel")).toHaveAttribute("data-prominent", "true");
    await expect(page.getByTestId("hint-reason")).toContainText("Every turn starts with a roll");
    // Exactly one chit marked, and it is the one the ranking named.
    await expect(page.locator('[data-hinted="true"]')).toHaveCount(1);
    await expect(page.locator('[data-hinted="true"]')).toHaveAttribute(
      "data-command-kind",
      "roll_dice",
    );
  });
});
