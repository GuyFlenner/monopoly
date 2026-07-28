/**
 * The pattern channel — the file `groups.ts` referenced and which did not exist (GAP §5, G-B3).
 *
 * A pattern is the only one of the three channels that survives both a colourblind viewer and
 * a greyscale printout, because it carries information in *geometry*. Ten of the tile-theme's
 * bands collapse into six indistinguishable greys once hue is removed (see `contrast.test.ts`,
 * which prints the collision table); the pattern is what keeps them apart.
 *
 * ## The 12 px / 200 px contract
 *
 * A colour band is roughly 12 px tall on a 320 px board and roughly 200 px tall on the
 * tile-detail sheet, and the same pattern has to work at both. The rule that makes that
 * possible is that pattern units are CSS pixels — `patternUnits="userSpaceOnUse"` — so the
 * motif does *not* scale with the shape. A band ten times taller shows ten times as many
 * repeats rather than one motif blown up into an unreadable abstraction. Two bounds keep the
 * motif honest at the small end, and `patterns.test.tsx` asserts both:
 *
 * - `cell` ≤ 8 px, so even a 12 px band shows at least one full repeat plus its neighbours.
 * - `strokeWidth` ≥ 1.2 px and ≤ `cell` / 3, so a stroke is thick enough to survive
 *   antialiasing at 12 px without flooding the band and destroying the colour channel.
 *
 * ## `solid` is not a pattern
 *
 * The old theme gave `dark_blue` the pattern `solid`, which is the *absence* of a pattern and
 * therefore silently degraded that group to colour-alone (G-B2). `dark_blue` now has
 * `diamonds`; `solid` is retained as an explicit, named "no pattern here" for non-group
 * surfaces (a tax square, free parking, the felt), and `patterns.test.tsx` asserts that no
 * ownable tile theme uses it.
 */

import { TILE_THEME, TILE_THEME_KEYS, type TileThemeKey } from "./groups";

export type PatternId =
  | "dots"
  | "waves"
  | "diagonal"
  | "checker"
  | "crosses"
  | "grid"
  | "chevron"
  | "diamonds"
  | "rails"
  | "rings"
  | "solid";

export interface PatternGeometry {
  /** Repeat size in CSS pixels, in both axes. Square cells tile identically under `dir="rtl"`. */
  readonly cell: number;
  /** Whether `d` is a filled silhouette or a stroked line. */
  readonly paint: "fill" | "stroke";
  /** Required for `paint: "stroke"`, absent for `paint: "fill"`. */
  readonly strokeWidth?: number;
  /** Path data expressed inside the cell. Overflow is clipped by the tile, which is intended. */
  readonly d: string;
}

/**
 * `null` is the geometry of `solid`: there is nothing to draw.
 *
 * Motifs are chosen for separability at 12 px, where the discriminating features are the
 * *shape family* (round / angular / linear) and the *orientation* (none / 45° / orthogonal),
 * not fine detail. Round-filled (`dots`) against round-hollow (`rings`) is the weakest pair
 * in the set, which is why those two are given to a colour group and a non-group kind rather
 * than to two adjacent colour groups.
 */
