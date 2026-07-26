/**
 * Colour-group presentation.
 *
 * Every group carries a colour **and** a pattern **and** an icon. That is not decoration:
 * it is the same decision serving two audiences at once — a six-year-old who cannot yet
 * read "St. James Place", and a colourblind player who cannot separate the orange group
 * from the red one. Anywhere a group is shown, show at least two of the three channels.
 *
 * The `ColorGroup` union mirrors `kesef_engine.board.models.ColorGroup`. It is written out
 * rather than imported from the generated API types on purpose: this is *presentation*
 * data, and a compile error here when the engine adds a group is exactly what we want.
 */

export type ColorGroup =
  | "brown"
  | "light_blue"
  | "pink"
  | "orange"
  | "red"
  | "yellow"
  | "green"
  | "dark_blue";

export interface GroupTheme {
  /** Fill for the tile's colour band. Contrast ≥ 3:1 against the board surface. */
  readonly color: string;
  /** Ink for text placed on `color`. Contrast ≥ 4.5:1 against it. */
  readonly onColor: string;
  /** SVG pattern id from `src/theme/patterns.tsx`, for the colourblind channel. */
  readonly pattern:
    | "dots"
    | "diagonal"
    | "grid"
    | "waves"
    | "chevron"
    | "cross"
    | "rings"
    | "solid";
  /** A single glyph a pre-reader can recognise and point at. */
  readonly icon: string;
  /** i18n key. Never a literal — the group name is spoken aloud in Hebrew too. */
  readonly nameKey: `group.${ColorGroup}`;
}

export const GROUP_THEME: Readonly<Record<ColorGroup, GroupTheme>> = {
  brown: {
    color: "#8d5524",
    onColor: "#fffaf5",
    pattern: "dots",
    icon: "🌰",
    nameKey: "group.brown",
  },
  light_blue: {
    color: "#7fc8f0",
    onColor: "#0b2c3d",
    pattern: "waves",
    icon: "💧",
    nameKey: "group.light_blue",
  },
  pink: {
    color: "#e05fa0",
    onColor: "#fff5fa",
    pattern: "diagonal",
    icon: "🌸",
    nameKey: "group.pink",
  },
  orange: {
    color: "#f08a24",
    onColor: "#2b1400",
    pattern: "chevron",
    icon: "🍊",
    nameKey: "group.orange",
  },
  red: {
    color: "#d63b3b",
    onColor: "#fff5f5",
    pattern: "cross",
    icon: "🍎",
    nameKey: "group.red",
  },
  yellow: {
    color: "#f2d024",
    onColor: "#2b2400",
    pattern: "grid",
    icon: "⭐",
    nameKey: "group.yellow",
  },
  green: {
    color: "#2f9e58",
    onColor: "#f2fff6",
    pattern: "rings",
    icon: "🌲",
    nameKey: "group.green",
  },
  dark_blue: {
    color: "#2b4bad",
    onColor: "#f5f8ff",
    pattern: "solid",
    icon: "💎",
    nameKey: "group.dark_blue",
  },
};

/** Board travel order, so a dossier can group a player's holdings the way the board reads. */
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
