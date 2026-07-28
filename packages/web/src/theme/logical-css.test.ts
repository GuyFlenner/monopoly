/* eslint-disable no-restricted-syntax -- This file's fixtures are deliberately physical CSS:
   its entire job is to prove the RTL lint rejects them. Every string below that mentions a
   physical utility is an input to the linter, never a class this product renders. */
import { readFileSync } from "node:fs";
import { URL as NodeURL, fileURLToPath } from "node:url";

import { Linter } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * The RTL lint, tested.
 *
 * The old rule looked at string `Literal`s and nothing else, so it missed the ordinary way a
 * React className is assembled — a template literal — along with transforms, inline styles and
 * scroll geometry (GAP §3, G-45). Extending it is easy; knowing the extension *works* is not,
 * because a `no-restricted-syntax` selector that silently matches nothing looks exactly like a
 * clean codebase. So the selectors live in `eslint.logical-css.json`, `eslint.config.js` reads
 * them, and this file reads the same bytes and feeds the linter fixtures both ways round.
 *
 * The "still rejected" cases are a regression guard: the hardened rule must be a superset of the
 * one it replaced, never a rewrite that quietly dropped a case.
 */

interface Restriction {
  readonly selector: string;
  readonly message: string;
}

// The same bytes `eslint.config.js` loads, so there is exactly one copy of the selector list in
// the repository and this test cannot pass against a config the linter does not use.
const CONFIG_PATH = fileURLToPath(new NodeURL("../../eslint.logical-css.json", import.meta.url));
const { restrictions } = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as {
  readonly restrictions: readonly Restriction[];
};

const linter = new Linter();

function lint(code: string): readonly string[] {
  const config: Linter.Config = {
    // Flat config matches by filename, and `.tsx` is not in the default set — without this the
    // linter answers "no matching configuration" for every fixture, which looks like a
    // violation to a naive `length > 0` check and would make this whole file a false pass.
    files: ["**/*.tsx"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: { "no-restricted-syntax": ["error", ...restrictions] },
  };
  return linter.verify(code, config, "fixture.tsx").map((message) => message.message);
}

function isRejected(code: string): boolean {
  return lint(code).length > 0;
}

describe("the RTL lint is wired up at all", () => {
  it("loads every selector from the JSON the eslint config reads", () => {
    expect(restrictions.length).toBeGreaterThanOrEqual(5);
    for (const restriction of restrictions) {
      expect(restriction.selector.length).toBeGreaterThan(0);
      expect(restriction.message.length).toBeGreaterThan(0);
    }
  });

  it("reports the message a developer needs, not just a rule id", () => {
    const messages = lint(`const a = "flex ml-4";`);
    expect(messages.join(" ")).toMatch(/logical/i);
  });
});

/** Cases the old rule already caught. The hardened rule must still catch every one. */
const STILL_REJECTED = [
  ["margin-left utility", 'const a = "flex ml-4";'],
  ["margin-right utility", 'const a = "mr-2 grow";'],
  ["padding-left utility", 'const a = "pl-3";'],
  ["padding-right utility", 'const a = "pr-3";'],
  ["negative margin-left", 'const a = "-ml-2";'],
  ["absolute left offset", 'const a = "absolute left-0";'],
  ["physical border side", 'const a = "border-l-2";'],
  ["physical corner radius", 'const a = "rounded-r-lg";'],
  ["physical text alignment", 'const a = "text-left";'],
] as const;

/** Cases the old rule let through, which is the point of MON-412's lint work. */
const NEWLY_REJECTED = [
  ["a physical utility inside a template literal", 'const a = `flex ${x ? "ml-2" : ""}`;'],
  ["a physical utility in a template literal chunk", "const a = `grow pr-4 ${x}`;"],
  ["a transform that never mirrors", 'const a = "translate-x-4";'],
  ["a negative transform", 'const a = "-translate-x-full";'],
  ["a physical transform origin", 'const a = "origin-left scale-95";'],
  ["a float", 'const a = "float-right";'],
  ["a physical inset pair", 'const a = "inset-x-0";'],
  ["physical sibling spacing", 'const a = "flex space-x-2";'],
  ["physical divider placement", 'const a = "divide-x";'],
  ["a physical background position", 'const a = "bg-right bg-no-repeat";'],
  ["a physical object position", 'const a = "object-left";'],
  ["a bare physical border side", 'const a = "border-l";'],
  ["a bare physical corner", 'const a = "rounded-tl";'],
  ["a physical scroll margin", 'const a = "scroll-ml-4";'],
  ["reading scroll geometry", "function f(el) { return el.scrollLeft; }"],
  ["writing scroll geometry", "function f(el) { el.scrollLeft = 0; }"],
  ["a physical inline style", "const a = <div style={{ marginLeft: 4 }} />;"],
  ["a physical inline offset", "const a = <div style={{ left: 0 }} />;"],
  ["a physical inline float", 'const a = <div style={{ float: "right" }} />;'],
] as const;

/** The logical forms, and the near-misses a sloppy regex would flag. */
const ACCEPTED = [
  ["logical margins", 'const a = "ms-4 me-2";'],
  ["logical padding", 'const a = "ps-3 pe-3";'],
  ["logical insets", 'const a = "absolute start-0 end-0";'],
  ["logical text alignment", 'const a = "text-start";'],
  ["logical border side", 'const a = "border-s-2";'],
  ["logical corner radius", 'const a = "rounded-s-lg";'],
  ["gap instead of space-x", 'const a = "flex gap-2";'],
  ["a block-axis transform", 'const a = "translate-y-2";'],
  ["a block-axis inset pair", 'const a = "inset-y-0";'],
  ["a direction-neutral background position", 'const a = "bg-top bg-no-repeat";'],
  ["a logical utility in a template literal", 'const a = `flex ${x ? "ms-2" : "me-2"}`;'],
  ["block-axis scroll geometry", "function f(el) { return el.scrollTop; }"],
  ["a logical inline style", "const a = <div style={{ marginInlineStart: 4 }} />;"],
  ["a colour that merely starts with a banned prefix", 'const a = "border-red-500 text-red-600";'],
  ['an English word containing "right"', 'const a = "copyright-notice bright-500";'],
  ["a non-style object with a left key", "const dice = { left: 3, right: 4 };"],
] as const;

describe.each([...STILL_REJECTED])("still rejects %s", (_name, code) => {
  it("is reported", () => {
    expect(isRejected(code), code).toBe(true);
  });
});

describe.each([...NEWLY_REJECTED])("now rejects %s", (_name, code) => {
  it("is reported", () => {
    expect(isRejected(code), code).toBe(true);
  });
});

describe.each([...ACCEPTED])("accepts %s", (_name, code) => {
  it("is not reported", () => {
    expect(lint(code), code).toEqual([]);
  });
});
