/**
 * What Kids mode changes, worked out from `/rulesets` rather than written down.
 *
 * MON-408's acceptance criterion is that the explanation is **sourced from the endpoint**, and
 * the catalogue's `setup.kids_explainer` — "No auctions or mortgages, simpler trades, hints on,
 * and games end in about {{minutes}} minutes" — is precisely the hardcoded sentence it forbids.
 * It is prose that was true when someone typed it, cannot be true after a flag changes, and
 * gives the reader no way to tell which of the two it is.
 *
 * So the diff is computed here from the two `Ruleset` objects the server returns. That is a
 * *presentation* of two server-supplied values, not a rule: nothing below decides what a flag
 * should be, only which pairs differ and what to call them.
 *
 * **The seam this leaves.** GAP G-36 asks for a `RulesetView` carrying `label_key` and
 * `differs_from_universal` per flag, and it is unclosed — `/rulesets` returns the raw engine
 * model with no label keys at all. When it lands, `diffRulesets` and `RULESET_LABEL_KEYS`
 * both delete, and the component renders the flags the server marked. Until then this file is
 * the client-side stand-in, and `RULESET_LABEL_KEYS` being `Record<keyof Ruleset, …>` is what
 * stops it drifting: a flag added to `ruleset.py` regenerates `generated.ts` and fails
 * `npm run typecheck` here until it has a label.
 */

import type { Ruleset } from "@/api";

/**
 * Every `Ruleset` field, mapped to its label key.
 *
 * The key names match the wire field names so the lookup is mechanical rather than a second
 * naming scheme to keep in step (the same reasoning GAP G-40 applies to `action.<command_kind>`).
 */
export const RULESET_LABEL_KEYS: Readonly<Record<keyof Ruleset, `ruleset.${string}`>> = {
  name: "ruleset.name",
  starting_cash: "ruleset.starting_cash",
  go_salary: "ruleset.go_salary",
  jail_fine: "ruleset.jail_fine",
  houses_available: "ruleset.houses_available",
  hotels_available: "ruleset.hotels_available",
  auctions_enabled: "ruleset.auctions_enabled",
  mortgages_enabled: "ruleset.mortgages_enabled",
  trading_enabled: "ruleset.trading_enabled",
  even_build_enforced: "ruleset.even_build_enforced",
  building_shortage_auction: "ruleset.building_shortage_auction",
  max_jail_turns: "ruleset.max_jail_turns",
  free_parking_pot_enabled: "ruleset.free_parking_pot_enabled",
  double_salary_on_exact_go: "ruleset.double_salary_on_exact_go",
  hints_enabled: "ruleset.hints_enabled",
  target_duration_minutes: "ruleset.target_duration_minutes",
  simplified_trades: "ruleset.simplified_trades",
  starting_cash_denominations: "ruleset.starting_cash_denominations",
};

/**
 * `name` is the identity of the rule set, not one of its settings.
 *
 * It differs between every pair by definition, so listing it would put "Rule set: kids (full
 * rules: universal)" at the top of a list of actual changes — and it is the one field whose
 * value is an enum, which a diff row has no honest way to print.
 */
const IDENTITY_FIELDS = new Set<keyof Ruleset>(["name"]);

/** The field order a reader sees: the order the contract declares them in. */
const FIELDS = Object.keys(RULESET_LABEL_KEYS).filter(
  (field): field is keyof Ruleset => !IDENTITY_FIELDS.has(field as keyof Ruleset),
);

/**
 * A rule value, classified so the component can render it without inspecting types.
 *
 * `absent` is its own case rather than a `null` because "no target length" and "a target
 * length of zero" are different sentences, and the wire allows both.
 */
export type RuleValue =
  | { readonly kind: "flag"; readonly on: boolean }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "numbers"; readonly values: readonly number[] }
  | { readonly kind: "absent" };

export interface RuleDifference {
  readonly field: keyof Ruleset;
  readonly labelKey: string;
  /** What the chosen rule set says. */
  readonly value: RuleValue;
  /** What the universal rules say — the "was" half of the sentence. */
  readonly baseline: RuleValue;
}

export function ruleValue(raw: Ruleset[keyof Ruleset]): RuleValue {
  if (typeof raw === "boolean") {
    return { kind: "flag", on: raw };
  }
  if (typeof raw === "number") {
    return { kind: "number", value: raw };
  }
  if (Array.isArray(raw)) {
    return { kind: "numbers", values: raw };
  }
  // `null`, `undefined`, and `RulesetName` all land here. The enum only reaches this function
  // for `name`, which the diff excludes — see IDENTITY_FIELDS.
  return { kind: "absent" };
}

/**
 * Which settings the chosen rule set changes, against the universal rules.
 *
 * Order is the contract's field order, so the list reads the same way twice running — a diff
 * that reshuffles itself is one a parent cannot check against last week's game.
 */
export function diffRulesets(chosen: Ruleset, baseline: Ruleset): readonly RuleDifference[] {
  const differences: RuleDifference[] = [];
  for (const field of FIELDS) {
    const value = ruleValue(chosen[field]);
    const previous = ruleValue(baseline[field]);
    if (!sameValue(value, previous)) {
      differences.push({
        field,
        labelKey: RULESET_LABEL_KEYS[field],
        value,
        baseline: previous,
      });
    }
  }
  return differences;
}

/** Find a rule set by name in whatever order `/rulesets` returned them. */
export function findRuleset(
  rulesets: readonly Ruleset[],
  name: Ruleset["name"],
): Ruleset | undefined {
  return rulesets.find((ruleset) => ruleset.name === name);
}

function sameValue(left: RuleValue, right: RuleValue): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "flag" && right.kind === "flag") {
    return left.on === right.on;
  }
  if (left.kind === "number" && right.kind === "number") {
    return left.value === right.value;
  }
  if (left.kind === "numbers" && right.kind === "numbers") {
    return (
      left.values.length === right.values.length &&
      left.values.every((entry, index) => entry === right.values[index])
    );
  }
  return true; // both `absent`
}
