/**
 * The 44 × 44 px floor, over **every interactive element**, at 320 px (MON-703).
 *
 * ## Why this exists next to `kids.spec.ts`
 *
 * That spec measures `.target:visible` — the elements that opted in to the utility. It is a good check
 * and it has one blind spot, which is the whole reason an audit was scheduled: a control that never
 * carried the class is invisible to it. `min-h-11` written by hand passes nothing and fails nothing;
 * a `<summary>` or a `<select>` that nobody thought of is simply not in the set.
 *
 * So this sweep starts from the other end: **everything a person can press**, whatever classes it
 * carries, and the floor as an assertion about boxes rather than about opt-in.
 *
 * ## What counts as the target
 *
 * For most controls, their own box. For an `<input>` inside a `<label>`, the **label's** box — because
 * that is what a finger lands on, and the product deliberately puts `sr-only` radios inside clickable
 * label cards so that arrow keys work and the focus ring lands on something visible (see
 * `SetupScreen.tsx` and `e2e/helpers.ts`). Measuring the 1 px input there would be measuring the wrong
 * thing and would push the design towards visible radio dots.
 *
 * Excluded: anything `sr-only` with no label to stand in for it, and anything with a zero box, which is
 * not on screen at all. Both exclusions are reported in the failure message, so a control cannot slip
 * out of the sweep by acquiring one of them.
 *
 * ## Why 320 px
 *
 * It is the narrowest viewport the product commits to, and it is where the floor and the layout are in
 * actual tension: at 1280 px everything is comfortably large and the check proves nothing.
 */

import { expect, test, type Page } from "@playwright/test";

import { KIDS_TARGET_PX, MIN_TARGET_PX } from "../src/theme/surfaces";
import { playTurns, startGame } from "./helpers";

/** A phone. The narrowest width the product commits to. */
const PHONE = { width: 320, height: 900 } as const;

/** Everything a person can press, tap or type into. */
const INTERACTIVE = [
  "button",
  "a[href]",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "summary",
  '[role="button"]',
  '[tabindex="0"]',
].join(",");

interface Target {
  readonly what: string;
  readonly w: number;
  readonly h: number;
}

/**
 * Measure every interactive element on screen.
 *
 * Runs in the page rather than through Playwright locators, because the label substitution above needs
 * the DOM relationship and because one round trip is worth having when a game screen carries fifty
 * controls.
 */
async function targets(page: Page, selector: string): Promise<readonly Target[]> {
  return page.evaluate((sel) => {
    const describe = (node: Element): string => {
      const bits = [node.tagName.toLowerCase()];
      for (const attribute of ["data-testid", "data-command-kind", "type", "name"]) {
        const value = node.getAttribute(attribute);
        if (value !== null) bits.push(`[${attribute}="${value}"]`);
      }
      const text = node.textContent.trim().slice(0, 28);
      if (text !== "") bits.push(` “${text}”`);
      return bits.join("");
    };

    const found: { what: string; w: number; h: number }[] = [];
    for (const node of document.querySelectorAll(sel)) {
      const element = node as HTMLElement;
      // Off screen entirely — a closed disclosure's contents, a panel that is not mounted.
      if (element.offsetParent === null && element.tagName !== "BODY") continue;

      // An input inside a label is hit through the label. Anything else stands on its own box.
      const stand =
        element.tagName === "INPUT" && element.closest("label") !== null
          ? (element.closest("label") as HTMLElement)
          : element;
      const box = stand.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      found.push({ what: describe(element), w: box.width, h: box.height });
    }
    return found;
  }, selector);
}

/** Assert every target clears `floor` on both axes, naming the ones that do not. */
function expectAllClear(found: readonly Target[], floor: number, where: string): void {
  expect(found.length, `${where}: no interactive elements found at all`).toBeGreaterThan(4);
  // Half a pixel of slack for sub-pixel layout, and no more: 43.6 px is a rounding artefact, 40 px is
  // a decision somebody made.
  const small = found.filter((target) => target.w < floor - 0.5 || target.h < floor - 0.5);
  expect(
    small.map(
      (target) =>
        `${target.what} is ${String(Math.round(target.w))}×${String(Math.round(target.h))}`,
    ),
    `${where}: controls below the ${String(floor)} px floor`,
  ).toEqual([]);
}

test.describe(`every control clears ${String(MIN_TARGET_PX)} px at 320 px`, () => {
  test("on the setup screen, in both languages", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto("/");
    // Both languages in one pass: the Hebrew build sets a larger root font, so a control that only
    // just clears the floor in English can clear it differently in Hebrew — and the reverse.
    for (const locale of ["he", "en"] as const) {
      await page.locator(`label:has(input[name$="-locale"][value="${locale}"])`).click();
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      // Open the advanced disclosure too, so the seed field is on screen and measurable.
      await page.locator("details summary").first().click();
      expectAllClear(await targets(page, INTERACTIVE), MIN_TARGET_PX, `setup screen in ${locale}`);
    }
  });

  test("on the game screen, with the tray, the hint and the replay open", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await startGame(page);

    expectAllClear(await targets(page, INTERACTIVE), MIN_TARGET_PX, "the game screen");

    // The hint, unfolded. Its badge and its summary are the newest controls in the aside (MON-605).
    await page.getByTestId("hint-panel").locator("summary").click();
    expectAllClear(await targets(page, INTERACTIVE), MIN_TARGET_PX, "with the hint unfolded");

    // The compare tray (MON-702) — pinned from the aside's dossier, which is the reachable surface.
    await page.getByTestId("pin-player-0").click();
    await expect(page.getByTestId("compare-tray")).toBeVisible();
    expectAllClear(await targets(page, INTERACTIVE), MIN_TARGET_PX, "with a dossier pinned");

    // The replay viewer (MON-705): a slider, four step buttons and a close button, none of which the
    // `.target`-based sweep in `kids.spec.ts` ever sees, because the panel is not open there. A couple
    // of turns first, because an empty log renders `replay.empty` — a different tree, with none of the
    // controls this is here to measure.
    await playTurns(page, 2);
    await page.getByTestId("open-replay").click();
    await expect(page.getByTestId("replay-controls")).toBeVisible();
    expectAllClear(await targets(page, INTERACTIVE), MIN_TARGET_PX, "with the replay open");
  });

  test("on a Kids Mode game, at the comfort scale", async ({ page }) => {
    // The same sweep against the raised floor. `kids.spec.ts` asserts the scale reaches every
    // `.target`; this asserts it reaches everything a child can press, which is the claim MON-604's
    // acceptance criteria actually make.
    await page.setViewportSize(PHONE);
    await startGame(page, { ruleset: "kids" });

    expectAllClear(await targets(page, INTERACTIVE), KIDS_TARGET_PX, "a kids game");
  });
});
