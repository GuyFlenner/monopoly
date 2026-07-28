/**
 * The board, as one import.
 *
 * `<Board>` is the whole public surface for a screen: hand it a `BoardView` and a `GameStateView` and
 * it draws forty squares, their owners, their buildings and every piece standing on them. `<Tile>`,
 * `<Token>` and `<DiceTray>` are exported for the panels that reuse a piece's identity — a dossier
 * header, a turn indicator, an auction bidder list — so that "the triangle is playing" is drawn by
 * the same code everywhere it appears.
 *
 * `geometry` and `projection` are exported because they are pure and worth reusing: a tile-detail
 * sheet needs `describeTile`, and a minimap would need `placeTile`.
 */

export { Board } from "./Board";
export type { BoardProps } from "./Board";

export { DiceTray, SkipAnimationsToggle, TUMBLE_MS } from "./DiceTray";
export type { DiceTrayProps, SkipAnimationsToggleProps } from "./DiceTray";

export { MOTION_STORAGE_KEY, useMotionPreference, useReducedMotion } from "./motion";
export type { MotionPreference } from "./motion";

export { Tile } from "./Tile";
export type { TileProps } from "./Tile";

export { ICON_MIN_PX, planCluster, Token, TokenCluster, TOKEN_MIN_PX } from "./Token";
export type { ClusterPlan, TokenClusterProps, TokenOccupant, TokenProps } from "./Token";

export {
  BOARD_SIDES,
  GRID_SPAN,
  INTERIOR_INSET,
  interactiveMinInlineSize,
  neighbour,
  nextIndex,
  placeTile,
  PLACEMENTS,
  previousIndex,
  SCREEN_DIRECTIONS,
  TILE_COUNT,
  TILES_PER_SIDE,
} from "./geometry";
export type { BoardSide, ScreenDirection, TilePlacement, TileRotation } from "./geometry";

export { describeTile, HOTEL_LEVEL, seatOf, tileThemeKey } from "./projection";
export type {
  PropertyProjection,
  TileDescription,
  TileKind,
  TileProjection,
  Translate,
} from "./projection";

export { INTERACTIVE_MIN_INLINE_PX, useBoardMetrics } from "./useBoardMetrics";
export type { BoardMetrics } from "./useBoardMetrics";
