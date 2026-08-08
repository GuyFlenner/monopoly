import { readFileSync, readdirSync } from "node:fs";
import { URL as NodeURL, fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Colour the contrast gate cannot see.
 *
 * `contrast.test.ts` measures pairs of solid `#rrggbb` values, and that is its strength and its
 * blind spot at once: markup written `text-ink opacity-60` *names* the solid `ink`, so the gate
 * measures `ink` and reports green while the browser paints a composite that measured **4.38:1** on
 * a card face and **2.70:1** on the felt (`border-current/30` came out at 1.91:1). MON-743 replaced
 * those with named solids. This file is the tripwire that stops the next one being written.
 *
 * The same failure has a second shape: a raw `oklch(…)` in a className. `parseHex` refuses any
 * notation but `#rrggbb` precisely so a colour cannot dodge measurement — but a colour that never
 * reaches `parseHex` dodges it anyway. MON-746 folded the literals into the palette; the second
 * half of this file keeps them out.
 *
 * ## Why the alpha rule is deliberately wider than "text"
 *
 * The rule below fires on *any* sub-100 `opacity-*`, not only on a class list that also carries a
 * `text-*` utility, because `opacity` inherits down the subtree: `<li className="opacity-55">` dims
 * every label inside it just as surely as putting the utility on the label would, and that is
 * exactly how the auction's withdrawn-bidder row lost 2.4 ratio points. A rule that tried to tell
 * "text" from "container" apart by regex would be a rule that can be walked around by moving the
 * utility up one element.
 *
 * ## The exemptions, and why each one is an exemption
 *
 * - **`disabled:` and its variants.** WCAG 1.4.3 exempts "inactive user interface components", and
 *   a control that cannot be pressed is exactly that. `disabled:opacity-40` is the product saying
 *   so in the one place a reader can check it.
 * - **`opacity-100`.** A restore, not a composition. `hover:opacity-100` un-dims; it cannot dim.
 * - **Motion.** Animated opacity is a *timing* channel, lives in `@keyframes`, and is bounded by
 *   the global `prefers-reduced-motion` rule in `index.css`. This scan reads `.ts`/`.tsx`, so it
 *   never sees a keyframe, and no keyframe should be moved into a className to dodge it.
 * - **Comments.** Stripped before scanning, so a file may explain the rule (several do) without
 *   tripping it.
 *
 * ## The allowlist is a ledger, not a hole
 *
 * `AWAITING_MUTED_INK` is compared for **exact equality**, both directions: a new violation fails,
 * and so does fixing one without striking the entry. A plain "these files are exempt" set would rot
 * into permanent permission, which is the failure mode `ENGLISH_ONLY_CATALOGUES` is guarded against
 * for the same reason.
 */

// --- the rule, as two regexes both halves of this file share --------------------------------

/** A Tailwind opacity utility with whatever variant chain precedes it. */
const ALPHA_UTILITY = /(?<![\w-])((?:[\w-]+:)*)opacity-(\d+)(?![\w-])/g;

/** The inactive-component exemption, including the group/peer/has forms of it. */
const DISABLED_VARIANT = /(?:^|:)(?:group-|peer-|has-|in-)?(?:aria-)?disabled:/;

/** A colour notation `parseHex` cannot measure, appearing anywhere but a comment. */
const UNMEASURABLE_NOTATION = /oklch\(/g;

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every sub-100 opacity utility in `source` that no exemption covers. */
function alphaFindings(source: string): readonly string[] {
  const code = withoutComments(source);
  const found: string[] = [];
  ALPHA_UTILITY.lastIndex = 0;
  let match: RegExpExecArray | null = ALPHA_UTILITY.exec(code);
  while (match !== null) {
    const [whole, variants = "", value = ""] = match;
    if (value !== "100" && !DISABLED_VARIANT.test(variants)) {
      found.push(whole);
    }
    match = ALPHA_UTILITY.exec(code);
  }
  return found;
}

/** Every `oklch(…)` in `source` that no comment covers. */
function notationFindings(source: string): readonly string[] {
  return withoutComments(source).match(UNMEASURABLE_NOTATION) ?? [];
}

// --- the corpus ------------------------------------------------------------------------------

const SRC = fileURLToPath(new NodeURL("..", import.meta.url));

/**
 * Every module the product ships, tests excluded.
 *
 * Tests are excluded because a test's fixtures are inputs to a linter rather than classes the
 * product renders — the same carve-out `logical-css.test.ts` needs and states.
 */
function shippedModules(): ReadonlyArray<readonly [string, string]> {
  const files: Array<readonly [string, string]> = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = `${directory}/${entry.name}`;
      const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path, name);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        files.push([name, readFileSync(path, "utf8")]);
      }
    }
  };
  walk(SRC, "");
  return files;
}

