/**
 * The bytes the browser reads for a building, held to the table the tests measure (MON-710).
 *
 * Two things are checked here and they are different things.
 *
 * 1. **Parity.** `BUILDING_FILL` is keyed by theme name because `contrast.test.ts` measures both
 *    themes; a component cannot pick between them, because which theme is live is a media query's
 *    answer. So the four fills exist twice, and a drift between them would mean the accessibility
 *    gate is measuring colours the product does not ship — the most expensive kind of green test.
 *    Same shape, same reason, as `panels.css.test.ts` and `surfaces.test.ts`.
 *
 * 2. **That the stylesheet distinguishes the two levels geometrically.** The bug MON-710 fixed was a
 *    house and a hotel separated by hue and eight pixels. The test named
 *    `the two levels differ in more than a colour` strips the `fill` declaration out of both rules
 *    and requires the remainders to still disagree, so a future edit that reduces the pair back to
 *    "same box, different colour" fails rather than merely looking simpler.
 */

import { readFileSync } from "node:fs";
import { URL as NodeURL, fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BUILDING_CSS_VAR, BUILDING_FIGURE, BUILDING_FILL, BUILDING_LEVELS } from "./buildings";
import { THEMES } from "./surfaces";

// Read from disk rather than imported: an `import "./buildings.css"` comes back through Tailwind,
// preflight and all, and every assertion below is about the bytes this repository authors.
const CSS = readFileSync(fileURLToPath(new NodeURL("./buildings.css", import.meta.url)), "utf8");

/** The same stylesheet with comments stripped, so a value quoted in prose cannot satisfy a check. */
const DECLARATIONS = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

function lightBlock(): string {
  const block = /^:root\s*\{([\s\S]*?)^\}/m.exec(DECLARATIONS);
  expect(block, "buildings.css has no top-level :root block").not.toBeNull();
  return block?.[1] ?? "";
}

function darkBlock(): string {
  const block = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{([\s\S]*?)^\}/m.exec(DECLARATIONS);
  expect(block, "buildings.css has no dark-scheme block").not.toBeNull();
  return block?.[1] ?? "";
}

/** The declarations inside one rule, or `null` if the selector is not there at all. */
function ruleBody(selector: string): string | null {
  const found = new RegExp(`(?:^|\\})\\s*${selector}\\s*\\{([\\s\\S]*?)\\}`, "m").exec(
    DECLARATIONS,
  );
  return found?.[1] ?? null;
}

function declaredValue(block: string, property: string): string | null {
  const found = new RegExp(`(?:^|;|\\{)\\s*${property}:\\s*([^;]+);`).exec(block);
  return found?.[1]?.trim() ?? null;
}

const BLOCKS: Readonly<Record<"light" | "dark", () => string>> = {
  light: lightBlock,
  dark: darkBlock,
};

describe("the fill custom properties match BUILDING_FILL", () => {
  for (const theme of THEMES) {
    for (const level of BUILDING_LEVELS) {
      it(`${theme}/${level} ships the fill the theme declares and the test measures`, () => {
        expect(declaredValue(BLOCKS[theme](), BUILDING_CSS_VAR[level])).toBe(
          BUILDING_FILL[theme][level],
        );
      });
    }
  }

  it("paints each level from its own property, so a themed fill cannot be unreachable", () => {
    for (const level of BUILDING_LEVELS) {
      const body = ruleBody(`\\.kesef-building--${level}`);
      expect(body, `.kesef-building--${level} has no rule`).not.toBeNull();
      expect(body).toContain(`var(${BUILDING_CSS_VAR[level]})`);
    }
  });
});

describe("the stylesheet tells the two levels apart by shape", () => {
  it("gives each level the aspect ratio of its own drawing grid", () => {
    for (const level of BUILDING_LEVELS) {
      const [width, height] = BUILDING_FIGURE[level].viewBox;
      expect(declaredValue(ruleBody(`\\.kesef-building--${level}`) ?? "", "aspect-ratio")).toBe(
        `${String(width)} / ${String(height)}`,
      );
    }
  });

  it("gives each level the block scale the figure table declares", () => {
    for (const level of BUILDING_LEVELS) {
      expect(
        declaredValue(ruleBody(`\\.kesef-building--${level}`) ?? "", "--kesef-building-scale"),
      ).toBe(String(BUILDING_FIGURE[level].blockScale));
    }
  });

  it("makes the two levels differ in more than a colour", () => {
    // The named guard against the defect coming back. Strip the fill out of both rules and the
    // remainders must still disagree — a house and a hotel that differ only in a `fill` are the two
    // coloured squares this work replaced, whatever the colours happen to be.
    const withoutFill = (level: string): string =>
      (ruleBody(`\\.kesef-building--${level}`) ?? "")
        .replace(/fill:[^;]+;/g, "")
        .replace(/\s+/g, " ")
        .trim();
    const house = withoutFill("house");
    const hotel = withoutFill("hotel");
    expect(house, "the house rule is empty once its colour is removed").not.toBe("");
    expect(house, "a house and a hotel are separated by colour alone").not.toBe(hotel);
  });
});

describe("a figure keeps its keyline and its sizing hook", () => {
  it("rims the silhouette with the hairline, at one device pixel whatever the size", () => {
    // `surfaces.ts`: a fill cannot carry an edge, the keyline does. A stroke in user units would be
    // a fifth of a pixel on a 5 px house, so the rim is explicitly non-scaling.
    const body = ruleBody("\\.kesef-building > path");
    expect(body, ".kesef-building > path has no rule").not.toBeNull();
    expect(body).toContain("var(--color-hairline)");
    expect(body).toContain("non-scaling-stroke");
  });

  it("takes its size from a container's unit and never hardcodes one", () => {
    const body = ruleBody("\\.kesef-building") ?? "";
    expect(body).toContain("var(--kesef-building-unit");
    expect(body).toContain("var(--kesef-building-scale");
    // Logical axis names, so the figure is the same figure in Hebrew.
    expect(body).toMatch(/block-size:/);
    expect(body).toMatch(/inline-size:/);
    expect(body).not.toMatch(/(?:^|[\s;{])(?:width|height)\s*:/);
  });

  it("uses no physical geometry anywhere — Stylelint agrees, and this says why", () => {
    expect(DECLARATIONS).not.toMatch(/\b(?:margin|padding|border|inset)-(?:left|right)\b/);
    expect(DECLARATIONS).not.toMatch(/\btranslateX\b/);
  });
});
