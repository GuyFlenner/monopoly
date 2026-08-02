/**
 * The two buildings, as figures rather than as coloured blocks (MON-710).
 *
 * ## What was wrong
 *
 * Development was already drawn on the board — `board/Tile.tsx` has drawn a mark per house since
 * MON-403 — but the marks were a **4.8 px green square** and a **9.9 × 5.1 px red block**
 * (`.kesef-house` / `.kesef-hotel`, now gone). Two defects followed, and the second is the one that
 * makes this a bug rather than a taste note.
 *
 * 1. Neither read as a building. A 4.8 px square is a pip, and the audience includes six-year-olds.
 * 2. **A house and a hotel were separated by hue and eight pixels of width.** Green against red is
 *    the canonical deutan/protan collision, and "colour groups always carry a pattern or icon as
 *    well as a colour" is a hard rule here. MON-412 fixed exactly this class of bug in the icon
 *    channel by replacing 🍊/🍎 — two same-sized circles with a stem — with silhouette-distinct
 *    shapes. Two dark rectangles of similar size were the same bug in a new place.
 *
 * And the old fills were measurably invisible in the dark theme: `#1f7a3d` on `#332d26` is
 * **2.53:1** and `#b3271f` on it is **2.09:1**, both under the 3:1 non-text floor. Nothing measured
 * them, because nothing knew they existed — they were literals in a stylesheet rather than theme
 * data. They are theme data now, and `contrast.test.ts` measures all four.
 *
 * ## Silhouette first, colour second
 *
 * A **house** is a cottage: vertical walls under a pitched roof with a slight eave overhang, so its
 * topmost point is a single apex. A **hotel** is a wide, flat-roofed, symmetrically stepped block —
 * a central tower between two lower wings — one and a bit times taller than a house and nearly
 * twice as wide. Cover the colour, print it in grey, or simulate protanopia and the pair is still a
 * pointed little thing against a big flat-topped thing. `buildings.test.tsx` asserts that
 * *geometrically*, from the path data: a pitched roofline reaches its topmost y at exactly one x, a
 * flat one reaches it at two or more. A "simplification" back to two coloured rectangles fails that
 * test by name, because a rectangle's topmost y is shared by two vertices.
 *
 * The fills are the reinforcing channel and are theme-aware, like `ACTION_TONE`: green house, red
 * hotel, each gated at ≥ 3:1 against the card face it sits on *in its own theme* and separated from
 * the other by ≥ 24 in the greyscale channel as well. Every painted figure is also rimmed with the
 * keyline, which is what lets the fill be an actual colour rather than a darkened compromise — the
 * argument in `surfaces.ts`, applied to a building.
 *
 * ## Why paths here and not in `icons.tsx`
 *
 * `ICON_PATH.house` exists and stays where it is: it is the *subject glyph* on the build and sell
 * buttons, drawn for a 20–24 px chit with 1.5-unit eaves, and there is no hotel glyph in that set
 * at all — so the pair that has to be *separable* does not exist there. These two are authored for
 * the 5–13 px range a board square affords, which is the same reasoning `patterns.tsx` gives for
 * its 12 px bound, and they are authored as **absolute line segments only** so that a test can
 * measure the silhouette rather than review it.
 *
 * ## Why sizing is a custom property and not a prop
 *
 * A figure on a board square must scale with the square (`board.css` sets the unit from `cqw`, so a
 * 26 px square on a phone and a 70 px square on a laptop both get a legible house); the same figure
 * on a dossier deed row is type-scale furniture and wants a fixed size (`panels.css`). Both set
 * {@link BUILDING_UNIT_CSS_VAR} on the container and the figures inherit it, so the two surfaces
 * share one figure vocabulary and disagree only about how big it is.
 */

import { SURFACES, type ThemeName } from "./surfaces";

import "./buildings.css";

/**
 * The two levels a square can be developed to.
 *
 * Deliberately *not* "one to five houses". The engine's `HOTEL_LEVEL` is what turns a count into a
 * level, and that comparison belongs to the caller reading the projection (`board/Tile.tsx`,
 * `panels/PlayerDossier.tsx`) — not here. This module knows how to draw a house and a hotel; it
 * does not know that five of one is the other.
 */
export const BUILDING_LEVELS = ["house", "hotel"] as const;
export type BuildingLevel = (typeof BUILDING_LEVELS)[number];

/** How the topmost edge of a silhouette is shaped. The primary, hue-free channel. */
export type Roofline = "pitched" | "flat";

export interface BuildingFigureGeometry {
  /** `[width, height]` of the user-space grid the path is drawn in. */
  readonly viewBox: readonly [number, number];
  /** Asserted against the path in `buildings.test.tsx`, never merely declared. */
  readonly roofline: Roofline;
  /**
   * The outline, as absolute `M`/`L` segments closed with `Z`, and nothing else.
   *
   * No curves and no relative commands, for two reasons: a straight-edged silhouette survives
   * antialiasing at 5 px where a bezier turns to grey mush, and a coordinate list a test can parse
   * is the difference between measuring the shape and describing it in a comment.
   */
  readonly d: string;
  /**
   * Block size as a multiple of {@link BUILDING_UNIT_CSS_VAR}.
   *
   * A hotel is a bigger building, not a differently coloured one, so it is drawn bigger — which is
   * also what makes "one hotel outranks four houses" legible to someone who cannot read the rent
   * table. Mirrored by `--kesef-building-scale` in `buildings.css`.
   */
  readonly blockScale: number;
}

