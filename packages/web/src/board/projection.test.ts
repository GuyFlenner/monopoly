import { describe, expect, it } from "vitest";

import { makeTile } from "@/test/fixtures";
import { TILE_THEME } from "@/theme";

import { makeSeats } from "./fixtures";
import { describeTile, seatOf, tileThemeKey, type Translate } from "./projection";

/**
 * A translate that echoes its key and its params.
 *
 * Asserting against this rather than against English is what makes these tests about *which facts
 * reach a screen reader* instead of about the current wording of a catalogue entry.
 */
const echo: Translate = (key, params) =>
  params === undefined || Object.keys(params).length === 0
    ? `[${key}]`
    : `[${key} ${Object.entries(params)
        .map(([name, value]) => `${name}=${String(value)}`)
        .join(" ")}]`;

describe("tileThemeKey", () => {
  it("uses the colour group when the engine gives one", () => {
    expect(tileThemeKey(makeTile(1, { group: "orange" }))).toBe("orange");
  });

  it("themes the two ownable kinds the engine leaves groupless (G-A3)", () => {
    // Six ownable squares identified by text alone is the same defect as colour alone. If this
    // regresses, the railroads lose their band, pattern and icon all at once.
    expect(tileThemeKey(makeTile(5, { kind: "railroad", group: null }))).toBe("railroad");
    expect(tileThemeKey(makeTile(12, { kind: "utility", group: null }))).toBe("utility");
  });

  it("returns null for a square nobody can own, rather than a fallback colour", () => {
    for (const kind of [
      "go",
      "chance",
      "community_chest",
      "tax",
      "jail",
      "free_parking",
    ] as const) {
      expect(tileThemeKey(makeTile(0, { kind, group: null }))).toBeNull();
    }
  });

  it("only ever names a key the theme actually defines", () => {
    for (const kind of ["property", "railroad", "utility"] as const) {
      const key = tileThemeKey(makeTile(1, { kind, group: kind === "property" ? "red" : null }));
      expect(key).not.toBeNull();
      if (key !== null) {
        expect(TILE_THEME[key]).toBeDefined();
      }
    }
  });
});

describe("seatOf", () => {
  const players = makeSeats(["Ruti", "Dan", "Maya"]);

  it("numbers seats from one, in the order the state lists them", () => {
    expect(seatOf(players, 0)).toBe(1);
    expect(seatOf(players, 1)).toBe(2);
    expect(seatOf(players, 2)).toBe(3);
  });

  it("has no seat for a player the state does not contain", () => {
    expect(seatOf(players, 99)).toBeUndefined();
  });

  it("refuses a seventh seat rather than reusing seat one's identity", () => {
    const seven = makeSeats(["a", "b", "c", "d", "e", "f", "g"]);
    expect(seatOf(seven, 5)).toBe(6);
    expect(seatOf(seven, 6)).toBeUndefined();
  });
});

describe("describeTile", () => {
  const base = {
    name: "Boardwalk",
    kind: "property" as const,
    ownerName: undefined,
    houses: 0,
    mortgaged: false,
    occupantNames: [] as readonly string[],
  };

  it("names the square and its kind, and says nothing about an owner it has not got", () => {
    const said = describeTile(base, echo);
    expect(said).toContain("a11y.boardTile");
    expect(said).toContain("name=Boardwalk");
    expect(said).toContain("tileKind.property");
    expect(said).not.toContain("a11y.ownedBy");
  });

  it("names the owner when there is one", () => {
    expect(describeTile({ ...base, ownerName: "Ruti" }, echo)).toContain("a11y.ownedBy name=Ruti");
  });

  it("distinguishes one house, several houses and a hotel", () => {
    expect(describeTile({ ...base, houses: 1 }, echo)).toContain("a11y.tileOneHouse");
    expect(describeTile({ ...base, houses: 3 }, echo)).toContain("a11y.tileHouses houses=3");
    expect(describeTile({ ...base, houses: 5 }, echo)).toContain("a11y.tileHotel");
  });

  it("calls the fifth building a hotel without ever calling it four houses", () => {
    const hotel = describeTile({ ...base, houses: 5 }, echo);
    expect(hotel).not.toContain("a11y.tileHouses");
    expect(hotel).not.toContain("a11y.tileOneHouse");
  });

  it("says a square is mortgaged", () => {
    expect(describeTile({ ...base, mortgaged: true }, echo)).toContain("a11y.tileMortgaged");
    expect(describeTile(base, echo)).not.toContain("a11y.tileMortgaged");
  });

  it("names every occupant, however few pieces the crowding ladder drew", () => {
    // The promise that lets `planCluster` collapse six pieces into one and a count: the names are
    // always here, whatever the geometry did.
    const crowded = describeTile(
      { ...base, occupantNames: ["Ruti", "Dan", "Maya", "Ari", "Noa", "Gil"] },
      echo,
    );
    for (const name of ["Ruti", "Dan", "Maya", "Ari", "Noa", "Gil"]) {
      expect(crowded).toContain(name);
    }
  });

  it("puts everything in one sentence, in a fixed order", () => {
    const said = describeTile(
      {
        name: "Park Place",
        kind: "property",
        ownerName: "Dan",
        houses: 5,
        mortgaged: true,
        occupantNames: ["Ruti"],
      },
      echo,
    );
    expect(said.indexOf("a11y.boardTile")).toBeLessThan(said.indexOf("a11y.tileHotel"));
    expect(said.indexOf("a11y.tileHotel")).toBeLessThan(said.indexOf("a11y.tileMortgaged"));
    expect(said.indexOf("a11y.tileMortgaged")).toBeLessThan(said.indexOf("a11y.tileOccupants"));
  });
});
