/**
 * Ending a turn the player has finished with — one pure decision, and one effect that obeys it.
 *
 * Owner request: *"When a player buys a property, automatically click 'finish turn' so the next
 * player can roll the dice immediately."* Buying is the last thing anybody does on a turn, so the
 * `end_turn` press after it is a click that carries no decision, and a click that carries no decision
 * is a click a six-year-old is being asked to find.
 *
 * **Declining is the same request from the other side** (owner, 2026-08-04): *"if I chose not to
 * purchase, end the turn; the next click should be the next player rolling."* It arrives by a different
 * route because a decline emits no events — see {@link endTurnAfterDecline}, which explains why that
 * makes the log-based trigger below unusable *and* makes acting immediately safe.
 *
 * ## The whole rule, and why it is only one line
 *
 * **Send `EndTurn` only if `end_turn` is in the `legal_commands` the engine has just returned — and
 * send the object out of that list, never a new one.**
 *
 * That single guard is doing a surprising amount of work, and a future reader must not "helpfully"
 * add to it:
 *
 * - **Doubles.** `post_move_phase` (`rules/common.py`) returns `AWAITING_ROLL` when the move roll was
 *   doubles, and `EndTurn`'s gate is `_current_player_gate(state, player, AWAITING_END_TURN)`. So
 *   after buying on doubles, `end_turn` is simply *not in the list*, and this does nothing — the
 *   player rolls again, which is the rule. **Do not add a doubles check.** One would be a copy of a
 *   rule, it would be the copy that is wrong, and it would be wrong silently.
 * - **Interrupts.** An auction, a trade review or a debt settlement is a phase in which `end_turn` is
 *   not offered either. Same guard, no extra code.
 * - **Jail.** Same again.
 *
 * The guard is not a legality *judgement*, it is a **lookup in the engine's own answer**, which is the
 * same thing `ActionBar` does when it draws a button. Nothing here compares cash to a price, reads a
 * phase, or counts anything. Delete the engine and this file cannot produce a command: `find` returns
 * `undefined` and the answer is `null`.
 *
 * ## Nothing is lost by ending early
 *
 * Building, selling, mortgaging, redeeming and proposing a trade are legal for **any solvent player
 * in any portfolio phase** — including the *next* player's `AWAITING_ROLL` (`PORTFOLIO_PHASES`, and
 * the MON-204 decision that portfolio actions wait for a quiet phase rather than for your turn). So
 * ending the turn does not close the player's estate window; it hands the dice on while leaving the
 * window open. That is also why the action bar's estate zone is not a thing you have to hurry
 * through — see `docs/UX_ACTION_PROMINENCE.md` §6.
 *
 * ## Why the *event log* is the trigger and not the mutation's promise
 *
 * The obvious implementation — `await send(buy); send(endTurn)` — makes the purchase imperceptible.
 * `useGame` hands a view's events to the animation queue from an **effect**, so two `setQueryData`
 * calls in quick succession can commit with only the second view's events ever reaching the queue:
 * the purchase's own beat, cue and sentence would be dropped on the floor.
 *
 * Reacting to the committed log instead makes perceptibility structural rather than a matter of
 * timing. By the time a `property_acquired` event is *in* `events`, the queue has it, which means the
 * board's pop is scheduled, `useSoundCues` has played the purchase cue and `useEventNarration` has
 * queued the sentence — those three read the same feed this does. No `setTimeout`, no frame counting,
 * and nothing to get wrong on a slow machine.
 *
 * `via: "purchase"` narrows it to a buy at list price. Winning an auction, receiving a square in a
 * trade and inheriting one in a bankruptcy all raise `property_acquired` too, and none of them is
 * "the player has finished their turn".
 */

import { useEffect, useRef } from "react";

import type { Command, LoggedEvent, PlayerView } from "@/api";

/** One frame's worth of what the decision needs. Every field is read from the projection. */
export interface AutoEndTurnInput {
  /** The de-duplicated event log, oldest first — `useGame().events`. */
  readonly events: readonly LoggedEvent[];
  /** `legal_commands` from the same view. The only source of the command that gets sent. */
  readonly legalCommands: readonly Command[];
  /** `state.players` from the same view, for `is_bot` on the seat that bought. */
  readonly players: readonly PlayerView[];
  /** The player's preference, already resolved. `false` means never. */
  readonly enabled: boolean;
  /** The `seq` of the newest purchase already acted on, or `null`. What makes this idempotent. */
  readonly handled: number | null;
}

export interface AutoEndTurn {
  /**
   * The `end_turn` to send.
   *
   * An **element of `legalCommands`**, returned by identity. Never constructed, so this cannot send a
   * command the engine did not offer even if every other guard here were removed.
   */
  readonly command: Command;
  /** The purchase's `seq`, so the caller can record what it has acted on. */
  readonly seq: number;
}

/** The newest list-price purchase in the log, or `null`. */
function newestPurchase(
  events: readonly LoggedEvent[],
): { readonly seq: number; readonly player: number } | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const logged = events[index];
    if (logged === undefined) {
      continue;
    }
    const { event } = logged;
    if (event.type === "property_acquired" && event.via === "purchase") {
      return { seq: logged.seq, player: event.player };
    }
  }
  return null;
}

