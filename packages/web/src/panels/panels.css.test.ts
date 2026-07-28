/**
 * The tripwire on the one duplication these panels need.
 *
 * `ACTION_TONE` is keyed by theme name because `contrast.test.ts` measures both themes. A component
 * cannot pick between them — which theme is live is a media query's answer, and a media query cannot
 * be written in an inline style — so the twelve values exist twice: in `theme/actions.ts`, where
 * they are measured, and in `panels.css`, where the browser reads them.
 *
 * A drift between the two would mean the accessibility gate is measuring colours the product does
 * not ship, which is the most expensive kind of green test. `surfaces.test.ts` closes exactly this
 * hole for `index.css`; this is the same check for the tones, in the same shape.
 */

import { readFileSync } from "node:fs";
import { URL as NodeURL, fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ACTION_TONE, type ActionTone } from "@/theme";

// Read from disk rather than imported: an `import "./panels.css"` comes back through Tailwind,
// preflight and all, and the assertions below are about the bytes this repository authors.
const CSS = readFileSync(fileURLToPath(new NodeURL("./panels.css", import.meta.url)), "utf8");

/** The same stylesheet with comments stripped, so a value quoted in prose cannot satisfy a check. */
const DECLARATIONS = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

const TONES: readonly ActionTone[] = ["primary", "neutral", "caution", "danger"];

/** The `:root` block, which is the light theme and the default. */
function lightBlock(): string {
  const block = /^:root\s*\{([\s\S]*?)^\}/m.exec(DECLARATIONS);
  expect(block, "panels.css has no top-level :root block").not.toBeNull();
  return block?.[1] ?? "";
}

/** The `prefers-color-scheme: dark` overrides. */
function darkBlock(): string {
  const block = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{([\s\S]*?)^\}/m.exec(DECLARATIONS);
  expect(block, "panels.css has no dark-scheme block").not.toBeNull();
  return block?.[1] ?? "";
}

function declaredValue(block: string, property: string): string | null {
  const found = new RegExp(`${property}:\\s*([^;]+);`).exec(block);
  return found?.[1]?.trim() ?? null;
}

describe("the tone custom properties match ACTION_TONE", () => {
  const blocks: Readonly<Record<"light" | "dark", () => string>> = {
    light: lightBlock,
    dark: darkBlock,
  };

  for (const theme of ["light", "dark"] as const) {
    for (const tone of TONES) {
      it(`${theme}/${tone} ships the ink, fill and label colours the theme declares`, () => {
        const block = blocks[theme]();
        const expected = ACTION_TONE[theme][tone];
        expect(declaredValue(block, `--kesef-tone-${tone}-ink`)).toBe(expected.ink);
        expect(declaredValue(block, `--kesef-tone-${tone}-fill`)).toBe(expected.fill);
        expect(declaredValue(block, `--kesef-tone-${tone}-on-fill`)).toBe(expected.onFill);
      });
    }
  }

  it("gives every tone a chit class, so a tone cannot be themed and unreachable", () => {
    for (const tone of TONES) {
      expect(DECLARATIONS).toContain(`.kesef-chit--${tone}`);
      // The class must wire the shared `--kesef-chit-*` slots the `.kesef-chit` rule paints from,
      // or a chit renders with no background at all.
      const rule = new RegExp(`\\.kesef-chit--${tone}\\s*\\{([\\s\\S]*?)\\}`).exec(DECLARATIONS);
      expect(rule?.[1]).toContain(`var(--kesef-tone-${tone}-fill)`);
      expect(rule?.[1]).toContain(`var(--kesef-tone-${tone}-on-fill)`);
    }
  });
});

describe("the painted surfaces keep their keyline", () => {
  it("rims the chit, the deed spine and every printed mark with the hairline", () => {
    // The band and button fills are identity channels, not boundary channels: yellow cannot reach
    // 3:1 against a card face and the keyline is what makes the edge visible (`surfaces.ts`). A
    // painted surface with no rim is the G-B1 defect coming back.
    for (const rule of [
      ".kesef-chit",
      ".kesef-spine",
      ".kesef-setpip",
      ".kesef-deed-house",
      ".kesef-deed-hotel",
      ".kesef-deed-mortgage",
    ]) {
      const body = new RegExp(`\\${rule}\\s*\\{([\\s\\S]*?)\\}`).exec(DECLARATIONS);
      expect(body?.[1], `${rule} has no rule`).toBeDefined();
      expect(body?.[1], `${rule} is painted without a keyline`).toContain("var(--color-hairline)");
    }
  });

  it("marks a terminal command by shape as well as by tone", () => {
    const terminal = /\.kesef-chit--terminal\s*\{([\s\S]*?)\}/.exec(DECLARATIONS);
    // `actions.ts`: the consequence class drives the confirm step rather than a shade of red,
    // "because a shade of red is exactly what a protan player cannot see". The dashed rim is the
    // channel that survives greyscale.
    expect(terminal?.[1]).toContain("dashed");
  });
});

describe("no physical geometry", () => {
  it("uses logical properties throughout — Stylelint agrees, and this says why", () => {
    // Stylelint is the gate; this asserts the intent so a future edit reading only the test file
    // still learns the rule. A physical property is invisible in English and obvious in Hebrew.
    expect(DECLARATIONS).not.toMatch(/\b(?:margin|padding|border|inset)-(?:left|right)\b/);
    expect(DECLARATIONS).not.toMatch(/\btranslateX\b/);
    expect(DECLARATIONS).toMatch(/inline-size|padding-inline|inline-start|inline-end/);
  });
});
