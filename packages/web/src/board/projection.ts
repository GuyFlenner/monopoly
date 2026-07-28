/**
 * Reading the projection, and nothing else.
 *
 * Every function here is a **lookup or a lookup plus a translation**. There is no arithmetic over
 * money, no comparison of cash against a price, no counting towards a colour set, no decision
 * about whether something may be built or bought. The server ships `owner`, `houses`, `mortgaged`,
 * `net_worth`, `group_holdings` and `is_ownable` precisely so that a component does not have to
 * work any of them out (ADR-008, GAP G-31), and the board's job is to draw what it is handed.
 *
 * The wire types are *derived* from `generated.ts` rather than restated. `src/api/types.ts` aliases
 * most of them but not these two, and re-declaring a shape the generator already produces would
 * break the one property that makes the contract worth having — that a field renamed in the server
 * becomes a TypeScript error here instead of an `undefined` at runtime.
 */

import type { GameStateView, PlayerView, TileView } from "@/api";
import { SEAT_COUNT, TILE_THEME, type SeatNumber, type TileThemeKey } from "@/theme";

/** One square of static board data. */
export type TileProjection = TileView;

/** Ownership and development of one square, index-aligned with `board.tiles`. */
export type PropertyProjection = GameStateView["properties"][number];

/** What happens when a token lands on a square. */
export type TileKind = TileView["kind"];

/**
 * i18next's `t`, narrowed to what this module uses.
 *
 * Taken as an argument rather than imported so that the description builders stay pure and can be
 * tested against a fake that returns its own key — which is what makes "does it *say* the owner"
 * a real assertion rather than a snapshot of English.
 */
export type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

/**
 * The band, pattern and icon key for a square, or `null` for one that owns nothing.
 *
 * `tileThemeFor` in the theme answers "which theme" but not "under which key", and `bandFill` and
 * `patternDomId` both need the key. Rather than have every consumer cast a `string` back into a
 * `TileThemeKey`, the narrowing happens once, here, against `TILE_THEME` itself.
 */
export function tileThemeKey(tile: TileProjection): TileThemeKey | null {
  if (tile.group !== null && tile.group !== undefined && tile.group in TILE_THEME) {
    return tile.group;
  }
  if (tile.kind === "railroad" || tile.kind === "utility") {
    return tile.kind;
  }
  return null;
}

/**
 * A seat number from a player's position in `state.players`.
 *
 * Seat order, not `PlayerView.token`. The engine's `token` is a free-form asset key
 * (`token.rocket`, `token.dog`, …) whose six default names are neither the six identities
 * `TOKEN_IDENTITY` defines nor in the same order, so using it would either mis-assign a shape or
 * need a lookup table that goes stale the first time a seat is configured with a custom token.
 * Seat order is what `TOKEN_IDENTITY` is indexed by and what the dossier, turn indicator and
 * auction list will index by too, which is the point of having one identity table.
 */
export function seatOf(players: readonly PlayerView[], playerId: number): SeatNumber | undefined {
  const seat = players.findIndex((player) => player.id === playerId) + 1;
  if (seat < 1 || seat > SEAT_COUNT) {
    return undefined;
  }
  return seat as SeatNumber;
}

export interface TileDescription {
  /** Translated square name, from `board.tiles[i].name_key` in the board's own namespace. */
  readonly name: string;
  readonly kind: TileKind;
  readonly ownerName: string | undefined;
  readonly houses: number;
  readonly mortgaged: boolean;
  /** Names of the players standing here, in seat order. */
  readonly occupantNames: readonly string[];
}

/** The engine's `HOTEL_LEVEL`: the fifth building is the hotel. Compared, never derived. */
export const HOTEL_LEVEL = 5;

/**
 * Everything a screen reader is told about one square, as one sentence.
 *
 * The full occupant list is always in here, whatever the token cluster's geometry decided to draw
 * — that is the promise that lets `planCluster` collapse six pieces into one and a count without
 * losing information (see `Token.tsx`).
 */
export function describeTile(description: TileDescription, t: Translate): string {
  const owner =
    description.ownerName === undefined ? "" : t("a11y.owned_by", { name: description.ownerName });

  let sentence = t("a11y.board_tile", {
    name: description.name,
    kind: t(`tile_kind.${description.kind}`),
    owner,
  });

  if (description.houses >= HOTEL_LEVEL) {
    sentence += t("a11y.tile_hotel");
  } else if (description.houses === 1) {
    sentence += t("a11y.tile_one_house");
  } else if (description.houses > 1) {
    sentence += t("a11y.tile_houses", { houses: description.houses });
  }

  if (description.mortgaged) {
    sentence += t("a11y.tile_mortgaged");
  }

  if (description.occupantNames.length > 0) {
    sentence += t("a11y.tile_occupants", { names: description.occupantNames.join(", ") });
  }

  return sentence;
}
