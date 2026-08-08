import { describe, expect, it } from "vitest";

import { ACTION_TONE } from "./actions";
import { BUILDING_FILL, BUILDING_LEVELS, buildingReferenceSurface } from "./buildings";
import {
  CONTRAST_FLOOR,
  contrastRatio,
  parseHex,
  ratio,
  relativeLuminance,
  toGrey,
} from "./contrast";
import { TILE_THEME, TILE_THEME_KEYS } from "./groups";
import {
  ACCENTS,
  CTA,
  FOCUS_RING,
  SURFACES,
  THEMES,
  UA_CANVAS,
  type Accents,
  type ThemeName,
} from "./surfaces";
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
 *   is drawn in the band's own `onColor`, so it inherits the text floor for free. Secondary text
 *   too: it is read, so it is text, and "it is only a hint" is not a WCAG exemption (MON-743).
 * - **Non-text ≥ 3:1.** The keyline, the control edge, and the focus ring.
 * - **The band fill is gated on neither, and that is the finding, not a dodge.** No yellow that
 *   is still yellow reaches 3:1 against a card face light enough to read black text on; the
 *   arithmetic is in `surfaces.ts`. The band's *edge* is therefore carried by the keyline, which
 *   is gated at 3:1 against both the card face and the felt, and the band's fill is gated on the
 *   thing it is actually responsible for: being visible as a region at all, even with hue
 *   removed. That last one is the greyscale-separation test below.
 *
 * ## What this file could not see before MON-743
 *
 * Every pair here is a pair of *solids*, and that used to be a loophole as well as a discipline:
 * markup written `text-ink opacity-60` names the solid `ink`, so the gate measured `ink` and passed
 * while the browser painted a composite at 4.38:1. The quiet tier is now solid tokens, measured
 * below like everything else, and `unmeasured-colour.test.ts` is the tripwire that stops the
 * loophole being reopened by the next `opacity-70`.
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

  // --- The quiet tier (MON-743) ------------------------------------------------------------
  //
  // These four assertions are the whole point of the item. Each replaces an `opacity-*` whose
  // composite was measured *below* its floor while this file reported green, so each names the
  // surface the markup actually renders on, exactly as the solid pairs above do.

  it("reads secondary text on a card face at ≥ 4.5:1 (inkMuted vs tile)", () => {
    expect(ratio(surface.inkMuted, surface.tile)).toBeGreaterThanOrEqual(CONTRAST_FLOOR.text);
  });

  it("reads secondary text on a raised panel at ≥ 4.5:1 (inkMuted vs panel)", () => {
    // `panel` is the second card face MON-746 rescued out of a className. One quiet ink serves both
    // faces, so it is measured against both — a token that passed on `tile` and was rendered on
    // `panel` would be the same unverified claim in a new place.
    expect(ratio(surface.inkMuted, surface.panel)).toBeGreaterThanOrEqual(CONTRAST_FLOOR.text);
  });

  it("reads secondary text on the felt at ≥ 4.5:1 (onTableMuted vs table)", () => {
    // Was `text-on-table opacity-80` → 3.94:1 in the light theme. The felt's whole budget is
    // 5.13:1, which is why there is one quiet tier here and not two — see surfaces.ts.
    expect(ratio(surface.onTableMuted, surface.table)).toBeGreaterThanOrEqual(CONTRAST_FLOOR.text);
  });

  it("keeps the quiet tier quieter than the full ink it stands in for", () => {
    // Without this, the cheapest way to pass the two tests above is to set the muted tokens to the
    // full inks, which would pass the gate and delete the design.
    expect(ratio(surface.inkMuted, surface.tile), "inkMuted is not quieter than ink").toBeLessThan(
      ratio(surface.ink, surface.tile),
    );
    expect(
      ratio(surface.onTableMuted, surface.table),
      "onTableMuted is not quieter than onTable",
    ).toBeLessThan(ratio(surface.onTable, surface.table));
  });

  it("draws a control edge at ≥ 3:1 against a card face (edge vs tile)", () => {
    // Was `border-current/30` → 1.91:1: a rim a sighted adult can find only by knowing it is there,
    // and the *only* edge on the remove-player button.
    expect(ratio(surface.edge, surface.tile)).toBeGreaterThanOrEqual(CONTRAST_FLOOR.nonText);
  });

  it("keeps the control edge softer than the keyline, or it is not a second token", () => {
    expect(ratio(surface.edge, surface.tile)).toBeLessThan(ratio(surface.hairline, surface.tile));
  });

  // --- The raised panel, and the accents that edge it (MON-746) -----------------------------

  it("reads text on a raised panel at ≥ 4.5:1 (onPanel vs panel)", () => {
    expect(ratio(surface.onPanel, surface.panel)).toBeGreaterThanOrEqual(CONTRAST_FLOOR.text);
  });

  it("draws the keyline and the control edge on a panel too", () => {
    // Everything rimmed on a card face is also rimmed on a panel — the setup screen's inputs and
    // its remove-player button live on one.
    expect(ratio(surface.hairline, surface.panel), "hairline vs panel").toBeGreaterThanOrEqual(
      CONTRAST_FLOOR.nonText,
    );
    expect(ratio(surface.edge, surface.panel), "edge vs panel").toBeGreaterThanOrEqual(
      CONTRAST_FLOOR.nonText,
    );
  });

  it.each(["accent", "notice", "alert"] as const)(
    "draws the %s edge at ≥ 3:1 on both card faces",
    (slot: keyof Accents) => {
      // As shipped these were 2.53:1, 2.36:1 and 2.88:1 — each of them somebody's only cue that a
      // control has focus or that a message is a refusal.
      const color = ACCENTS[theme][slot];
      expect(ratio(color, surface.tile), `${slot} vs tile`).toBeGreaterThanOrEqual(
        CONTRAST_FLOOR.nonText,
      );
      expect(ratio(color, surface.panel), `${slot} vs panel`).toBeGreaterThanOrEqual(
        CONTRAST_FLOOR.nonText,
      );
    },
  );
});

