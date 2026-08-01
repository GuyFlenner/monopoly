/**
 * The queue, driven by a clock that is just a number.
 *
 * ## The falsifiers
 *
 * The two claims MON-701 makes that are easy to satisfy wrongly are both about *not* computing
 * things, so both are tested by making the projection and the queue disagree and asserting the queue
 * shuts up:
 *
 * - **"Skipping mid-flight lands the piece at its true position."** An implementation that worked out
 *   the destination and reported it would pass a test whose fixture agrees with the projection. So
 *   the test below skips a walk to square 12 and asserts the queue reports **no position at all** —
 *   because reporting 12 is reporting a figure this package derived, and the day the engine disagrees
 *   with that derivation the board would draw the wrong square with total confidence.
 * - **"An idle queue draws the truth."** Same shape: once a timeline drains, `tokens` is empty rather
 *   than holding the last square it computed.
 *
 * The rest is arithmetic on a clock, which is exactly why the clock is an argument.
 */

import { describe, expect, it } from "vitest";

import { MotionQueue, STILL } from "./queue";
import { DEFAULT_DURATIONS, type TimelineStep } from "./timeline";

function move(
  player: number,
  path: readonly number[],
  durationMs = DEFAULT_DURATIONS.perTileMs * path.length,
  seq = 1,
): TimelineStep {
  return {
    kind: "token_move",
    id: `${String(seq)}:token`,
    seq,
    player,
    from: 0,
    path,
    durationMs,
  };
}

function dice(seq = 1, durationMs = DEFAULT_DURATIONS.diceMs): TimelineStep {
  return { kind: "dice_settle", id: `${String(seq)}:dice`, seq, player: 1, durationMs };
}

function pulse(player: number, seq = 1, durationMs = DEFAULT_DURATIONS.cashMs): TimelineStep {
  return { kind: "cash_pulse", id: `${String(seq)}:cash`, seq, player, delta: -50, durationMs };
}

function pop(tile: number, seq = 1, durationMs = DEFAULT_DURATIONS.buildingMs): TimelineStep {
  return { kind: "building_pop", id: `${String(seq)}:building`, seq, tile, houses: 1, durationMs };
}

describe("a queue with nothing in it", () => {
  it("is idle and overrides nothing", () => {
    const queue = new MotionQueue();
    expect(queue.idle).toBe(true);
    expect(queue.frame).toEqual(STILL);
    expect(queue.nextWakeMs(0)).toBeNull();
  });
});

describe("a piece waiting its turn to move", () => {
  it("is held at the origin of its pending move rather than left to the projection", () => {
    // The projection is committed before its events reach the feed, so `player.position` is already
    // the destination by the time a timeline arrives. A piece with no override is drawn from the
    // projection — so without this the board teleported to the destination during the dice settle and
    // then snapped back to walk the squares it had visibly skipped.
    const queue = new MotionQueue();
    queue.push([dice(1), move(2, [1, 2, 3], 300, 2)], 0);

    expect(queue.frame.tokens.get(2)).toBe(0);
    queue.advance(DEFAULT_DURATIONS.diceMs);
    expect(queue.frame.tokens.get(2)).toBe(1);
  });

  it("does not overwrite a walk already in flight with a later step's origin", () => {
    const queue = new MotionQueue();
    queue.push([move(1, [1, 2, 3, 4], 400, 1)], 0);
    queue.advance(250);
    expect(queue.frame.tokens.get(1)).toBe(3);

    queue.push([move(1, [8, 9], 200, 2)], 250);
    expect(queue.frame.tokens.get(1)).toBe(3);
  });
});

describe("a piece travelling", () => {
  it("is drawn on one square per slice of the walk", () => {
    const queue = new MotionQueue();
    queue.push([move(1, [1, 2, 3, 4], 400)], 0);

    expect(queue.frame.tokens.get(1)).toBe(1);
    queue.advance(150);
    expect(queue.frame.tokens.get(1)).toBe(2);
    queue.advance(250);
    expect(queue.frame.tokens.get(1)).toBe(3);
    queue.advance(399);
    expect(queue.frame.tokens.get(1)).toBe(4);
  });

  it("wakes at the next square boundary rather than every frame", () => {
    const queue = new MotionQueue();
    queue.push([move(1, [1, 2, 3, 4], 400)], 0);
    expect(queue.nextWakeMs(0)).toBe(100);
    expect(queue.nextWakeMs(30)).toBe(70);
    expect(queue.nextWakeMs(120)).toBe(80);
  });

  it("reports nothing at all once the timeline drains, so the board reads the projection", () => {
    const queue = new MotionQueue();
    queue.push([move(1, [1, 2, 3], 300)], 0);
    queue.advance(300);

    expect(queue.idle).toBe(true);
    // Not `3`. See the module docstring: a position this class reported would be a position this
    // package derived, and the projection is the one the server sent.
    expect(queue.frame.tokens.size).toBe(0);
    expect(queue.frame.remaining).toBe(0);
  });

  it("holds the destination while later steps in the same timeline are still playing", () => {
    // Between two beats the piece must stay where its walk ended, not snap forward to the truth: the
    // truth is the *final* state of everything in the batch, and a leg that finished has not yet
    // been followed by the one that moves the piece again.
    const queue = new MotionQueue();
    queue.push([move(1, [1, 2], 200, 1), pulse(1, 2, 400)], 0);
    queue.advance(250);

    expect(queue.frame.tokens.get(1)).toBe(2);
    expect(queue.frame.remaining).toBe(1);
  });
});

