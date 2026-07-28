/**
 * The drift gate and the diff, tested separately from the screen that draws them.
 *
 * The important assertion is the boring one: **every `Ruleset` field has a label key, and every
 * label key resolves.** `RULESET_LABEL_KEYS` is `Record<keyof Ruleset, …>`, so a field added to
 * `ruleset.py` already fails `npm run typecheck` — but a key that is *spelled* right and missing
 * from the catalogue typechecks fine and renders a raw `ruleset.whatever` to a parent, so that
 * half needs a runtime check. The `UNIVERSAL` literal below is typed as `Ruleset` with no cast,
 * which makes it a second compile-time witness of the field list.
 */

import i18next from "i18next";
import { describe, expect, it } from "vitest";

import type { Ruleset } from "@/api";

import { KIDS_RULES as KIDS, UNIVERSAL_RULES as UNIVERSAL } from "./SetupScreenFixtures";
import { diffRulesets, findRuleset, RULESET_LABEL_KEYS, ruleValue } from "./SetupScreenRuleset";

describe("the label-key gate", () => {
  it("labels every field the contract declares", () => {
    const labelled = new Set(Object.keys(RULESET_LABEL_KEYS));
    const declared = Object.keys(UNIVERSAL);
    expect(declared.filter((field) => !labelled.has(field))).toEqual([]);
    // And no orphans in the other direction: a label for a field that no longer exists is a
    // row that can never render, and a reader who trusts the list is misled.
    expect([...labelled].filter((field) => !declared.includes(field))).toEqual([]);
  });

  it("resolves every label key in the catalogue", () => {
    const unresolved = Object.values(RULESET_LABEL_KEYS).filter((key) => !i18next.exists(key));
    expect(unresolved).toEqual([]);
  });
});

describe("classifying a value", () => {
  it("tells a flag, a number, a list and an absence apart", () => {
    expect(ruleValue(true)).toEqual({ kind: "flag", on: true });
    expect(ruleValue(50)).toEqual({ kind: "number", value: 50 });
    expect(ruleValue([500, 1])).toEqual({ kind: "numbers", values: [500, 1] });
    expect(ruleValue(null)).toEqual({ kind: "absent" });
  });
});

describe("the diff", () => {
  it("reports exactly the fields that differ", () => {
    const fields = diffRulesets(KIDS, UNIVERSAL).map((difference) => difference.field);
    expect(fields).toEqual([
      "starting_cash",
      "auctions_enabled",
      "mortgages_enabled",
      "hints_enabled",
      "target_duration_minutes",
      "simplified_trades",
    ]);
  });

  it("keeps the contract's field order, not the order the flags were changed in", () => {
    const first = diffRulesets(KIDS, UNIVERSAL).map((difference) => difference.field);
    const second = diffRulesets({ ...KIDS }, { ...UNIVERSAL }).map(
      (difference) => difference.field,
    );
    expect(first).toEqual(second);
  });

  it("leaves `name` out — it is the identity, not a setting", () => {
    const fields = diffRulesets(KIDS, UNIVERSAL).map((difference) => difference.field);
    expect(fields).not.toContain("name");
  });

  it("carries both halves, so a row can say what the full rules do", () => {
    const auctions = diffRulesets(KIDS, UNIVERSAL).find(
      (difference) => difference.field === "auctions_enabled",
    );
    expect(auctions?.value).toEqual({ kind: "flag", on: false });
    expect(auctions?.baseline).toEqual({ kind: "flag", on: true });
  });

  it("finds no difference between a rule set and itself", () => {
    expect(diffRulesets(UNIVERSAL, UNIVERSAL)).toEqual([]);
  });

  it("compares lists by content rather than by identity", () => {
    const copied: Ruleset = {
      ...UNIVERSAL,
      starting_cash_denominations: [500, 100, 50, 20, 10, 5, 1],
    };
    expect(diffRulesets(copied, UNIVERSAL)).toEqual([]);
    const shortened: Ruleset = { ...UNIVERSAL, starting_cash_denominations: [500, 100] };
    expect(diffRulesets(shortened, UNIVERSAL).map((difference) => difference.field)).toEqual([
      "starting_cash_denominations",
    ]);
  });
});

describe("finding a rule set", () => {
  it("does not care what order the endpoint returned them in", () => {
    expect(findRuleset([KIDS, UNIVERSAL], "universal")).toBe(UNIVERSAL);
    expect(findRuleset([UNIVERSAL, KIDS], "kids")).toBe(KIDS);
  });

  it("says so when the endpoint did not offer one", () => {
    expect(findRuleset([UNIVERSAL], "kids")).toBeUndefined();
  });
});
