/**
 * Where a tile sits, which way it faces, and which tile an arrow key reaches.
 *
 * Pure arithmetic over a tile index. No React, no DOM, no game state — the board's shape is a
 * property of a 40-square ring, not of whose turn it is, and keeping it here is what lets the
 * whole layout be tested without rendering anything.
 *
 * ## The grid is 11 x 11 and pinned `dir="ltr"` — see `Board.tsx`
 *
 * Every coordinate below is **absolute screen geometry**: `column: 1` is the visual left edge in
 * English *and* in Hebrew. That is only true because the grid container pins `dir="ltr"`, which
 * is the single deliberate physical-direction exception in this package (spec 5.1 as amended,
 * GAP G-44). The reason is in `Board.tsx`, next to the attribute; the consequence is here, in
 * that `column` may be read as "how far from the left" without a caveat.
 *
 * ## Rotation is derived, not chosen
 *
 * A real board's four edges are rigid rotations of one printed tile face, and the invariant that
 * fixes the angle is that **the colour band faces the board's interior**. Author one face with
 * its band at `block-start` and the rotation follows: the bottom row is upright, the left column
 * turns a quarter clockwise (its band lands on the right, facing in), the top row is a half turn
 * (band at the bottom, facing in — which is also why top-row text reads upside down to someone
 * sitting at the bottom edge, exactly as on cardboard), and the right column is three quarters.
 * `geometry.test.ts` asserts the band-faces-interior property rather than the angles, so the
 * angles cannot be "corrected" into something that looks tidy and prints wrong.
 */

/** Cells per edge of the grid, counting both corners. */
export const GRID_SPAN = 11;

/** Squares on one edge, counting the corner that starts it and not the one that ends it. */
export const TILES_PER_SIDE = 10;

/** The ring. A board with a different count is a different board and would need a new geometry. */
export const TILE_COUNT = TILES_PER_SIDE * 4;

/**
 * Which edge a tile belongs to, named by where it sits on screen.
 *
 * Screen names rather than logical ones on purpose: the grid does not mirror, so "bottom" is the
 * bottom in both languages. Every other name in this package is logical; these four are the
 * exception the pinned `dir` buys us.
 */
export const BOARD_SIDES = ["bottom", "left", "top", "right"] as const;
export type BoardSide = (typeof BOARD_SIDES)[number];

/** A screen direction, for the arrow keys. Also the exception the pinned `dir` buys us. */
export const SCREEN_DIRECTIONS = ["up", "down", "left", "right"] as const;
export type ScreenDirection = (typeof SCREEN_DIRECTIONS)[number];

/** Degrees clockwise applied to the authored tile face. See the module docstring. */
export type TileRotation = 0 | 90 | 180 | 270;

export interface TilePlacement {
  readonly index: number;
  /** 1-based grid row, counting from the top. */
  readonly row: number;
  /** 1-based grid column, counting from the visual left. */
  readonly column: number;
  readonly side: BoardSide;
  /** A corner belongs to two edges; it is named for the one it starts and is never rotated. */
  readonly isCorner: boolean;
  readonly rotation: TileRotation;
}

/** Edges in travel order: index 0 starts the bottom edge and play runs clockwise from there. */
const SIDE_ORDER: readonly [BoardSide, BoardSide, BoardSide, BoardSide] = [
  "bottom",
  "left",
  "top",
  "right",
];

/**
 * The screen direction a token travels while it is on this edge.
 *
 * This is the whole reason the board does not mirror. Reverse the inline axis and this table
 * inverts, so a token would circle one way in English and the other way in Hebrew — a change to
 * how the *game* works, dressed up as a change to how it reads (spec 5.3, GAP G-44).
 */
const TRAVEL_DIRECTION: Readonly<Record<BoardSide, ScreenDirection>> = {
  bottom: "left",
  left: "up",
  top: "right",
  right: "down",
};

const OPPOSITE: Readonly<Record<ScreenDirection, ScreenDirection>> = {
  up: "down",
  down: "up",
  left: "right",
  right: "left",
};

