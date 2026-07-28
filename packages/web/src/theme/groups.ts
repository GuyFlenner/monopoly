/**
 * Ownable-tile presentation.
 *
 * Every ownable tile carries a colour **and** a pattern **and** an icon. That is not
 * decoration: it is the same decision serving two audiences at once — a six-year-old who
 * cannot yet read "St. James Place", and a colourblind player who cannot separate the orange
 * group from the red one. Anywhere a tile's identity is shown, show at least two of the three
 * channels.
 *
 * **Railroads and utilities are ownable too.** They used to carry no band, no pattern and no
 * icon at all, because their engine `group` is `None` — six ownable tiles identified by text
 * alone, which is the same defect as colour-alone (GAP §5, G-A3/G-52). `TileTheme` is
 * therefore keyed by `ColorGroup | "railroad" | "utility"`, which is `TileKind` for the two
 * groupless ownable kinds.
 *
 * The `ColorGroup` union mirrors `kesef_engine.board.models.ColorGroup`. It is written out
 * rather than imported from the generated API types on purpose: this is *presentation* data,
 * and a compile error here when the engine adds a group is exactly what we want.
 *
 * ## About the colours
 *
 * `color` is theme-invariant. A painted band is the group's identity, and a green group that
 * turns a different green after dark is a different group to a child. What changes between
 * themes is the surface underneath and therefore the *keyline* — see `surfaces.ts`. The band
 * fill is an identity channel, not a boundary channel; `contrast.test.ts` measures every pair
 * and says which floor each one answers to.
 */

import type { TileIconName } from "./icons";
import type { PatternId } from "./patterns";

export type ColorGroup =
  "brown" | "light_blue" | "pink" | "orange" | "red" | "yellow" | "green" | "dark_blue";

/** The two ownable `TileKind`s the engine leaves `group=None`. Snake case, as the engine spells them. */
export type GrouplessOwnableKind = "railroad" | "utility";

export type TileThemeKey = ColorGroup | GrouplessOwnableKind;

export interface TileTheme {
  /** Fill for the tile's colour band. Theme-invariant; see the module docstring. */
  readonly color: string;
  /** Ink for text *and* pattern motif placed on `color`. Contrast ≥ 4.5:1 against it. */
  readonly onColor: string;
  /** SVG pattern id from `src/theme/patterns.tsx`, for the colourblind channel. Never `solid`. */
  readonly pattern: PatternId;
  /** A silhouette a pre-reader can recognise and point at. Never an emoji — see `icons.tsx`. */
  readonly icon: TileIconName;
  /** i18n key. Never a literal — the group name is spoken aloud in Hebrew too. */
  readonly nameKey: `group.${TileThemeKey}`;
}

export const TILE_THEME: Readonly<Record<TileThemeKey, TileTheme>> = {
  brown: {
    color: "#8d5524",
    onColor: "#fffaf5",
    pattern: "dots",
    icon: "acorn",
    nameKey: "group.brown",
  },
  light_blue: {
    color: "#7fc8f0",
    onColor: "#0b2c3d",
    pattern: "waves",
    icon: "droplet",
    nameKey: "group.light_blue",
  },
  pink: {
    color: "#dd5798",
    onColor: "#33091d",
    pattern: "diagonal",
    icon: "blossom",
    nameKey: "group.pink",
  },
  orange: {
    color: "#ef8722",
    onColor: "#2b1400",
    pattern: "checker",
    icon: "citrus",
    nameKey: "group.orange",
  },
  red: {
    color: "#c92c2c",
    onColor: "#fff4f4",
    pattern: "crosses",
    icon: "heart",
    nameKey: "group.red",
  },
  yellow: {
    color: "#f2d024",
    onColor: "#2b2400",
    pattern: "grid",
    icon: "star",
    nameKey: "group.yellow",
  },
  green: {
    color: "#2f9e58",
    onColor: "#04240f",
    pattern: "chevron",
    icon: "pine",
    nameKey: "group.green",
  },
  dark_blue: {
    // Was `solid`, i.e. no pattern at all, which quietly degraded this group to colour-alone.
    color: "#2b4bad",
    onColor: "#f5f8ff",
    pattern: "diamonds",
    icon: "gem",
    nameKey: "group.dark_blue",
  },
  railroad: {
    // Slate rather than a ninth hue: the four railroads are a *kind*, not a colour set, and
    // a neutral band says so without competing with the eight.
    color: "#525a66",
    onColor: "#f6f7f9",
    pattern: "rails",
    icon: "locomotive",
    nameKey: "group.railroad",
  },
  utility: {
    // Violet is the one hue no colour group uses, so "utility" can never be misread as a set.
    color: "#9b7bc4",
    onColor: "#1c0f2e",
    pattern: "rings",
    icon: "bolt",
    nameKey: "group.utility",
  },
};

/** The eight buildable groups, in board travel order. */
export const GROUP_ORDER: readonly ColorGroup[] = [
  "brown",
  "light_blue",
  "pink",
  "orange",
  "red",
  "yellow",
  "green",
  "dark_blue",
];

/** Every themed ownable kind, groups first: the order a dossier lists a player's holdings in. */
export const TILE_THEME_KEYS: readonly TileThemeKey[] = [...GROUP_ORDER, "railroad", "utility"];

/**
 * The eight colour groups only.
 *
 * Kept as its own view because "own the whole colour group" is a *rule* concept that railroads
 * and utilities do not participate in, so a dossier's set-completion section must not iterate
 * the ten.
 */
export const GROUP_THEME: Readonly<Record<ColorGroup, TileTheme>> = {
  brown: TILE_THEME.brown,
  light_blue: TILE_THEME.light_blue,
  pink: TILE_THEME.pink,
  orange: TILE_THEME.orange,
  red: TILE_THEME.red,
  yellow: TILE_THEME.yellow,
  green: TILE_THEME.green,
  dark_blue: TILE_THEME.dark_blue,
};

/**
 * Theme for one ownable tile, from the two fields the engine gives every tile.
 *
 * `group` is `null` for railroads and utilities, and `kind` is what identifies them. Anything
 * that is not ownable has no band, which is a `null` rather than a fallback: silently painting
 * Free Parking brown would be worse than painting nothing.
 */
export function tileThemeFor(kind: string, group: string | null): TileTheme | null {
  if (group !== null && group in TILE_THEME) {
    return TILE_THEME[group as TileThemeKey];
  }
  if (kind === "railroad" || kind === "utility") {
    return TILE_THEME[kind];
  }
  return null;
}
