/**
 * A theme per command kind — icon, tone, consequence class.
 *
 * The whole command surface used to be text: fifteen labels and not one icon, so a pre-reader
 * could not use a single button (GAP §5, G-A1/G-50). This module fixes that, and it is keyed by
 * **command kind** rather than by button, because the kinds are the engine's vocabulary. The
 * UI's job is to render `GameView.legal_commands`; if it can theme every kind, it can theme
 * every button it will ever be asked to draw, and no rule logic leaks in to decide which.
 *
 * ## The three consequence classes
 *
 * - `reversible` — undoable from the same screen. Proposing a trade can be cancelled.
 * - `consequential` — moves money or holdings and cannot be taken back, but is an ordinary move.
 * - `terminal` — permanently removes an option or ends participation. Exactly three commands are
 *   terminal, and **MON-405 must put a confirm step with a plain-language consequence in front
 *   of each of them**: `declare_bankruptcy` (you are out), `withdraw_from_auction` (you cannot
 *   bid again on this lot), `decline_purchase` (the tile goes to auction and anyone can take it).
 *   `requiresConfirmation()` below is that predicate, so the ActionBar reads it rather than
 *   keeping its own list to drift out of date.
 *
 * ## Icons compose rather than multiply
 *
 * Seventeen unrelated drawings would be seventeen things to learn. Instead a small glyph
 * vocabulary — a house, a deed, a paddle, a speech bubble — carries the *subject*, and a
 * modifier badge carries the *direction*: house + plus is build, house + minus is sell, deed +
 * minus is mortgage, deed + plus is pay it off. Six glyphs and four badges cover the seventeen
 * kinds, and a child who learns "plus means more of it" learns four buttons at once.
 *
 * ## Tone is a reinforcing channel, never the load-bearing one
 *
 * `tone` gives a button its colour role. It is deliberately *not* the signal that an action is
 * dangerous — the class is, and the class drives a confirm step rather than a shade of red,
 * because a shade of red is exactly what a protan player cannot see.
 */

import type { ActionIconName, ModifierIconName } from "./icons";
import type { components } from "../api/generated";

/**
 * Every command the server will accept, straight from the generated contract.
 *
 * Distributing `["kind"]` over the discriminated union in `CommandRequest.command` is what makes
 * this list impossible to get quietly wrong: it is the openapi document's own view of the
 * engine's command set, not a hand-copied echo of it.
 */
export type CommandKind = components["schemas"]["CommandRequest"]["command"]["kind"];

/**
 * The same union as values, for the tests and for anything that must iterate the kinds.
 *
 * `satisfies` rejects an entry that is not a real kind. The `AssertNever` line below rejects the
 * opposite mistake — a kind the contract has and this array does not — at compile time, which is
 * the trick `groups.ts` uses for colour groups and the reason a new engine command cannot land
 * here unthemed.
 */
export const COMMAND_KINDS = [
  "roll_dice",
  "end_turn",
  "buy_property",
  "decline_purchase",
  "place_bid",
  "withdraw_from_auction",
  "build_house",
  "sell_house",
  "mortgage_property",
  "unmortgage_property",
  "propose_trade",
  "respond_to_trade",
  "cancel_trade",
  "pay_jail_fine",
  "use_jail_card",
  "roll_for_jail",
  "declare_bankruptcy",
] as const satisfies readonly CommandKind[];

type AssertNever<T extends never> = T;
/** A compile error here means the contract gained a command kind and `COMMAND_KINDS` did not. */
export type NoUnlistedCommandKind = AssertNever<
  Exclude<CommandKind, (typeof COMMAND_KINDS)[number]>
>;

export type ActionTone = "primary" | "neutral" | "caution" | "danger";
export type ActionClass = "reversible" | "consequential" | "terminal";

export interface ActionTheme {
  /** The subject glyph. */
  readonly icon: ActionIconName;
  /** Optional badge carrying the direction of the action. Omitted, never `undefined`. */
  readonly modifier?: ModifierIconName;
  readonly tone: ActionTone;
  /** How much it costs to be wrong. `terminal` ⇒ a confirm step, see `requiresConfirmation`. */
  readonly class: ActionClass;
}