/** Rotation per edge, expressed as the quarter-turns needed to keep the band facing inward. */
const SIDE_ROTATION: Readonly<Record<BoardSide, TileRotation>> = {
  bottom: 0,
  left: 90,
  top: 180,
  right: 270,
};

function assertIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= TILE_COUNT) {
    throw new RangeError(`tile ${String(index)} is outside 0-${String(TILE_COUNT - 1)}`);
  }
}

/**
 * Place one tile.
 *
 * Throws on an out-of-range index rather than clamping: a 41st square means the board data and
 * this module disagree, and a tile quietly stacked on top of GO is the least debuggable possible
 * symptom of that.
 */
export function placeTile(index: number): TilePlacement {
  assertIndex(index);
  const side = SIDE_ORDER[Math.floor(index / TILES_PER_SIDE)] ?? "bottom";
  const step = index % TILES_PER_SIDE;
  const isCorner = step === 0;
  const last = GRID_SPAN;

  const { row, column } = ((): { row: number; column: number } => {
    switch (side) {
      case "bottom":
        return { row: last, column: last - step };
      case "left":
        return { row: last - step, column: 1 };
      case "top":
        return { row: 1, column: 1 + step };
      case "right":
        return { row: 1 + step, column: last };
    }
  })();

  return { index, row, column, side, isCorner, rotation: isCorner ? 0 : SIDE_ROTATION[side] };
}

/** Every square, in travel order. Computed once: the ring is the same for every board. */
export const PLACEMENTS: readonly TilePlacement[] = Array.from({ length: TILE_COUNT }, (_, index) =>
  placeTile(index),
);

/** The next square in travel order, wrapping at GO. */
export function nextIndex(index: number): number {
  assertIndex(index);
  return (index + 1) % TILE_COUNT;
}

/** The previous square in travel order, wrapping at GO. */
export function previousIndex(index: number): number {
  assertIndex(index);
  return (index + TILE_COUNT - 1) % TILE_COUNT;
}

/**
 * The tile an arrow key reaches from `index`, or `null` if that key does nothing here.
 *
 * The board is a ring, so exactly two of the four keys move from any square, and *which* two
 * depends on the edge. Pressing the travel direction advances one square; pressing the reverse
 * of the *previous* square's travel direction goes back one. Corners fall out of that for free:
 * at GO (which starts the bottom edge, travelling left) the left arrow reaches square 1, and the
 * up arrow reaches square 39 — because square 39 is on the right edge, travelling down.
 */
export function neighbour(index: number, direction: ScreenDirection): number | null {
  assertIndex(index);
  const here = PLACEMENTS[index];
  const behind = PLACEMENTS[previousIndex(index)];
  if (here === undefined || behind === undefined) {
    return null;
  }
  if (TRAVEL_DIRECTION[here.side] === direction) {
    return nextIndex(index);
  }
  if (OPPOSITE[TRAVEL_DIRECTION[behind.side]] === direction) {
    return previousIndex(index);
  }
  return null;
}

/**
 * The four inset percentages of the interior well, as one CSS length.
 *
 * The 9 x 9 hole in the middle of the ring is one cell in from every edge. Expressed as a single
 * symmetric `inset` because a symmetric inset cannot be a mirroring bug — there is no start or
 * end in it to get backwards.
 */
export const INTERIOR_INSET = `${String(100 / GRID_SPAN)}%`;

/**
 * The narrowest board that may hand its tiles a hit target.
 *
 * Not a taste breakpoint — arithmetic. Eleven columns of the 44 px floor need 484 px of inline
 * size, so below this a tile *cannot* be a tap target and pretending otherwise ships a control
 * a six-year-old cannot hit (GAP G-C1/G-53). Above it, tiles carry `.target` and rove; below,
 * the board is keyboard- and list-driven and no tile is focusable. Derived from `MIN_TARGET_PX`
 * so that raising the floor moves the breakpoint with it.
 */
export function interactiveMinInlineSize(minTargetPx: number): number {
  return minTargetPx * GRID_SPAN;
}
