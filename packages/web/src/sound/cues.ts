/**
 * One event in, at most one cue out. A pure function — no React, no audio, no i18next.
 *
 * The same shape as `a11y/narration.ts`, and for the same reason: the decision "which sound does
 * this event make" is a **presentation table**, and a presentation table is testable to the point
 * of boredom while an `AudioContext` is not. Everything that could be wrong about MON-706 that
 * matters — a dice roll that makes no sound, a mortgage that makes the purchase sound, an event
 * that plays two cues at once — is wrong in this file, where a test can see it.
 *
 * Nothing here decides whether the event happened, reads a figure, or infers a consequence. It
 * looks at `event.type` and, in one case, the sign of a number the event already carries.
 */

import type { GameEvent } from "@/api";

/**
 * The four cues MON-706 asks for.
 *
 * Four, not twenty-four. A game that pings on all twenty-four event types is a game people play
 * with the sound off, which is a more complete failure than shipping no sound at all. These are
 * the four moments a player looks up for: the dice, their money, a square changing hands, and
 * jail.
 */
export const CUES = ["dice", "cash", "purchase", "jail"] as const;

export type CueName = (typeof CUES)[number];

/**
 * Which cue this event makes, or `null` for silence.
 *
 * The mapping, event by event, and the reason for each omission:
 *
 * * `dice_rolled` — the dice, all three purposes. A jail roll is still a roll.
 * * `cash_changed` — money, in either direction. **One cue, not two.** The pitch does not encode
 *   the sign, because "gained" and "paid" are already said out loud by the Announcer and shown in
 *   the log; a second channel guessing at the same fact from a waveform helps nobody, and a rising
 *   versus falling tone is exactly the sort of distinction that does not survive a phone speaker.
 *   A zero delta is silence: `narrate` drops it too, and a cue for nothing happening is a lie.
 * * `rent_charged` is deliberately **absent**. Every rent charge is accompanied by its own
 *   `cash_changed` — that is how the reducer emits it — so cueing both would double every rent
 *   payment. The rule is one sound per thing that happened, not one sound per event.
 * * `property_acquired` — a square changing hands, however it changed: bought, won at auction,
 *   traded, or taken in a bankruptcy. The cue is about the ownership, which is what the board
 *   redraws.
 * * `sent_to_jail` and `left_jail` — jail, in both directions, for the reason above: the direction
 *   is narrated, and the sound is there to make a player look at the board.
 * * Everything else is silent. Building, mortgaging, bidding, trading and the phase machine all
 *   produce plenty of visible feedback, and each one added here is a cue closer to the threshold
 *   where a parent turns the sound off for good.
 */
export function cueFor(event: GameEvent): CueName | null {
  switch (event.type) {
    case "dice_rolled":
      return "dice";

    case "cash_changed":
      return event.delta === 0 ? null : "cash";

    case "property_acquired":
      return "purchase";

    case "sent_to_jail":
    case "left_jail":
      return "jail";

    default:
      return null;
  }
}
