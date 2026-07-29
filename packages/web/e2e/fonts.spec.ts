/**
 * Does the typeface actually arrive (MON-504).
 *
 * `src/fonts.css.test.ts` reads the declarations and proves the *contract* — self-hosted, subset,
 * `swap`. It cannot prove the files are where the URLs say, that Vite emitted them, or that the
 * browser chose Heebo over a system font, because jsdom has no font machinery at all. Those are the
 * failures that survive a green unit suite: a renamed directory, a build that did not copy the asset,
 * a `unicode-range` that excludes the very glyphs the Hebrew build needs.
 *
 * So every assertion here goes through `document.fonts`, which is the browser's own answer.
 */

import { expect, test } from "@playwright/test";

import { switchTo } from "./helpers";

/** Wait for the font machinery to settle, then report what actually loaded. */
async function loadedFaces(page: import("@playwright/test").Page): Promise<readonly string[]> {
  return page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts]
      .filter((face) => face.status === "loaded")
      .map((face) => face.family);
  });
}

test.describe("the self-hosted typeface", () => {
  test("loads Heebo for an English page", async ({ page }) => {
    await page.goto("/");
    // Explicit: the app opens in Hebrew, and this test is about the Latin face.
    await switchTo(page, "en");
    await expect(page.getByRole("heading", { level: 1, name: "New game" })).toBeVisible();

    // `check()` asks "would this font be used for this text", which is the question that matters —
    // a face can be present and still lose to a `unicode-range` that excludes the string.
    const usesHeebo = await page.evaluate(async () => {
      await document.fonts.ready;
      return document.fonts.check('1rem "Heebo"');
    });
    expect(usesHeebo, "Heebo did not load for Latin text").toBe(true);
  });

  test("serves Hebrew text from the Hebrew face, on both screens", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "משחק חדש" })).toBeVisible();

    // This test first claimed the Hebrew face loads "only once Hebrew is on screen", and that is
    // false — for a reason worth recording rather than working around. **The language picker labels
    // itself with the endonym**, so `עברית` is painted on the very first frame of an English page, in
    // both the setup radio group and the game chrome's switch. Hebrew glyphs are therefore never
    // deferred, and a test asserting they were would have been asserting a design mistake: labelling
    // the Hebrew option "Hebrew" is what would make the subset lazy, and it is exactly what a
    // Hebrew-speaking player cannot read.
    //
    // What the `unicode-range` split still buys is that Latin and Hebrew are separate requests, so
    // neither range is re-downloaded when the other changes. What is worth asserting is the thing a
    // broken path or a wrong range would actually break: that Hebrew text resolves to Heebo.
    const bothFaces = await loadedFaces(page);
    expect(bothFaces.filter((family) => family === "Heebo")).toHaveLength(2);

    const hebrewRenders = await page.evaluate(async () => {
      await document.fonts.ready;
      // A string of Hebrew, so the range that answers is the Hebrew one.
      return document.fonts.check('1rem "Heebo"', "רחוב הכסף");
    });
    expect(hebrewRenders, "Heebo did not load for Hebrew text").toBe(true);
  });

  test("fetches no font from a third party", async ({ page }) => {
    // The self-hosting criterion, checked at the only level that can actually establish it: what the
    // browser asked for. A stylesheet can be clean while an @import two levels down reaches a CDN.
    const external: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (/fonts\.(googleapis|gstatic)\.com|use\.typekit|fonts\.bunny/.test(url)) {
        external.push(url);
      }
    });

    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "משחק חדש" })).toBeVisible();
    await switchTo(page, "en");
    await page.evaluate(() => document.fonts.ready);

    expect(external, "a font was fetched from a third party").toEqual([]);
  });

  test("sets Hebrew a little larger than English", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "משחק חדש" })).toBeVisible();

    const rootSize = async (): Promise<number> =>
      page.evaluate(() =>
        Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize),
      );

    await switchTo(page, "en");
    const english = await rootSize();
    await switchTo(page, "he");
    const hebrew = await rootSize();

    // Hebrew has no case and no ascender/descender rhythm, so at an identical size it reads smaller.
    // Measured on the computed root size rather than asserted against the CSS percentage, so this
    // fails if the rule stops applying — a `lang` attribute that never gets set, for instance.
    expect(hebrew, "the Hebrew size bump is not being applied").toBeGreaterThan(english);
    // And a bump, not a jump. The board's fit at 320 px is measured in rtl.spec.ts.
    expect(hebrew / english).toBeLessThan(1.15);
  });
});
