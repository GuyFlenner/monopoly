/**
 * The timeline, and the tests that have to be able to fail.
 *
 * ## The falsifiers
 *
 * Most of MON-701's acceptance criteria can be satisfied by an implementation that just plays every
 * event in order, and a test fed a *short* batch cannot tell that apart from one that compresses. So
 * the central tests here feed batches that are deliberately over budget and assert on what
 * *survived*:
 *
 * - A thirty-seven-square move walks thirty-seven squares when it is the only thing in the batch, and
 *   collapses to a single glide when it is not. Delete `compress` and the second one goes red.
 * - Six bot turns' worth of rolls produce **one** dice settle. Remove the supersession rule and the
 *   count is six.
 * - A move is *never* superseded, even when a later move by the same player follows a payment.
 *   Widen the supersession rule to cover moves and that test goes red, because the piece would skip
 *   the square it stopped on.
 * - `instant` produces a timeline with the same *steps* and zero durations, not an empty one. Return
 *   `[]` for reduced motion — the obvious shortcut — and the board never updates its token
 *   positions at all, which is the bug that shortcut would ship.
 */

import { describe, expect, it } from "vitest";

import type { LoggedEvent } from "@/api";
import { TILE_COUNT } from "@/board";

import {
  compress,
  DEFAULT_BUDGET_MS,
  DEFAULT_DURATIONS,
  destinationOf,
  instantly,
  plan,
  stepFor,
  totalMs,
  walk,
  type TimelineStep,
  type TokenMoveStep,
} from "./timeline";

let nextSeq = 1;

function frame(event: LoggedEvent["event"], seq?: number): LoggedEvent {
  const assigned = seq ?? nextSeq;
  nextSeq = assigned + 1;
  return { seq: assigned, event };
}

function moved(
  player: number,
  from: number,
  to: number,
  extras: { readonly forward?: boolean; readonly passed_go?: boolean } = {},
): LoggedEvent {
  return frame({
    type: "token_moved",
    player,
    from_tile: from,
    to_tile: to,
    forward: extras.forward ?? true,
    passed_go: extras.passed_go ?? false,
  });
}

function rolled(player: number, first = 3, second = 4): LoggedEvent {
  return frame({
    type: "dice_rolled",
    player,
    first,
    second,
    total: first + second,
    doubles_streak: 0,
    purpose: "move",
  });
}

function cash(player: number, delta: number): LoggedEvent {
  return frame({
    type: "cash_changed",
    player,
    delta,
    reason: "rent",
    balance: 1500 + delta,
    counterparty: "bank",
  });
}

function built(tile: number, houses: number, delta = 1): LoggedEvent {
  return frame({ type: "building_changed", tile, houses, delta, level: "house" });
}

/** An event nothing animates, so a batch can be checked for what it *leaves* still. */
function mortgaged(tile: number): LoggedEvent {
  return frame({ type: "mortgage_changed", tile, player: 1, mortgaged: true });
}

function kinds(steps: readonly TimelineStep[]): readonly string[] {
  return steps.map((step) => step.kind);
}

function moves(steps: readonly TimelineStep[]): readonly TokenMoveStep[] {
  return steps.filter((step): step is TokenMoveStep => step.kind === "token_move");
}

describe("walking the ring", () => {
  it("counts the squares crossed, excluding the one left and including the one landed on", () => {
    expect(walk(5, 9, true)).toEqual([6, 7, 8, 9]);
  });

  it("wraps past GO", () => {
    expect(walk(38, 2, true)).toEqual([39, 0, 1, 2]);
  });

  it("goes the short way backwards when the event says backwards, not the long way round", () => {
    // The endpoints alone cannot tell "back three" from "forward thirty-seven", which is why
    // `TokenMoved.forward` exists and why this module never infers the direction.
    expect(walk(5, 2, false)).toEqual([4, 3, 2]);
    expect(walk(5, 2, true)).toHaveLength(TILE_COUNT - 3);
  });

  it("degrades to a single hop for an index the ring does not contain", () => {
    // A missed flourish, rather than a walk that never arrives. `walk` is the only thing between a
    // malformed frame and a board that hangs on an animation.
    expect(walk(-1, 4, true)).toEqual([4]);
    expect(walk(3, 99, true)).toEqual([99]);
  });

  it("treats a move that did not move as one terminal position", () => {
    expect(walk(7, 7, true)).toEqual([7]);
  });
});

