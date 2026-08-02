/**
 * What must be true of board-scoped group names — and the tests that can fail.
 *
 * Three separate claims, and the third is the one that earns this file's keep.
 *
 * 1. **The resolver picks the right catalogue.** Israeli board → the city, classic board → the
 *    colour, unknown board → the colour, and never a throw. The fallback is the load-bearing half:
 *    `missingKeyHandler` raises under test by design (GAP G-F17), so the last test in that block
 *    asserts the unguarded lookup *does* throw. That is what makes the `exists` guard in
 *    `groupLabel` something the suite would notice the removal of.
 * 2. **The catalogue is complete, in both languages.** Eight groups, English and Hebrew, or a board
 *    ships half a set of names and the other half silently reads as a colour. And exactly eight: no
 *    railroad, no utility, nothing invented (the root `CLAUDE.md` rule about board data — a
 *    plausible fabricated name is worse than a missing one).
 * 3. **Every render site routes through the resolver.** A site left out does not fail loudly, it
 *    shows "dark blue" beside "Tel Aviv" on the same screen, which is a screenshot nobody is
 *    watching for. The type system covers the paths that take a `GroupNameScope` — `noteLines`,
 *    `resolveNoteParams` and `<GroupRow>` cannot be called without one — so what is left to check is
 *    the *untyped* path: a component reaching for `t("group.dark_blue")` directly. The last block
 *    reads the package's own source and refuses it.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { URL as NodeURL, fileURLToPath } from "node:url";

import i18next from "i18next";
import { describe, expect, it } from "vitest";

import { GROUP_ORDER, TILE_THEME, type ColorGroup } from "@/theme";

import { boardGroupKey, groupLabel, isGroupKey, type GroupNameScope } from "./groupNames";
import boardClassicEn from "./locales/board-classic.en.json";
import boardClassicHe from "./locales/board-classic.he.json";
import boardIsraelEn from "./locales/board-israel.en.json";
import boardIsraelHe from "./locales/board-israel.he.json";

/**
 * The real i18next, in one language, without changing the one the rest of the suite is in.
 *
 * `getFixedT` and `exists({lng})` rather than `changeLanguage`: the setup file pins English for
 * every test in the package, and a Hebrew assertion that mutated the global language would leak
 * into whatever ran next.
 */
function scopeFor(boardId: string | undefined, language = "en"): GroupNameScope {
  const fixed = i18next.getFixedT(language);
  return {
    boardId,
    translate: (key, params) => fixed(key, params ?? {}),
    exists: (key) => i18next.exists(key, { lng: language }),
  };
}

describe("groupLabel picks the catalogue the board is played from", () => {
  it("names the city on the Israeli board, where a colour group *is* a city", () => {
    // Allenby and Dizengoff are the two squares in this group, and they are streets in Tel Aviv.
    expect(groupLabel(scopeFor("israel"), "group.dark_blue")).toBe("Tel Aviv");
    expect(groupLabel(scopeFor("israel"), "group.yellow")).toBe("Jerusalem");
  });

  it("names the city in Hebrew as well, which is the build this was reported on", () => {
    expect(groupLabel(scopeFor("israel", "he"), "group.dark_blue")).toBe("תל אביב");
    expect(groupLabel(scopeFor("israel", "he"), "group.brown")).toBe("אילת");
  });

  it("names the colour on the classic board, whose colour names are the right answer", () => {
    expect(groupLabel(scopeFor("classic"), "group.dark_blue")).toBe("Dark blue");
    expect(groupLabel(scopeFor("classic"), "group.light_blue")).toBe("Light blue");
  });

  it("names the colour for a board nobody has written a catalogue for, and before one loads", () => {
    // A board id the app has never heard of names a namespace i18next has no resources for. That
    // has to resolve, not raise: the alternative is a panel that disappears because a new board
    // was declared before its catalogue landed (GAP G-46).
    expect(groupLabel(scopeFor("atlantis"), "group.dark_blue")).toBe("Dark blue");
    expect(groupLabel(scopeFor(undefined), "group.dark_blue")).toBe("Dark blue");
  });

  it("leaves the two groupless ownable kinds to the global catalogue", () => {
    // No board renames a railroad here, and none should: the owner verified eight cities off the
    // physical board and nothing about the railways or the utilities.
    expect(groupLabel(scopeFor("israel"), "group.railroad")).toBe(i18next.t("group.railroad"));
    expect(groupLabel(scopeFor("israel"), "group.utility")).toBe(i18next.t("group.utility"));
  });

  it("passes a key that names no group straight through, on any board", () => {
    // This is what lets the generic `*_key` resolver in `panels/EventLogLines.ts` route every param
    // through here without learning what a colour group is (MON-415).
    expect(groupLabel(scopeFor("israel"), "deck.chance")).toBe(i18next.t("deck.chance"));
    expect(groupLabel(scopeFor("israel"), "label.bank")).toBe(i18next.t("label.bank"));
  });

  it("resolves a group name that is already namespaced without scoping it twice", () => {
    expect(groupLabel(scopeFor("israel"), "board-israel:group.green")).toBe("Haifa");
  });

  it("guards with `exists` because the unguarded lookup is fatal, not merely empty", () => {
    // The falsifier for the fallback. Delete the `exists` check in `groupLabel` and the first
    // expectation goes red — a missing key throws in dev and test by design (GAP G-F17), so
    // "ask, then fall back" is the only way the classic board can stay silent.
    expect(() => groupLabel(scopeFor("classic"), "group.dark_blue")).not.toThrow();
    expect(() => i18next.t("board-classic:group.dark_blue")).toThrow(/missing key/);
  });
});

