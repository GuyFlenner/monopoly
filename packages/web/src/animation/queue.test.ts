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

/**
 * A budget no fixture in this file can exceed, for the tests that need every beat they pushed.
 *
 * Named rather than inlined so the reason is in one place: the compression ladder is a *feature* and
 * several tests below exercise it deliberately, so the ones that must not compress have to say which
 * they are. Derived from the card dwell, which is the longest beat there is and the one that moved
 * (MON-719) — a literal would go stale the next time it does.
 */
const ROOMY_BUDGET_MS = DEFAULT_DURATIONS.cardMs * 10;

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

function card(
  cardId = "card.chance.advance_to_go",
  seq = 1,
  extras: { readonly delta?: number | null; readonly durationMs?: number } = {},
): TimelineStep {
  return {
    kind: "card_reveal",
    id: `${String(seq)}:card`,
    seq,
    player: 1,
    deck: "chance",
    cardId,
    delta: extras.delta ?? null,
    balance: extras.delta === undefined || extras.delta === null ? null : 1500 + extras.delta,
    durationMs: extras.durationMs ?? DEFAULT_DURATIONS.cardMs,
  };
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

/**
 * The card is the one thing in a frame that is content rather than a counter (MON-709), so it is the
 * one thing that must come back *off* the frame. The falsifiers: a card left up after its beat is
 * this class asserting a fact the projection does not carry — `GameStateView` has no "card showing"
 * — and an idle queue that still names a card is the idle contract broken for the only field where
 * breaking it is visible to a player.
 */
describe("the card on the board", () => {
  it("goes up when its beat starts, carrying only what the step carried", () => {
    const queue = new MotionQueue();
    queue.push([card("card.chest.doctors_fee", 1, { delta: -50 })], 0);

    expect(queue.frame.card?.cardId).toBe("card.chest.doctors_fee");
    expect(queue.frame.card?.delta).toBe(-50);
    expect(queue.frame.card?.balance).toBe(1450);
    expect(queue.frame.card?.nonce).toBe(1);
  });

  it("comes down when its beat ends, and the queue is idle with no card", () => {
    const queue = new MotionQueue();
    queue.push([card()], 0);
    queue.advance(DEFAULT_DURATIONS.cardMs);

    expect(queue.idle).toBe(true);
    expect(queue.frame.card).toBeNull();
  });

  it("comes down when the player catches up, in the same gesture as the rest", () => {
    const queue = new MotionQueue();
    queue.push([card()], 0);
    queue.advance(100);
    expect(queue.frame.card).not.toBeNull();

    queue.skip();

    expect(queue.frame.card).toBeNull();
    expect(queue.frame).toEqual(STILL);
  });

  it("counts a fresh beat for the same card drawn twice, so two draws read as two", () => {
    // A budget wide enough to hold both cards, stated rather than inherited. Two cards at the default
    // dwell are ten seconds, which the compression ladder is *right* to shorten (MON-719 raised the
    // dwell to 5 s) — and a compressed batch drops the superseded card, which is the behaviour under
    // test in `drops the card a later draw replaced` below rather than here.
    const queue = new MotionQueue({ budgetMs: ROOMY_BUDGET_MS });
    queue.push([card("card.chance.go_to_jail", 1), card("card.chance.go_to_jail", 2)], 0);
    const first = queue.frame.card?.nonce;
    queue.advance(DEFAULT_DURATIONS.cardMs);

    expect(first).toBe(1);
    expect(queue.frame.card?.nonce).toBe(2);
  });

  it("comes down while the rest of the timeline is still playing", () => {
    // The clear that the drain would otherwise hide. A card is up for *its beat*, not until the
    // batch happens to run out: leave it and the payment that follows a card plays underneath a card
    // the player finished reading a second ago.
    const queue = new MotionQueue();
    queue.push([card("card.chance.advance_to_go", 1), pulse(1, 2, 400)], 0);
    queue.advance(DEFAULT_DURATIONS.cardMs + 10);

    expect(queue.idle).toBe(false);
    expect(queue.frame.remaining).toBe(1);
    expect(queue.frame.card).toBeNull();
  });

  it("shows the card of the beat in flight, never a later one waiting its turn", () => {
    // Same reason as above: this is about *which* card is on screen while a beat plays, so both have
    // to survive planning.
    const queue = new MotionQueue({ budgetMs: ROOMY_BUDGET_MS });
    queue.push([card("card.chance.first", 1), card("card.chance.second", 2)], 0);
    expect(queue.frame.card?.cardId).toBe("card.chance.first");
  });

  it("holds up nothing at all when its dwell is zero", () => {
    // The history path: `plan` drops the step rather than zeroing it, and this is the belt to that
    // brace — a zero-length card must not flash a frame with content nobody can read.
    const queue = new MotionQueue();
    queue.push([card("card.chance.old", 1, { durationMs: 0 })], 0);

    expect(queue.idle).toBe(true);
    expect(queue.frame.card).toBeNull();
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
