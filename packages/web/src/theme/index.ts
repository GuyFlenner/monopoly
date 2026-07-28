/**
 * The design primitives, as one import.
 *
 * Everything a component needs to *show* a tile, a seat or a command, and nothing that decides
 * what is legal. Later waves — the board (MON-403), tokens and dice (MON-404), the ActionBar
 * (MON-405), the dossier (MON-406), the auction panel (MON-409) — read from here rather than
 * choosing their own colours, so "the triangle is playing" and "orange has a checkerboard" mean
 * the same thing in every one of them.
 */

export {
  contrastRatio,
  CONTRAST_FLOOR,
  meets,
  parseHex,
  ratio,
  relativeLuminance,
  toGrey,
  type ContrastFloor,
} from "./contrast";

export {
  GROUP_ORDER,
  GROUP_THEME,
  TILE_THEME,
  TILE_THEME_KEYS,
  tileThemeFor,
  type ColorGroup,
  type GrouplessOwnableKind,
  type TileTheme,
  type TileThemeKey,
} from "./groups";

export {
  Icon,
  ICON_NAMES,
  ICON_PATH,
  ICON_VIEWBOX,
  type ActionIconName,
  type IconName,
  type IconProps,
  type ModifierIconName,
  type TileIconName,
  type TokenIconName,
} from "./icons";

export {
  bandFill,
  BandPatternDefs,
  PATTERN_GEOMETRY,
  PATTERN_IDS,
  patternDomId,
  ThemeSprite,
  type PatternGeometry,
  type PatternId,
} from "./patterns";

export {
  FOCUS_CSS_VAR,
  FOCUS_RING,
  MIN_TARGET_PX,
  SURFACE_CSS_VAR,
  SURFACES,
  THEMES,
  type Surfaces,
  type ThemeName,
} from "./surfaces";

export {
  SEAT_COUNT,
  TOKEN_IDENTITY,
  TOKEN_SHAPE_EDGES,
  TOKEN_SHAPE_PATH,
  tokenForSeat,
  type SeatNumber,
  type TokenIdentity,
  type TokenShape,
} from "./tokens";

export {
  ACTION_THEME,
  ACTION_TONE,
  COMMAND_KINDS,
  requiresConfirmation,
  TERMINAL_COMMANDS,
  type ActionClass,
  type ActionTheme,
  type ActionTone,
  type CommandKind,
  type ToneColors,
} from "./actions";
