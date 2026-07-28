import { readFileSync } from "node:fs";
import { URL as NodeURL, fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FOCUS_CSS_VAR, FOCUS_RING, MIN_TARGET_PX, SURFACE_CSS_VAR, SURFACES } from "./surfaces";

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

  it("authors every surface as #rrggbb, in both files", () => {
    for (const surfaces of Object.values(SURFACES)) {
      for (const value of Object.values(surfaces)) {
        expect(value).toMatch(/^#[0-9a-f]{6}$/);
      }
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
    // A control 44px tall and 20px wide passes a naive height check and still cannot be hit.
    expect(body).toMatch(new RegExp(`min-block-size:\\s*${String(MIN_TARGET_PX)}px`));
    expect(body).toMatch(new RegExp(`min-inline-size:\\s*${String(MIN_TARGET_PX)}px`));
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
