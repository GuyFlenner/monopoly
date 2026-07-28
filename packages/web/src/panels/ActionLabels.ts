/**
 * What a command's button says — and the bridge that exists only because the catalogue is
 * spelled wrong.
 *
 * ## This whole file is scaffolding with a demolition date
 *
 * The engine's vocabulary is snake_case command kinds (`build_house`, `declare_bankruptcy`).
 * The catalogue's action leaves are camelCase and named after *verbs a designer chose*
 * (`action.build_house`, `action.declare_bankruptcy`) — so not one of them can be reached by
 * concatenating `"action." + command.kind`. That is GAP G-40, it is owned by MON-501, and the
 * accepted resolution is snake_case everywhere. When that rename lands, `action.<command_kind>`
 * resolves directly, {@link ACTION_LABEL_KEY} becomes an identity function, and this module is
 * deleted.
 *
 * Until then the mapping is **explicit and exhaustively covered** rather than clever. A
 * `Record<CommandKind, …>` will not compile with a kind missing, and `ActionLabels.test.ts`
 * re-checks the same thing at runtime *and* checks that every key the resolver can emit actually
 * exists in the catalogue. The failure mode that matters is a new engine command rendering a raw
 * `build_house` at a six-year-old; a compile error and a red test are both cheaper than that.
 *
 * ## What this module refuses to do
 *
 * It never decides whether a command is legal, and it never invents a figure. Two labels want a
 * number the command itself does not carry:
 *
 * - `action.place_bid` wants `{{amount}}` — `PlaceBid.amount` carries it. Fine.
 * - `action.pay_jail_fine` wants `{{amount}}` — `PayJailFine` carries nothing, so the figure comes in
 *   as `jailFine`, which the caller reads from `state.ruleset.jail_fine`. A projected field, not
 *   a derivation.
 * - `action.buy` wants `{{price}}` and **nothing on the wire can supply it**. `BuyProperty`
 *   carries no `tile`, and the only way to reach a price is to assume the purchase targets the
 *   square the player is standing on — which is a *rule* ("you may buy the square you landed
 *   on") and would print a wrong number the first time a card offers a purchase elsewhere. So
 *   `buy_property` gets the price-free `action.buy_property`, and the missing accessor is filed
 *   as a contract gap alongside MON-420.
 */

import type { CommandKind } from "@/theme";
import type { Command } from "@/api";

/**
 * Command kind to catalogue key.
 *
 * The values are the catalogue's spellings, warts included: the pre-existing camelCase leaves are
 * referenced as they are (renaming them is MON-501's job, not this item's), and the leaves added
 * for MON-405 are snake_case — which is both the accepted spelling and, not by accident, the name
 * the rename is heading for.
 */
export const ACTION_LABEL_KEY: Readonly<Record<CommandKind, string>> = {
  roll_dice: "action.roll_dice",
  end_turn: "action.end_turn",
  // New: price-free, because no field on the wire can supply the price. See the module docstring.
  buy_property: "action.buy_property",
  decline_purchase: "action.decline_purchase",
  place_bid: "action.place_bid",
  withdraw_from_auction: "action.withdraw_from_auction",
  build_house: "action.build_house",
  sell_house: "action.sell_house",
  mortgage_property: "action.mortgage_property",
  unmortgage_property: "action.unmortgage_property",
  propose_trade: "action.propose_trade",
  // New. `respond_to_trade` is one kind with two opposite meanings, so it has no usable base
  // label — see VARIANT_SUFFIX.
  respond_to_trade: "action.respond_to_trade",
  cancel_trade: "action.cancel_trade",
  pay_jail_fine: "action.pay_jail_fine",
  use_jail_card: "action.use_jail_card",
  roll_for_jail: "action.roll_for_jail",
  declare_bankruptcy: "action.declare_bankruptcy",
};

/**
 * The kinds whose *own payload* changes what the button says, and the suffixes they resolve to.
 *
 * This is not a rule and not a judgement. `RespondToTrade.accept` is a boolean on the command the
 * engine handed us, and one button reading "Answer the trade" twice would be a UI that cannot be
 * used: accepting and declining a trade are the two commands, and they must not share a label.
 * `SellHouse.demolish_hotel` is the same shape of fact — the engine already decided which is
 * legal, and the label reports which one this button is.
 *
 * An empty suffix means "the base key itself is one of the variants".
 */
const VARIANT_SUFFIX: Readonly<Partial<Record<CommandKind, readonly string[]>>> = {
  sell_house: ["", "_hotel"],
  respond_to_trade: ["_accept", "_decline"],
};

/**
 * Every catalogue key a command of one kind can resolve to.
 *
 * Derived from the two tables above rather than restated, so a variant cannot be added in one place
 * and forgotten in the other. This is what the coverage test walks: for every kind in the theme's
 * `COMMAND_KINDS`, every key it can emit must exist in the catalogue.
 */
export function labelKeysFor(kind: CommandKind): readonly string[] {
  return (VARIANT_SUFFIX[kind] ?? [""]).map((suffix) => `${ACTION_LABEL_KEY[kind]}${suffix}`);
}

/** The catalogue key for one specific command, variant included. */
export function labelKeyFor(command: Command): string {
  const base = ACTION_LABEL_KEY[command.kind];
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
 * @param jailFine `state.ruleset.jail_fine`. The projected figure `action.pay_jail_fine` states; the
 *   ActionBar has no business working out what bail costs.
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
 * A structural `in` check rather than a hand-kept list of kinds: the four tile-scoped commands
 * are the four whose schema has a `tile`, and asking the command is the one phrasing that cannot
 * drift when a fifth arrives.
 */
export function tileOf(command: Command): number | undefined {
  return "tile" in command ? command.tile : undefined;
}

/**
 * The plain-language consequence of a terminal command, as a catalogue key.
 *
 * Keyed by the three kinds `requiresConfirmation` returns true for, and only those — a confirm
 * step whose body is empty is a dialog that teaches nothing, so the theme's terminal set and this
 * table are checked against each other in the tests rather than trusted to agree.
 */
export const CONSEQUENCE_KEY: Readonly<Partial<Record<CommandKind, string>>> = {
  decline_purchase: "confirm.consequence.decline_purchase",
  withdraw_from_auction: "confirm.consequence.withdraw_from_auction",
  declare_bankruptcy: "confirm.consequence.declare_bankruptcy",
};
