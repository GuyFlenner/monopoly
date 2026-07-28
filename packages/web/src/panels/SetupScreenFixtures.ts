/**
 * The two rule sets `/rulesets` returns, spelled out in full.
 *
 * Deliberately **not** cast. `src/test/fixtures.ts` writes `{ name: "universal" } as unknown as
 * Ruleset` because no test there reads a flag — reasonable for the projection, useless here: the
 * whole point of MON-408's diff is that it reads every flag, and a cast would hide a field the
 * contract added. Written out, this file is a second compile-time witness of `Ruleset`'s field
 * list alongside `RULESET_LABEL_KEYS`, and the two cannot drift apart quietly.
 *
 * Test-only, in a plain module rather than a `.test.ts` so two suites can share it. Nothing in
 * the app imports it.
 */

import type { Ruleset } from "@/api";

export const UNIVERSAL_RULES: Ruleset = {
  name: "universal",
  starting_cash: 1500,
  go_salary: 200,
  jail_fine: 50,
  houses_available: 32,
  hotels_available: 12,
  auctions_enabled: true,
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
