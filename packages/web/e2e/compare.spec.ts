/**
 * The compare tray, measured (MON-702).
 *
 * `CompareTray.test.tsx` asserts everything jsdom can answer — pin order, the ceiling of three, the
 * projection's own net worth, the class that makes the rail a scroll container. It cannot answer the
 * two claims that matter most about a tray, because **jsdom has no layout engine**:
 *
 * 1. **The cards are side by side, and they fill from the inline start.** In English the first pinned
 *    card sits to the left of the second; in Hebrew it sits to the right. That is a claim about two
 *    boxes and only a browser can settle it. Asserted geometrically rather than by reading `dir` back,
 *    which the same line of `applyLocale` would set and satisfy (G-F32).
 * 2. **The page does not scroll horizontally.** The whole point of `overflow-x` on the rail is that
 *    three cards overflowing does not push the action bar off the side of the screen. That is
 *    `scrollWidth` against `clientWidth` on the document, and it is 0 for every element in jsdom.
 */

import { expect, test } from "@playwright/test";

import { rectOf, startGame, switchTo } from "./helpers";

/** The tray's cards, in pin order. */
const CARDS = '[data-testid="compare-tray"] [data-testid="player-dossier"]';

/**
 * Pin a seat from the aside's dossier.
 *
 * The aside shows one card at a time — the seat picker chooses which — so pinning two seats means
 * selecting each in turn. That is the real gesture a player makes, and it is also the check that
 * pinning is reachable from the surface that is reachable for any player at any time (spec §5.2).
 */
async function pinFromAside(page: import("@playwright/test").Page, name: string): Promise<void> {
  await page.getByRole("button", { name, exact: true }).first().click();
  const dossier = page.locator('aside [data-testid="player-dossier"]');
  await expect(dossier).toHaveAttribute("aria-label", `${name}'s properties`);
  await dossier.getByRole("button", { name: "Pin side by side" }).click();
}

test.describe("pinning dossiers side by side", () => {
  test("shows two cards, and unpinning leaves one", async ({ page }) => {
    await startGame(page);

    // Nothing pinned, nothing drawn: the tray appears because a player pinned something.
    await expect(page.getByTestId("compare-tray")).toHaveCount(0);

    await pinFromAside(page, "Ruti");
    await expect(page.locator(CARDS)).toHaveCount(1);

    await pinFromAside(page, "Dan");
    await expect(page.locator(CARDS)).toHaveCount(2);

    // Both seats' figures are on screen at once, which is the whole feature.
    const tray = page.getByTestId("compare-tray");
    await expect(tray.getByRole("heading", { name: "Ruti" })).toBeVisible();
    await expect(tray.getByRole("heading", { name: "Dan" })).toBeVisible();

    // Unpin from the tray itself.
    await tray.locator('[data-player="0"]').getByRole("button", { name: "Unpin" }).click();
    await expect(page.locator(CARDS)).toHaveCount(1);
    await expect(tray.getByRole("heading", { name: "Dan" })).toBeVisible();
  });

  test("lays the cards along the inline axis, mirrored in Hebrew", async ({ page }) => {
    await startGame(page);
    await pinFromAside(page, "Ruti");
    await pinFromAside(page, "Dan");

    const first = page.locator(CARDS).nth(0);
    const second = page.locator(CARDS).nth(1);

    const firstEn = await rectOf(first);
    const secondEn = await rectOf(second);
    // Side by side, not stacked: the same band of the page, different columns.
    expect(
      Math.abs(firstEn.y - secondEn.y),
      "pinned cards should sit on one row, not stack",
    ).toBeLessThan(4);
    expect(
      firstEn.x,
      "in English the first pinned card is nearer the start edge, which is the lower coordinate",
    ).toBeLessThan(secondEn.x);

    await switchTo(page, "he");
    const firstHe = await rectOf(first);
    const secondHe = await rectOf(second);
    expect(
      Math.abs(firstHe.y - secondHe.y),
      "pinned cards should sit on one row in Hebrew too",
    ).toBeLessThan(4);
    // The claim the logical properties exist for. A physical direction anywhere in the rail would
    // leave this measurement identical to the English one.
    expect(
      firstHe.x,
      "in Hebrew the start edge is the far side, so the first card has the higher coordinate",
    ).toBeGreaterThan(secondHe.x);
  });

  test("scrolls inside the tray, never the page", async ({ page }) => {
    // Narrow enough that three cards cannot fit, which is the condition the rail's `overflow-x`
    // exists for. At a comfortable width there is nothing to prove.
    await page.setViewportSize({ width: 420, height: 900 });
    await startGame(page);
    await pinFromAside(page, "Ruti");
    await pinFromAside(page, "Dan");

    const rail = page.getByTestId("compare-tray-rail");
    const overflows = await rail.evaluate((node) => node.scrollWidth > node.clientWidth + 1);
    expect(overflows, "two cards at 420 px should overflow the rail").toBe(true);

    // And the page does not. This is the assertion the whole `overflow-x`-on-the-rail decision is
    // for: a horizontally scrolling document loses the action bar off the side of the screen.
    const pageScrolls = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(pageScrolls, "the document must not scroll horizontally").toBe(false);
  });

  test("is operable from the keyboard, in Hebrew as well", async ({ page }) => {
    await startGame(page);
    await switchTo(page, "he");

    const dossier = page.locator('aside [data-testid="player-dossier"]');
    const toggle = dossier.getByRole("button", { name: "הצמדה להשוואה" });
    await toggle.focus();
    await page.keyboard.press("Enter");

    await expect(page.locator(CARDS)).toHaveCount(1);
    // A real button with `aria-pressed`, so the state is exposed rather than only painted.
    await expect(
      page.locator('aside [data-testid="player-dossier"]').getByRole("button", { pressed: true }),
    ).toBeVisible();
  });
});