const MODULES = shippedModules();

/**
 * Where alpha-composited colour still lives, and how much of it — MON-743's tail.
 *
 * MON-743 converted the three call sites its own finding named (`DiceTray`, `AuctionPanel`,
 * `SetupScreen`) and recorded the rest here rather than leaving them unmeasured *and* unnamed. The
 * counts come down as screens are touched; `MON-747` splits `GameScreen` and takes several with it.
 * Nothing may be added.
 */
const AWAITING_MUTED_INK: Readonly<Record<string, number>> = {
  "animation/SkipMotionButton.tsx": 1,
  "board/Tile.tsx": 2,
  "game/GameScreen.tsx": 7,
  "local/LocalEngineGate.tsx": 2,
  "panels/ActionBar.tsx": 6,
  "panels/CardReveal.tsx": 2,
  "panels/CompareTray.tsx": 2,
  "panels/EventLog.tsx": 3,
  "panels/HintPanel.tsx": 8,
  "panels/LoadSavedGame.tsx": 2,
  "panels/ModalDialog.tsx": 2,
  "panels/PlayerDossier.tsx": 11,
  "panels/SquareBuild.tsx": 1,
  "panels/States.tsx": 2,
  "panels/TurnBanner.tsx": 1,
  "replay/ReplayControls.tsx": 2,
  "replay/ReplayPanel.tsx": 4,
};

/** The files MON-743 cleared. Named so the item's own scope is a test rather than a claim. */
const CLEARED_BY_MON_743 = [
  "board/DiceTray.tsx",
  "panels/AuctionPanel.tsx",
  "panels/SetupScreen.tsx",
] as const;

// --- the rule is wired up at all --------------------------------------------------------------

/**
 * The notation, kept out of the fixture strings themselves.
 *
 * Tailwind scans every file in the package for utility-shaped candidates and generates CSS for
 * whatever it finds — including a fixture in a test. Spelled inline, the two `oklch` cases below
 * would put the very arbitrary colour this file exists to ban back into `dist/`. Interpolated, the
 * candidate is never contiguous in the source, so nothing is generated and the fixture still reads
 * as the class it stands for. (`logical-css.test.ts` has the same leak with `border-red-500`; that
 * one is only dead weight, where this one would be self-contradicting.)
 */
const NOTATION = "oklch(70%_0.18_250)";

/** Class lists the rule must reject. */
const REJECTED = [
  ["a muted label", 'const a = "text-sm opacity-70";'],
  ["a muted label on the felt", 'const a = "text-on-table text-sm opacity-80";'],
  ["the faintest tier", 'const a = "opacity-55";'],
  ["a container dim that reaches the text inside it", 'const a = "opacity-85 saturate-50";'],
  ["a conditional dim", 'const a = `flex ${x ? "opacity-60" : ""}`;'],
  ["a hover variant, which is not the disabled variant", 'const a = "hover:opacity-70";'],
  ["a dark-theme dim", 'const a = "dark:opacity-75";'],
  ["a raw oklch fill", `const a = "bg-[${NOTATION}]";`],
  ["a raw oklch outline", `const a = "outline-[${NOTATION}]";`],
] as const;

