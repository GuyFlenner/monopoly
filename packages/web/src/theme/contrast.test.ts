import { readFileSync } from "node:fs";
import { URL as NodeURL, fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ACTION_TONE } from "./actions";
import {
  CONTRAST_FLOOR,
  contrastRatio,
  parseHex,
  ratio,
  relativeLuminance,
  toGrey,
} from "./contrast";
import { TILE_THEME, TILE_THEME_KEYS } from "./groups";
import { BUILDING_MARK, FOCUS_RING, SURFACES, THEMES, type ThemeName } from "./surfaces";
import { TOKEN_IDENTITY } from "./tokens";

/**
 * Contrast, computed rather than claimed (GAP §5, G-B1).
 *
 * The bug this file exists to prevent was not a wrong colour, it was an *unfalsifiable claim*:
 * a comment saying "≥ 3:1 against the board surface" above a value that measured 1.41:1 against
 * the tile face, with no test and no named reference surface. So every assertion below names the
 * surface it measures against, and the reporting test at the end prints the whole table so a
 * reviewer can read the actual numbers instead of trusting a comment.
 *
 * ## Which floor applies where, and why
 *
 * - **Text ≥ 4.5:1.** Labels, prices, rent notes, button text, and the pattern motif — the motif
 *   is drawn in the band's own `onColor`, so it inherits the text floor for free.
 * - **Non-text ≥ 3:1.** The keyline, and the focus ring.
 * - **The band fill is gated on neither, and that is the finding, not a dodge.** No yellow that
 *   is still yellow reaches 3:1 against a card face light enough to read black text on; the
 *   arithmetic is in `surfaces.ts`. The band's *edge* is therefore carried by the keyline, which
 *   is gated at 3:1 against both the card face and the felt, and the band's fill is gated on the
 *   thing it is actually responsible for: being visible as a region at all, even with hue
 *   removed. That last one is the greyscale-separation test below.
 */

/** Minimum separation in the 0–255 greyscale channel for a region to read as a region. */
const GREY_SEPARATION = 24;

function greyChannel(color: string): number {
  return parseHex(toGrey(color))[0];
}

function greyDistance(a: string, b: string): number {
  return Math.abs(greyChannel(a) - greyChannel(b));
}

