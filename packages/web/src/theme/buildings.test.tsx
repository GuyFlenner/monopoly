/**
 * The building figures, measured rather than looked at (MON-710).
 *
 * The defect these tests exist for is not "the house was ugly", it is that **a house and a hotel
 * were told apart by hue**: a 4.8 px green square and a 9.9 px red block. A screenshot in greyscale,
 * or a protan player, saw two dark rectangles of similar size. So the assertions below are about
 * *geometry*, computed from the path data, and the fills are checked separately in
 * `contrast.test.ts` as the reinforcing channel they are.
 *
 * The load-bearing test is `a house has one apex and a hotel has a flat roofline`. A rectangle
 * reaches its topmost y at two vertices, so the two-coloured-squares implementation this replaced
 * fails it — which is the point: a future "simplification" back to it breaks a named test rather
 * than quietly losing the colourblind channel again.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  BUILDING_CSS_VAR,
  BUILDING_FIGURE,
  BUILDING_FILL,
  BUILDING_LEVELS,
  BUILDING_UNIT_CSS_VAR,
  BuildingFigure,
  buildingFigureClass,
  buildingReferenceSurface,
} from "./buildings";
import { parseHex } from "./contrast";
import { SURFACES, THEMES } from "./surfaces";

type Point = readonly [number, number];

/**
 * Every vertex of a silhouette, in order.
 *
 * Only `M`, `L` and `Z` are allowed through, which is a real constraint rather than parser
 * convenience: a curve or a relative command would make the shape unmeasurable here, and "the
 * silhouette is asserted, not described" is the whole reason these paths are authored the way they
 * are. See `BuildingFigureGeometry.d`.
 */
