/**
 * Which of the legal moves to point at — and *no* knowledge of the rules whatsoever (MON-605).
 *
 * ## The acceptance criterion with teeth
 *
 * This module ranks the list it is given. It never asks whether a command is legal, never compares
 * cash against a price, never counts a colour set, never computes rent, and never looks at
 * `GameState` at all: its entire input is `GameView.legal_commands`, which the engine already
 * decided. Delete the engine and this file cannot invent a single move — there is no code path here
 * that constructs a `Command`.
 *
 * The consequence is that a hint can never be *wrong* in the dangerous sense. It can be poor
 * advice; it cannot suggest something the engine would refuse, because everything it can suggest
 * came out of `legal_commands`.
 *
 * ## What the ordering is about, and what it deliberately is not
 *
 * {@link HINT_ORDER} is a static preference over command **kinds**, read as *which decision is in
 * front of you*, not *which move wins*. That distinction is the whole design:
 *
 * - **Flow first.** A turn cannot start without `roll_dice` and cannot end without `end_turn`, so
 *   those bracket the list. A child who is stuck is nearly always stuck on one of them.
 * - **A waiting table next.** An auction, a trade offer or a jail sentence is the table waiting on
 *   this seat. Those come before anything optional.
 * - **Irreversible last, always.** Every kind `theme/actions.ts` classes `terminal` sorts behind
 *   every kind it does not, so a hint cannot cheerfully highlight "give up" while an ordinary move
 *   is available. `hints.test.ts` asserts that as an invariant over the whole set rather than
 *   spot-checking the three kinds, because the classification lives in the theme and can change.
 *
 * What it is *not* is a strategy. It says nothing about whether a property is worth buying, whether
 * an offer is a good one, or what a bid should be — those are judgements, they would be the bot's
 * territory (MON-601) rather than the UI's, and a hint that quietly played the game for a child
 * would be teaching them nothing.
 *
 * ## Ties keep the engine's order
 *
 * Two commands of one kind — four `build_house`, accept and decline for one `respond_to_trade` —
 * are ranked equal and stay in the order the engine offered them. The sort is stable by explicit
 * index rather than by trusting `Array.prototype.sort`, so "the first one the engine listed" is a
 * statement about the projection and not about a runtime. Nothing here picks *between* two
 * commands of a kind: choosing to accept rather than decline is exactly the judgement above.
 */

import type { Command } from "@/api";
import { ACTION_THEME, requiresConfirmation, type CommandKind } from "@/theme";

/**
 * Command kinds from "the thing you are here to do" to "the thing you do when nothing is left".
 *
 * `satisfies` rejects an entry that is not a real kind; the `AssertNever` below rejects the
 * opposite mistake — a kind the contract has and this list does not — at compile time. The same
 * pairing `COMMAND_KINDS` uses, and the reason a new engine command cannot land here unranked and
 * silently sort last.
 */
export const HINT_ORDER = [
  // --- The turn cannot proceed without these ---
  "roll_dice",
  // --- In jail: the free ways out before the paid one ---
  "use_jail_card",
  "roll_for_jail",
  "pay_jail_fine",
  // --- The table is waiting on this seat ---
  "place_bid",
  "respond_to_trade",
  // --- The decision the square in front of you poses ---
  "buy_property",
  // --- Optional moves that add rather than remove ---
  "build_house",
  "unmortgage_property",
  "propose_trade",
  // --- Done ---
  "end_turn",
  // --- Undoing your own offer: reversible, but nobody is waiting on it ---
  "cancel_trade",
  // --- Raising cash by giving something up ---
  "sell_house",
  "mortgage_property",
  // --- Terminal: every one of these is behind every kind above (see the invariant test) ---
  "decline_purchase",
  "withdraw_from_auction",
  "declare_bankruptcy",
] as const satisfies readonly CommandKind[];

type AssertNever<T extends never> = T;
/** A compile error here means the contract gained a command kind and `HINT_ORDER` did not. */
export type NoUnrankedCommandKind = AssertNever<Exclude<CommandKind, (typeof HINT_ORDER)[number]>>;

/**
 * Where a kind sits in the preference. Lower is nearer the front.
 *
 * Exported for the test that proves the terminal invariant, so that the invariant is checked
 * against the same numbers the sort uses rather than against a re-derivation of them.
 */
export function preferenceOf(kind: CommandKind): number {
  const at = (HINT_ORDER as readonly CommandKind[]).indexOf(kind);
  // Unreachable while `NoUnrankedCommandKind` compiles. A widened key type would make it
  // reachable, and sorting an unknown kind last is the answer that cannot promote it.
  return at === -1 ? HINT_ORDER.length : at;
}

export interface Hint {
  /**
   * The command to point at. Always an element of the array handed in — never a copy and never
   * constructed here, so a caller can compare it by identity against `legal_commands` to decide
   * which chit to mark.
   */
  readonly command: Command;
  /** `hint.reason.<kind>` — why this is the decision on the table. A key, never a sentence. */
  readonly reasonKey: string;
  /**
   * `true` when acting on this needs a confirm step first.
   *
   * The theme's predicate, surfaced so a hint surface can decline to offer a shortcut past the
   * MON-405 confirm dialog. See `HintPanel.tsx`, which offers no button at all for that reason.
   */
  readonly terminal: boolean;
}

/** The catalogue key explaining a kind. Concatenated, like `action.<kind>` — ADR-003 §6. */
export function reasonKeyFor(kind: CommandKind): string {
  return `hint.reason.${kind}`;
}

/**
 * The legal commands, most worth pointing at first.
 *
 * A new array; the input is left untouched, because the caller's copy is `legal_commands` and the
 * action bar renders that one verbatim. A hint that reordered the bar would have turned an
 * explanation into a rule about what to press first.
 */
export function rankCommands(commands: readonly Command[]): readonly Command[] {
  return commands
    .map((command, index) => ({ command, index }))
    .sort(
      (left, right) =>
        preferenceOf(left.command.kind) - preferenceOf(right.command.kind) ||
        left.index - right.index,
    )
    .map((entry) => entry.command);
}

/**
 * The one command to highlight, or `null` when there is nothing to highlight.
 *
 * `null` for an empty list is the whole of the "no legal commands" case: an interrupt frame that
 * belongs to another seat, a finished game, a bot's turn. There is no fallback suggestion, because
 * a suggestion with nothing behind it would be the UI inventing a move.
 */
export function suggest(commands: readonly Command[]): Hint | null {
  const best = rankCommands(commands)[0];
  if (best === undefined) {
    return null;
  }
  return {
    command: best,
    reasonKey: reasonKeyFor(best.kind),
    terminal: requiresConfirmation(best.kind),
  };
}

/** The glyph the suggested command already carries, so the hint and its chit look like one thing. */
export function iconFor(kind: CommandKind): (typeof ACTION_THEME)[CommandKind]["icon"] {
  return ACTION_THEME[kind].icon;
}
