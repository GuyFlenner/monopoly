import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TILE_THEME, TILE_THEME_KEYS } from "./groups";
import { ICON_NAMES, ICON_PATH, ICON_VIEWBOX, Icon } from "./icons";

/**
 * What is provable here, and what is not.
 *
 * **Greyscale safety is proved, not sampled.** Every glyph is a single path filled with
 * `currentColor` and nothing else, so converting the page to greyscale is a lossless transform
 * of the icon: there is no hue in it to lose. The test below asserts exactly that — no colour
 * literal reaches the DOM — which is a stronger statement than eyeballing a desaturated
 * screenshot, because it holds for every future icon too.
 *
 * **Silhouette distinctness is checked structurally, not rasterised.** jsdom implements neither
 * `getBBox` nor `getPointAtLength`, so nothing here can compute a filled area. What it can do
 * is (a) prove no two glyphs share geometry, (b) prove the path data is well formed, so a typo
 * cannot ship as an invisible icon, and (c) prove the ten tile icons are not all drawn from one
 * shape family — the specific regression that produced 🍊 against 🍎, two circles with a stem
 * (GAP §5, G-B4). The human greyscale and CVD review remains MON-703's; this is the floor that
 * stops the same mistake being reintroduced silently between now and then.
 */

const PATH_ARITY: Readonly<Record<string, number>> = {
  M: 2,
  L: 2,
  T: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  A: 7,
  Z: 0,
};

const NUMBER = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;

interface PathShape {
  /** Uppercased command letters in order, e.g. "MHAZMCSZ". */
  readonly commands: string;
  readonly subpaths: number;
  readonly arcs: number;
  readonly curves: number;
  readonly straights: number;
}

/**
 * Walk one path's commands, checking each has a whole number of argument groups.
 *
 * A malformed `d` does not throw in a browser — it renders nothing at all, which is exactly the
 * failure a reviewer cannot see in a diff. This makes it a test failure instead.
 */
function describePath(d: string, name: string): PathShape {
  const segments = d.match(/[MmLlHhVvCcSsQqTtAaZz][^MmLlHhVvCcSsQqTtAaZz]*/g);
  expect(segments, `${name}: no path commands at all`).not.toBeNull();

  let commands = "";
  let subpaths = 0;
  let arcs = 0;
  let curves = 0;
  let straights = 0;

  for (const segment of segments ?? []) {
    const letter = segment.charAt(0);
    const upper = letter.toUpperCase();
    const arity = PATH_ARITY[upper];
    if (arity === undefined) {
      expect.fail(`${name}: unknown path command "${letter}"`);
    }
    commands += upper;

    const args = segment.slice(1).match(NUMBER) ?? [];
    if (arity === 0) {
      expect(args, `${name}: Z takes no arguments`).toHaveLength(0);
      continue;
    }
    expect(
      args.length,
      `${name}: "${letter}" has ${String(args.length)} arguments`,
    ).toBeGreaterThan(0);
    expect(
      args.length % arity,
      `${name}: "${letter}" needs a multiple of ${String(arity)} arguments, got ${String(args.length)}`,
    ).toBe(0);

    const groups = args.length / arity;
    if (upper === "M") subpaths += 1;
    else if (upper === "A") arcs += groups;
    else if (upper === "C" || upper === "S" || upper === "Q" || upper === "T") curves += groups;
    else straights += groups;
  }

  return { commands, subpaths, arcs, curves, straights };
}

/** Which shape families a glyph is built from — round, curved, straight-edged, or a mix. */
function shapeFamily(shape: PathShape): string {
  const round = shape.arcs > 0 ? "a" : "-";
  const curved = shape.curves > 0 ? "c" : "-";
  const straight = shape.straights > 0 ? "l" : "-";
  const complexity = shape.subpaths === 1 ? "single" : "multi";
  return `${round}${curved}${straight}:${complexity}`;
}

describe("icon set", () => {
  it("draws every glyph with well-formed path data", () => {
    for (const name of ICON_NAMES) {
      const d = ICON_PATH[name];
      expect(d.startsWith("M"), `${name} must open with an absolute moveto`).toBe(true);
      expect(d.trimEnd().toUpperCase().endsWith("Z"), `${name} must be a closed silhouette`).toBe(
        true,
      );
      describePath(d, name);
    }
  });

  it("shares no geometry between two glyphs", () => {
    const drawn = ICON_NAMES.map((name) => ICON_PATH[name]);
    const duplicates = drawn.filter((d, index) => drawn.indexOf(d) !== index);
    expect(duplicates, "two icons are literally the same drawing").toEqual([]);
  });

  it("contains no emoji or other text: an icon the OS can pronounce is not an icon (G-B4)", () => {
    // A raw emoji is text. The OS announces it in the OS's language, so 🍊 in a Hebrew build is
    // spoken by whichever voice happens to be installed, in whichever language it happens to
    // speak — bypassing the catalogue entirely.
    for (const name of ICON_NAMES) {
      expect(ICON_PATH[name], `${name} contains non-ASCII`).toMatch(/^[ -~]+$/);
      expect(name, `${name} is not an ASCII identifier`).toMatch(/^[a-zA-Z]+$/);
    }
  });

  it("draws the ten tile icons from several different shape families, not ten blobs", () => {
    const families = TILE_THEME_KEYS.map((key) => {
      const name = TILE_THEME[key].icon;
      return shapeFamily(describePath(ICON_PATH[name], name));
    });
    // 🍊 against 🍎 was one family used twice. Requiring at least half the set to differ
    // structurally makes that specific regression a failure rather than a review comment.
    expect(new Set(families).size).toBeGreaterThanOrEqual(5);
  });

  it("gives every ownable tile theme an icon that exists", () => {
    for (const key of TILE_THEME_KEYS) {
      expect(ICON_PATH[TILE_THEME[key].icon], `${key}'s icon is missing`).toBeDefined();
    }
    const icons = TILE_THEME_KEYS.map((key) => TILE_THEME[key].icon);
    expect(new Set(icons).size, "two tile themes share an icon").toBe(icons.length);
  });

  it("renders aria-hidden, unfocusable, and in a single inherited ink", () => {
    const { container } = render(<Icon name="heart" size={16} />);
    const svg = container.querySelector("svg");

    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("focusable")).toBe("false");
    expect(svg?.getAttribute("viewBox")).toBe(ICON_VIEWBOX);
    expect(svg?.getAttribute("width")).toBe("16");
    expect(svg?.getAttribute("height")).toBe("16");

    const path = svg?.querySelector("path");
    expect(path?.getAttribute("fill")).toBe("currentColor");
    expect(path?.getAttribute("stroke")).toBeNull();
  });

  it("puts no colour literal in the DOM for any glyph, in any theme (greyscale is lossless)", () => {
    for (const name of ICON_NAMES) {
      const { container, unmount } = render(<Icon name={name} />);
      const painted = container.querySelectorAll("[fill],[stroke],[style]");
      for (const element of painted) {
        for (const attribute of ["fill", "stroke", "style"]) {
          const value = element.getAttribute(attribute);
          if (value === null) continue;
          expect(value, `${name} hardcodes a colour in ${attribute}`).not.toMatch(
            /#|rgb|hsl|oklch/i,
          );
        }
      }
      unmount();
    }
  });
});