/**
 * `Record<CommandKind, …>` is the coverage gate: omit a kind and this file does not compile.
 * `actions.test.ts` re-checks the same thing at runtime, because the compile gate disappears the
 * moment somebody widens the key type.
 */
export const ACTION_THEME: Readonly<Record<CommandKind, ActionTheme>> = {
  roll_dice: { icon: "die", tone: "primary", class: "consequential" },
  end_turn: { icon: "cycle", tone: "neutral", class: "consequential" },
  buy_property: { icon: "tag", tone: "primary", class: "consequential" },
  // Terminal: declining sends the tile to auction, where anyone can take it for less.
  decline_purchase: { icon: "tag", modifier: "cross", tone: "caution", class: "terminal" },
  place_bid: { icon: "paddle", tone: "primary", class: "consequential" },
  // Terminal: a withdrawal is final for this lot — there is no re-entry.
  withdraw_from_auction: { icon: "paddle", modifier: "cross", tone: "caution", class: "terminal" },
  build_house: { icon: "house", modifier: "plus", tone: "primary", class: "consequential" },
  sell_house: { icon: "house", modifier: "minus", tone: "caution", class: "consequential" },
  mortgage_property: { icon: "deed", modifier: "minus", tone: "caution", class: "consequential" },
  unmortgage_property: { icon: "deed", modifier: "plus", tone: "primary", class: "consequential" },
  propose_trade: { icon: "swap", tone: "primary", class: "reversible" },
  respond_to_trade: { icon: "bubble", modifier: "check", tone: "primary", class: "consequential" },
  cancel_trade: { icon: "bubble", modifier: "cross", tone: "neutral", class: "reversible" },
  pay_jail_fine: { icon: "coin", tone: "neutral", class: "consequential" },
  use_jail_card: { icon: "card", tone: "primary", class: "consequential" },
  roll_for_jail: { icon: "jailDie", tone: "neutral", class: "consequential" },
  // Terminal in the fullest sense: the player leaves the game.
  declare_bankruptcy: { icon: "flag", tone: "danger", class: "terminal" },
};

/**
 * Does this command need a confirm step with a stated consequence?
 *
 * The single source of truth for MON-405. Note what it is *not*: it is not "is the tone danger".
 * `decline_purchase` is only `caution` in colour and still needs the confirm, because the cost
 * of a mis-tap is losing the tile.
 */
export function requiresConfirmation(kind: CommandKind): boolean {
  return ACTION_THEME[kind].class === "terminal";
}

/** The three terminal kinds, derived rather than restated. */
export const TERMINAL_COMMANDS: ReadonlySet<CommandKind> = new Set(
  COMMAND_KINDS.filter((kind) => ACTION_THEME[kind].class === "terminal"),
);

export interface ToneColors {
  /** Icon and text on a plain card face. Contrast ≥ 4.5:1 against `tile`. */
  readonly ink: string;
  /** A filled button's background. Rimmed with `hairline`, so it is not gated against `tile`. */
  readonly fill: string;
  /** Label on `fill`. Contrast ≥ 4.5:1 against it. */
  readonly onFill: string;
}

export const ACTION_TONE: Readonly<
  Record<"light" | "dark", Readonly<Record<ActionTone, ToneColors>>>
> = {
  light: {
    primary: { ink: "#0a5b39", fill: "#0a5b39", onFill: "#f4fbf6" },
    neutral: { ink: "#3c3a34", fill: "#eae3d4", onFill: "#241f18" },
    caution: { ink: "#79490a", fill: "#f6dca8", onFill: "#2e1c00" },
    danger: { ink: "#98181d", fill: "#f7d3d3", onFill: "#3a0a0a" },
  },
  dark: {
    primary: { ink: "#79d6a4", fill: "#1d6b47", onFill: "#f4fbf6" },
    neutral: { ink: "#e0d8c8", fill: "#4a443b", onFill: "#f8f3e8" },
    caution: { ink: "#f3c76e", fill: "#6a4a12", onFill: "#fff6e2" },
    danger: { ink: "#f5a6a6", fill: "#7d2126", onFill: "#fff0f0" },
  },
};
