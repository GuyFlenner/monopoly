/**
 * What a command's button says, and which square it acts on — all of it derived.
 *
 * ## What replaced what
 *
 * This module is what is left of `ActionLabels.ts` after MON-501. That file existed for one
 * reason: the catalogue's action leaves were camelCase names a designer chose (`action.build`,
 * `action.declareBankruptcy`), so not one of them could be reached by concatenating
 * `"action." + command.kind`. It carried a hand-written `Record<CommandKind, string>` bridge and
 * a test asserting the bridge was still necessary — a demolition date in executable form.
 *
 * ADR-003 §6's rename landed, that assertion went red, and the bridge is gone. `action.build_house`
 * *is* the key for `build_house`. What remains here is the part that was never a naming problem.
 *
 * ## Why anything remains at all
 *
 * Three facts about a command are not derivable from its kind, and each is a fact the engine
 * already decided rather than a rule this module invents:
 *
 * - **Two kinds have payload-dependent labels.** `RespondToTrade.accept` and
 *   `SellHouse.demolish_hotel` are booleans on the command the engine handed us. One button
 *   reading "Answer the trade" twice would be a UI that cannot be used — accepting and declining
 *   are the two commands and must not share a label. The suffix is read off the payload, never
 *   decided here.
 * - **Two labels want a figure.** `action.place_bid` wants `{{amount}}`, which `PlaceBid` carries.
 *   `action.pay_jail_fine` wants one too, and `PayJailFine` carries nothing — so the figure is
 *   handed in from `state.ruleset.jail_fine`. A projected field, not a derivation: this module has
 *   no business working out what bail costs.
 * - **Four kinds act on a square.** Asked structurally (`"tile" in command`) rather than by a
 *   hand-kept list, so a fifth cannot drift.
 *
 * It still never decides whether a command is legal, and it still never invents a figure.
 */

import type { Command, CommandKind } from "@/api";

/**
 * The catalogue key for a command kind, before any payload variant.
 *
 * The whole of ADR-003 §6's payoff is this one line of concatenation. `COMMAND_KINDS` is checked
 * against the engine's `Command` union by the contract suite, and `tests/test_key_contract.py`
 * checks the other end — that every kind the engine accepts has a leaf under this prefix.
 */
export function baseLabelKey(kind: CommandKind): string {
  return `action.${kind}`;
}

/**
 * The kinds whose own payload changes what the button says, and the suffixes they resolve to.
 *
 * Not a naming map — a statement about which commands carry a label-bearing boolean. An empty
 * suffix means "the base key itself is one of the variants", which is true of `sell_house`
 * (selling a house is the unmarked case) and false of `respond_to_trade` (there is no neutral
 * answer to a trade).
 */
const VARIANT_SUFFIX: Readonly<Partial<Record<CommandKind, readonly string[]>>> = {
  sell_house: ["", "_hotel"],
  respond_to_trade: ["_accept", "_decline"],
};

/**
 * Every catalogue key a command of one kind can resolve to.
 *
 * Derived from {@link baseLabelKey} and the suffix table rather than restated, so a variant cannot
 * be added in one place and forgotten in the other. This is what the coverage test walks.
 */
export function labelKeysFor(kind: CommandKind): readonly string[] {
  return (VARIANT_SUFFIX[kind] ?? [""]).map((suffix) => `${baseLabelKey(kind)}${suffix}`);
}

/** The catalogue key for one specific command, variant included. */
export function labelKeyFor(command: Command): string {
  const base = baseLabelKey(command.kind);
  if (command.kind === "sell_house") {
    return command.demolish_hotel ? `${base}_hotel` : base;
  }
  if (command.kind === "respond_to_trade") {
    return command.accept ? `${base}_accept` : `${base}_decline`;
  }
  return base;
}

/** Interpolation values, read off the command or handed in. Never computed. */
export type LabelParams = Readonly<Record<string, string | number>>;

const NO_PARAMS: LabelParams = {};

/**
 * The interpolation values one command's label needs.
 *
 * @param jailFine `state.ruleset.jail_fine`. The projected figure `action.pay_jail_fine` states.
 */
export function labelParamsFor(command: Command, jailFine: number): LabelParams {
  if (command.kind === "place_bid") {
    return { amount: command.amount };
  }
  if (command.kind === "pay_jail_fine") {
    return { amount: jailFine };
  }
  return NO_PARAMS;
}

/**
 * The square a command acts on, or `undefined` for one that acts on no square.
 *
 * A structural `in` check rather than a hand-kept list of kinds: the four tile-scoped commands are
 * the four whose schema has a `tile`, and asking the command is the one phrasing that cannot drift
 * when a fifth arrives.
 */
export function tileOf(command: Command): number | undefined {
  return "tile" in command ? command.tile : undefined;
}

/**
 * The variant suffix for the one consequence sentence that depends on a rule set (MON-604).
 *
 * `confirm.consequence.decline_purchase` says "the square goes up for auction instead. Anyone at
 * the table can buy it" — which is true under the universal rules and **false in Kids Mode**, where
 * `auctions_enabled` is off and declining simply leaves the square unsold. A confirm dialog that
 * states a consequence that will not happen is worse than no dialog: it teaches a rule the game
 * does not play, to the exact audience least able to notice.
 *
 * Exported so the test can name the same string the implementation does.
 */
export const NO_AUCTION_SUFFIX = "_no_auction";

/**
 * The plain-language consequence of a terminal command, as a catalogue key.
 *
 * Derived, like the labels — `confirm.consequence.<kind>`. The old hand-written table had to be
 * checked against the theme's terminal set in both directions to be trusted; a concatenation
 * cannot disagree with itself, so what remains to test is only that the key resolves and that the
 * sentence explains rather than restates.
 *
 * Callers ask this only for the kinds `requiresConfirmation` returns true for. A confirm step whose
 * body is empty is a dialog that teaches nothing.
 *
 * @param auctions `ruleset.auctions_enabled`. A *presentation* input: it selects which true sentence
 * to print, and decides nothing about whether the command may be sent. `decline_purchase` is the
 * only kind whose consequence names an auction — `withdraw_from_auction` cannot be legal in a game
 * with no auctions in it, so it needs no variant.
 */
export function consequenceKeyFor(kind: CommandKind, auctions = true): string {
  const base = `confirm.consequence.${kind}`;
  return kind === "decline_purchase" && !auctions ? `${base}${NO_AUCTION_SUFFIX}` : base;
}
