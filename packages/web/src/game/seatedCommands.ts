/**
 * Which of the engine's legal moves belong to the people at *this* screen, and whose each one is.
 *
 * ## The defect
 *
 * `legal_commands` answers for **every seat that may act**, not for the seat being waited on. That is
 * MON-204 and it is a real rule rather than an oversight: the estate is open in any portfolio phase,
 * so a player may build, sell, mortgage and redeem while waiting for their turn (`phases.py` on
 * `PORTFOLIO_PHASES`, GAP G-5). The action bar renders what it is given, so on seat 0's turn a game
 * where seat 1 also holds a complete group put this on screen:
 *
 * ```
 * [🏠+ Build a house]  Mediterranean Avenue     ← seat 0's
 * [🏠+ Build a house]  Baltic Avenue            ← seat 1's, and nothing said so
 * [🏠+ Build a house]  Oriental Avenue          ← seat 1's, and nothing said so
 * ```
 *
 * Three identical chits, two of which spend somebody else's money. It was survivable while builds
 * collapsed behind one affordance; MON-724 flattened them, which made it three rows of trap.
 *
 * ## Two answers, because there are two different questions
 *
 * **A bot's estate is not offered.** A bot seat plays its own portfolio — `bots.py` drives it for
 * whichever seat the engine is waiting on — so a chit that builds for it is a move no human would
 * ever mean to press. {@link movesAtThisScreen} drops those.
 *
 * **A human's estate is offered, and says whose it is.** Six people round one screen is the product
 * (`CLAUDE.md`: "any mix of six seats, all on one screen"), so taking another human's moves away
 * would remove a rule the engine deliberately grants. {@link actingFor} names the seat instead.
 *
 * ## Why this is here and not in `ActionBar`
 *
 * `ActionBar`'s invariant is that it renders `commands` **whole** — no filter, no slice — and that
 * invariant is what makes "the disabled state never lies" free rather than vigilant. It stays exactly
 * true: the bar still renders every command it is handed. What changed is *which set the screen hands
 * it*, and that is a question about who is holding the mouse rather than about what the rules allow.
 * Keeping the two separate is what lets `ActionBar.test.tsx` go on asserting reachability over the set
 * it is given, and lets this file be the one place the narrowing is stated and tested.
 *
 * **This is a real narrowing of what the screen offers, and it is deliberate** (owner decision,
 * 2026-08-06). It is bounded in two ways that keep it from becoming a rule: only the `portfolio`
 * zone is touched, and only for seats the projection says are bots. Turn flow is never filtered — so
 * no value of `players` can strand a game by hiding the move it is waiting on.
 */

import type { Command, PlayerView } from "@/api";
import { zoneOf } from "@/theme";

/**
 * Whether a seat is played by the machine — **read, not worked out**.
 *
 * `PlayerView.is_bot` is one of the derived facts the projection ships precisely so a client does not
 * re-derive it (`schemas.py`: "the four derived facts the dossier would otherwise re-derive"). The
 * tempting alternative, `player.kind.bot_level !== null`, is the *engine's* rule about what makes a
 * seat a bot — true today, and a second place for it to live. `PlayerDossier` is the file whose
 * docstring opens "not one number on this card is computed"; this is the same principle one field
 * over.
 *
 * A named function rather than an inline field read because the *reason* is worth keeping next to the
 * use, and because it is the one place to change if a seat ever becomes something other than the two.
 */
export function isBot(player: PlayerView): boolean {
  return player.is_bot;
}

/**
 * The legal set, minus the estate moves of seats nobody at this screen plays.
 *
 * Order is preserved and nothing else is touched: this is a `filter`, so relative order within the
 * result is the engine's, which is what `ActionBar`'s zoning then re-groups.
 *
 * **Turn flow is never dropped**, whoever it belongs to. A bot's `roll_dice` should not reach a
 * resting view at all — the driver advances every bot the engine is waiting on before the response is
 * built — but "should not" is not "cannot", and the failure mode of guessing wrong here would be a
 * game with no way to advance it. Hiding an estate move costs a player a convenience; hiding the move
 * the game is waiting on costs them the game.
 */
export function movesAtThisScreen(
  commands: readonly Command[],
  players: readonly PlayerView[],
): readonly Command[] {
  const bots = new Set(players.filter(isBot).map((player) => player.id));
  if (bots.size === 0) {
    // Identity, not a copy: an all-human table is the common case and `useMemo` downstream compares
    // by reference. A fresh array every render would rebuild the bar's chits on every frame.
    return commands;
  }
  return commands.filter(
    (command) => !(bots.has(command.player) && zoneOf(command.kind) === "portfolio"),
  );
}

/**
 * A resolver naming the seat a command acts for, or `undefined` when it acts for the current one.
 *
 * The current player's own moves are left unlabelled deliberately. Labelling everything would put a
 * name on "Roll the dice" — which is whose turn it is, already said by `TurnBanner` in larger type at
 * the top of the screen — and a label that is on every row is a label nobody reads. So the mark means
 * one thing only: **this one is not for the seat being waited on**.
 *
 * `currentPlayerId` is a projected field read to decide how to draw, which is presentation in the
 * sense `game/presentation.ts` sets out. It cannot decide what may be *sent*: the return value is a
 * string that reaches a `<span>`.
 *
 * An unknown seat answers `undefined` rather than an id. A number in that slot would read as part of
 * the square's name, and the projection always carries every seat — so this is the unreachable branch
 * being quiet rather than a case worth reporting.
 */
export function actingFor(
  players: readonly PlayerView[],
  currentPlayerId: number,
): (command: Command) => string | undefined {
  const names = new Map(players.map((player) => [player.id, player.name]));
  return (command) => (command.player === currentPlayerId ? undefined : names.get(command.player));
}
