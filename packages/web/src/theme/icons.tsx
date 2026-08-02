/**
 * The icon channel.
 *
 * Three rules make this file what it is, and all three come from GAP §5 (G-B4, G-50):
 *
 * 1. **Silhouettes, not hues.** The old set used 🍊 for orange and 🍎 for red — two
 *    same-sized circles with a stem, separated by nothing but colour. That is precisely the
 *    deutan/protan collision the icon channel exists to fix. Every glyph below is chosen for
 *    its *outline*: a teardrop, a semicircle, a five-point star, a tiered triangle, a
 *    lozenge, a zigzag. Cover the colour and they are still ten different things.
 * 2. **One ink.** Every path is filled with `currentColor` and nothing else. An icon that
 *    cannot express a hue cannot depend on one, so the greyscale rendering *is* the icon —
 *    that property is asserted in `icons.test.tsx` rather than reviewed by eye.
 * 3. **No text.** Emoji are text: the OS speaks them in the OS's language, so 🍊 in a Hebrew
 *    build is announced as "tangerine" in whatever voice the machine happens to run. These
 *    are `aria-hidden` SVG, and the accessible name always comes from a catalogue key that
 *    the *product* owns.
 *
 * Everything is drawn in one 24×24 grid with `fill-rule: evenodd`, so a hole is just a
 * second subpath. Consumers scale with `size`; nothing here has a fixed pixel dimension.
 */

export const ICON_VIEWBOX = "0 0 24 24";

/**
 * Tile icons — one per colour group plus the two kinds the old theme forgot (G-A3/G-52).
 * Chosen so no two share an outline family.
 */
const TILE_ICON_PATH = {
  /** brown — an acorn: capped oval, wide at the top, tapering to a point. */
  acorn:
    "M6 6h12a1.6 1.6 0 0 1 0 3.2H6A1.6 1.6 0 0 1 6 6Zm1.2 4.4h9.6c0 5.6-2.1 10.6-4.8 10.6s-4.8-5-4.8-10.6Z",
  /** light_blue — a droplet: point up, belly down. */
  droplet: "M12 2.2c4.1 6.1 6.1 8.9 6.1 12.2a6.1 6.1 0 0 1-12.2 0c0-3.3 2-6.1 6.1-12.2Z",
  /** pink — a five-lobed rosette: radial, no straight edges. */
  blossom:
    "M12 3.4c1.7 0 2.9 1.3 2.9 2.9 1.4-.8 3.2-.4 4 1s.5 3.3-.9 4.1c1.4.8 1.9 2.6 1.1 4s-2.6 1.9-4 1.1c0 1.6-1.4 2.9-3.1 2.9s-3.1-1.3-3.1-2.9c-1.4.8-3.2.3-4-1.1s-.3-3.2 1.1-4c-1.4-.8-1.9-2.7-1.1-4.1s2.6-1.8 4-1c0-1.6 1.4-2.9 3.1-2.9Z",
  /** orange — a citrus half-wheel: flat base, domed top, bilaterally symmetric. */
  citrus: "M2.6 19.4a9.4 9.4 0 0 1 18.8 0Z",
  /** red — a heart: two lobes above, one point below. Nothing else here is bilobed. */
  heart:
    "M12 20.8S3.4 15 3.4 9.5A4.6 4.6 0 0 1 12 6.9a4.6 4.6 0 0 1 8.6 2.6c0 5.5-8.6 11.3-8.6 11.3Z",
  /** yellow — a five-point star: the only spiked outline in the set. */
  star: "M12 2.8l2.7 5.8 6.3 0.8-4.7 4.4 1.3 6.2L12 16.9l-5.6 3.1 1.3-6.2L3 9.4l6.3-0.8Z",
  /** green — a pine: stacked triangles over a trunk. The only tiered outline. */
  pine: "M12 2.6l4.7 6.2H7.3Zm0 5.2l6.3 7.6H5.7Zm-1.6 8.2h3.2v4.8h-3.2Z",
  /** dark_blue — a cut gem: flat crown, faceted shoulders, single point. */
  gem: "M7.4 3.6h9.2l4.2 5.4L12 21 3.2 9Z",
  /** railroad — a locomotive: boxy, wheeled, unmistakable at any size. */
  locomotive:
    "M3 4.8h9.2v6h4.1L20.4 15v1.8H3Zm4.3 15.9a2.3 2.3 0 1 1 0-4.6 2.3 2.3 0 0 1 0 4.6Zm9.4 0a2.3 2.3 0 1 1 0-4.6 2.3 2.3 0 0 1 0 4.6Z",
  /** utility — a bolt: a thin zigzag with no closed body at all. */
  bolt: "M13.6 2.2 5 13.4h5.2l-1.4 8.4L19 10.2h-5.3Z",
} as const;

