/**
 * A full forty-square board, for the board's own tests.
 *
 * `src/test/fixtures.ts` builds a three-tile board, which is the right size for testing a client and
 * the wrong size for testing a ring. This builds the whole ring instead, and takes its square names
 * from the real catalogue rather than inventing `tile.classic.t7`: the i18n layer throws on a missing
 * key under Vitest (deliberately — GAP G-F17), so a fabricated key would fail for the wrong reason
 * and a test would be "fixed" by loosening the thing that catches real missing translations.
 */

import type { BoardView, GameStateView, PlayerView } from "@/api";
import boardClassicEn from "@/i18n/locales/board-classic.en.json";
import { makePlayer, makeState, makeTile } from "@/test/fixtures";

import { TILE_COUNT } from "./geometry";
import type { PropertyProjection, TileKind } from "./projection";

/** The forty real square keys, in board order — the order they are written in the catalogue. */
export const CLASSIC_NAME_KEYS: readonly string[] = Object.keys(boardClassicEn.tile.classic).map(
  (leaf) => `tile.classic.${leaf}`,
);

/** Kinds that are not `property`, at the indices the classic board puts them. */
const KIND_AT: Readonly<Record<number, TileKind>> = {
  0: "go",
  2: "community_chest",
  4: "tax",
  5: "railroad",
  7: "chance",
  10: "jail",
  12: "utility",
  15: "railroad",
  20: "free_parking",
  22: "chance",
  25: "railroad",
  28: "utility",
  30: "go_to_jail",
  33: "community_chest",
  35: "railroad",
  36: "chance",
  38: "tax",
};

const GROUPS = [
  "brown",
  "light_blue",
  "pink",
  "orange",
  "red",
  "yellow",
  "green",
  "dark_blue",
] as const;

/**
 * A whole ring. Only `kind`, `group`, `price` and `name_key` matter to the board.
 *
 * Groups are handed out by a counter over the *street* squares rather than by `index % 8`. With a
 * modulus, four of the eight groups land only on indices the classic board uses for taxes and card
 * squares, so the fixture would silently never produce a red band — and a test asserting that every
 * group gets one would fail on the fixture instead of on the component.
 */
export function makeRingBoard(overrides: Partial<BoardView> = {}): BoardView {
  let street = 0;
  const tiles = Array.from({ length: TILE_COUNT }, (_, index) => {
    const kind = KIND_AT[index] ?? "property";
    const ownable = kind === "property" || kind === "railroad" || kind === "utility";
    const group = kind === "property" ? (GROUPS[street++ % GROUPS.length] ?? "brown") : null;
    return makeTile(index, {
      kind,
      name_key: CLASSIC_NAME_KEYS[index] ?? "tile.classic.go",
      group,
      price: ownable ? 60 + index * 10 : null,
      is_ownable: ownable,
      ...(ownable ? {} : { rent: [], house_cost: null, mortgage: null }),
    });
  });
  return {
    id: "classic",
    name_key: "board.classic.name",
    tiles,
    go_to_jail_target: 10,
    ...overrides,
  };
}

/** Forty unowned squares, index-aligned with the ring. */
export function makeProperties(
  overrides: Readonly<Record<number, Partial<PropertyProjection>>> = {},
): PropertyProjection[] {
  return Array.from({ length: TILE_COUNT }, (_, index) => ({
    owner: null,
    houses: 0,
    mortgaged: false,
    ...overrides[index],
  }));
}

/** Seats, in seat order: `state.players[0]` is seat 1. */
export function makeSeats(names: readonly string[]): PlayerView[] {
  return names.map((name, index) => makePlayer(index, { name }));
}

export function makeRingState(overrides: Partial<GameStateView> = {}): GameStateView {
  return makeState({
    players: makeSeats(["Ruti", "Dan"]),
    properties: makeProperties(),
    ...overrides,
  });
}
