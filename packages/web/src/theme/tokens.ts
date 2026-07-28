/**
 * Six seat identities — shape, colour, icon.
 *
 * "Up to six distinguishable tokens" left the hard question unasked: distinguishable *by what*
 * (GAP §5, G-A2/G-51)? Colour alone fails a colourblind player. A name fails a pre-reader. So a
 * seat is a **shape** first, a **colour** second and an **icon** third, and this module is the
 * only place those three are decided. The board token, the turn indicator, the dossier header
 * and the auction bidder list all read from here, which is what makes "the triangle is playing"
 * learnable by a child who cannot read any of the names on screen.
 *
 * ## Shape is the primary channel, and it is countable
 *
 * The plinth outlines are not arbitrary: from seat 2 onwards the shape has exactly as many
 * straight edges as the seat number — two for the capsule, three for the triangle, four for the
 * square, five for the pentagon, six for the hexagon — and seat 1 is the circle, which has
 * none. A child who can count can work out which seat a piece belongs to without being told,
 * and an adult reading a dossier header gets the same mapping for free.
 *
 * ## What is deliberately *not* here
 *
 * There is no `nameKey`. A seat's accessible name is the player's own name, which comes from
 * game state, not from the theme; inventing `token.triangle` would mean a catalogue key that
 * duplicates information the player already gave us and has to be translated twice. Narration
 * (MON-411) says "Maya's turn", not "the triangle's turn".
 *
 * Colours are also secondary on purpose. Six hues that all clear 4.5:1 against their own ink
 * end up clustered in lightness, so several pairs collapse to near-identical greys — the
 * collision table is printed by `contrast.test.ts`. That is acceptable *here* and only here,
 * because shape and icon are both fully independent of hue.
 */

import type { TokenIconName } from "./icons";

export const SEAT_COUNT = 6;

/** Seat numbers as a player sees them: 1–6, not 0–5. */
export type SeatNumber = 1 | 2 | 3 | 4 | 5 | 6;

export type TokenShape = "circle" | "capsule" | "triangle" | "square" | "pentagon" | "hexagon";

export interface TokenIdentity {
  readonly seat: SeatNumber;
  /** The primary channel. Rendered from `TOKEN_SHAPE_PATH`. */
  readonly shape: TokenShape;
  /** The plinth fill. Theme-invariant, like a colour band. */
  readonly color: string;
  /** Ink for the icon and any numeral drawn on the plinth. Contrast ≥ 4.5:1 against `color`. */
  readonly onColor: string;
  /** The piece riding the plinth. A different icon family from the tile icons, on purpose. */
  readonly icon: TokenIconName;
}

export const TOKEN_IDENTITY: readonly [
  TokenIdentity,
  TokenIdentity,
  TokenIdentity,
  TokenIdentity,
  TokenIdentity,
  TokenIdentity,
] = [
  { seat: 1, shape: "circle", color: "#bf3c25", onColor: "#fff6f1", icon: "cat" },
  { seat: 2, shape: "capsule", color: "#3fb0c2", onColor: "#05282e", icon: "sailboat" },
  { seat: 3, shape: "triangle", color: "#5b3aa8", onColor: "#f7f4ff", icon: "rocket" },
  { seat: 4, shape: "square", color: "#d9a017", onColor: "#241a00", icon: "bicycle" },
  { seat: 5, shape: "pentagon", color: "#b8306e", onColor: "#fff2f8", icon: "umbrella" },
  { seat: 6, shape: "hexagon", color: "#457a27", onColor: "#f4fff0", icon: "cactus" },
];

/**
 * Plinth outlines in the same 24×24 grid the icons use, so a token composes as
 * shape-then-icon with no coordinate arithmetic at the call site.
 */
export const TOKEN_SHAPE_PATH: Readonly<Record<TokenShape, string>> = {
  circle: "M12 1.2a10.8 10.8 0 1 0 0 21.6 10.8 10.8 0 0 0 0-21.6Z",
  capsule: "M6.6 2.4h10.8a6.6 6.6 0 0 1 0 19.2H6.6a6.6 6.6 0 0 1 0-19.2Z",
  triangle: "M12 1.4 23 21.4H1Z",
  square: "M2.4 2.4h19.2v19.2H2.4Z",
  pentagon: "M12 1.2 22.8 9.1 18.7 21.8H5.3L1.2 9.1Z",
  hexagon: "M7.2 2.1h9.6L21.6 12l-4.8 9.9H7.2L2.4 12Z",
};

/** How many straight edges the outline has. Seat 1 is the circle, which has none. */
export const TOKEN_SHAPE_EDGES: Readonly<Record<TokenShape, number>> = {
  circle: 0,
  capsule: 2,
  triangle: 3,
  square: 4,
  pentagon: 5,
  hexagon: 6,
};

/**
 * The identity for a seat number.
 *
 * Throws rather than falling back, because a seventh seat is an engine-contract violation and
 * silently handing back seat 1's identity would put two players behind one shape.
 */
export function tokenForSeat(seat: number): TokenIdentity {
  const identity = TOKEN_IDENTITY[seat - 1];
  if (identity === undefined) {
    throw new Error(`seat ${String(seat)} is outside 1–${String(SEAT_COUNT)}`);
  }
  return identity;
}
