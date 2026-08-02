/**
 * The auto-end-turn decision, and the four ways it must decline.
 *
 * The whole feature is one guard — *send the `end_turn` the engine offered, or send nothing* — so the
 * tests that earn their keep are the ones where sending would be a bug. Each of these is a real
 * defect this would have shipped with a slightly different implementation, and none of them is
 * comfortable to reproduce in a browser:
 *
 * 1. **Doubles.** Buying on doubles leaves the player at `AWAITING_ROLL`, so `end_turn` is not in the
 *    list. An implementation that checked `applied.kind === "buy_property"` and dispatched a
 *    *constructed* `EndTurn` would silently end a turn the rules say continues. This is the test that
 *    would go red for that, and it is why there is no doubles check in the implementation.
 * 2. **A bot's purchase**, which the server already follows with its own `EndTurn` (MON-304).
 * 3. **The same purchase twice**, which is a command racing a command.
 * 4. **The preference switched off.**
 *
 * `autoEndTurn` is pure, which is what lets all four be four assertions rather than four Playwright
 * runs. The identity assertion below is the other half: the command that comes back is an *element of
 * `legalCommands`*, so even with every guard removed this could not send something the engine did not
 * offer.
 */

import { describe, expect, it } from "vitest";

import type { Command, LoggedEvent, PlayerView } from "@/api";
import { loggedEvent, makePlayer } from "@/test/fixtures";

import { autoEndTurn } from "./autoEndTurn";

const HUMANS: readonly PlayerView[] = [
  makePlayer(0, { name: "Ruti" }),
  makePlayer(1, { name: "Dan" }),
];

const END_TURN: Command = { kind: "end_turn", player: 0, elapsed_seconds: null };
const ROLL: Command = { kind: "roll_dice", player: 0 };

/** The log after seat 0 bought a square at list price. */
function boughtBy(player: number, seq = 7): readonly LoggedEvent[] {
  return [
    loggedEvent(seq - 1, { type: "turn_started", player, turn_number: 3 }),
    loggedEvent(seq, {
      type: "property_acquired",
      player,
      tile: 3,
      price: 60,
      via: "purchase",
    }),
  ];
}

function decide(overrides: {
  readonly events?: readonly LoggedEvent[];
  readonly legalCommands?: readonly Command[];
  readonly players?: readonly PlayerView[];
  readonly enabled?: boolean;
  readonly handled?: number | null;
}) {
  return autoEndTurn({
    events: overrides.events ?? boughtBy(0),
    legalCommands: overrides.legalCommands ?? [END_TURN],
    players: overrides.players ?? HUMANS,
    enabled: overrides.enabled ?? true,
    handled: overrides.handled ?? null,
  });
}

describe("after a purchase the engine is willing to end the turn on", () => {
  it("returns the engine's own `end_turn`, by identity", () => {
    const decision = decide({ legalCommands: [ROLL, END_TURN] });
    // Not a structurally equal copy. `toBe` is the assertion that makes "never constructs a command"
    // a fact about this function rather than a claim in its docstring.
    expect(decision?.command).toBe(END_TURN);
  });

  it("reports the purchase's seq, so the caller can record what it acted on", () => {
    expect(decide({ events: boughtBy(0, 42) })?.seq).toBe(42);
  });

  it("acts on the seat that bought, not on whoever `end_turn` happens to name", () => {
    // An `end_turn` offered to another seat is not this purchase's follow-through.
    const someoneElse: Command = { kind: "end_turn", player: 1, elapsed_seconds: null };
    expect(decide({ legalCommands: [someoneElse] })).toBeNull();
  });
});

describe("the doubles position — the case a weakened guard would break", () => {
  it("does nothing when the engine did not offer `end_turn`", () => {
    // `post_move_phase` returns AWAITING_ROLL after a doubles move, so buying on doubles leaves the
    // player owing themselves another roll. The engine says so by *omitting* `end_turn`, and that
    // omission is the entire doubles rule as far as this file is concerned.
    expect(decide({ legalCommands: [ROLL] })).toBeNull();
  });

  it("does nothing when the engine offered nothing at all", () => {
    // An interrupt frame belonging to another seat: an auction, a trade review, a debt. Same guard.
    expect(decide({ legalCommands: [] })).toBeNull();
  });
});

describe("the three other ways it declines", () => {
  it("leaves a bot's purchase alone", () => {
    const withBot = [makePlayer(0, { name: "Robo", is_bot: true }), makePlayer(1, { name: "Dan" })];
    expect(decide({ players: withBot })).toBeNull();
  });

  it("does nothing for a seat the projection does not have", () => {
    expect(decide({ players: [] })).toBeNull();
  });

  it("never acts on one purchase twice", () => {
    expect(decide({ events: boughtBy(0, 7), handled: 7 })).toBeNull();
    // …and not on an older one either, which is what a replay or a refetch from a stale cursor looks
    // like. `<=`, not `!==`.
    expect(decide({ events: boughtBy(0, 5), handled: 7 })).toBeNull();
    // A genuinely newer purchase still fires.
    expect(decide({ events: boughtBy(0, 9), handled: 7 })?.seq).toBe(9);
  });

  it("does nothing when the preference is off", () => {
    expect(decide({ enabled: false })).toBeNull();
  });
});

describe("which acquisitions count", () => {
  it("ignores a square won at auction, traded for, or taken in a bankruptcy", () => {
    for (const via of ["auction", "trade", "bankruptcy"] as const) {
      const events = [
        loggedEvent(4, { type: "property_acquired", player: 0, tile: 3, price: 60, via }),
      ];
      expect(decide({ events }), via).toBeNull();
    }
  });

  it("ignores a log with no purchase in it at all", () => {
    expect(decide({ events: [] })).toBeNull();
    expect(
      decide({ events: [loggedEvent(1, { type: "turn_started", player: 0, turn_number: 1 })] }),
    ).toBeNull();
  });

  it("acts on the newest purchase when a turn produced more than one acquisition", () => {
    const events = [
      loggedEvent(3, { type: "property_acquired", player: 0, tile: 1, price: 60, via: "trade" }),
      loggedEvent(4, {
        type: "property_acquired",
        player: 0,
        tile: 3,
        price: 60,
        via: "purchase",
      }),
      loggedEvent(5, { type: "cash_changed", player: 0, delta: -60, reason: "purchase" }),
    ];
    expect(decide({ events })?.seq).toBe(4);
  });
});
