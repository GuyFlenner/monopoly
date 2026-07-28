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