function vertices(d: string): readonly Point[] {
  expect(d, `${d} uses something other than absolute line segments`).toMatch(
    /^M[\d.\s]+(?:L[\d.\s]+)+Z$/,
  );
  const numbers = (d.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  expect(numbers.length % 2, `${d} has an odd number of coordinates`).toBe(0);
  const points: Point[] = [];
  for (let at = 0; at < numbers.length; at += 2) {
    points.push([numbers[at] ?? 0, numbers[at + 1] ?? 0]);
  }
  return points;
}

/** The x coordinates that share the silhouette's topmost y. One means an apex. */
function ridge(points: readonly Point[]): readonly number[] {
  const top = Math.min(...points.map(([, y]) => y));
  return [...new Set(points.filter(([, y]) => y === top).map(([x]) => x))];
}

function extent(points: readonly Point[]): { readonly width: number; readonly height: number } {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

describe("the figure table covers exactly the two levels", () => {
  it("names a geometry and a fill for every level, in both themes", () => {
    expect([...BUILDING_LEVELS]).toEqual(["house", "hotel"]);
    for (const level of BUILDING_LEVELS) {
      expect(BUILDING_FIGURE[level], `${level} has no geometry`).toBeDefined();
      expect(BUILDING_CSS_VAR[level], `${level} has no custom property`).toMatch(/^--kesef-/);
      for (const theme of THEMES) {
        // `parseHex` throws on anything but `#rrggbb`, which is what keeps a fill measurable.
        expect(() => parseHex(BUILDING_FILL[theme][level])).not.toThrow();
      }
    }
  });

  it("names the reference surface its fills are measured against", () => {
    // The G-B1 lesson: "≥ 3:1" means nothing without saying against what. A figure sits on a card
    // face, so that is the surface, and it is returned rather than assumed by each test.
    for (const theme of THEMES) {
      expect(buildingReferenceSurface(theme)).toBe(SURFACES[theme].tile);
    }
  });
});

describe("a house and a hotel are separated by silhouette", () => {
  it("authors both as absolute line segments, so the shape can be measured at all", () => {
    for (const level of BUILDING_LEVELS) {
      expect(vertices(BUILDING_FIGURE[level].d).length).toBeGreaterThanOrEqual(5);
    }
  });

  it("gives a house one apex and a hotel a flat roofline", () => {
    // The assertion that a pair of coloured rectangles cannot pass. A rectangle's topmost y is
    // shared by two vertices, so it can only ever be `flat`; a house must reach its highest point
    // at exactly one x, and it is that single point that survives greyscale and protanopia.
    const house = ridge(vertices(BUILDING_FIGURE.house.d));
    const hotel = ridge(vertices(BUILDING_FIGURE.hotel.d));
    expect(BUILDING_FIGURE.house.roofline).toBe("pitched");
    expect(house, "a pitched roof reaches its top at one x").toHaveLength(1);
    expect(BUILDING_FIGURE.hotel.roofline).toBe("flat");
    expect(hotel.length, "a flat roof reaches its top at two or more x").toBeGreaterThanOrEqual(2);
  });

  it("declares the roofline it actually draws, for both levels", () => {
    // The `roofline` field is documentation only if nothing checks it against the path. Checked in
    // the general form, so a third level added later cannot declare one thing and draw another.
    for (const level of BUILDING_LEVELS) {
      const figure = BUILDING_FIGURE[level];
      const shared = ridge(vertices(figure.d)).length;
      expect(shared === 1 ? "pitched" : "flat", `${level} draws a different roof`).toBe(
        figure.roofline,
      );
    }
  });

  it("makes the hotel the visibly bigger building, on both axes", () => {
    const house = extent(vertices(BUILDING_FIGURE.house.d));
    const hotel = extent(vertices(BUILDING_FIGURE.hotel.d));
    // Wider in its own grid…
    expect(hotel.width / hotel.height).toBeGreaterThan(1.35 * (house.width / house.height));
    // …and drawn larger on the block axis, so "a hotel outranks four houses" is legible before a
    // player can read a rent table.
    expect(BUILDING_FIGURE.hotel.blockScale).toBeGreaterThan(BUILDING_FIGURE.house.blockScale);
    // Which together make it close to twice as wide on screen at the same unit.
    const houseInline = BUILDING_FIGURE.house.blockScale * (house.width / house.height);
    const hotelInline = BUILDING_FIGURE.hotel.blockScale * (hotel.width / hotel.height);
    expect(hotelInline / houseInline).toBeGreaterThan(1.6);
  });

  it("keeps the pair apart with no colour applied at all", () => {
    // Belt and braces on the one above: whatever the fills are, the two shapes are different
    // shapes. If this ever passes only because the fills differ, it has stopped testing anything.
    expect(BUILDING_FIGURE.house.d).not.toBe(BUILDING_FIGURE.hotel.d);
    expect(BUILDING_FIGURE.house.roofline).not.toBe(BUILDING_FIGURE.hotel.roofline);
    expect(BUILDING_FIGURE.house.viewBox).not.toEqual(BUILDING_FIGURE.hotel.viewBox);
  });

  it("keeps every vertex a unit inside its own grid, so the keyline is never clipped", () => {
    // The rim is a non-scaling 1 px stroke centred on the outline, so a path touching the viewBox
    // edge loses half its keyline — the one channel `surfaces.ts` says a fill cannot replace.
    for (const level of BUILDING_LEVELS) {
      const figure = BUILDING_FIGURE[level];
      const [width, height] = figure.viewBox;
      for (const [x, y] of vertices(figure.d)) {
        expect(x, `${level} touches the inline edge`).toBeGreaterThanOrEqual(1);
        expect(x, `${level} touches the inline edge`).toBeLessThanOrEqual(width - 1);
        expect(y, `${level} touches the block edge`).toBeGreaterThanOrEqual(1);
        expect(y, `${level} touches the block edge`).toBeLessThanOrEqual(height - 1);
      }
    }
  });
});

describe("<BuildingFigure>", () => {
  it.each([...BUILDING_LEVELS])("draws %s from the table and nothing else", (level) => {
    render(<BuildingFigure level={level} />);
    const figure = screen.getByTestId("building-figure");
    expect(figure.getAttribute("data-level")).toBe(level);
    const geometry = BUILDING_FIGURE[level];
    expect(figure.getAttribute("viewBox")).toBe(
      `0 0 ${String(geometry.viewBox[0])} ${String(geometry.viewBox[1])}`,
    );
    const paths = figure.querySelectorAll("path");
    expect(paths).toHaveLength(1);
    expect(paths[0]?.getAttribute("d")).toBe(geometry.d);
  });

  it.each([...BUILDING_LEVELS])("hides %s from the accessibility tree", (level) => {
    // A developed square states its buildings in words in its accessible name (`describeTile`) and
    // the dossier states them again in the deed row. Four decorative shapes read aloud instead
    // would be worse than silence — the same rule every glyph in `icons.tsx` follows.
    render(<BuildingFigure level={level} />);
    const figure = screen.getByTestId("building-figure");
    expect(figure.getAttribute("aria-hidden")).toBe("true");
    expect(figure.getAttribute("focusable")).toBe("false");
    expect(figure.textContent).toBe("");
  });

  it("carries the level's class, which is where its size and fill come from", () => {
    render(<BuildingFigure level="house" className="kesef-test-hook" />);
    const figure = screen.getByTestId("building-figure");
    expect(figure.getAttribute("class")).toContain("kesef-building");
    expect(figure.getAttribute("class")).toContain(buildingFigureClass("house"));
    expect(figure.getAttribute("class")).toContain("kesef-test-hook");
  });

  it("hardcodes no size of its own, so a container can scale it", () => {
    // The whole reason the unit is a custom property: a board square scales its buildings with
    // itself and a deed row does not, and neither of them wants to pass a pixel count down.
    render(<BuildingFigure level="hotel" />);
    const figure = screen.getByTestId("building-figure");
    expect(figure.getAttribute("width")).toBeNull();
    expect(figure.getAttribute("height")).toBeNull();
    expect(BUILDING_UNIT_CSS_VAR).toBe("--kesef-building-unit");
  });
});
