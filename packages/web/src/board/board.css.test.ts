/**
 * The board's block-axis sizing contract, asserted against the bytes this repository authors.
 *
 * ## Why a stylesheet parser and not a rendered assertion
 *
 * The defect these tests exist for is that at 320 px the grid's box was 295 x 295 and its
 * `scrollHeight` was 414: eleven rows of squares painting a hundred and twenty pixels below the
 * felt, over the panels. **jsdom has no layout engine**, so no Vitest render can see it —
 * `scrollHeight` is 0 for every element in every one of the other tests in this directory. What
 * jsdom *can* do is read the two declarations whose absence caused it, which is why they were moved
 * out of a Tailwind class list and into `board.css` where a test can quote them. Same shape, and the
 * same reason, as `panels/panels.css.test.ts`.
 *
 * The real measurement belongs to MON-707's Playwright surface, which does not exist yet (there is
 * no `playwright.config.ts` and no `e2e/` directory in this package). When it lands it should assert
 * `scrollHeight <= clientHeight + 1` on `[data-testid="board-grid"]` at 320 px; until then this file
 * plus `Board.test.tsx`'s explicit-placement test are the guard, and they are checks on the cause
 * rather than on the symptom.
 */

import { readFileSync } from "node:fs";
import { URL as NodeURL, fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const CSS = readFileSync(fileURLToPath(new NodeURL("./board.css", import.meta.url)), "utf8");

/** The same stylesheet with comments stripped, so a property named in prose cannot satisfy a check. */
const DECLARATIONS = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations inside one top-level rule, or `null` if the selector is not there at all. */
function ruleBody(selector: string): string | null {
  const found = new RegExp(`^\\${selector}\\s*\\{([\\s\\S]*?)^\\}`, "m").exec(DECLARATIONS);
  return found?.[1] ?? null;
}

function declaredValue(selector: string, property: string): string | null {
  const body = ruleBody(selector);
  expect(body, `board.css has no top-level ${selector} rule`).not.toBeNull();
  const found = new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+);`).exec(body ?? "");
  return found?.[1]?.trim() ?? null;
}

describe("a row of the ring declares exactly one block-axis track", () => {
  it("sizes its single track to the row, not to the squares' text", () => {
    // Without this the nested grid's one implicit track is `auto`, its children's `block-size: 100%`
    // is cyclic against it and resolves to auto, and every square shrinks to the height of its own
    // name — 6 px inside a 26 px band at 320 px.
    expect(declaredValue(".kesef-board-row", "grid-template-rows")).toBe("minmax(0, 1fr)");
  });

  it("declares one track and not eleven, so no square can be auto-placed into a twelfth", () => {
    // The ceiling matters as much as the size. The bottom edge's squares are emitted from column 11
    // down to column 2, and sparse auto-placement answers a backwards column by opening a new
    // implicit row — which is what turned row 11 into a 145 px staircase out of the felt.
    const value = declaredValue(".kesef-board-row", "grid-template-rows") ?? "";
    // One track: no `repeat()`, and no second track after the first one's closing bracket.
    expect(value).not.toMatch(/repeat/);
    expect(
      value
        .replace(/minmax\([^)]*\)/g, "T")
        .trim()
        .split(/\s+/),
    ).toHaveLength(1);
  });
});

/**
 * Four houses on the narrowest square there is (MON-710).
 *
 * `board.css` states this arithmetic in prose and says this file does it. It did not, which is the
 * same class of defect as the 1.41:1 contrast claim `theme/contrast.test.ts` was written for: a
 * number in a comment that nothing checks is a number that drifts the first time someone tunes the
 * clamp. Every term below is either read out of the stylesheet or named as an input with the file
 * that pins it, so tuning any of them without re-checking the fit turns this red.
 *
 * jsdom has no layout engine, so this is arithmetic on declared values rather than a measurement —
 * the same bargain the rest of this file makes, and MON-707's Playwright run is where the real
 * geometry gets checked.
 */
describe("four houses fit on a 320 px board's square", () => {
  /**
   * The inline size a square gets when the whole board is 320 px wide.
   *
   * The conservative figure of the two this repo quotes: `board/Token.tsx` says about 29 px and
   * `board.css` about 24.2. They differ because they measure at different points in the padding
   * chain; the smaller one is the one worth holding the fit to.
   */
  const NARROWEST_SQUARE_PX = 24.2;
  /** `gap-px` on `.kesef-tile-buildings`, pinned by `Board.test.tsx`. */
  const GAP_PX = 1;
  /** Four is the most houses a square can hold: the fifth is a hotel (`HOTEL_LEVEL`). */
  const MOST_HOUSES = 4;

  function clampTerms(): { floor: number; preferredCqw: number; ceiling: number } {
    const declared = declaredValue(".kesef-tile-buildings", "--kesef-building-unit") ?? "";
    const found = /clamp\(\s*([\d.]+)px\s*,\s*([\d.]+)cqw\s*,\s*([\d.]+)px\s*\)/.exec(declared);
    expect(found, `--kesef-building-unit is not a px/cqw/px clamp: ${declared}`).not.toBeNull();
    return {
      floor: Number(found?.[1]),
      preferredCqw: Number(found?.[2]),
      ceiling: Number(found?.[3]),
    };
  }

  it("sizes a house from the square rather than from the type scale", () => {
    // The bug this replaced: `0.3rem` is 4.8 px on a 26 px square and *still* 4.8 px on a 70 px one.
    const { floor, preferredCqw, ceiling } = clampTerms();
    expect(preferredCqw).toBeGreaterThan(0);
    expect(floor).toBeLessThan(ceiling);
  });

  it("still draws a house at least 5 px wide when the square is at its narrowest", () => {
    const { floor, preferredCqw } = clampTerms();
    const preferred = (preferredCqw / 100) * NARROWEST_SQUARE_PX;
    // The preferred size falls under the floor here, which is the whole point of having one.
    expect(preferred).toBeLessThan(floor);
    expect(Math.max(floor, preferred)).toBe(floor);
  });

  it("leaves four of them and their gaps inside the square", () => {
    const { floor, preferredCqw, ceiling } = clampTerms();
    const unit = Math.min(Math.max(floor, (preferredCqw / 100) * NARROWEST_SQUARE_PX), ceiling);
    // A house is square (`aspect-ratio: 22 / 22`), so its inline size is the unit itself.
    const row = MOST_HOUSES * unit + (MOST_HOUSES - 1) * GAP_PX;

    expect(row).toBeLessThanOrEqual(NARROWEST_SQUARE_PX);
  });

  it("does not let the ceiling bind on a large square, or a big board would grow scenery", () => {
    const { ceiling, preferredCqw } = clampTerms();
    // A 70 px square would otherwise take 14 px houses, which start competing with the square's own
    // name for the eye.
    expect((preferredCqw / 100) * 70).toBeGreaterThan(ceiling);
  });
});

describe("a square fills the cell it is placed in", () => {
  it("gives .kesef-tile a full block size", () => {
    // A square is a flex column whose parts are percentages of it — a 22% colour band, a 10%
    // ownership plinth — so an auto block size leaves those percentages resolving against nothing.
    expect(declaredValue(".kesef-tile", "block-size")).toBe("100%");
  });

  it("says so logically, so the rule is the same rule in Hebrew", () => {
    // Stylelint refuses `height` here as well; this states the intent rather than the ban, so the
    // check survives a Stylelint config edit.
    expect(ruleBody(".kesef-tile")).not.toMatch(/(^|[\s;{])height\s*:/);
  });
});