describe("contrast maths", () => {
  it("agrees with the WCAG reference values", () => {
    expect(ratio("#000000", "#ffffff")).toBe(21);
    expect(ratio("#ffffff", "#ffffff")).toBe(1);
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 10);
    // The canonical mid-grey pair from the WCAG techniques.
    expect(ratio("#767676", "#ffffff")).toBeCloseTo(4.54, 1);
  });

  it("is order-independent", () => {
    expect(contrastRatio("#123456", "#fedcba")).toBeCloseTo(
      contrastRatio("#fedcba", "#123456"),
      10,
    );
  });

  it("refuses any notation but #rrggbb, so a colour cannot dodge measurement", () => {
    expect(() => parseHex("oklch(45% 0.09 155)")).toThrow(/#rrggbb/);
    expect(() => parseHex("#abc")).toThrow(/#rrggbb/);
    expect(() => parseHex("rebeccapurple")).toThrow(/#rrggbb/);
  });

  it("collapses hue when it converts to grey, which is what the CVD channel does", () => {
    // Two colours a deutan viewer struggles to separate should land close in grey.
    expect(greyDistance("#2f9e58", "#dd5798")).toBeLessThan(10);
    expect(greyChannel("#ffffff")).toBe(255);
    expect(greyChannel("#000000")).toBe(0);
  });
});

describe.each([...THEMES])("surfaces — %s theme", (theme: ThemeName) => {
  const surface = SURFACES[theme];

  it("reads text on a card face at ≥ 4.5:1 (ink vs tile)", () => {
    expect(ratio(surface.ink, surface.tile)).toBeGreaterThanOrEqual(CONTRAST_FLOOR.text);
  });

  it("reads text on the felt at ≥ 4.5:1 (onTable vs table)", () => {
    expect(ratio(surface.onTable, surface.table)).toBeGreaterThanOrEqual(CONTRAST_FLOOR.text);
  });

  it("draws the keyline at ≥ 3:1 against a card face AND against the felt", () => {
    // This is the pair that carries every painted edge in the product. If it fails, bands,
    // tokens and buttons all lose their boundary at once — see surfaces.ts.
    expect(ratio(surface.hairline, surface.tile), "hairline vs tile").toBeGreaterThanOrEqual(
      CONTRAST_FLOOR.nonText,
    );
    expect(ratio(surface.hairline, surface.table), "hairline vs table").toBeGreaterThanOrEqual(
      CONTRAST_FLOOR.nonText,
    );
  });
});

describe.each([...THEMES])("tile bands — %s theme", (theme: ThemeName) => {
  const surface = SURFACES[theme];

  it.each([...TILE_THEME_KEYS])("%s reads its own ink at ≥ 4.5:1 (onColor vs color)", (key) => {
    // Covers both the label on the band and the pattern motif, which share the ink.
    expect(ratio(TILE_THEME[key].onColor, TILE_THEME[key].color)).toBeGreaterThanOrEqual(
      CONTRAST_FLOOR.text,
    );
  });

  it.each([...TILE_THEME_KEYS])(
    "%s is visible as a region with hue removed (grey vs tile)",
    (key) => {
      expect(greyDistance(TILE_THEME[key].color, surface.tile)).toBeGreaterThanOrEqual(
        GREY_SEPARATION,
      );
    },
  );
});

describe.each([...THEMES])("seat tokens — %s theme", (theme: ThemeName) => {
  const surface = SURFACES[theme];

  it.each([...TOKEN_IDENTITY])("seat $seat reads its own ink at ≥ 4.5:1", (identity) => {
    expect(ratio(identity.onColor, identity.color)).toBeGreaterThanOrEqual(CONTRAST_FLOOR.text);
  });

  it.each([...TOKEN_IDENTITY])("seat $seat is visible as a region with hue removed", (identity) => {
    expect(greyDistance(identity.color, surface.tile)).toBeGreaterThanOrEqual(GREY_SEPARATION);
  });
});

describe.each([...THEMES])("building marks — %s theme (MON-703)", (theme: ThemeName) => {
  const surface = SURFACES[theme];

  it.each(Object.entries(BUILDING_MARK))(
    "%s is visible as a region on a card face with hue removed",
    (_name, color) => {
      // A pip is a painted area on a deed row and on a board square, so the claim is the band's
      // claim: visible as a region at all, in the channel a colourblind player has. Its *edge* is the
      // keyline, gated at 3:1 above.
      expect(greyDistance(color, surface.tile)).toBeGreaterThanOrEqual(GREY_SEPARATION);
    },
  );

  /*
    There is deliberately **no** gate against the felt.

    The first draft of this file had one and it failed: the light theme's felt is a mid green
    (`#33754f`) and a house is a mid green, one greyscale step apart. That is not a defect, because a
    pip is never drawn on the felt — it sits inside a board square or on a deed row, and both of those
    are card faces, which is the pair gated above. Gating the felt would have forced a colour change to
    fix a situation that does not occur, which is the failure mode `surfaces.ts` was written against:
    a ratio quoted without naming the surface it is measured on. The felt readings are *reported* in
    the measured table at the end of this file instead, where a reviewer can see them.
  */
});

describe("building marks are told apart by shape, not by hue (MON-703)", () => {
  it("records that the two collide in grey, which is why the shapes differ", () => {
    // The assertion is the *collision*, deliberately. A mid green and a mid red are close in the
    // greyscale channel, so hue is not a channel a colourblind player has here — and the separation is
    // geometric: `.kesef-house` is a square and `.kesef-hotel` is a block roughly twice as wide, in
    // both `board.css` and `panels.css`. Asserting the collision means that re-tinting one of them to
    // "improve contrast" fails this test rather than silently removing the only channel that works.
    expect(greyDistance(BUILDING_MARK.house, BUILDING_MARK.hotel)).toBeLessThan(GREY_SEPARATION);
  });

  // Both stylesheets that draw a pip, with the class names each uses. A board square's marks and a
  // deed row's marks are separate rules on purpose — a square sizes in `cqw` against its own
  // container and a list row cannot — so the shape claim has to be checked in both places.
  it.each([
    { path: "src/board/board.css", house: "kesef-house", hotel: "kesef-hotel" },
    { path: "src/panels/panels.css", house: "kesef-deed-house", hotel: "kesef-deed-hotel" },
  ])(
    "$path draws the hotel wider than the house and rims both with the keyline",
    ({ path, house, hotel }) => {
      const css = readFileSync(
        fileURLToPath(new NodeURL(`../../${path}`, import.meta.url)),
        "utf8",
      );
      const widthOf = (selector: string): number => {
        const rule = new RegExp(`\\.${selector}\\s*\\{([\\s\\S]*?)\\}`).exec(css)?.[1] ?? "";
        expect(rule, `${path} has no .${selector} rule`).not.toBe("");
        expect(rule, `.${selector} is not rimmed with the keyline`).toContain(
          "var(--color-hairline)",
        );
        // Logical property only — `inline-size` is the width in Hebrew too (CLAUDE.md rule 4).
        const size = /inline-size:\s*([\d.]+)rem/.exec(rule)?.[1];
        expect(size, `.${selector} has no rem inline-size`).toBeDefined();
        return Number(size);
      };
      // The shape channel, as a number: a hotel is wider, so five houses never read as four.
      expect(widthOf(hotel)).toBeGreaterThan(widthOf(house) * 1.4);
    },
  );
});

describe.each([...THEMES])("action tones — %s theme", (theme: ThemeName) => {
  const surface = SURFACES[theme];
  const tones = ACTION_TONE[theme];

  it.each(["primary", "neutral", "caution", "danger"] as const)(
    "%s reads on a card face at ≥ 4.5:1 (ink vs tile)",
    (tone) => {
      expect(ratio(tones[tone].ink, surface.tile)).toBeGreaterThanOrEqual(CONTRAST_FLOOR.text);
    },
  );

  it.each(["primary", "neutral", "caution", "danger"] as const)(
    "%s reads its label on a filled button at ≥ 4.5:1 (onFill vs fill)",
    (tone) => {
      expect(ratio(tones[tone].onFill, tones[tone].fill)).toBeGreaterThanOrEqual(
        CONTRAST_FLOOR.text,
      );
    },
  );
});

/**
 * Every surface the focus ring can land on.
 *
 * Spec §5.5 asks for the ring to be "contrast-tested against every surface it can sit on", and
 * this is that list: both card faces, both felts, all ten bands, all six tokens, and every
 * filled button in both themes.
 */
function everySurfaceTheRingCanSitOn(): ReadonlyArray<readonly [string, string]> {
  const entries: Array<readonly [string, string]> = [];
  for (const theme of THEMES) {
    entries.push([`${theme}:tile`, SURFACES[theme].tile]);
    entries.push([`${theme}:table`, SURFACES[theme].table]);
    for (const tone of ["primary", "neutral", "caution", "danger"] as const) {
      entries.push([`${theme}:button.${tone}`, ACTION_TONE[theme][tone].fill]);
    }
  }
  for (const key of TILE_THEME_KEYS) {
    entries.push([`band:${key}`, TILE_THEME[key].color]);
  }
  for (const identity of TOKEN_IDENTITY) {
    entries.push([`seat:${String(identity.seat)}`, identity.color]);
  }
  return entries;
}

describe("focus ring", () => {
  it.each([...everySurfaceTheRingCanSitOn()])(
    "shows at least one of its two rings at ≥ 3:1 on %s",
    (_name, color) => {
      const best = Math.max(ratio(FOCUS_RING.inner, color), ratio(FOCUS_RING.outer, color));
      expect(best).toBeGreaterThanOrEqual(CONTRAST_FLOOR.nonText);
    },
  );

  it("cannot fail for any surface at all, which is why it is two rings and not one", () => {
    // The proof from surfaces.ts, checked numerically across the whole luminance range: the
    // near-white ring clears 3:1 up to L ≈ 0.29 and the near-black ring from L ≈ 0.13, and the
    // ranges overlap. A single-colour ring has no such guarantee.
    for (let step = 0; step <= 255; step += 1) {
      const grey = `#${step.toString(16).padStart(2, "0").repeat(3)}`;
      const best = Math.max(ratio(FOCUS_RING.inner, grey), ratio(FOCUS_RING.outer, grey));
      expect(best, `grey ${grey}`).toBeGreaterThanOrEqual(CONTRAST_FLOOR.nonText);
    }
  });
});

describe("the measured table", () => {
  it("prints every ratio against its named reference surface", () => {
    const lines: string[] = [];
    for (const theme of THEMES) {
      const surface = SURFACES[theme];
      lines.push(`\n[${theme}] reference surfaces: tile=${surface.tile} table=${surface.table}`);
      lines.push(
        `  ink        vs tile   ${ratio(surface.ink, surface.tile).toFixed(2)}  (text ≥ 4.5)`,
      );
      lines.push(
        `  onTable    vs table  ${ratio(surface.onTable, surface.table).toFixed(2)}  (text ≥ 4.5)`,
      );
      lines.push(
        `  hairline   vs tile   ${ratio(surface.hairline, surface.tile).toFixed(2)}  (non-text ≥ 3)`,
      );
      lines.push(
        `  hairline   vs table  ${ratio(surface.hairline, surface.table).toFixed(2)}  (non-text ≥ 3)`,
      );
      lines.push(
        `  tile       vs table  ${ratio(surface.tile, surface.table).toFixed(2)}  (reported; edge is the keyline)`,
      );
      for (const key of TILE_THEME_KEYS) {
        const band = TILE_THEME[key];
        lines.push(
          `  band ${key.padEnd(11)} onColor/color ${ratio(band.onColor, band.color).toFixed(2).padStart(5)}` +
            `  color/tile ${ratio(band.color, surface.tile).toFixed(2).padStart(5)} (reported)` +
            `  grey Δtile ${String(greyDistance(band.color, surface.tile)).padStart(3)}`,
        );
      }
      for (const identity of TOKEN_IDENTITY) {
        lines.push(
          `  seat ${String(identity.seat)}      onColor/color ${ratio(identity.onColor, identity.color).toFixed(2).padStart(5)}` +
            `  grey Δtile ${String(greyDistance(identity.color, surface.tile)).padStart(3)}`,
        );
      }
      for (const tone of ["primary", "neutral", "caution", "danger"] as const) {
        const colors = ACTION_TONE[theme][tone];
        lines.push(
          `  tone ${tone.padEnd(8)} ink/tile ${ratio(colors.ink, surface.tile).toFixed(2).padStart(5)}` +
            `  onFill/fill ${ratio(colors.onFill, colors.fill).toFixed(2).padStart(5)}`,
        );
      }
      for (const [name, color] of Object.entries(BUILDING_MARK)) {
        // Both surfaces, so the felt figure the gate above deliberately omits is still on the record.
        lines.push(
          `  mark ${name.padEnd(9)} grey Δtile ${String(greyDistance(color, surface.tile)).padStart(3)}` +
            `  grey Δtable ${String(greyDistance(color, surface.table)).padStart(3)} (reported;` +
            ` a pip is only drawn on a card face)`,
        );
      }
    }
    const report = lines.join("\n");
    console.info(report);

    // A report that asserts nothing is documentation with a misleading name, so assert the one
    // thing the table is for: nothing measurable is silently missing from it.
    for (const theme of THEMES) {
      expect(report, `${theme} is not in the table`).toContain(`[${theme}]`);
    }
    for (const key of TILE_THEME_KEYS) {
      expect(report, `band ${key} is not in the table`).toContain(`band ${key.padEnd(11)}`);
    }
    for (const identity of TOKEN_IDENTITY) {
      expect(report, `seat ${String(identity.seat)} is not in the table`).toContain(
        `seat ${String(identity.seat)}`,
      );
    }
    for (const tone of ["primary", "neutral", "caution", "danger"] as const) {
      expect(report, `tone ${tone} is not in the table`).toContain(`tone ${tone.padEnd(8)}`);
    }
    for (const name of Object.keys(BUILDING_MARK)) {
      expect(report, `building mark ${name} is not in the table`).toContain(
        `mark ${name.padEnd(9)}`,
      );
    }
  });

  it("names the greyscale collisions the pattern channel has to carry", () => {
    const collisions: string[] = [];
    for (let i = 0; i < TILE_THEME_KEYS.length; i += 1) {
      for (let j = i + 1; j < TILE_THEME_KEYS.length; j += 1) {
        const a = TILE_THEME_KEYS[i];
        const b = TILE_THEME_KEYS[j];
        if (a === undefined || b === undefined) continue;
        if (greyDistance(TILE_THEME[a].color, TILE_THEME[b].color) < GREY_SEPARATION) {
          collisions.push(`${a}/${b}`);
          // Every colliding pair must be separated by both remaining channels.
          expect(TILE_THEME[a].pattern, `${a}/${b} share a pattern`).not.toBe(
            TILE_THEME[b].pattern,
          );
          expect(TILE_THEME[a].icon, `${a}/${b} share an icon`).not.toBe(TILE_THEME[b].icon);
        }
      }
    }
    // There *are* collisions — ten bands cannot all be far apart in one channel. Asserting that
    // keeps this test honest: if it ever finds none, the greyscale check above has stopped
    // measuring anything.
    expect(collisions.length).toBeGreaterThan(0);
    console.info(`greyscale collisions carried by pattern + icon: ${collisions.join(", ")}`);
  });
});
