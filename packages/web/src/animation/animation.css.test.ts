/**
 * The two claims about `animation.css` that jsdom cannot render but can read.
 *
 * Same shape and the same reasoning as `board/board.css.test.ts` and `panels/panels.css.test.ts`:
 * jsdom applies no UA animation and computes no keyframes, so a rendered assertion here would pass
 * whatever the stylesheet said. What it *can* do is quote the two declarations whose absence is a
 * silent failure.
 *
 * 1. **`display: inline-block` is load-bearing.** `scale` does not apply to a non-replaced inline
 *    box, so without it every pulse and pop is a no-op that looks exactly like a missing animation.
 * 2. **No translation, in any spelling.** A `translateX` would need mirroring under `dir="rtl"`; the
 *    keyframes animate `scale` and `opacity` only, so there is no inline axis to get backwards.
 *    Stylelint refuses `transform: translateX(...)` by value, and this closes the rest of the family
 *    — `translate`, `margin-inline-start`, an animated `inset` — which it has no rule for.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";

import { describe, expect, it } from "vitest";

const CSS = readFileSync(fileURLToPath(new NodeURL("./animation.css", import.meta.url)), "utf8");

/** The stylesheet with comments stripped, so a property named in prose cannot satisfy a check. */
const DECLARATIONS = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations inside one top-level rule, or `null` if the selector is not there at all. */
function ruleBody(selector: string): string | null {
  const found = new RegExp(`^\\${selector}\\s*\\{([\\s\\S]*?)^\\}`, "m").exec(DECLARATIONS);
  return found?.[1] ?? null;
}

const FLOURISHES = [".kesef-pulse", ".kesef-pop"] as const;

describe("the flourish classes", () => {
  it.each(FLOURISHES)("%s exists and can actually scale", (selector) => {
    const body = ruleBody(selector);
    expect(body, `animation.css has no top-level ${selector} rule`).not.toBeNull();
    // Without this the animation is silently a no-op — a missing display type that reads as a
    // missing animation.
    expect(body).toMatch(/display:\s*inline-block;/);
  });

  it.each(FLOURISHES)("%s takes its duration from the custom property JS sets", (selector) => {
    // The player's own switch and `prefers-reduced-motion` both arrive as a number chosen in JS, and
    // `!important` in a media query cannot help a duration JS is choosing (`board.css`'s contract).
    expect(ruleBody(selector)).toMatch(/animation-duration:\s*var\(--kesef-motion-ms,\s*0ms\);/);
  });

  it.each(FLOURISHES)("%s runs once, so nothing on the board loops", (selector) => {
    expect(ruleBody(selector)).toMatch(/animation-iteration-count:\s*1;/);
  });
});

describe("nothing here has an inline axis to get backwards", () => {
  it("declares both keyframe sets", () => {
    expect(DECLARATIONS).toMatch(/@keyframes\s+kesef-pulse\s*\{/);
    expect(DECLARATIONS).toMatch(/@keyframes\s+kesef-pop\s*\{/);
  });

  it("animates scale and opacity only — no translation in any spelling", () => {
    expect(DECLARATIONS).not.toMatch(/translate/i);
    expect(DECLARATIONS).not.toMatch(/\bmargin-(?:left|right|inline)/);
    expect(DECLARATIONS).not.toMatch(/\b(?:left|right|inset)\s*:/);
  });

  it("names no physical property at all", () => {
    // The whole file, not just the keyframes: a `padding-left` added to a flourish wrapper later
    // would be invisible in English and obvious in Hebrew.
    expect(DECLARATIONS).not.toMatch(
      /(?:margin|padding|border|scroll-margin|scroll-padding)-(?:left|right)/,
    );
  });
});
