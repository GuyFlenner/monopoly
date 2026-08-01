/**
 * The cue table (MON-706).
 *
 * This is where every defect in the sound feature that a player would notice lives, which is why
 * it is a pure function: an event that makes no sound, an event that makes the wrong one, and — the
 * one worth the most care — an event that makes two, because the reducer emits `rent_charged` and
 * `cash_changed` for one rent payment and cueing both would double every rent in the game.
 *
 * Nothing here asserts on audio. See `audioPort.ts` for why that is a rule and not a shortcut.
 */

import { describe, expect, it } from "vitest";

import type { GameEvent, GameEventType } from "@/api";

import { cueFor, CUES } from "./cues";

/**
 * An event of a given type, with just enough fields to satisfy the union.
 *
 * The cast is confined to this helper: `cueFor` reads `type` and, for `cash_changed`, `delta`, so a
 * fixture carrying the other fifteen fields of a `TokenMoved` would be fifteen fields of noise. A
 * *renamed* tag is still caught — `GameEventType` is read off `generated.ts`, so the parameter type
 * is the contract's own list.
 */
function event(type: GameEventType, fields: Record<string, unknown> = {}): GameEvent {
  return { type, ...fields } as unknown as GameEvent;
}

describe("cueFor", () => {
  it("cues the dice on every roll, whatever it was for", () => {
    // All three purposes. A jail roll is still a roll, and a player waiting to see whether they got
    // out is exactly the player who looked away from the screen.
    for (const purpose of ["move", "jail", "rent"]) {
      expect(cueFor(event("dice_rolled", { purpose }))).toBe("dice");
    }
  });

  it("cues money in either direction, with one sound", () => {
    expect(cueFor(event("cash_changed", { delta: 200 }))).toBe("cash");
    expect(cueFor(event("cash_changed", { delta: -50 }))).toBe("cash");
  });

  it("is silent on a zero delta", () => {
    // `narrate` drops it too. A cue for nothing having happened is a lie told with a speaker.
    expect(cueFor(event("cash_changed", { delta: 0 }))).toBeNull();
  });

  it("cues a square changing hands, however it changed", () => {
    for (const via of ["purchase", "auction", "trade", "bankruptcy"]) {
      expect(cueFor(event("property_acquired", { via }))).toBe("purchase");
    }
  });

  it("cues jail in both directions, and by every route into and out of it", () => {
    for (const via of ["tile", "card", "three_doubles"]) {
      expect(cueFor(event("sent_to_jail", { via }))).toBe("jail");
    }
    for (const via of ["fine", "card", "doubles", "time_served"]) {
      expect(cueFor(event("left_jail", { via }))).toBe("jail");
    }
  });

  it("does not cue rent, because its own cash_changed already does", () => {
    // The regression this guards: adding `rent_charged` here looks like an improvement and doubles
    // the sound on the single most common payment in the game. One sound per *thing that happened*,
    // not one per event.
    expect(cueFor(event("rent_charged", { amount: 24 }))).toBeNull();
  });

  it("is silent on everything else", () => {
    // Named exhaustively rather than sampled: this list is the *decision*, and a new event type
    // quietly acquiring a cue is what turns four cues into twenty-four.
    const silent: readonly GameEventType[] = [
      "turn_started",
      "token_moved",
      "phase_changed",
      "building_changed",
      "mortgage_changed",
      "auction_started",
      "bid_placed",
      "bidder_withdrew",
      "auction_ended",
      "card_drawn",
      "trade_proposed",
      "trade_executed",
      "trade_declined",
      "trade_cancelled",
      "debt_incurred",
      "debt_settled",
      "player_bankrupted",
      "game_ended",
    ];
    for (const type of silent) {
      expect(cueFor(event(type)), type).toBeNull();
    }
  });

  it("never returns a name the port has no score for", () => {
    // Every cue `cueFor` can produce has to be playable. Asserted over the *declared* list because a
    // fifth cue added to `CUES` without a score would be a silent event that looks handled.
    const produced = new Set(
      (["dice_rolled", "cash_changed", "property_acquired", "sent_to_jail", "left_jail"] as const)
        .map((type) => cueFor(event(type, { delta: 1 })))
        .filter((cue) => cue !== null),
    );
    expect([...produced].every((cue) => CUES.includes(cue))).toBe(true);
    expect(produced.size).toBe(CUES.length);
  });
});
