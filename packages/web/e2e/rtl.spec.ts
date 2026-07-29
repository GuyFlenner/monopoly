/**
 * MON-502's RTL audit, measured rather than inferred.
 *
 * Three of the item's four criteria are enforced elsewhere and are *verified* here rather than
 * re-implemented: the physical-CSS ban is ESLint + Stylelint over the source (with
 * `src/theme/logical-css.test.ts` proving the rules fire), and FSI/PDI isolation is `src/i18n/bidi.ts`
 * with unit tests. Those are the primary gates and they are cheaper and stricter than a browser.
 *
 * What only a browser can answer is the fourth: **does the layout actually mirror, and does the board
 * actually not.** Every assertion below is on a box.
 *
 * The trap this file is written to avoid (G-F32): asserting `dir="rtl"` would be satisfied by the
 * same line of `applyLocale` that sets it, and would pass just as happily if every square had
 * reversed. `switchTo` checks `dir` only as a precondition — that the switch took effect — and never
 * as the finding.
 */

import { expect, test } from "@playwright/test";

import { inBothLocales, type Rect, rectOf, startGame, switchTo } from "./helpers";

/**
 * Two normalised rectangles agree to within 1% of the board.
 *
 * Two decimal places, not more: the comparison has to survive a legitimate re-scale (the Hebrew size
 * bump changes the board's pixel size) while still failing on a mirror, which moves a corner by most
 * of the axis. There is a wide gap between 0.01 and 0.9, and this sits in it deliberately.
 */
function expectSameFraction(
  actual: { x: number; y: number; width: number; height: number },
  expected: { x: number; y: number; width: number; height: number },
  because: string,
): void {
  expect(actual.x, `${because}: x`).toBeCloseTo(expected.x, 2);
  expect(actual.y, `${because}: y`).toBeCloseTo(expected.y, 2);
  expect(actual.width, `${because}: width`).toBeCloseTo(expected.width, 2);
  expect(actual.height, `${because}: height`).toBeCloseTo(expected.height, 2);
}

test.describe("the board does not mirror", () => {
  test("GO keeps its corner of the board in both languages", async ({ page }) => {
    await startGame(page);

    // Spec §5.1 as amended, G-44. `dir="rtl"` flips a grid's inline axis, which would reverse the
    // *visible direction of travel* — tokens circling clockwise in Hebrew and counter-clockwise in
    // English, from one line of CSS nobody would connect to the symptom. The board grid is pinned
    // `dir="ltr"` for exactly this reason, and this is the assertion that pin exists to satisfy.
    //
    // Measured **relative to the board**, which is a correction to how M5_KICKOFF §4 words this
    // criterion ("tile 0's rect identical across locales"). Tile 0's rect in the *viewport* is not
    // identical and should not be: the game screen is a two-column layout, so under `dir="rtl"` the
    // side panel moves to the inline-start edge and the whole board slides 22rem across with it.
    // That is the chrome mirroring correctly — asserted in the next describe block. Taking the
    // viewport reading as the criterion fails on a working board, which is the worse error: it would
    // have been "fixed" by un-mirroring the page.
    // Expressed as a *fraction* of the board rather than in pixels, which is a second correction to
    // this criterion. MON-504's Hebrew size bump makes the root font 6.25% larger, which widens the
    // 22rem side panel and therefore shrinks the board column — so tile 0's offset within the board
    // legitimately differs by 22 px between locales while sitting in the same corner. A pixel
    // comparison fails on that, and "fixing" it would have meant dropping the size bump.
    //
    // A fraction is scale-free and still catches what matters: a mirrored ring moves GO from one end
    // of the inline axis to the other, which is a change of about 0.9, not 0.001.
    const cornerFraction = async (): Promise<Rect> => {
      const grid = await rectOf(page.getByTestId("board-grid"));
      const go = await rectOf(page.locator('[data-tile-index="0"]'));
      return {
        x: (go.x - grid.x) / grid.width,
        y: (go.y - grid.y) / grid.height,
        width: go.width / grid.width,
        height: go.height / grid.height,
      };
    };

    const [english, hebrew] = await inBothLocales(page, cornerFraction);
    expectSameFraction(hebrew, english, "GO changed corners when the language changed");
  });

  test("the ring's corners keep their order, so travel direction is unchanged", async ({
    page,
  }) => {
    await startGame(page);

    // Tile 0 alone could be identical while the ring between the corners reversed. Squares 0 and 10
    // are two corners of the ring: whatever their relationship is in English — one left of the other
    // — it must survive the switch. This is the assertion that would catch a *partial* mirror.
    const cornerOrder = async (): Promise<number> => {
      const go = await rectOf(page.locator('[data-tile-index="0"]'));
      const jail = await rectOf(page.locator('[data-tile-index="10"]'));
      return Math.sign(jail.x - go.x);
    };

    const [english, hebrew] = await inBothLocales(page, cornerOrder);
    expect(english, "squares 0 and 10 should not share an x").not.toBe(0);
    expect(hebrew, "the ring reversed: square 10 changed sides relative to GO").toBe(english);
  });
});