describe("one event, at most one beat", () => {
  it("maps the four MON-701 events and nothing else", () => {
    expect(stepFor(moved(1, 0, 3), DEFAULT_DURATIONS)?.kind).toBe("token_move");
    expect(stepFor(rolled(1), DEFAULT_DURATIONS)?.kind).toBe("dice_settle");
    expect(stepFor(cash(1, -50), DEFAULT_DURATIONS)?.kind).toBe("cash_pulse");
    expect(stepFor(built(3, 1), DEFAULT_DURATIONS)?.kind).toBe("building_pop");
    expect(stepFor(mortgaged(3), DEFAULT_DURATIONS)).toBeNull();
  });

  it("leaves a rent charge to the cash movement it comes with, so a payment pulses once", () => {
    // `rent_charged` and its `cash_changed` are two events for one thing that happened. The rule is
    // one beat per thing, and this is the specific place a second beat would be added.
    const steps = plan([
      frame({
        type: "rent_charged",
        payer: 1,
        owner: 2,
        tile: 6,
        amount: 50,
        base_rent: 50,
        houses: 0,
        multiplier: 1,
        note_keys: [],
        note_params: {},
      }),
      cash(1, -50),
    ]);
    expect(kinds(steps)).toEqual(["cash_pulse"]);
  });

  it("is still for a zero delta — an animation for nothing happening is a lie", () => {
    expect(stepFor(cash(1, 0), DEFAULT_DURATIONS)).toBeNull();
  });

  it("prices a move by the squares it crosses", () => {
    const step = stepFor(moved(1, 0, 7), DEFAULT_DURATIONS);
    expect(step?.durationMs).toBe(DEFAULT_DURATIONS.perTileMs * 7);
  });
});

describe("ordering", () => {
  it("keeps the order the events happened in", () => {
    const steps = plan([rolled(1), moved(1, 0, 4), cash(1, -50), built(4, 1)]);
    expect(kinds(steps)).toEqual(["dice_settle", "token_move", "cash_pulse", "building_pop"]);
  });

  it("carries each step's originating seq, so a step can be traced to its event", () => {
    const steps = plan([rolled(1, 1, 1), built(9, 2)]);
    expect(steps.map((step) => step.seq)).toEqual([steps[0]?.seq, steps[1]?.seq]);
    expect(steps[1]?.seq).toBeGreaterThan(steps[0]?.seq ?? 0);
  });
});

describe("coalescing: adjacent legs of one journey", () => {
  it("folds two consecutive moves by the same player into one walk that keeps every square", () => {
    const steps = plan([moved(1, 0, 3), moved(1, 3, 6)]);
    const [journey] = moves(steps);
    expect(steps).toHaveLength(1);
    expect(journey?.path).toEqual([1, 2, 3, 4, 5, 6]);
    expect(journey?.from).toBe(0);
    expect(destinationOf(journey as TokenMoveStep)).toBe(6);
  });

  it("does not fold across an event that happened in between", () => {
    // A move, a payment and another move are three things. Folding the moves would hide the
    // payment's beat between them.
    const steps = plan([moved(1, 0, 3), cash(1, -50), moved(1, 3, 6)]);
    expect(kinds(steps)).toEqual(["token_move", "cash_pulse", "token_move"]);
  });

  it("does not fold two different players' moves", () => {
    const steps = plan([moved(1, 0, 3), moved(2, 10, 12)]);
    expect(moves(steps)).toHaveLength(2);
  });
});