describe("the start button", () => {
  it("reads its own label at ≥ 4.5:1 (CTA.ink vs CTA.fill)", () => {
    expect(ratio(CTA.ink, CTA.fill)).toBeGreaterThanOrEqual(CONTRAST_FLOOR.text);
  });

  it.each([...THEMES])("is rimmed by a keyline that clears the %s page", (theme: ThemeName) => {
    // The fill cannot carry the button's edge in the dark (2.65:1 against the canvas), which is why
    // it is rimmed. This asserts the thing that makes the rim work: the keyline contrasts with the
    // *page*, so the boundary between page and button is visible whatever the fill does.
    expect(ratio(SURFACES[theme].hairline, UA_CANVAS[theme])).toBeGreaterThanOrEqual(
      CONTRAST_FLOOR.nonText,
    );
  });
});

/**
 * The page itself.
 *
 * The setup screen — the first screen anybody sees — has no background of its own, so its text and
 * its control edges sit on the user agent's `Canvas`. That surface is not the theme's to choose,
 * which is exactly why it has to be measured rather than assumed: a token tuned against `tile` and
 * rendered on `#ffffff` is a claim nobody checked.
 */
describe.each([...THEMES])("the user agent's canvas — %s theme", (theme: ThemeName) => {
  const surface = SURFACES[theme];
  const canvas = UA_CANVAS[theme];

  it("reads secondary text on the page at ≥ 4.5:1 (inkMuted vs Canvas)", () => {
    expect(ratio(surface.inkMuted, canvas)).toBeGreaterThanOrEqual(CONTRAST_FLOOR.text);
  });

  it("draws a control edge on the page at ≥ 3:1 (edge vs Canvas)", () => {
    expect(ratio(surface.edge, canvas)).toBeGreaterThanOrEqual(CONTRAST_FLOOR.nonText);
  });
});