export const BUILDING_FIGURE: Readonly<Record<BuildingLevel, BuildingFigureGeometry>> = {
  /**
   * A cottage. Apex at the top, eaves overhanging the walls by 2.8 units on each side, vertical
   * walls, flat ground line. Seven vertices, one of which is the highest point.
   */
  house: {
    viewBox: [22, 22],
    roofline: "pitched",
    d: "M11 1.2 L21 9.4 L18.2 9.4 L18.2 20.8 L3.8 20.8 L3.8 9.4 L1 9.4 Z",
    blockScale: 1,
  },
  /**
   * A stepped block: a central tower between two lower wings, symmetric about its own middle.
   *
   * Symmetric on purpose. An asymmetric skyline would be an inline-axis asymmetry that does not
   * mirror under `dir="rtl"` — harmless here, since a picture of a building carries no reading
   * order, but a symmetric one cannot even raise the question.
   */
  hotel: {
    viewBox: [34, 24],
    roofline: "flat",
    d: "M11.5 1.2 L22.5 1.2 L22.5 9 L32.8 9 L32.8 22.8 L1.2 22.8 L1.2 9 L11.5 9 Z",
    blockScale: 1.28,
  },
};

/**
 * The fill per level, per theme — measured by `contrast.test.ts` against `SURFACES[theme].tile`.
 *
 * Keyed by theme name for the same reason `ACTION_TONE` is: which theme is live is a media query's
 * answer, so the values also exist as custom properties in `buildings.css`, and
 * `buildings.css.test.ts` fails if the two ever drift. The measured figures, against the card face
 * each sits on:
 *
 * | theme | level | fill      | vs `tile` | grey Δ `tile` |
 * |-------|-------|-----------|-----------|---------------|
 * | light | house | `#2f7d4a` | 4.69:1    | 135           |
 * | light | hotel | `#9c2118` | 7.37:1    | 165           |
 * | dark  | house | `#79d6a4` | 7.75:1    | 149           |
 * | dark  | hotel | `#ea7a7a` | 4.90:1    | 109           |
 *
 * House against hotel in the greyscale channel: 30 in the light theme, 40 in the dark. That is a
 * bonus rather than the guarantee — the guarantee is the silhouette.
 */
export const BUILDING_FILL: Readonly<Record<ThemeName, Readonly<Record<BuildingLevel, string>>>> = {
  light: { house: "#2f7d4a", hotel: "#9c2118" },
  dark: { house: "#79d6a4", hotel: "#ea7a7a" },
};

/** The custom property each level's fill ships as. Keeps the CSS/TS parity test honest. */
export const BUILDING_CSS_VAR: Readonly<Record<BuildingLevel, string>> = {
  house: "--kesef-building-house",
  hotel: "--kesef-building-hotel",
};

/**
 * The custom property a *container* sets to size every figure inside it.
 *
 * One house is `1 ×` this; a hotel is `blockScale ×` it. Set it on the element that wraps the
 * figures — see `.kesef-tile-buildings` in `board.css` and `.kesef-deed-buildings` in `panels.css`.
 */
export const BUILDING_UNIT_CSS_VAR = "--kesef-building-unit";

/** The class that carries the shared geometry. One per level, plus the base. */
export function buildingFigureClass(level: BuildingLevel): string {
  return `kesef-building--${level}`;
}

/** The reference surface every fill above is measured against, named so the test cannot guess. */
export function buildingReferenceSurface(theme: ThemeName): string {
  return SURFACES[theme].tile;
}

export interface BuildingFigureProps {
  readonly level: BuildingLevel;
  /** The caller's sizing hook, if it needs one beyond the container's unit. */
  readonly className?: string | undefined;
}

/**
 * One building.
 *
 * Always `aria-hidden`, like every glyph in this theme: a developed square states its development
 * **in words** in its accessible name (`board/projection.ts`'s `describeTile` →
 * `a11y.tile_one_house` / `a11y.tile_houses` / `a11y.tile_hotel`) and the dossier states it again in
 * its deed row. Four decorative shapes read aloud in place of "with three houses" would be worse
 * than silence.
 *
 * Fill, keyline and size all come from the stylesheet, so nothing here needs to know which theme is
 * live or how big the square it is standing on happens to be.
 */
export function BuildingFigure({ level, className }: BuildingFigureProps): React.JSX.Element {
  const figure = BUILDING_FIGURE[level];
  return (
    <svg
      viewBox={`0 0 ${String(figure.viewBox[0])} ${String(figure.viewBox[1])}`}
      aria-hidden="true"
      focusable="false"
      data-testid="building-figure"
      data-level={level}
      className={["kesef-building", buildingFigureClass(level), className ?? ""]
        .filter(Boolean)
        .join(" ")}
    >
      <path d={figure.d} />
    </svg>
  );
}