export const PATTERN_GEOMETRY: Readonly<Record<PatternId, PatternGeometry | null>> = {
  /** Two offset filled discs — the only motif with no straight edge at all. */
  dots: {
    cell: 6,
    paint: "fill",
    d: "M1.5 0.4a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2Zm3 3a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2Z",
  },
  /** Rounded horizontal swells. Reads as ruled lines at 12 px, as water at 200 px. */
  waves: { cell: 8, paint: "stroke", strokeWidth: 1.4, d: "M0 2.4q2-2 4 0t4 0M0 6.4q2-2 4 0t4 0" },
  /** 45° stripes. The corner repeats keep the diagonal unbroken across cell edges. */
  diagonal: { cell: 6, paint: "stroke", strokeWidth: 1.6, d: "M0 6 6 0M-1 1 1-1M5 7 7 5" },
  /** A two-square checkerboard: the highest-contrast motif in the set, and unmistakable. */
  checker: { cell: 8, paint: "fill", d: "M0 0h4v4H0Zm4 4h4v4H4Z" },
  /** Discrete saltire marks. Angular and *separated*, where `grid` is continuous. */
  crosses: { cell: 6, paint: "stroke", strokeWidth: 1.4, d: "M1.2 1.2 4.8 4.8M4.8 1.2 1.2 4.8" },
  /** Orthogonal crosshatch: continuous lines on both axes. */
  grid: { cell: 6, paint: "stroke", strokeWidth: 1.3, d: "M0 3h6M3 0v6" },
  /** Angular zigzag rows — the pointed counterpart to `waves`. */
  chevron: { cell: 8, paint: "stroke", strokeWidth: 1.6, d: "M0 4 4 1.4 8 4M0 8 4 5.4 8 8" },
  /** Filled lozenges. A rotated square reads differently from `checker` even at 12 px. */
  diamonds: { cell: 7, paint: "fill", d: "M3.5 0.6 6.4 3.5 3.5 6.4 0.6 3.5Z" },
  /** Two rails and their sleepers — a ladder, denser and more directional than `grid`. */
  rails: {
    cell: 8,
    paint: "stroke",
    strokeWidth: 1.3,
    d: "M0 1.6h8M0 6.4h8M1.4 1.6v4.8M4 1.6v4.8M6.6 1.6v4.8",
  },
  /** Hollow concentric ring, like a meter dial. */
  rings: {
    cell: 8,
    paint: "stroke",
    strokeWidth: 1.3,
    d: "M4 1.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2Z",
  },
  /** Deliberately empty: see the module docstring. */
  solid: null,
};

export const PATTERN_IDS = Object.keys(PATTERN_GEOMETRY) as readonly PatternId[];

/** DOM id of the `<pattern>` for one tile theme. Namespaced so a host page cannot collide. */
export function patternDomId(key: TileThemeKey): string {
  return `kesef-band-${key}`;
}

/** The `fill` value a band shape uses. Paints the group colour *and* its pattern in one go. */
export function bandFill(key: TileThemeKey): string {
  return `url(#${patternDomId(key)})`;
}

/**
 * The `<pattern>` definitions for every tile theme.
 *
 * Each pattern paints the band colour as its background and the motif in the band's own
 * `onColor`, so one `fill: url(#…)` gives a consumer the colour channel and the pattern
 * channel together and cannot accidentally ship one without the other. Reusing `onColor`
 * for the motif is deliberate: the label and the pattern then read as a single printing
 * pass, and the ≥ 4.5:1 the text needs already clears the ≥ 3:1 the motif needs.
 *
 * Must be rendered inside a `<defs>`; `<ThemeSprite>` does that once at the app root and
 * every board tile, dossier row and auction line then references the ids cross-`<svg>`.
 */
export function BandPatternDefs(): React.JSX.Element {
  return (
    <>
      {TILE_THEME_KEYS.map((key) => {
        const theme = TILE_THEME[key];
        const geometry = PATTERN_GEOMETRY[theme.pattern];
        if (geometry === null) {
          return null;
        }
        return (
          <pattern
            key={key}
            id={patternDomId(key)}
            patternUnits="userSpaceOnUse"
            width={geometry.cell}
            height={geometry.cell}
          >
            <rect width={geometry.cell} height={geometry.cell} fill={theme.color} />
            <path
              d={geometry.d}
              fill={geometry.paint === "fill" ? theme.onColor : "none"}
              stroke={geometry.paint === "stroke" ? theme.onColor : "none"}
              strokeWidth={geometry.strokeWidth ?? 0}
              strokeLinecap="square"
            />
          </pattern>
        );
      })}
    </>
  );
}

/**
 * The one hidden `<svg>` that holds every shared definition.
 *
 * Mount it once, at the app root. A pattern referenced by `url(#id)` resolves against the
 * whole document, so a board built from ordinary grid `<div>`s — each with its own small
 * `<svg>` band — still gets its fill from here, and the ten patterns are parsed once
 * instead of forty times.
 */
export function ThemeSprite(): React.JSX.Element {
  return (
    <svg aria-hidden="true" focusable="false" width={0} height={0} className="absolute">
      <defs>
        <BandPatternDefs />
      </defs>
    </svg>
  );
}
