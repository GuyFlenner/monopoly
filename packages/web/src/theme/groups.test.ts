import { describe, expect, it } from "vitest";

import commonEn from "../i18n/locales/common.en.json";
import { GROUP_ORDER, GROUP_THEME, TILE_THEME, TILE_THEME_KEYS, tileThemeFor } from "./groups";

/**
 * The engine's own spelling of the ownable kinds.
 *
 * Restated here rather than imported, because the point is to *disagree loudly* if the engine
 * changes: this file is presentation data and a mismatch must fail a test, not silently paint a
 * new group in a fallback colour. The eight are `kesef_engine.board.models.ColorGroup`; the two
 * others are the `TileKind` members in `OWNABLE_KINDS` that the engine leaves `group=None`.
 */
const ENGINE_COLOR_GROUPS = [
  "brown",
  "light_blue",
  "pink",
  "orange",
  "red",
  "yellow",
  "green",
  "dark_blue",
] as const;
const ENGINE_GROUPLESS_OWNABLE_KINDS = ["railroad", "utility"] as const;

describe("tile theme", () => {
  it("themes every ownable kind the engine has, and nothing else (G-A3)", () => {
    expect(Object.keys(TILE_THEME).sort()).toEqual(
      [...ENGINE_COLOR_GROUPS, ...ENGINE_GROUPLESS_OWNABLE_KINDS].sort(),
    );
  });

  it("keys everything in the engine's snake_case (ADR-003 §6)", () => {
    for (const key of Object.keys(TILE_THEME)) {
      expect(key, `${key} is not snake_case`).toMatch(/^[a-z]+(?:_[a-z]+)*$/);
    }
  });

  it("derives every name from a catalogue key, never a literal", () => {
    for (const key of TILE_THEME_KEYS) {
      expect(TILE_THEME[key].nameKey).toBe(`group.${key}`);
    }
  });

  it("has an English catalogue entry for every name key, including the two new ones", () => {
    // `group.railroad` / `group.utility` did not exist before MON-412. Hebrew is MON-501's,
    // and `tests/test_locale_parity.py` holds the documented exemption with a tripwire.
    const groups: Readonly<Record<string, string>> = commonEn.group;
    for (const key of TILE_THEME_KEYS) {
      expect(groups[key], `common.en.json is missing group.${key}`).toBeTruthy();
    }
  });

  it("authors every colour as #rrggbb, so the contrast test measures the shipped value", () => {
    for (const key of TILE_THEME_KEYS) {
      expect(TILE_THEME[key].color, `${key}.color`).toMatch(/^#[0-9a-f]{6}$/);
      expect(TILE_THEME[key].onColor, `${key}.onColor`).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("gives no two ownable kinds the same colour", () => {
    const colors = TILE_THEME_KEYS.map((key) => TILE_THEME[key].color);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it("lists the eight groups in board travel order and the two kinds after them", () => {
    expect(GROUP_ORDER).toEqual(ENGINE_COLOR_GROUPS);
    expect(TILE_THEME_KEYS).toEqual([...ENGINE_COLOR_GROUPS, ...ENGINE_GROUPLESS_OWNABLE_KINDS]);
  });

  it("exposes the eight buildable groups separately from the ten themed kinds", () => {
    // "Own the whole colour group" is a rule concept railroads and utilities do not share, so
    // a dossier's set-completion section must not be able to iterate the ten by accident.
    expect(Object.keys(GROUP_THEME).sort()).toEqual([...ENGINE_COLOR_GROUPS].sort());
    expect(GROUP_THEME.orange).toBe(TILE_THEME.orange);
  });
});

describe("tileThemeFor", () => {
  it("resolves a property from its group", () => {
    expect(tileThemeFor("property", "dark_blue")).toBe(TILE_THEME.dark_blue);
  });

  it("resolves railroads and utilities from their kind, which is the whole point (G-52)", () => {
    expect(tileThemeFor("railroad", null)).toBe(TILE_THEME.railroad);
    expect(tileThemeFor("utility", null)).toBe(TILE_THEME.utility);
  });

  it("returns null for a tile that owns no band rather than inventing one", () => {
    // Painting Free Parking brown would be worse than painting nothing: it implies ownership.
    expect(tileThemeFor("free_parking", null)).toBeNull();
    expect(tileThemeFor("tax", null)).toBeNull();
    expect(tileThemeFor("go", null)).toBeNull();
    expect(tileThemeFor("chance", null)).toBeNull();
  });

  it("returns null for a group the engine has and this theme does not", () => {
    expect(tileThemeFor("property", "teal")).toBeNull();
  });
});
