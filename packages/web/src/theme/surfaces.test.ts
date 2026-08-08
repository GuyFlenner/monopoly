import { readFileSync } from "node:fs";
import { URL as NodeURL, fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ACCENT_CSS_VAR,
  ACCENTS,
  COMFORT_ATTRIBUTE,
  CTA,
  CTA_CSS_VAR,
  FOCUS_CSS_VAR,
  FOCUS_RING,
  KIDS_COMFORT,
  KIDS_TARGET_PX,
  MIN_TARGET_PX,
  SHADOW_CSS_VAR,
  SURFACE_CSS_VAR,
  SURFACES,
  TARGET_CSS_VAR,
} from "./surfaces";

/**
 * The one duplication in the theme, and its tripwire.
 *
 * CSS cannot import TypeScript, so the surface values exist twice: in `surfaces.ts`, where the
 * contrast test measures them, and in `index.css`, where the browser reads them. A drift between
 * the two would mean the accessibility gate is measuring colours the product does not ship — the
 * most expensive kind of green test. This file closes that by parsing the stylesheet.
 */

// Read from disk rather than imported: an `import '…css'` would come back through Tailwind,
// preflight and all, and the assertions below are about the bytes this repository authors.
// node:url's URL explicitly, because under jsdom the global URL is jsdom's own implementation
// and node:fs does not recognise it.
const CSS = readFileSync(fileURLToPath(new NodeURL("../index.css", import.meta.url)), "utf8");

/** The same stylesheet with comments stripped, for assertions about what it actually declares. */
const DECLARATIONS = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/** The `@theme` block, which is the light theme and the default. */
function themeBlock(): string {
  const block = /@theme\s*\{([\s\S]*?)\n\}/.exec(CSS);
  expect(block, "index.css has no @theme block").not.toBeNull();
  return block?.[1] ?? "";
}

/** The `prefers-color-scheme: dark` overrides. */
function darkBlock(): string {
  const block = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{([\s\S]*?)\n\}\n/.exec(CSS);
  expect(block, "index.css has no dark-scheme block").not.toBeNull();
  return block?.[1] ?? "";
}

function declaredValue(block: string, property: string): string | null {
  const match = new RegExp(`${property}:\\s*([^;]+);`).exec(block);
  return match?.[1]?.trim() ?? null;
}

