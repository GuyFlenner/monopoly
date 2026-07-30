import { describe, expect, it } from "vitest";

import { KIDS_RULESET, makeRuleset } from "@/test/fixtures";

import { FULL_RULES_PRESENTATION, KIDS, presentationFor } from "./presentation";

/**
 * The four switches, and the one thing they must never become.
 *
 * The test worth having here is not "the getter returns the field" — it is that each switch is
 * wired to the flag it claims and to no other, because the failure mode is silent: a
 * `mortgages: ruleset.auctions_enabled` typo produces a screen that looks entirely plausible and
 * hides the wrong affordance. So every flag is flipped **one at a time** and the other three are
 * asserted unchanged, which is a test a copy-paste error cannot pass.
 */
describe("presentationFor", () => {
  it("reads the universal rules as every affordance on and hints quiet", () => {
    expect(presentationFor(makeRuleset())).toEqual(FULL_RULES_PRESENTATION);
  });

  it("reads Kids Mode as no auctions, no mortgages, prominent hints, simple wording", () => {
    expect(presentationFor(KIDS_RULESET)).toEqual({
      kids: true,
      auctions: false,
      mortgages: false,
      hintsProminent: true,
    });
  });

  it("falls back to the universal presentation before the first view arrives", () => {
    // A half-drawn screen is worse than a screen that steps up when the projection lands.
    expect(presentationFor(undefined)).toEqual(FULL_RULES_PRESENTATION);
  });

  const CASES = [
    ["auctions", makeRuleset({ auctions_enabled: false }), { auctions: false }],
    ["mortgages", makeRuleset({ mortgages_enabled: false }), { mortgages: false }],
    ["hintsProminent", makeRuleset({ hints_enabled: true }), { hintsProminent: true }],
    ["kids", makeRuleset({ name: KIDS }), { kids: true }],
  ] as const;

  it.each(CASES)("wires %s to its own flag and to no other", (_name, ruleset, expected) => {
    expect(presentationFor(ruleset)).toEqual({ ...FULL_RULES_PRESENTATION, ...expected });
  });

  it("keys the comfort scale on identity, not on a capability", () => {
    // A game with auctions switched off is not automatically a game a six-year-old is playing —
    // `ruleset.py` names `name` as its one identity field for exactly this reason. If `kids` ever
    // starts being inferred from a feature switch, this goes red.
    const houseRules = makeRuleset({ auctions_enabled: false, mortgages_enabled: false });
    expect(presentationFor(houseRules).kids).toBe(false);
  });
});