/** Class lists the rule must accept, including the near-misses a sloppy regex would flag. */
const ACCEPTED = [
  ["an inactive control", 'const a = "target rounded-xl disabled:opacity-40";'],
  ["an inactive control by aria", 'const a = "aria-disabled:opacity-60";'],
  ["an inactive control by group", 'const a = "group-disabled:opacity-50";'],
  ["a restore to full strength", 'const a = "hover:opacity-100";'],
  ["a named solid instead of a composition", 'const a = "text-ink-muted text-sm";'],
  ["the felt's named quiet tier", 'const a = "text-on-table-muted";'],
  ["a measured edge token", 'const a = "border border-edge";'],
  ["a comment explaining the rule", "// was text-ink opacity-60, see MON-743\nconst a = 1;"],
  ["a block comment quoting the notation", `/* ${NOTATION} became --color-accent */\nconst a = 1;`],
  ["an unrelated word ending in opacity", 'const a = "backdrop-opacity";'],
] as const;

describe("the alpha-composition rule is wired up at all", () => {
  it.each([...REJECTED])("rejects %s", (_name, code) => {
    const found = [...alphaFindings(code), ...notationFindings(code)];
    expect(found, code).not.toEqual([]);
  });

  it.each([...ACCEPTED])("accepts %s", (_name, code) => {
    const found = [...alphaFindings(code), ...notationFindings(code)];
    expect(found, code).toEqual([]);
  });

  it("reads the whole product, not an empty list", () => {
    // A sweep over zero files passes every assertion below it, which is the one way this file
    // could be green and worthless.
    expect(MODULES.length).toBeGreaterThan(40);
    expect(MODULES.map(([name]) => name)).toContain("panels/SetupScreen.tsx");
  });
});

// --- the sweep --------------------------------------------------------------------------------

describe("non-disabled text carries no alpha composition (MON-743)", () => {
  it("matches the recorded ledger exactly, in both directions", () => {
    const counted: Record<string, number> = {};
    for (const [name, source] of MODULES) {
      const found = alphaFindings(source);
      if (found.length > 0) {
        counted[name] = found.length;
      }
    }
    // Exact equality rather than a subset check: a new `opacity-70` fails here, and so does an
    // entry left in the ledger after the screen was fixed. See the module docstring.
    expect(counted).toEqual(AWAITING_MUTED_INK);
  });

  it.each([...CLEARED_BY_MON_743])("%s composites no colour at all", (name) => {
    const source = MODULES.find(([candidate]) => candidate === name)?.[1];
    expect(source, `${name} is not in the source tree`).toBeDefined();
    expect(alphaFindings(source ?? "")).toEqual([]);
  });

  it("still sees the disabled utilities it is meant to let through", () => {
    // Without this the ledger could be satisfied by an exemption that swallowed everything.
    const disabled = MODULES.flatMap(([, source]) => [
      ...withoutComments(source).matchAll(ALPHA_UTILITY),
    ]).filter(([, variants = ""]) => DISABLED_VARIANT.test(variants));
    expect(disabled.length).toBeGreaterThan(0);
  });
});

describe("no colour is authored where the gate cannot reach it (MON-746)", () => {
  it("leaves no oklch() literal in any shipped module", () => {
    // `parseHex` refuses every notation but `#rrggbb` so a colour cannot dodge measurement — which
    // does nothing about a colour that never reaches it. Before MON-746 there were eleven of these
    // across six components: a start button, a second dark card face, three edge accents and two
    // shadows, none of them in `contrast.test.ts` and three of them below their floor.
    const offenders = MODULES.filter(([, source]) => notationFindings(source).length > 0).map(
      ([name]) => name,
    );
    expect(offenders).toEqual([]);
  });

  it("keeps the exemption honest: a comment may quote the notation it replaced", () => {
    const commented = MODULES.filter(
      ([, source]) => /oklch\(/.test(source) && notationFindings(source).length === 0,
    );
    // `surfaces.ts` explains what each folded literal used to be. If that stops being true the
    // exemption has stopped being exercised and this file is asserting less than it claims.
    expect(commented.map(([name]) => name)).toContain("theme/surfaces.ts");
  });
});