/** Seat tokens — vehicles and objects, deliberately a different family from the tile icons. */
const TOKEN_ICON_PATH = {
  cat: "M4.9 9.1 3.8 3.9l4.9 2.7h6.6l4.9-2.7-1.1 5.2a7.6 7.6 0 0 1 1.5 4.5c0 4.1-4.3 6.9-8.6 6.9s-8.6-2.8-8.6-6.9a7.6 7.6 0 0 1 1.5-4.5Z",
  sailboat:
    "M11.4 2.2h1.2v11.6h-1.2Zm-.8 1.9L4.3 13.8h6.3Zm2.6 2.1 5.4 7.6h-5.4ZM2.8 15.6h18.4l-2.6 5.4H5.4Z",
  rocket:
    "M12 2.2c3.1 3.2 4.7 7.2 4.7 11.3L14.5 17h-5l-2.2-3.5c0-4.1 1.6-8.1 4.7-11.3ZM7.1 16.6l-2.6 4.2 4.2-1.3Zm9.8 0 2.6 4.2-4.2-1.3Z",
  bicycle:
    "M6.4 21.2a4.6 4.6 0 1 1 0-9.2 4.6 4.6 0 0 1 0 9.2Zm0-2.3a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6Zm11.2 2.3a4.6 4.6 0 1 1 0-9.2 4.6 4.6 0 0 1 0 9.2Zm0-2.3a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6ZM8.8 7.6h4.4l4.6 8.2-1.9 1.1-4.2-7.4H8.8Z",
  umbrella:
    "M12 2.2C6.6 2.2 2.3 6.3 2 11.4h20C21.7 6.3 17.4 2.2 12 2.2Zm-1.1 10.4h2.2v6.9a0.7 0.7 0 0 0 1.4 0h2.2a2.9 2.9 0 0 1-5.8 0Z",
  cactus:
    "M10.4 2.8h3.2v18.4h-3.2ZM4.6 7.8h2.6v4.4a2.1 2.1 0 0 0 2.1 2.1v2.6a4.7 4.7 0 0 1-4.7-4.7Zm14.8-1h-2.6v3.4a2.1 2.1 0 0 1-2.1 2.1v2.6a4.7 4.7 0 0 0 4.7-4.7Z",
} as const;

/** Action glyphs — one per command family, composed with a modifier badge where a family splits. */
const ACTION_ICON_PATH = {
  die: "M6.6 3h10.8A3.6 3.6 0 0 1 21 6.6v10.8a3.6 3.6 0 0 1-3.6 3.6H6.6A3.6 3.6 0 0 1 3 17.4V6.6A3.6 3.6 0 0 1 6.6 3Zm2 3.9a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4Zm6.8 0a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4Zm-6.8 6.8a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4Zm6.8 0a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4Z",
  /** A die between two prison bars: "roll for doubles" is a roll *and* a jail matter. */
  jailDie:
    "M2.4 2.6h2.2v18.8H2.4Zm17 0h2.2v18.8h-2.2ZM7.6 7.6h8.8v8.8H7.6Zm2 2a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Zm4.8 2.8a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Z",
  cycle: "M12 3.4a8.6 8.6 0 1 1-8.1 5.8l2.1 0.7A6.4 6.4 0 1 0 12 5.6Zm-1.2-2.2 4.6 2.7-4.6 2.7Z",
  tag: "M3.4 3.8h9.4l8.4 8.4-8.4 8.4-8.4-8.4Zm3.9 2.1a1.9 1.9 0 1 0 0 3.8 1.9 1.9 0 0 0 0-3.8Z",
  paddle:
    "M6.2 2.4h11.6a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-4.3v7.4h-3v-7.4H6.2a2 2 0 0 1-2-2V4.4a2 2 0 0 1 2-2Z",
  house: "M12 2.8 21 11h-3v10.2H6V11H3Z",
  deed: "M5.2 2.4h11.6a2 2 0 0 1 2 2v13.2a4 4 0 0 1-4 4H7.2a2 2 0 0 1-2-2Zm2.6 4h8.4v2.2H7.8Zm0 4.2h8.4v2.2H7.8Zm0 4.2h5.2V17H7.8Z",
  banknote: "M2.2 6.2h19.6v11.6H2.2Zm9.8 2.1a3.7 3.7 0 1 0 0 7.4 3.7 3.7 0 0 0 0-7.4Z",
  bubble:
    "M4.2 3.2h15.6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7.9L5.8 21v-4.8H4.2a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z",
  swap: "M3.6 8.2h13.1l-3.2-3.2 1.6-1.6L20.7 9.3l-5.6 5.9-1.6-1.6 3.2-3.2H3.6Zm16.8 7.6H7.3l3.2 3.2-1.6 1.6L3.3 14.7l5.6-5.9 1.6 1.6-3.2 3.2h13.1Z",
  card: "M2.6 5.2h18.8a1 1 0 0 1 1 1v11.6a1 1 0 0 1-1 1H2.6a1 1 0 0 1-1-1V6.2a1 1 0 0 1 1-1Zm3 3v7.6h5.2V8.2Z",
  coin: "M12 2.2a9.8 9.8 0 1 0 0 19.6 9.8 9.8 0 0 0 0-19.6Zm0 3.4a6.4 6.4 0 1 1 0 12.8 6.4 6.4 0 0 1 0-12.8Z",
  flag: "M4.8 2.4H7v19.2H4.8Zm3.4 1h11.4l-2.6 4.6 2.6 4.6H8.2Z",
} as const;