describe("the two helpers the resolver is built from", () => {
  it("recognises a group key, and only an unqualified one", () => {
    expect(isGroupKey("group.dark_blue")).toBe(true);
    expect(isGroupKey("group.railroad")).toBe(true);
    expect(isGroupKey("board-israel:group.dark_blue")).toBe(false);
    expect(isGroupKey("tile.israel.t37")).toBe(false);
    expect(isGroupKey("deck.chance")).toBe(false);
  });

  it("scopes a group key to a board, and refuses to scope anything else", () => {
    expect(boardGroupKey("group.dark_blue", "israel")).toBe("board-israel:group.dark_blue");
    expect(boardGroupKey("group.dark_blue", undefined)).toBeNull();
    expect(boardGroupKey("deck.chance", "israel")).toBeNull();
  });

  it("agrees with the key `TILE_THEME` carries for every band", () => {
    // The dossier renders `TILE_THEME[key].nameKey`, so the two spellings of "the group's name key"
    // have to be the same one.
    for (const group of GROUP_ORDER) {
      expect(isGroupKey(TILE_THEME[group].nameKey), `${group}'s nameKey`).toBe(true);
    }
  });
});

/** The `group` block of a board catalogue, as a plain lookup. */
function groupBlock(catalogue: {
  readonly group?: Readonly<Record<string, string>>;
}): Readonly<Record<string, string>> {
  return catalogue.group ?? {};
}

describe("the board catalogues", () => {
  const israel = { en: groupBlock(boardIsraelEn), he: groupBlock(boardIsraelHe) };

  it("names every one of the eight colour groups, in both languages", () => {
    // A half-filled catalogue is the failure mode this is for: seven cities and one "dark blue" on
    // the same card reads as a bug in the board rather than a gap in a file.
    for (const group of GROUP_ORDER) {
      expect(israel.en[group], `${group} missing from board-israel.en.json`).toBeTruthy();
      expect(israel.he[group], `${group} missing from board-israel.he.json`).toBeTruthy();
    }
  });

  it("names exactly those eight, and nothing it has no source for", () => {
    const expected = [...GROUP_ORDER].sort();
    expect(Object.keys(israel.en).sort()).toEqual(expected);
    expect(Object.keys(israel.he).sort()).toEqual(expected);
  });

  it("does not ship the English name under the Hebrew key", () => {
    // The repo-level mirror of tests/test_locale_parity.py's copied-English check, kept here too
    // because this is the file somebody adds the ninth board's names in.
    for (const group of GROUP_ORDER) {
      expect(israel.he[group], `${group} is identical in both languages`).not.toBe(
        israel.en[group],
      );
    }
  });

  it("leaves the classic board with no group names at all: its colours are the answer", () => {
    expect(boardClassicEn).not.toHaveProperty("group");
    expect(boardClassicHe).not.toHaveProperty("group");
    for (const group of GROUP_ORDER) {
      expect(i18next.exists(`board-classic:group.${group}`), `${group} on the classic board`).toBe(
        false,
      );
    }
  });

  it("has a city for every group the board actually paints", () => {
    // `GROUP_ORDER` is the engine's `ColorGroup` in board order (asserted in `theme/groups.test.ts`),
    // so this is the coverage claim stated against the engine rather than against a literal list.
    const covered: readonly ColorGroup[] = GROUP_ORDER.filter((group) => group in israel.he);
    expect(covered).toEqual(GROUP_ORDER);
  });
});