/**
 * The `end_turn` to send after a purchase, or `null` — the whole decision, as a pure function.
 *
 * Pure so that every branch is a unit test rather than a Playwright run: the doubles position (no
 * `end_turn` in the list), a bot's purchase, a purchase already acted on, the preference switched
 * off. Those four are the ones that would each be a bug in production and none of which is
 * comfortable to reproduce in a browser.
 */
export function autoEndTurn(input: AutoEndTurnInput): AutoEndTurn | null {
  if (!input.enabled) {
    return null;
  }

  const purchase = newestPurchase(input.events);
  if (purchase === null) {
    return null;
  }
  // Idempotence. `<=` rather than `!==` so a log that shrinks — a replay, a reconnect that refetched
  // from an older cursor — cannot re-fire an advance that has already happened.
  if (input.handled !== null && purchase.seq <= input.handled) {
    return null;
  }

  /*
    Bots are driven server-side (MON-304), so a bot's purchase is followed by the server's own
    `EndTurn` and a second one from here would be a command racing a command. `undefined` — a seat the
    projection does not have — is treated as "not ours to advance" for the same reason a missing tile
    name falls back rather than throwing: the cautious branch is the one that does nothing.
  */
  const buyer = input.players.find((player) => player.id === purchase.player);
  if (buyer === undefined || buyer.is_bot) {
    return null;
  }

  /*
    The one guard, and the only place a command comes from. Matching `player` as well as `kind` is free
    and narrows this to "the seat that just bought is the seat now able to end" — an `end_turn` offered
    to somebody else is not this purchase's follow-through.
  */
  const endTurn = input.legalCommands.find(
    (command) => command.kind === "end_turn" && command.player === purchase.player,
  );
  if (endTurn === undefined) {
    return null;
  }

  return { command: endTurn, seq: purchase.seq };
}

/**
 * The `end_turn` to send after a *declined* purchase, or `null` (owner request, 2026-08-04).
 *
 * The same request as the purchase one — *"if I chose not to purchase, end the turn; the next click
 * should be the next player rolling"* — and it needs a different mechanism, for a reason worth stating
 * because it looks like an inconsistency:
 *
 * **A decline produces no events.** With auctions off, `rules/purchase.py::_decline` returns
 * `(state, ())` — the state unchanged and the log untouched. So the committed-log trigger the purchase
 * path uses cannot see a decline *at all*; there is nothing to wait for. The other half of that same
 * fact is what makes acting immediately safe here: the perceptibility argument in this module's header
 * is about not dropping the purchase's own beat, cue and sentence, and a decline has none of the three
 * to drop.
 *
 * So this reads the **response** to the decline — the view the engine returned — and asks it the same
 * question the other path asks: is `end_turn` in the list, for this player? That keeps the one rule
 * this module has: *the command is an element of `legal_commands`, never one we constructed.*
 *
 * ## What it does not need to check, and must not start checking
 *
 * - **Auctions.** Declining with auctions *on* opens an auction, and during an auction interrupt
 *   `end_turn` is not offered — so the lookup fails and this returns `null` on its own. Do not add an
 *   `auctions_enabled` check: it would be a copy of a rule, and the copy is the one that goes stale.
 * - **Doubles.** Same as the purchase path: `post_move_phase` decides, and after doubles `end_turn` is
 *   simply not in the list.
 * - **Whose turn it is.** The `player` match does that, and it is why a decline by one seat cannot end
 *   another's turn.
 */
export function endTurnAfterDecline(
  declined: Command,
  view: { readonly legal_commands: readonly Command[] },
  enabled: boolean,
): Command | null {
  if (!enabled || declined.kind !== "decline_purchase") {
    return null;
  }
  return (
    view.legal_commands.find(
      (command) => command.kind === "end_turn" && command.player === declined.player,
    ) ?? null
  );
}

export interface UseAutoEndTurnOptions extends Omit<AutoEndTurnInput, "handled"> {
  /** `status.isSending`. A command is in flight; nothing is dispatched over the top of one. */
  readonly sending: boolean;
  /** Where the command goes. `useGame().send`, by way of the screen's own `dispatch`. */
  readonly send: (command: Command) => void;
}

/**
 * Watch the committed log and end the turn once, per purchase, when the engine says it may be ended.
 *
 * The `handled` cursor is a ref and is written **before** the send, which is what makes a re-run of
 * this effect — and there are several, since `sending` flips twice per command — unable to dispatch a
 * second time for one purchase.
 *
 * Nothing here blocks: the effect posts and returns, and the action bar has already rendered whatever
 * the engine offered. A player who wants to act during the hand-off can.
 */
export function useAutoEndTurn({
  events,
  legalCommands,
  players,
  enabled,
  sending,
  send,
}: UseAutoEndTurnOptions): void {
  const handled = useRef<number | null>(null);

  useEffect(() => {
    if (sending) {
      return;
    }
    const decision = autoEndTurn({
      events,
      legalCommands,
      players,
      enabled,
      handled: handled.current,
    });
    if (decision === null) {
      return;
    }
    handled.current = decision.seq;
    send(decision.command);
  }, [events, legalCommands, players, enabled, sending, send]);
}