/**
 * Deck glyphs — the two card decks (MON-709).
 *
 * Two decks that must be told apart *without colour*, which is this project's standing rule for any
 * grouping (spec §5.4, G-B4). So they are a four-point spark and a lidded box: one radial, one
 * rectilinear, and the only pair in this file where distinctness from each other is the requirement
 * rather than a consequence. Cover the colour, shrink them to 16 px, and they are still two different
 * things — which is also why the card surface names its deck in words as well.
 */
const DECK_ICON_PATH = {
  /** chance — a four-point spark: a sudden turn of fortune, and the only quadrilateral star here. */
  spark: "M12 2.2L15.2 8.8L21.8 12L15.2 15.2L12 21.8L8.8 15.2L2.2 12L8.8 8.8Z",
  /** community_chest — a chest: a trapezoid lid over a box, with a keyhole punched by evenodd. */
  chest: "M3.4 9.4H20.6V19.8H3.4ZM5.6 4.2H18.4L20.6 7.8H3.4ZM10.8 12.4H13.2V16.8H10.8Z",
} as const;

/** Modifier badges. Small, high-contrast marks that ride the corner of a glyph. */
const MODIFIER_ICON_PATH = {
  plus: "M10.4 3h3.2v7.4H21v3.2h-7.4V21h-3.2v-7.4H3v-3.2h7.4Z",
  minus: "M3 10.4h18v3.2H3Z",
  check: "M9.2 19.6 2.4 12.8l2.3-2.3 4.5 4.5L19.3 4.9l2.3 2.3Z",
  cross: "M6.3 4 12 9.7 17.7 4l2.3 2.3L14.3 12l5.7 5.7-2.3 2.3L12 14.3 6.3 20 4 17.7 9.7 12 4 6.3Z",
} as const;

export const ICON_PATH = {
  ...TILE_ICON_PATH,
  ...TOKEN_ICON_PATH,
  ...ACTION_ICON_PATH,
  ...DECK_ICON_PATH,
  ...MODIFIER_ICON_PATH,
} as const;

export type IconName = keyof typeof ICON_PATH;
export type TileIconName = keyof typeof TILE_ICON_PATH;
export type TokenIconName = keyof typeof TOKEN_ICON_PATH;
export type ActionIconName = keyof typeof ACTION_ICON_PATH;
export type DeckIconName = keyof typeof DECK_ICON_PATH;
export type ModifierIconName = keyof typeof MODIFIER_ICON_PATH;

export const ICON_NAMES = Object.keys(ICON_PATH) as readonly IconName[];

export interface IconProps {
  readonly name: IconName;
  /** Edge length in CSS pixels. Square by construction — a 24×24 grid cannot be lopsided. */
  readonly size?: number;
  readonly className?: string;
}

/**
 * Render one glyph.
 *
 * Always `aria-hidden`: an icon here is a second channel on a control that already has a
 * name from the catalogue, never the name itself. `focusable="false"` keeps legacy Edge/IE
 * SVG from stealing a tab stop, which is cheap insurance on a keyboard-only path.
 */
export function Icon({ name, size = 24, className }: IconProps): React.JSX.Element {
  return (
    <svg
      viewBox={ICON_VIEWBOX}
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path d={ICON_PATH[name]} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}
