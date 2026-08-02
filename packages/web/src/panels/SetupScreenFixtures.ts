/**
 * The two rule sets `/rulesets` returns, spelled out in full.
 *
 * `UNIVERSAL_RULES` and `KIDS_RULES` are deliberately **not** cast. `src/test/fixtures.ts` writes
 * `{ name: "universal" } as unknown as Ruleset` because no test there reads a flag — reasonable for
 * the projection, useless here: written out, this file is a compile-time witness of `Ruleset`'s
 * field list, so a flag added to `ruleset.py` and regenerated into `generated.ts` fails
 * `npm run typecheck` until this file acknowledges it. That was `RULESET_LABEL_KEYS`'s other job,
 * and it is the half worth keeping.
 *
 * ## Why the views are hand-written and not computed
 *
 * MON-417 moved the diff and the label keys to the server: `/rulesets` returns a `RulesetView` whose
 * every flag already carries `label_key`, `universal_value` and `differs_from_universal`. A fixture
 * that *computed* those from the two `Ruleset` literals would be a second implementation of the
 * server's projection living in the test suite, and the screen's tests would then pass or fail
 * against the fixture's opinion rather than the contract's.
 *
 * So `flag()` takes `differs` as an argument. Nothing here decides which rules differ; these
 * fixtures assert that the screen **renders what it is handed**, and whether the server marks the
 * right ones is a server test (`test_api.py::test_kids_mode_marks_exactly_the_settings_it_changes`).
 * That division is one the deleted `SetupScreenRuleset.test.ts` could not have had — it was testing
 * a diff the client no longer performs.
 *
 * Test-only, in a plain module rather than a `.test.ts` so two suites can share it. Nothing in the
 * app imports it.
 */

import type { RuleFlagView, Ruleset, RulesetView, RuleValue } from "@/api";

export const UNIVERSAL_RULES: Ruleset = {
  name: "universal",
  starting_cash: 1500,
  go_salary: 200,
  jail_fine: 50,
  houses_available: 32,
  hotels_available: 12,
  auctions_enabled: true,
  auction_minimum: "none",
  mortgages_enabled: true,
  trading_enabled: true,
  even_build_enforced: true,
  building_shortage_auction: false,
  max_jail_turns: 3,
  free_parking_pot_enabled: false,
  double_salary_on_exact_go: false,
  hints_enabled: false,
  target_duration_minutes: null,
  simplified_trades: false,
  starting_cash_denominations: [500, 100, 50, 20, 10, 5, 1],
};

/** Matches ADR-004's Kids flags. The values are what a test asserts against, not a claim. */
export const KIDS_RULES: Ruleset = {
  ...UNIVERSAL_RULES,
  name: "kids",
  starting_cash: 1000,
  auctions_enabled: false,
  mortgages_enabled: false,
  simplified_trades: true,
  hints_enabled: true,
  target_duration_minutes: 45,
};

/** Shorthands for the value kinds the wire tags. */
export const FLAG_ON: RuleValue = { kind: "flag", on: true };
export const FLAG_OFF: RuleValue = { kind: "flag", on: false };
export const ABSENT: RuleValue = { kind: "absent" };

export function amount(value: number): RuleValue {
  return { kind: "number", value };
}

/**
 * One flag row, exactly as the server would send it.
 *
 * `label_key` is spelled from `field` the same way `Ruleset.label_key` does, because that mapping is
 * mechanical in both places by design (the GAP G-40 argument applied to rule names). `differs` is
 * supplied, never worked out — see the header.
 */
export function flag(
  field: string,
  value: RuleValue,
  universalValue: RuleValue,
  differs: boolean,
): RuleFlagView {
  return {
    field,
    label_key: `ruleset.${field}`,
    value,
    universal_value: universalValue,
    differs_from_universal: differs,
  };
}

/** The universal rules: every flag present, none of them different from itself. */
export const UNIVERSAL_VIEW: RulesetView = {
  name: "universal",
  label_key: "setup.universal",
  ruleset: UNIVERSAL_RULES,
  flags: [
    flag("starting_cash", amount(1500), amount(1500), false),
    flag("auctions_enabled", FLAG_ON, FLAG_ON, false),
    flag("mortgages_enabled", FLAG_ON, FLAG_ON, false),
    flag("hints_enabled", FLAG_OFF, FLAG_OFF, false),
    flag("target_duration_minutes", ABSENT, ABSENT, false),
    flag("double_salary_on_exact_go", FLAG_OFF, FLAG_OFF, false),
  ],
};

/** Kids mode, with four of its six rows marked as changes. */
export const KIDS_VIEW: RulesetView = {
  name: "kids",
  label_key: "setup.kids",
  ruleset: KIDS_RULES,
  flags: [
    flag("starting_cash", amount(1000), amount(1500), true),
    flag("auctions_enabled", FLAG_OFF, FLAG_ON, true),
    flag("mortgages_enabled", FLAG_OFF, FLAG_ON, true),
    flag("hints_enabled", FLAG_ON, FLAG_OFF, true),
    // Present and *unmarked*, so a screen that rendered every flag rather than the marked ones
    // fails: these two are what "shows only what changed" means.
    flag("target_duration_minutes", ABSENT, ABSENT, false),
    flag("double_salary_on_exact_go", FLAG_OFF, FLAG_OFF, false),
  ],
};

/** Kids mode that changes nothing — the "plays by the full rules here" case. */
export const KIDS_VIEW_UNCHANGED: RulesetView = {
  ...KIDS_VIEW,
  flags: KIDS_VIEW.flags.map((entry) => ({ ...entry, differs_from_universal: false })),
};

/** Kids mode whose only change is a house rule — the falsifier for a hardcoded explainer. */
export const KIDS_VIEW_ONE_CHANGE: RulesetView = {
  ...KIDS_VIEW,
  flags: KIDS_VIEW.flags.map((entry) => ({
    ...entry,
    differs_from_universal: entry.field === "double_salary_on_exact_go",
    ...(entry.field === "double_salary_on_exact_go" ? { value: FLAG_ON } : {}),
  })),
};