test.describe("the page around it does mirror", () => {
  test("the heading changes sides with the language", async ({ page }) => {
    await startGame(page);

    // The complement of the test above, and the reason that one is not just "nothing moved". The
    // chrome is ordinary content: under `dir="rtl"` the header's title belongs on the other edge. If
    // this passed *and* the board test passed, both halves of G-44 hold.
    const viewport = page.viewportSize();
    expect(viewport, "no viewport").not.toBeNull();
    const width = viewport?.width ?? 0;

    const [english, hebrew] = await inBothLocales(page, () =>
      rectOf(page.getByRole("heading", { level: 1 })),
    );

    expect(english.x, "the English heading should start near the inline-start edge").toBeLessThan(
      width / 2,
    );
    expect(
      hebrew.x + hebrew.width,
      "the Hebrew heading should end near the other edge",
    ).toBeGreaterThan(width / 2);
  });
});

test.describe("the Hebrew build is actually Hebrew", () => {
  test("shows Hebrew and stops showing English", async ({ page }) => {
    await startGame(page);
    await expect(page.getByRole("heading", { name: "Kesef Street" })).toBeVisible();

    await switchTo(page, "he");

    // Both directions. "A Hebrew string is present" alone would pass while English leaked beside it,
    // which is what a half-translated catalogue looks like.
    await expect(page.getByRole("heading", { name: "רחוב הכסף" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Kesef Street" })).toHaveCount(0);
    await expect(page.getByText("What's happened")).toHaveCount(0);
  });

  test("plays a turn in Hebrew and writes a Hebrew log line", async ({ page }) => {
    // The catalogue-level checks in tests/test_locale_parity.py prove every key *has* Hebrew. They
    // cannot prove the sentences survive interpolation, and that is where the remaining risk is now
    // that the last 45 keys are written: a placeholder Hebrew names but nothing supplies renders
    // literal braces, and a number dropped into an RTL sentence reorders its neighbours.
    //
    // So this rolls the dice with the page in Hebrew and reads the log. It is the one assertion in
    // the suite that exercises the Hebrew *sentences* rather than the layout around them.
    await startGame(page);
    await switchTo(page, "he");

    await page.getByRole("button", { name: "הטל קוביות" }).click();

    const log = page.getByRole("region", { name: "מה קרה" });
    await expect(log).toBeVisible();

    // A brace on screen means a placeholder the sentence names and the call site does not pass.
    await expect(log).not.toContainText("{{");
    // Latin script in the log would be an untranslated key or an English fallback leaking through.
    // The player names are Latin ("Ruti", "Dan"), so they are excluded before the check.
    const withoutNames = ((await log.textContent()) ?? "").replaceAll(/Ruti|Dan/g, "");
    expect(withoutNames, "Latin text in a Hebrew log").not.toMatch(/[A-Za-z]{3,}/);
  });
});

test.describe("the board fits the space it is given", () => {
  // The M4 defect, finally measurable. `src/board/board.css.test.ts` names this assertion in its
  // docstring and explains why it could not live there: jsdom reports `scrollHeight` as 0 for every
  // element, so the Vitest suite guards the *cause* (two declarations in board.css) while this
  // guards the symptom.
  for (const locale of ["en", "he"] as const) {
    test(`no overflow at 320 px in ${locale}`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 900 });
      await startGame(page);
      await switchTo(page, locale);

      const overflow = await page.getByTestId("board-grid").evaluate((node) => ({
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
      }));

      // The exact numbers from the bug, for the record: 414 against a 295 client height.
      expect(overflow.scrollHeight, "the ring is taller than the felt").toBeLessThanOrEqual(
        overflow.clientHeight + 1,
      );
      expect(overflow.scrollWidth, "the ring is wider than the felt").toBeLessThanOrEqual(
        overflow.clientWidth + 1,
      );
    });
  }

  test("the page itself never scrolls sideways", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await startGame(page);
    await switchTo(page, "he");

    // A horizontal scrollbar on the document is the shape the original defect took at the page level,
    // and it is the one an RTL layout regresses first: an element pushed past the inline-start edge
    // is invisible in English and obvious in Hebrew.
    const document = await page.evaluate(() => ({
      scrollWidth: window.document.documentElement.scrollWidth,
      clientWidth: window.document.documentElement.clientWidth,
    }));
    expect(document.scrollWidth).toBeLessThanOrEqual(document.clientWidth + 1);
  });
});