describe("beats", () => {
  it("bumps a beat when its step starts, once per step", () => {
    const queue = new MotionQueue();
    queue.push([dice(1), dice(2), pulse(4, 3), pop(6, 4)], 0);

    expect(queue.frame.dice).toBe(1);
    queue.advance(DEFAULT_DURATIONS.diceMs);
    expect(queue.frame.dice).toBe(2);
    queue.advance(10_000);
    expect(queue.frame.cash.get(4)).toBe(1);
    expect(queue.frame.buildings.get(6)).toBe(1);
  });

  it("never resets a beat, so going idle cannot replay an old flourish", () => {
    const queue = new MotionQueue();
    queue.push([pulse(1)], 0);
    queue.advance(10_000);
    expect(queue.idle).toBe(true);
    expect(queue.frame.cash.get(1)).toBe(1);
  });

  it("counts beats per subject rather than globally", () => {
    const queue = new MotionQueue();
    queue.push([pulse(1, 1), pulse(2, 2), pulse(1, 3)], 0);
    queue.advance(10_000);
    expect(queue.frame.cash.get(1)).toBe(2);
    expect(queue.frame.cash.get(2)).toBe(1);
  });
});

describe("skipping", () => {
  it("drops everything mid-flight and reports no position, rather than a computed destination", () => {
    const queue = new MotionQueue();
    queue.push([move(1, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 1200)], 0);
    queue.advance(300);
    expect(queue.frame.tokens.get(1)).toBe(4);

    queue.skip();

    expect(queue.idle).toBe(true);
    expect(queue.frame.tokens.size).toBe(0);
    expect(queue.nextWakeMs(300)).toBeNull();
  });

  it("fires no pending beats, so catching up is quieter rather than louder", () => {
    // "Apply every remaining step at once" is the tempting implementation and it is wrong: a dozen
    // simultaneous pulses is a noisier screen than the one the player asked to quieten.
    const queue = new MotionQueue();
    queue.push([move(1, [1], 100, 1), pulse(2, 2), pulse(3, 3), pop(9, 4)], 0);
    queue.skip();

    expect(queue.frame.cash.size).toBe(0);
    expect(queue.frame.buildings.size).toBe(0);
  });

  it("is safe when nothing is moving", () => {
    const queue = new MotionQueue();
    queue.skip();
    queue.skip();
    expect(queue.frame).toEqual(STILL);
  });
});

describe("zero durations", () => {
  it("drains the whole timeline in one advance and leaves the truth showing", () => {
    const queue = new MotionQueue();
    queue.push([move(1, [1, 2, 3], 0), dice(2, 0), pulse(1, 3, 0), pop(4, 4, 0)], 0);

    expect(queue.idle).toBe(true);
    expect(queue.frame.tokens.size).toBe(0);
    // The beats still fired: reduced motion means "do not take time", not "do not tell me".
    expect(queue.frame.dice).toBe(1);
    expect(queue.frame.cash.get(1)).toBe(1);
    expect(queue.frame.buildings.get(4)).toBe(1);
  });
});

describe("a clock that jumped", () => {
  it("drains the backlog in one advance rather than restarting each step from the jump", () => {
    // A backgrounded tab whose timers were throttled, or a machine that slept. The first version of
    // this class started each step at the moment it happened to be noticed, so a jump replayed the
    // whole remaining timeline at full length from the jump — the backlog stretched instead of
    // draining, and the longer the board was ignored the further behind it fell. Overrun carries
    // forward now.
    const queue = new MotionQueue();
    queue.push([dice(1), pulse(1, 2), pop(4, 3)], 0);
    queue.advance(60_000);

    expect(queue.idle).toBe(true);
    expect(queue.frame.dice).toBe(1);
    expect(queue.frame.cash.get(1)).toBe(1);
    expect(queue.frame.buildings.get(4)).toBe(1);
  });

  it("starts a batch that arrives after the queue drained at the time it arrived", () => {
    const queue = new MotionQueue();
    queue.push([dice(1)], 0);
    queue.advance(1000);
    expect(queue.idle).toBe(true);

    queue.push([move(1, [1, 2], 200, 2)], 5000);
    expect(queue.frame.tokens.get(1)).toBe(1);
    queue.advance(5150);
    expect(queue.frame.tokens.get(1)).toBe(2);
  });
});

describe("events outpacing playback", () => {
  it("compresses the backlog when a second batch arrives on top of a first", () => {
    // The reconnect case: the socket delivers one frame per message, so `plan` sizes each batch
    // against the budget without ever seeing the pressure. Only the queue can.
    const queue = new MotionQueue({ budgetMs: 500 });
    for (let seq = 1; seq <= 8; seq += 1) {
      queue.push([move(seq, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 900, seq)], 0);
    }

    // Every walk collapsed to its destination, so the whole backlog is one beat per leg.
    expect(queue.frame.tokens.get(1)).toBe(10);
    expect(queue.remaining).toBeLessThanOrEqual(8);
    queue.advance(10_000);
    expect(queue.idle).toBe(true);
  });

  it("appends rather than replacing, because two batches are two things that happened", () => {
    const queue = new MotionQueue();
    queue.push([pulse(1, 1)], 0);
    queue.push([pulse(2, 2)], 0);
    expect(queue.remaining).toBe(2);
  });
});
