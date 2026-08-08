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
 * ## The estate belongs to the seat in play, and to nobody else (MON-753)
 *
 * MON-726 first answered this by *labelling*: a bot's estate was dropped, and another human's was
 * offered with their name against it ("Dan · Baltic Avenue"), on the reasoning that six people round
 * one screen is the product and taking a human's moves away would remove a rule the engine grants.
 *
 * **Played, that was still confusing** (owner, 2026-08-07): two players each holding a complete group
 * saw both sets of streets, and a name on a row is a weaker signal than the row not being there. So
 * the rule is now the simple one a player already expects from every other board game — **you manage
 * your estate on your turn** — and the label is left to do the job it is still needed for (below).
 *
 * ### What this gives up, stated plainly
 *
 * The engine allows building, selling and mortgaging while waiting for your turn (MON-204,
 * `PORTFOLIO_PHASES`, GAP G-5) and **the screen no longer offers it**. That is a deliberate narrowing
 * of the UI against the rules, taken because on one shared screen the turn comes round in seconds and
 * the cost of the confusion was higher than the cost of waiting. It is the kind of thing that must be
 * written down rather than discovered: nothing is broken, and a player who knows the printed rules is
 * not wrong to expect otherwise.
 *
 * ### Why the seat label survives it
 *
 * Because *turn flow* still reaches seats whose turn it is not, and those are exactly the moments a
 * player needs telling. `legality.py`'s candidates put `place_bid`/`withdraw_from_auction` on the
 * bidder, `declare_bankruptcy` on the debtor, and `respond_to_trade`/`cancel_trade` on the two sides
 * of an offer — none of which need be the current seat, because the interrupt phases exist *for*
 * another actor. {@link actingFor} names those.
 *
 * ## Why this is here and not in `ActionBar`
 *
 * `ActionBar`'s invariant is that it renders `commands` **whole** — no filter, no slice — and that
 * invariant is what makes "the disabled state never lies" free rather than vigilant. It stays exactly
 * true: the bar still renders every command it is handed. What changed is *which set the screen hands
 * it*, and that is a question about whose turn it is rather than about what the rules allow. Keeping
 * the two separate is what lets `ActionBar.test.tsx` go on asserting reachability over the set it is
 * given, and lets this file be the one place the narrowing is stated and tested.
 *
 * **This is a real narrowing of what the screen offers, and it is deliberate** (owner decisions,
 * 2026-08-06 and 2026-08-07). It is bounded so that it cannot become a rule: only the `portfolio`
 * zone is ever touched. Turn flow is never filtered — so no value of `players` or `currentPlayerId`
 * can strand a game by hiding the move it is waiting on.
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
 * The legal set, minus every estate move that is not the seat-in-play's own.
 *
 * Order is preserved and nothing else is touched: this is a `filter`, so relative order within the
 * result is the engine's, which is what `ActionBar`'s zoning then re-groups.
 *
 * **Turn flow is never dropped**, whoever it belongs to. A bidder, a debtor and a trade recipient are
 * all seats the engine is waiting on *without* it being their turn (the interrupt phases exist for
 * exactly that), and a bot's `roll_dice` should not reach a resting view at all — the driver advances
 * every bot the engine is waiting on before the response is built — but "should not" is not "cannot".
 * The asymmetry is the argument: hiding an estate move costs a player a convenience, and hiding the
 * move the game is waiting on costs them the game.
 */
export function movesAtThisScreen(
  commands: readonly Command[],
  players: readonly PlayerView[],
  currentPlayerId: number,
): readonly Command[] {
  const seatInPlay = players.find((player) => player.id === currentPlayerId);
  // Nobody's estate is offered when the seat in play is a bot or unknown: it is not a human's turn,
  // so there is no human whose estate this could be. `undefined` is unreachable while the projection
  // is well-formed, and answering "nothing" is the safe way to be wrong.
  const offersEstate = seatInPlay !== undefined && !isBot(seatInPlay);
  return commands.filter(
    (command) =>
      zoneOf(command.kind) !== "portfolio" || (offersEstate && command.player === currentPlayerId),
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