describe("the compression ladder", () => {
  it("plays a long move square by square when it is the only thing in the batch", () => {
    const steps = plan([moved(1, 0, 12)]);
    expect(moves(steps)[0]?.path).toHaveLength(12);
  });

  it("collapses intermediate positions once the batch is over budget", () => {
    // A bot's whole turn arriving at once. Without `compress` this is 30-plus seconds of travel;
    // with it, one glide per leg that still lands on the right square.
    const burst = [
      rolled(1),
      moved(1, 0, 37),
      cash(1, -200),
      rolled(2),
      moved(2, 0, 33),
      cash(2, -150),
    ];
    const steps = plan(burst);
    expect(totalMs(steps)).toBeLessThanOrEqual(DEFAULT_BUDGET_MS);
    for (const step of moves(steps)) {
      expect(step.path).toHaveLength(1);
    }
    expect(moves(steps).map(destinationOf)).toEqual([37, 33]);
  });

  it("keeps one dice settle out of six, not six", () => {
    const burst = [1, 2, 3, 4, 5, 6].flatMap((seat) => [rolled(seat), moved(seat, 0, 20)]);
    const steps = plan(burst);
    expect(kinds(steps).filter((kind) => kind === "dice_settle")).toHaveLength(1);
  });

  it("keeps the last cash beat per player and the last pop per square", () => {
    const steps = compress([
      ...plan([cash(1, 100)]),
      ...plan([cash(1, -50)]),
      ...plan([cash(2, -50)]),
      ...plan([built(6, 1)]),
      ...plan([built(6, 2)]),
      ...plan([built(8, 1)]),
    ]);
    expect(kinds(steps)).toEqual(["cash_pulse", "cash_pulse", "building_pop", "building_pop"]);
    // The survivor is the *later* one: the fact a beat shows became true at its last occurrence.
    const pops = steps.filter(
      (step): step is Extract<TimelineStep, { kind: "building_pop" }> =>
        step.kind === "building_pop",
    );
    expect(pops.map((step) => step.houses)).toEqual([2, 1]);
  });

  it("never supersedes a move, because every leg is a square the piece stopped on", () => {
    const steps = compress([...plan([moved(1, 0, 3)]), ...plan([moved(1, 10, 14)])]);
    expect(moves(steps).map(destinationOf)).toEqual([3, 14]);
  });

  it("falls to zero durations when even the compressed timeline cannot fit", () => {
    // Sixty seats' worth of distinct payments: nothing left to supersede and nothing left to
    // shorten, so the honest answer is to stop taking time rather than to drop what happened.
    const many = Array.from({ length: 60 }, (_, seat) => cash(seat, -10));
    const steps = plan(many);
    expect(steps).toHaveLength(60);
    expect(totalMs(steps)).toBe(0);
  });
});

describe("reduced motion", () => {
  it("keeps every step and zeroes every duration", () => {
    // Not `[]`. An empty timeline would never move a token override off its old square, so the
    // board would keep drawing a stale position — the exact bug the "obvious" shortcut ships.
    const events = [rolled(1), moved(1, 0, 5), cash(1, -50), built(5, 1)];
    const steps = plan(events, { instant: true });
    expect(kinds(steps)).toEqual(kinds(plan(events)));
    expect(totalMs(steps)).toBe(0);
  });

  it("is idempotent, and leaves an already-instant step alone", () => {
    const once = instantly(plan([moved(1, 0, 4)]));
    expect(instantly(once)).toEqual(once);
  });

  it("still merges adjacent legs, so the piece lands in one place rather than two", () => {
    const steps = plan([moved(1, 0, 3), moved(1, 3, 6)], { instant: true });
    expect(steps).toHaveLength(1);
    expect(destinationOf(moves(steps)[0] as TokenMoveStep)).toBe(6);
  });
});
