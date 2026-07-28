/**
 * WCAG 2.1 relative-luminance and contrast maths.
 *
 * This module exists so that "contrast ≥ 4.5:1" is a *computed* claim rather than a comment
 * (GAP §5, G-B1: the colour band claimed 3:1 and measured 1.4:1 against the tile face).
 * `contrast.test.ts` walks every foreground/background pair the theme can actually produce
 * and fails the build on any pair below its floor, in both themes.
 *
 * Colours are authored as `#rrggbb` throughout the theme rather than in `oklch()` on purpose:
 * a single notation means the numbers a designer reads in `groups.ts`, the numbers the CSS
 * ships in `index.css`, and the numbers this file measures are the same numbers, with no
 * conversion step to be subtly wrong in.
 */

/** The two WCAG floors that apply to this product. Spec §5.5. */
export const CONTRAST_FLOOR = {
  /** Anything a person reads: labels, prices, rent notes. */
  text: 4.5,
  /** Anything a person must merely *see*: bands, rims, focus rings, pattern ink. */
  nonText: 3,
} as const;

export type ContrastFloor = keyof typeof CONTRAST_FLOOR;

const HEX = /^#[0-9a-f]{6}$/i;

/** Split `#rrggbb` into three 0–255 channels. Throws on any other notation. */
export function parseHex(color: string): readonly [number, number, number] {
  if (!HEX.test(color)) {
    throw new Error(`theme colours must be authored as #rrggbb, got: ${color}`);
  }
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ];
}

function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(color: string): number {
  const [r, g, b] = parseHex(color);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG contrast ratio, 1 (identical) to 21 (black on white). Order-independent. */
export function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Rounded to two decimals — the form the contrast table reports. */
export function ratio(a: string, b: string): number {
  return Math.round(contrastRatio(a, b) * 100) / 100;
}

export function meets(a: string, b: string, floor: ContrastFloor): boolean {
  // Rounded, so a reported 3.00 is a pass rather than a 2.9996 that reads as passing.
  return ratio(a, b) >= CONTRAST_FLOOR[floor];
}

/**
 * Greyscale luminance rendered back to a hex grey.
 *
 * Used by the icon and pattern tests to reason about the achromatic channel: if two things
 * are only separable by hue, their greys collapse and the deutan/protan player loses them.
 */
export function toGrey(color: string): string {
  const linear = relativeLuminance(color);
  const encoded = linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
  const channel = Math.round(Math.min(1, Math.max(0, encoded)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${channel}${channel}${channel}`;
}
