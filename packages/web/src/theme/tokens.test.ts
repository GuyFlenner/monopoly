import { describe, expect, it } from "vitest";

import { ICON_PATH } from "./icons";
import {
  SEAT_COUNT,
  TOKEN_IDENTITY,
  TOKEN_SHAPE_EDGES,
  TOKEN_SHAPE_PATH,
  tokenForSeat,
} from "./tokens";

/**
 * The gate behind "six distinguishable tokens" (GAP §5, G-A2/G-51).
 *
 * MON-604's acceptance criterion is "the turn indicator is identifiable with all text removed",
 * and these tests are what make that structurally true rather than hoped for: three independent
 * channels, none of which is a name, and none of which repeats between seats.
 */
describe("seat identities", () => {
  it("covers exactly six seats, numbered the way a player counts", () => {
    expect(TOKEN_IDENTITY).toHaveLength(SEAT_COUNT);
    expect(TOKEN_IDENTITY.map((identity) => identity.seat)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("gives every seat a unique shape, colour and icon — three channels, no collisions", () => {
    const shapes = TOKEN_IDENTITY.map((identity) => identity.shape);
    const colors = TOKEN_IDENTITY.map((identity) => identity.color);
    const icons = TOKEN_IDENTITY.map((identity) => identity.icon);

    expect(new Set(shapes).size, "two seats share a shape").toBe(SEAT_COUNT);
    expect(new Set(colors).size, "two seats share a colour").toBe(SEAT_COUNT);
    expect(new Set(icons).size, "two seats share an icon").toBe(SEAT_COUNT);
  });

  it("makes the shape countable: from seat 2 on, edges equal the seat number", () => {
    // The mnemonic that lets a child work out which seat a piece is without being told.
    for (const identity of TOKEN_IDENTITY) {
      const edges = TOKEN_SHAPE_EDGES[identity.shape];
      if (identity.seat === 1) {
        expect(edges, "seat 1 is the circle").toBe(0);
      } else {
        expect(edges, `seat ${String(identity.seat)}`).toBe(identity.seat);
      }
    }
  });

  it("draws every shape and every icon it claims", () => {
    for (const identity of TOKEN_IDENTITY) {
      expect(TOKEN_SHAPE_PATH[identity.shape], `${identity.shape} has no outline`).toBeTruthy();
      expect(ICON_PATH[identity.icon], `${identity.icon} has no glyph`).toBeTruthy();
    }
    const outlines = Object.values(TOKEN_SHAPE_PATH);
    expect(new Set(outlines).size, "two shapes are the same drawing").toBe(outlines.length);
  });

  it("authors every colour as #rrggbb so the contrast test measures the shipped value", () => {
    for (const identity of TOKEN_IDENTITY) {
      expect(identity.color, `seat ${String(identity.seat)}.color`).toMatch(/^#[0-9a-f]{6}$/);
      expect(identity.onColor, `seat ${String(identity.seat)}.onColor`).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("carries no name key: a seat's name is the player's name, not the theme's", () => {
    for (const identity of TOKEN_IDENTITY) {
      expect(identity).not.toHaveProperty("nameKey");
    }
  });
});

describe("tokenForSeat", () => {
  it("resolves each of the six", () => {
    for (let seat = 1; seat <= SEAT_COUNT; seat += 1) {
      expect(tokenForSeat(seat).seat).toBe(seat);
    }
  });

  it("throws rather than wrapping around, so two players can never share a shape", () => {
    expect(() => tokenForSeat(0)).toThrow(/outside/);
    expect(() => tokenForSeat(7)).toThrow(/outside/);
    expect(() => tokenForSeat(-1)).toThrow(/outside/);
  });
});