// --- The exhaustiveness scan -------------------------------------------------------------------

const SRC_DIR = fileURLToPath(new NodeURL("..", import.meta.url));

/** Every shipped module of the package: `.ts`/`.tsx`, tests and fixtures excluded. */
function shippedSources(dir: string = SRC_DIR): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...shippedSources(path));
      continue;
    }
    if (!/\.tsx?$/.test(entry) || /\.(test|spec)\.tsx?$/.test(entry) || entry === "fixtures.ts") {
      continue;
    }
    found.push(path);
  }
  return found;
}

/** Where a `group.*` key is allowed to be spelled out or read without this resolver. */
const OWNS_THE_KEYS = [join("theme", "groups.ts"), join("i18n", "groupNames.ts")];

function isOwner(path: string): boolean {
  return OWNS_THE_KEYS.some((suffix) => path.endsWith(suffix));
}

function relative(path: string): string {
  return path.slice(SRC_DIR.length).replace(/\\/g, "/");
}

describe("every site that shows a group's name routes through the resolver", () => {
  const sources = shippedSources().map((path) => ({ path, text: readFileSync(path, "utf8") }));

  it("finds the package's source at all, so the two scans below can fail", () => {
    // A scan over an empty list passes silently. This is the assertion that says it did not.
    expect(sources.length).toBeGreaterThan(40);
    expect(sources.map(({ path }) => relative(path))).toContain("panels/PlayerDossier.tsx");
  });

  it("hands no `group.*` key straight to a translate call", () => {
    // The untyped path, and the one a new panel would take: `t("group.dark_blue")` compiles, renders
    // and is wrong on the Israeli board. Every other path takes a `GroupNameScope`, which cannot be
    // supplied by accident.
    const direct = /\b(?:t|translate|copy|label)\(\s*["'`]group\./;
    const offenders = sources
      .filter(({ path, text }) => !isOwner(path) && direct.test(text))
      .map(({ path }) => relative(path));
    expect(
      offenders,
      "translate a group's name through `groupLabel(scope, key)` — the board may rename it",
    ).toEqual([]);
  });

  it("passes every theme `nameKey` it reads to the resolver, not to `t`", () => {
    // `TILE_THEME[key].nameKey` is the dossier's route to a group's name, and `t(theme.nameKey)` is
    // exactly the line this whole change replaced. Counting rather than asking whether `groupLabel`
    // appears anywhere in the file: an import left behind while the call site regressed would
    // satisfy the weaker check, and one `nameKey` resolved the old way is one band saying
    // "dark blue" next to a deed list of Tel Aviv streets.
    const reads = /\.nameKey/g;
    const resolved = /groupLabel\([^)]*\.nameKey/g;
    const offenders = sources
      .filter(({ path, text }) => !isOwner(path) && /TILE_THEME|GROUP_THEME/.test(text))
      .filter(
        ({ text }) => (text.match(reads) ?? []).length !== (text.match(resolved) ?? []).length,
      )
      .map(({ path }) => relative(path));
    expect(offenders, "a theme `nameKey` is a key, not a label — resolve it").toEqual([]);
  });

  it("still sees the site it is guarding, so a rename cannot blind it", () => {
    // The scans above are absence assertions, and an absence assertion over a pattern that no
    // longer matches anything is green forever. This pins that `PlayerDossier` remains a file the
    // second scan inspects — if `nameKey` or `TILE_THEME` is renamed, this goes red and the scan
    // gets updated with it rather than quietly retiring.
    const dossier = sources.find(({ path }) => path.endsWith(join("panels", "PlayerDossier.tsx")));
    expect(dossier?.text).toMatch(/TILE_THEME/);
    expect(dossier?.text).toMatch(/\.nameKey/);
    expect(dossier?.text).toContain("groupLabel");
  });
});
