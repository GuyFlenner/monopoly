import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TILE_THEME, TILE_THEME_KEYS } from "./groups";
import { PATTERN_GEOMETRY, PATTERN_IDS, ThemeSprite, bandFill, patternDomId } from "./patterns";

/**
 * The pattern channel's own gates. Each of these corresponds to a GAP §5 finding and each one
 * fails if the finding is reintroduced — deleting `diamonds` from `dark_blue`, sharing a motif
 * between two groups, or shrinking a stroke to a hairline nobody can see at 12 px.
 */
describe("pattern set", () => {
  it("gives every ownable tile theme a distinct pattern (G-B3)", () => {
    const used = TILE_THEME_KEYS.map((key) => TILE_THEME[key].pattern);
    expect(new Set(used).size).toBe(used.length);
    expect(used).toHaveLength(10);
  });

  it("never uses `solid`, which is the absence of a pattern (G-B2)", () => {
    // dark_blue's pattern used to be `solid`, silently degrading it to colour-alone.
    for (const key of TILE_THEME_KEYS) {
      expect(TILE_THEME[key].pattern, `${key} has no real pattern`).not.toBe("solid");
    }
    expect(PATTERN_GEOMETRY.solid).toBeNull();
  });

  it("draws real geometry for every pattern except `solid`", () => {
    for (const id of PATTERN_IDS) {
      const geometry = PATTERN_GEOMETRY[id];
      if (id === "solid") {
        expect(geometry).toBeNull();
        continue;
      }
      expect(geometry, `${id} has no geometry`).not.toBeNull();
      expect(geometry?.d.length ?? 0).toBeGreaterThan(4);
    }
  });

  it("keeps every motif legible at 12 px and at 200 px", () => {
    for (const id of PATTERN_IDS) {
      const geometry = PATTERN_GEOMETRY[id];
      if (geometry === null) {
        continue;
      }
      // Pattern units are CSS pixels, so a cell of at most 8 px shows at least one full
      // repeat inside a 12 px band, and about 25 across a 200 px one.
      expect(geometry.cell, `${id} cell`).toBeGreaterThanOrEqual(3);
      expect(geometry.cell, `${id} cell`).toBeLessThanOrEqual(8);
      if (geometry.paint === "stroke") {
        expect(geometry.strokeWidth, `${id} needs a strokeWidth`).toBeDefined();
        const width = geometry.strokeWidth ?? 0;
        // Thick enough to survive antialiasing at 12 px…
        expect(width, `${id} stroke too thin`).toBeGreaterThanOrEqual(1.2);
        // …and thin enough that the band's colour still reads through it.
        expect(width, `${id} stroke floods the band`).toBeLessThanOrEqual(geometry.cell / 3);
      } else {
        expect(geometry.strokeWidth, `${id} fills, so it must not stroke`).toBeUndefined();
      }
    }
  });

  it("uses distinct geometry for every pattern, not just distinct names", () => {
    const drawn = PATTERN_IDS.map((id) => PATTERN_GEOMETRY[id]?.d).filter((d) => d !== undefined);
    expect(new Set(drawn).size).toBe(drawn.length);
  });

  it("mounts one hidden sprite carrying a pattern per tile theme, painted in the band's ink", () => {
    const { container } = render(<ThemeSprite />);

    const sprite = container.querySelector("svg");
    expect(sprite?.getAttribute("aria-hidden")).toBe("true");

    for (const key of TILE_THEME_KEYS) {
      const pattern = container.querySelector(`#${patternDomId(key)}`);
      expect(pattern, `${key} has no <pattern>`).not.toBeNull();
      expect(pattern?.getAttribute("patternUnits")).toBe("userSpaceOnUse");

      // The band colour is painted by the pattern itself, so a consumer cannot ship the
      // colour without the pattern or the pattern without the colour.
      expect(pattern?.querySelector("rect")?.getAttribute("fill")).toBe(TILE_THEME[key].color);

      const path = pattern?.querySelector("path");
      const ink = TILE_THEME[key].onColor;
      const painted = path?.getAttribute("fill") === ink || path?.getAttribute("stroke") === ink;
      expect(painted, `${key}'s motif is not drawn in its own ink`).toBe(true);
    }
  });

  it("addresses a band by a namespaced url() so a host page cannot collide with it", () => {
    expect(bandFill("orange")).toBe("url(#kesef-band-orange)");
    expect(patternDomId("railroad")).toBe("kesef-band-railroad");
  });
});
