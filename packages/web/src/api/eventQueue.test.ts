import { describe, expect, it, vi } from "vitest";

import { EventQueue } from "./eventQueue";
import type { LoggedEvent } from "./types";

/**
 * The de-duplication test is the one with teeth. Two transports carry the same envelope, so
 * "a replayed seq is announced twice" is not a hypothetical — it is the default behaviour of
 * any queue that does not do this, and the symptom (the dice announced twice on reconnect) is
 * exactly the double-speak MON-411 exists to prevent.
 */

function frame(seq: number, player = 0): LoggedEvent {
  return { seq, event: { type: "turn_started", player, turn_number: seq } };
}

describe("EventQueue", () => {
  it("accepts new frames in order and advances the cursor to the highest seq", () => {
    const queue = new EventQueue();

    const accepted = queue.offer([frame(1), frame(2), frame(3)]);

    expect(accepted.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(queue.cursor).toBe(3);
    expect(queue.log).toHaveLength(3);
  });

  it("drops a replayed seq, so a reconnect's backlog is not announced a second time", () => {
    const queue = new EventQueue();
    queue.offer([frame(1), frame(2), frame(3)]);

    // What `GET /games/{id}?since=0` returns after a reload: the whole log, most of which the
    // socket already delivered.
    const replay = queue.offer([frame(1), frame(2), frame(3), frame(4)]);

    expect(replay.map((entry) => entry.seq)).toEqual([4]);
    expect(queue.log.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
    expect(queue.cursor).toBe(4);
  });

  it("de-duplicates when the same frames arrive from both transports at once", () => {
    const queue = new EventQueue();
    const seen: number[] = [];
    queue.subscribe((frames) => {
      seen.push(...frames.map((entry) => entry.seq));
    });

    // The socket pushes 1 and 2; the command's HTTP response reports the same two.
    queue.offer([frame(1)]);
    queue.offer([frame(2)]);
    queue.offer([frame(1), frame(2)]);

    expect(seen).toEqual([1, 2]);
  });

  it("sorts by seq, because the two transports race and arrival order is not seq order", () => {
    const queue = new EventQueue();

    const accepted = queue.offer([frame(3), frame(1), frame(2)]);

    expect(accepted.map((entry) => entry.seq)).toEqual([1, 2, 3]);
  });

  it("reports only the frames after a reader's own cursor", () => {
    const queue = new EventQueue();
    queue.offer([frame(1), frame(2), frame(3)]);

    expect(queue.since(1).map((entry) => entry.seq)).toEqual([2, 3]);
    expect(queue.since(3)).toEqual([]);
  });

  it("notifies subscribers with just the accepted frames, and stops on unsubscribe", () => {
    const queue = new EventQueue();
    const listener = vi.fn();
    const unsubscribe = queue.subscribe(listener);

    queue.offer([frame(1)]);
    queue.offer([frame(1)]); // a replay: nothing accepted, so nothing announced
    unsubscribe();
    queue.offer([frame(2)]);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith([frame(1)]);
  });

  it("isolates a listener that throws, so one broken consumer cannot stop the next", () => {
    const queue = new EventQueue();
    const healthy = vi.fn();
    queue.subscribe(() => {
      throw new Error("the animation layer fell over");
    });
    queue.subscribe(healthy);

    expect(() => queue.offer([frame(1)])).not.toThrow();
    expect(healthy).toHaveBeenCalledOnce();
    // And the producer's own bookkeeping survived: nothing blocks on a consumer.
    expect(queue.cursor).toBe(1);
  });

  it("bounds the log and says which seq it forgot, so a late reader knows it lost frames", () => {
    const queue = new EventQueue(3);

    queue.offer([frame(1), frame(2), frame(3), frame(4), frame(5)]);

    expect(queue.log.map((entry) => entry.seq)).toEqual([3, 4, 5]);
    expect(queue.droppedThrough).toBe(2);
    // The cursor is about what has been *seen*, not what is retained: replaying from 2 would
    // re-announce events the narration already read out.
    expect(queue.cursor).toBe(5);
  });

  it("resets the cursor with the log, so a new game's seq 1 is not mistaken for a replay", () => {
    const queue = new EventQueue();
    queue.offer([frame(1), frame(2)]);

    queue.reset();
    const accepted = queue.offer([frame(1)]);

    expect(accepted.map((entry) => entry.seq)).toEqual([1]);
    expect(queue.cursor).toBe(1);
    expect(queue.droppedThrough).toBe(0);
  });
});
