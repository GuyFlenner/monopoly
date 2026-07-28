import { describe, expect, it } from "vitest";

import { MIN_TARGET_PX } from "@/theme";

import {
  BOARD_SIDES,
  GRID_SPAN,
  interactiveMinInlineSize,
  neighbour,
  nextIndex,
  placeTile,
  PLACEMENTS,
  previousIndex,
  SCREEN_DIRECTIONS,
  TILE_COUNT,
  TILES_PER_SIDE,
  type ScreenDirection,
  type TilePlacement,
} from "./geometry";

/** Which edge of a *rotated* tile face the colour band ends up against, on screen. */
function bandEdge(placement: TilePlacement): "top" | "right" | "bottom" | "left" {
  // The face is authored with its band at block-start, i.e. the top, before rotation.
  switch (placement.rotation) {
    case 0:
      return "top";
    case 90:
      return "right";
    case 180:
      return "bottom";
    case 270:
      return "left";
  }
}

/** Which way the board's interior lies from a tile on this edge. */
const INTERIOR_FROM: Readonly<Record<string, "top" | "right" | "bottom" | "left">> = {
  bottom: "top",
  left: "right",
  top: "bottom",
  right: "left",
};

describe("placeTile", () => {
  it("places all forty squares on the ring and none in the interior", () => {
    for (const placement of PLACEMENTS) {
      const onEdge =
        placement.row === 1 ||
        placement.row === GRID_SPAN ||
        placement.column === 1 ||
        placement.column === GRID_SPAN;
      expect(onEdge, `tile ${String(placement.index)} left the ring`).toBe(true);
    }
  });

  it("gives every square its own cell", () => {
    const cells = new Set(PLACEMENTS.map((p) => `${String(p.row)}:${String(p.column)}`));
    expect(cells.size).toBe(TILE_COUNT);
  });

  it("puts GO in the bottom-right corner and runs clockwise from there", () => {
    expect(placeTile(0)).toMatchObject({ row: 11, column: 11, side: "bottom", isCorner: true });
    // Clockwise means the next square is one step to the *left* along the bottom edge. If this
    // ever reads column 12 or a different row, the direction of travel has been reversed.
    expect(placeTile(1)).toMatchObject({ row: 11, column: 10, side: "bottom" });
    expect(placeTile(10)).toMatchObject({ row: 11, column: 1, side: "left", isCorner: true });
    expect(placeTile(11)).toMatchObject({ row: 10, column: 1, side: "left" });
    expect(placeTile(20)).toMatchObject({ row: 1, column: 1, side: "top", isCorner: true });
    expect(placeTile(21)).toMatchObject({ row: 1, column: 2, side: "top" });
    expect(placeTile(30)).toMatchObject({ row: 1, column: 11, side: "right", isCorner: true });
    expect(placeTile(39)).toMatchObject({ row: 10, column: 11, side: "right" });
  });

  it("names exactly four corners, one per edge", () => {
    const corners = PLACEMENTS.filter((p) => p.isCorner);
    expect(corners.map((p) => p.index)).toEqual([0, 10, 20, 30]);
    expect(new Set(corners.map((p) => p.side))).toEqual(new Set(BOARD_SIDES));
  });

  it("rotates every edge tile so its colour band faces the board's interior", () => {
    // The property, not the angle. A "tidier" rotation table that turned the top row upright
    // would print the band on the outside edge, which is the one thing a real board never does.
    for (const placement of PLACEMENTS) {
      if (placement.isCorner) {
        expect(placement.rotation).toBe(0);
        continue;
      }
      expect(bandEdge(placement), `tile ${String(placement.index)}`).toBe(
        INTERIOR_FROM[placement.side],
      );
    }
  });

  it("gives each edge one corner and nine ordinary squares", () => {
    for (const side of BOARD_SIDES) {
      const onSide = PLACEMENTS.filter((p) => p.side === side);
      expect(onSide).toHaveLength(TILES_PER_SIDE);
      expect(onSide.filter((p) => p.isCorner)).toHaveLength(1);
    }
  });

  it("refuses an index the ring does not have", () => {
    expect(() => placeTile(-1)).toThrow(RangeError);
    expect(() => placeTile(TILE_COUNT)).toThrow(RangeError);
    expect(() => placeTile(1.5)).toThrow(RangeError);
  });
});

describe("travel order", () => {
  it("wraps at GO in both directions", () => {
    expect(nextIndex(TILE_COUNT - 1)).toBe(0);
    expect(previousIndex(0)).toBe(TILE_COUNT - 1);
  });

  it("advances one square in the direction the edge travels, on screen", () => {
    // Walking the whole ring: each step must be one cell away from the last, and the step must
    // move in the travel direction of the edge it left. This is the assertion that would fail if
    // someone mirrored the grid.
    for (let index = 0; index < TILE_COUNT; index += 1) {
      const from = PLACEMENTS[index];
      const to = PLACEMENTS[nextIndex(index)];
      expect(from).toBeDefined();
      expect(to).toBeDefined();
      if (from === undefined || to === undefined) {
        continue;
      }
      const distance = Math.abs(from.row - to.row) + Math.abs(from.column - to.column);
      expect(distance, `step ${String(index)} skipped a cell`).toBe(1);
    }
  });
});

describe("neighbour", () => {
  it("moves along the ring for the two keys that apply and does nothing for the other two", () => {
    for (let index = 0; index < TILE_COUNT; index += 1) {
      const reached = SCREEN_DIRECTIONS.map((direction) => neighbour(index, direction));
      const moves = reached.filter((value): value is number => value !== null);
      expect(moves, `tile ${String(index)}`).toHaveLength(2);
      expect(new Set(moves)).toEqual(new Set([previousIndex(index), nextIndex(index)]));
    }
  });

  it("turns the corner at GO: left continues, up goes back along the trailing edge", () => {
    expect(neighbour(0, "left")).toBe(1);
    expect(neighbour(0, "up")).toBe(39);
    expect(neighbour(0, "right")).toBeNull();
    expect(neighbour(0, "down")).toBeNull();
  });

  it("turns the corner at jail: up continues, right goes back along the bottom edge", () => {
    expect(neighbour(10, "up")).toBe(11);
    expect(neighbour(10, "right")).toBe(9);
  });

  it("is its own inverse", () => {
    const inverse: Readonly<Record<ScreenDirection, ScreenDirection>> = {
      up: "down",
      down: "up",
      left: "right",
      right: "left",
    };
    for (let index = 0; index < TILE_COUNT; index += 1) {
      for (const direction of SCREEN_DIRECTIONS) {
        const there = neighbour(index, direction);
        if (there !== null) {
          expect(neighbour(there, inverse[direction])).toBe(index);
        }
      }
    }
  });
});

describe("interactiveMinInlineSize", () => {
  it("is eleven columns of the accessibility floor, not a taste breakpoint", () => {
    expect(interactiveMinInlineSize(MIN_TARGET_PX)).toBe(MIN_TARGET_PX * GRID_SPAN);
    expect(interactiveMinInlineSize(MIN_TARGET_PX)).toBe(484);
  });

  it("proves a 320 px board cannot give its tiles a hit target", () => {
    expect(interactiveMinInlineSize(MIN_TARGET_PX)).toBeGreaterThan(320);
  });
});