describe("the dark canvas is a range, not a constant", () => {
  // Chrome #121212, Firefox #1c1b22, Safari #1e1e1e — and nothing stops a fourth engine picking
  // another. Sweeping the range is the same move the focus ring makes, and for the same reason:
  // a pass against one browser's constant is a pass against one browser.
  const brightest = relativeLuminance(UA_CANVAS.dark);

  it.each([
    ["inkMuted", SURFACES.dark.inkMuted, CONTRAST_FLOOR.text],
    ["onTableMuted", SURFACES.dark.onTableMuted, CONTRAST_FLOOR.text],
    ["edge", SURFACES.dark.edge, CONTRAST_FLOOR.nonText],
  ])("%s clears its floor on every dark canvas up to Safari's", (_name, color, floor) => {
    for (let step = 0; step <= 255; step += 1) {
      const grey = `#${step.toString(16).padStart(2, "0").repeat(3)}`;
      if (relativeLuminance(grey) > brightest) break;
      expect(ratio(color, grey), `grey ${grey}`).toBeGreaterThanOrEqual(floor);
    }
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

describe.each([...THEMES])("buildings — %s theme", (theme: ThemeName) => {
  const face = buildingReferenceSurface(theme);
  const fills = BUILDING_FILL[theme];

  it.each([...BUILDING_LEVELS])("a %s reads on the face it stands on at ≥ 3:1", (level) => {
    expect(ratio(fills[level], face)).toBeGreaterThanOrEqual(CONTRAST_FLOOR.nonText);
  });

  it.each([...BUILDING_LEVELS])("a %s is still a region with hue removed", (level) => {
    expect(greyDistance(fills[level], face)).toBeGreaterThanOrEqual(GREY_SEPARATION);
  });

  it("keeps the house and the hotel apart in the greyscale channel too", () => {
    // Green against red is the canonical deutan/protan collision — the very pair MON-412 removed
    // from the icon channel. Colour is the *second* channel here, so it has to survive losing hue.
    expect(greyDistance(fills.house, fills.hotel)).toBeGreaterThanOrEqual(GREY_SEPARATION);
  });
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
    entries.push([`${theme}:panel`, SURFACES[theme].panel]);
    entries.push([`${theme}:canvas`, UA_CANVAS[theme]]);
    for (const tone of ["primary", "neutral", "caution", "danger"] as const) {
      entries.push([`${theme}:button.${tone}`, ACTION_TONE[theme][tone].fill]);
    }
  }
  entries.push(["cta", CTA.fill]);
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
        `  inkMuted   vs tile   ${ratio(surface.inkMuted, surface.tile).toFixed(2)}  (text ≥ 4.5)`,
      );
      lines.push(
        `  inkMuted   vs canvas ${ratio(surface.inkMuted, UA_CANVAS[theme]).toFixed(2)}  (text ≥ 4.5)`,
      );
      lines.push(
        `  onTblMuted vs table  ${ratio(surface.onTableMuted, surface.table).toFixed(2)}  (text ≥ 4.5)`,
      );
      lines.push(
        `  onPanel    vs panel  ${ratio(surface.onPanel, surface.panel).toFixed(2)}  (text ≥ 4.5)`,
      );
      lines.push(
        `  inkMuted   vs panel  ${ratio(surface.inkMuted, surface.panel).toFixed(2)}  (text ≥ 4.5)`,
      );
      lines.push(
        `  edge       vs tile   ${ratio(surface.edge, surface.tile).toFixed(2)}  (non-text ≥ 3)`,
      );
      lines.push(
        `  edge       vs canvas ${ratio(surface.edge, UA_CANVAS[theme]).toFixed(2)}  (non-text ≥ 3)`,
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
      for (const level of BUILDING_LEVELS) {
        const fill = BUILDING_FILL[theme][level];
        lines.push(
          `  build ${level.padEnd(7)} fill/face ${ratio(fill, buildingReferenceSurface(theme)).toFixed(2).padStart(5)}` +
            `  grey Δface ${String(greyDistance(fill, buildingReferenceSurface(theme))).padStart(3)}`,
        );
      }
      for (const slot of ["accent", "notice", "alert"] as const) {
        const color = ACCENTS[theme][slot];
        lines.push(
          `  edge ${slot.padEnd(8)} ${color} vs tile ${ratio(color, surface.tile).toFixed(2).padStart(5)}` +
            `  vs panel ${ratio(color, surface.panel).toFixed(2).padStart(5)} (non-text ≥ 3)`,
        );
      }
    }
    lines.push(
      `\n[both] cta ${CTA.fill} label ${CTA.ink}  ink/fill ${ratio(CTA.ink, CTA.fill).toFixed(2)}  (text ≥ 4.5)`,
    );
    const report = lines.join("\n");
    console.info(report);

    // A report that asserts nothing is documentation with a misleading name, so assert the one
    // thing the table is for: nothing measurable is silently missing from it.
    for (const theme of THEMES) {
      expect(report, `${theme} is not in the table`).toContain(`[${theme}]`);
    }
    for (const row of [
      "inkMuted   vs tile",
      "onTblMuted vs table",
      "edge       vs tile",
      "onPanel    vs panel",
    ]) {
      expect(report, `${row} is not in the table`).toContain(row);
    }
    for (const slot of ["accent", "notice", "alert"] as const) {
      expect(report, `edge ${slot} is not in the table`).toContain(`edge ${slot.padEnd(8)}`);
    }
    expect(report, "the start button is not in the table").toContain(`cta ${CTA.fill}`);
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
    for (const level of BUILDING_LEVELS) {
      expect(report, `building ${level} is not in the table`).toContain(`build ${level.padEnd(7)}`);
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
