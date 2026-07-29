/**
 * The typeface contract (MON-504), asserted against the bytes this repository authors.
 *
 * Same shape and the same reason as `board/board.css.test.ts`: jsdom has no font machinery, so a
 * render cannot tell whether Heebo arrived. What jsdom *can* do is read the declarations, and three
 * of them carry the item's acceptance criteria — self-hosted, subset, `font-display: swap`.
 *
 * Whether the font actually *loads and is used* is a browser question, and it is asserted in
 * `e2e/fonts.spec.ts` against `document.fonts`. The two files are deliberately not the same check:
 * this one fails when somebody edits the stylesheet, that one fails when somebody moves the files.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";

import { describe, expect, it } from "vitest";

const FONTS_CSS = readFileSync(fileURLToPath(new NodeURL("./fonts.css", import.meta.url)), "utf8");
const INDEX_CSS = readFileSync(fileURLToPath(new NodeURL("./index.css", import.meta.url)), "utf8");

/** The stylesheet with comments stripped, so a property named in prose cannot satisfy a check. */
const DECLARATIONS = FONTS_CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of each `@font-face` block, in source order. */
const FACES = [...DECLARATIONS.matchAll(/@font-face\s*\{([\s\S]*?)\}/g)].map(
  (match) => match[1] ?? "",
);

describe("the self-hosted faces", () => {
  it("declares one face per script, and only those", () => {
    // Two, not four: both are variable on weight 400-700, so a bold face would be a third request
    // for glyphs already downloaded.
    expect(FACES).toHaveLength(2);
  });

  it("serves every face from this repository, never from a CDN", () => {
    // The acceptance criterion is "self-hosted". A `fonts.gstatic.com` URL would work in development
    // and make the product depend on a third party at play time — and would send every player's IP
    // to it, which is the part a family game has no business doing.
    for (const face of FACES) {
      expect(face).toMatch(/url\("\.\/assets\/fonts\/[a-z-]+\.woff2"\)/);
      expect(face).not.toMatch(/https?:/);
    }
  });

  it("asks the browser to paint immediately", () => {
    // `font-display: swap`, by name in the item. The alternative is a blank board for the length of
    // the download.
    for (const face of FACES) {
      expect(face).toMatch(/font-display:\s*swap;/);
    }
  });

  it("subsets by unicode-range, so an English game never fetches Hebrew glyphs", () => {
    for (const face of FACES) {
      expect(face).toMatch(/unicode-range:/);
    }
    // The Hebrew block, and the shekel sign with it rather than stranded in the Latin subset.
    const hebrew = FACES.find((face) => face.includes("heebo-hebrew"));
    expect(hebrew).toBeDefined();
    expect(hebrew).toMatch(/U\+0590-05FF/);
    expect(hebrew).toMatch(/U\+20AA/);
  });

  it("declares one variable weight range rather than a static weight", () => {
    for (const face of FACES) {
      expect(face).toMatch(/font-weight:\s*400\s+700;/);
    }
  });
});

describe("the Hebrew size bump", () => {
  it("is applied once, on the root, keyed off the language", () => {
    // One declaration rather than a second set of type-scale tokens per language: every size in the
    // product is relative to the root, so this moves all of them together and cannot drift from the
    // Latin scale.
    const bump = /html\[lang="he"\]\s*\{\s*font-size:\s*([\d.]+)%;\s*\}/.exec(DECLARATIONS);
    expect(bump, "no root-level Hebrew size rule").not.toBeNull();
    const percent = Number(bump?.[1] ?? "0");
    // A bump, but a small one. Above ~110% the 320 px board starts pushing its container, which
    // `e2e/rtl.spec.ts` measures — so this range is the reason that test runs in both locales.
    expect(percent).toBeGreaterThan(100);
    expect(percent).toBeLessThanOrEqual(110);
  });

  it("keys off lang, not dir", () => {
    // `dir="rtl"` is about layout and `lang` is about language, and it is the *language* whose
    // x-height differs. Keying this off direction would also bump a future Arabic build, whose
    // metrics are not Hebrew's.
    expect(DECLARATIONS).not.toMatch(/\[dir="rtl"\]\s*\{[^}]*font-size/);
  });
});

describe("the font stack", () => {
  it("names exactly one family ahead of the system stack, and ships it", () => {
    const stack = /--font-sans:\s*([^;]+);/.exec(INDEX_CSS.replace(/\/\*[\s\S]*?\*\//g, ""));
    expect(stack, "no --font-sans token").not.toBeNull();
    const families = (stack?.[1] ?? "").split(",").map((family) => family.trim());

    // The defect this replaces: the token read `"Rubik", "Heebo", …` while the repository shipped
    // neither, so the design depended on what the player happened to have installed.
    expect(families[0]).toBe('"Heebo"');
    const quoted = families.filter((family) => family.startsWith('"'));
    expect(quoted, "a named family this repo does not serve").toEqual(['"Heebo"']);
  });

  it("imports the faces before the theme names them", () => {
    // Comments stripped first, or this measures the position of the prose that *mentions*
    // `--font-sans` rather than the declaration — which is how this assertion failed on its first
    // run, against a correctly ordered file.
    const source = INDEX_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    const importAt = source.indexOf('@import "./fonts.css"');
    const tokenAt = source.indexOf("--font-sans");
    expect(importAt).toBeGreaterThan(-1);
    expect(tokenAt).toBeGreaterThan(-1);
    expect(importAt).toBeLessThan(tokenAt);
  });
});
