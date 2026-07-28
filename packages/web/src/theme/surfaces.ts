/**
 * Named surfaces, and the keyline that makes the accessibility floor reachable.
 *
 * ## Why these names exist
 *
 * "Contrast ≥ 3:1" is meaningless without saying *against what*. The old band comment claimed
 * 3:1 and measured 1.41:1, because it never named its reference surface (GAP §5, G-B1). Every
 * ratio this theme claims is quoted against one of the surfaces below, by name, in
 * `contrast.test.ts`.
 *
 * ## The keyline — the one idea this theme spends its boldness on
 *
 * A band's edge cannot be carried by its fill. Yellow at `#f2d024` has a relative luminance of
 * 0.65; against any surface light enough to read black text on, its maximum contrast is about
 * 1.4:1, and the only yellow that reaches 3:1 against a card face is a dark olive that is no
 * longer yellow. Real boards have always solved this the same way, with a printed keyline: a
 * near-black hairline drawn around every painted area. So every painted surface in this
 * theme — colour bands, seat tokens, buttons, the cards themselves — is rimmed with
 * `hairline`, and *that* is the token gated at ≥ 3:1. The fill is then free to be the group's
 * actual colour, and the boundary is still visible to everyone.
 *
 * `hairline` is gated against **both** `tile` and `table`, because a rimmed thing may sit on a
 * card face or on the felt. In the light theme that forces it to near-black; in the dark theme
 * it inverts to a warm bone. It is not gated against the band it rims — a keyline separates
 * the band from the *surface*, and an edge is visible as long as one of the two regions it
 * divides contrasts with it.
 *
 * ## The focus ring is a sandwich, and provably sufficient
 *
 * §5.5 asks for a focus ring "contrast-tested against every surface it can sit on". No single
 * colour can do that: a ring that clears 3:1 against yellow (L 0.65) needs L ≤ 0.18, and one
 * that clears 3:1 against dark blue (L 0.10) needs L ≥ 0.39. So the ring is two concentric
 * rings, one near-black and one near-white, and the gate is that *at least one* of them clears
 * 3:1 against each surface. That is not merely satisfiable, it is unconditional: for any
 * surface luminance L, the near-white ring works whenever L ≤ 0.29 and the near-black ring
 * works whenever L ≥ 0.13, and those two ranges overlap, so every possible surface is covered.
 * `contrast.test.ts` checks it against the concrete list anyway.
 *
 * Values are duplicated in `src/index.css`, which is where the browser reads them from.
 * `surfaces.test.ts` parses that file and fails if the two ever disagree, so the duplication
 * cannot rot.
 */

export const THEMES = ["light", "dark"] as const;
export type ThemeName = (typeof THEMES)[number];

export interface Surfaces {
  /** The felt playing surface the board sits on. */
  readonly table: string;
  /** Ink for text placed directly on the felt. */
  readonly onTable: string;
  /** A card face: tiles, dossiers, panels, buttons. The default reference surface. */
  readonly tile: string;
  /** Ink for text placed on a card face. */
  readonly ink: string;
  /** The keyline. See the module docstring. */
  readonly hairline: string;
}

export const SURFACES: Readonly<Record<ThemeName, Surfaces>> = {
  light: {
    table: "#33754f",
    onTable: "#f2f8f3",
    tile: "#fbf6ec",
    ink: "#1f1b16",
    hairline: "#1c1712",
  },
  dark: {
    table: "#10281c",
    onTable: "#e8f2ea",
    tile: "#332d26",
    ink: "#f6efe2",
    hairline: "#b3a692",
  },
};

/** Both rings, in both themes. Theme-invariant by design — see the module docstring's proof. */
export const FOCUS_RING = {
  inner: "#101a2e",
  outer: "#fffdf7",
} as const;

/** The CSS custom property each surface slot ships as. Keeps the CSS/TS parity test honest. */
export const SURFACE_CSS_VAR: Readonly<Record<keyof Surfaces, string>> = {
  table: "--color-table",
  onTable: "--color-on-table",
  tile: "--color-tile",
  ink: "--color-ink",
  hairline: "--color-hairline",
};

export const FOCUS_CSS_VAR: Readonly<Record<keyof typeof FOCUS_RING, string>> = {
  inner: "--color-focus-inner",
  outer: "--color-focus-outer",
};

/** Minimum hit target, in CSS pixels. Mirrored by the `.target` utility in `index.css`. */
export const MIN_TARGET_PX = 44;