describe("index.css and surfaces.ts agree", () => {
  it("ships every light-theme surface with the value surfaces.ts measures", () => {
    const block = themeBlock();
    for (const [slot, property] of Object.entries(SURFACE_CSS_VAR)) {
      const declared = declaredValue(block, property);
      expect(declared, `${property} is not declared in @theme`).not.toBeNull();
      expect(declared, `${property} drifted from surfaces.ts`).toBe(
        SURFACES.light[slot as keyof typeof SURFACES.light],
      );
    }
  });

  it("ships every dark-theme surface with the value surfaces.ts measures", () => {
    const block = darkBlock();
    for (const [slot, property] of Object.entries(SURFACE_CSS_VAR)) {
      const declared = declaredValue(block, property);
      expect(declared, `${property} is not overridden for dark`).not.toBeNull();
      expect(declared, `${property} drifted from surfaces.ts`).toBe(
        SURFACES.dark[slot as keyof typeof SURFACES.dark],
      );
    }
  });

  it("ships both focus rings, and does not vary them by theme", () => {
    const light = themeBlock();
    for (const [slot, property] of Object.entries(FOCUS_CSS_VAR)) {
      expect(declaredValue(light, property)).toBe(FOCUS_RING[slot as keyof typeof FOCUS_RING]);
      // The two-ring proof only holds if both rings are present on every surface, so a dark
      // override would quietly break it.
      expect(declaredValue(darkBlock(), property), `${property} must not vary by theme`).toBeNull();
    }
  });

  it("ships the accents, and varies them by theme (MON-746)", () => {
    // Both directions, because the accents are the one set whose *point* is that they differ per
    // theme: the light values darken to clear a cream card, the dark red lightens to clear a slate
    // one. A missing dark override would silently ship the light value into the dark theme.
    for (const [slot, property] of Object.entries(ACCENT_CSS_VAR)) {
      expect(declaredValue(themeBlock(), property), `${property} is not declared in @theme`).toBe(
        ACCENTS.light[slot as keyof typeof ACCENTS.light],
      );
      expect(declaredValue(darkBlock(), property), `${property} has no dark override`).toBe(
        ACCENTS.dark[slot as keyof typeof ACCENTS.dark],
      );
    }
  });

  it("ships the start button, and does not vary it by theme (MON-746)", () => {
    for (const [slot, property] of Object.entries(CTA_CSS_VAR)) {
      expect(declaredValue(themeBlock(), property)).toBe(CTA[slot as keyof typeof CTA]);
      // Theme-invariant by design — the rim, not the fill, is what carries its edge on both pages.
      expect(declaredValue(darkBlock(), property), `${property} must not vary by theme`).toBeNull();
    }
  });

  it("ships every shadow as a token rather than five copies of an arbitrary value", () => {
    for (const property of SHADOW_CSS_VAR) {
      const declared = declaredValue(themeBlock(), property);
      expect(declared, `${property} is not declared in @theme`).not.toBeNull();
      expect(declared?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("authors every surface as #rrggbb, in both files", () => {
    for (const surfaces of Object.values(SURFACES)) {
      for (const value of Object.values(surfaces)) {
        expect(value).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
    for (const accents of Object.values(ACCENTS)) {
      for (const value of Object.values(accents)) {
        expect(value).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
    for (const value of Object.values(CTA)) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
    // oklch() in the stylesheet would be a value the contrast test cannot parse — and the old
    // stylesheet used it, which is part of why nothing was ever measured.
    expect(DECLARATIONS).not.toMatch(/oklch\(/);
  });
});

describe("index.css chrome", () => {
  it("draws the focus ring as two rings, so it survives any surface", () => {
    const rule = /:focus-visible\s*\{([\s\S]*?)\}/.exec(CSS)?.[1] ?? "";
    expect(rule).toContain("var(--color-focus-inner)");
    expect(rule).toContain("var(--color-focus-outer)");
    expect(rule).toMatch(/outline:/);
    expect(rule).toMatch(/box-shadow:/);
  });

  it("still honours prefers-reduced-motion globally", () => {
    // Pre-existing behaviour; asserted here so a theme edit cannot quietly drop it.
    expect(CSS).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    expect(CSS).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
  });

  it("sets the hit-target minimum on both axes (G-C6)", () => {
    const utility = /@utility\s+target\s*\{([\s\S]*?)\}/.exec(CSS);
    expect(utility, "index.css has no .target utility").not.toBeNull();
    const body = utility?.[1] ?? "";
    // A control 44px tall and 20px wide passes a naive height check and still cannot be hit. Both
    // axes size from one custom property whose *fallback* is the floor, so a subtree that raises
    // the property cannot accidentally raise one axis only.
    for (const property of ["min-block-size", "min-inline-size"]) {
      expect(body).toMatch(
        new RegExp(`${property}:\\s*var\\(${TARGET_CSS_VAR},\\s*${String(MIN_TARGET_PX)}px\\)`),
      );
    }
  });

  it("steps the target up for a kids game, and nowhere else (MON-604)", () => {
    // The whole comfort scale is this one rule. If it stops declaring the property, every
    // `.target` silently falls back to the 44px floor and Kids Mode looks identical — a
    // regression no screenshot would catch, because nothing would look broken.
    const rule = new RegExp(`\\[${COMFORT_ATTRIBUTE}="${KIDS_COMFORT}"\\]\\s*\\{([\\s\\S]*?)\\}`);
    const block = rule.exec(DECLARATIONS);
    expect(block, `index.css declares no [${COMFORT_ATTRIBUTE}] rule`).not.toBeNull();
    expect(declaredValue(block?.[1] ?? "", TARGET_CSS_VAR)).toBe(`${String(KIDS_TARGET_PX)}px`);

    // A step up, not a step down: a "comfortable" target below the floor would be a regression
    // wearing the word comfortable.
    expect(KIDS_TARGET_PX).toBeGreaterThan(MIN_TARGET_PX);
  });

  it("uses no physical property anywhere in the stylesheet", () => {
    // Stylelint enforces this over every .css file; this asserts it for the one that exists, so
    // the theme's own stylesheet is exemplary rather than merely unlinted.
    expect(DECLARATIONS).not.toMatch(
      /\b(?:margin|padding|border|inset|scroll-margin|scroll-padding)-(?:left|right)\b/,
    );
    expect(DECLARATIONS).not.toMatch(/\btext-align:\s*(?:left|right)\b/);
    expect(DECLARATIONS).not.toMatch(/\btranslateX\(/);
  });
});
