import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SocketLike } from "./client";
import { EventQueue } from "./eventQueue";
import { EventSocket, parseFrame, TERMINAL_CLOSE_CODES, WS_CURSOR_RESET } from "./eventSocket";
import type { LoggedEvent } from "./types";

/**
 * Reconnect behaviour is the part of this layer that only fails in the field: a socket that
 * never comes back looks exactly like a socket nobody disconnected. So the tests drive the
 * close codes the server actually sends (`api.py` WS_*), assert that the retry replays from
 * the *current* cursor rather than from zero, and assert that a terminal code stops the loop
 * instead of hammering a 404 forever.
 */

class FakeSocket implements SocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  closedByClient = false;

  close(): void {
    this.closedByClient = true;
  }

  accept(): void {
    this.onopen?.(null);
  }

  push(frame: LoggedEvent): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  pushRaw(data: unknown): void {
    this.onmessage?.({ data });
  }

  serverClose(code: number, reason = ""): void {
    this.onclose?.({ code, reason, wasClean: false });
  }
}

interface Harness {
  readonly socket: EventSocket;
  readonly opened: FakeSocket[];
  readonly urls: number[];
  readonly frames: LoggedEvent[];
  readonly states: string[];
  cursor: number;
}

function harness(): Harness {
  const opened: FakeSocket[] = [];
  const urls: number[] = [];
  const frames: LoggedEvent[] = [];
  const states: string[] = [];
  const state = { cursor: 0 };

  const socket = new EventSocket({
    open: (since) => {
      urls.push(since);
      const fake = new FakeSocket();
      opened.push(fake);
      return fake;
    },
    cursor: () => state.cursor,
    onFrames: (pushed) => {
      frames.push(...pushed);
    },
    onStatus: (status) => {
      states.push(status.state);
    },
    backoff: { initialMs: 100, maxMs: 800, factor: 2 },
    random: () => 1, // pin the jitter so a delay is arithmetic, not a coin flip
  });

  return {
    socket,
    opened,
    urls,
    frames,
    states,
    get cursor() {
      return state.cursor;
    },
    set cursor(value: number) {
      state.cursor = value;
    },
  };
}

function frame(seq: number): LoggedEvent {
  return { seq, event: { type: "turn_started", player: 0, turn_number: seq } };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("EventSocket — connecting", () => {
  it("opens at the cursor it is given and reports open once accepted", () => {
    const h = harness();
    h.cursor = 4;

    h.socket.start();
    h.opened[0]?.accept();

    expect(h.urls).toEqual([4]);
    expect(h.socket.status.state).toBe("open");
    expect(h.socket.status.attempts).toBe(0);
  });

  it("hands each frame to the consumer as it arrives", () => {
    const h = harness();
    h.socket.start();
    h.opened[0]?.accept();

    h.opened[0]?.push(frame(1));
    h.opened[0]?.push(frame(2));

    expect(h.frames.map((entry) => entry.seq)).toEqual([1, 2]);
  });

  it("drops a malformed frame instead of tearing down a healthy subscription", () => {
    const h = harness();
    h.socket.start();
    h.opened[0]?.accept();

    h.opened[0]?.pushRaw("{not json");
    h.opened[0]?.pushRaw(JSON.stringify({ seq: 0, event: { type: "turn_started" } }));
    h.opened[0]?.push(frame(1));

    expect(h.frames.map((entry) => entry.seq)).toEqual([1]);
    expect(h.socket.status.state).toBe("open");
  });
});

describe("EventSocket — reconnecting", () => {
  it("retries after an unexpected close, with a backing-off delay", () => {
    const h = harness();
    h.socket.start();
    h.opened[0]?.accept();

    h.opened[0]?.serverClose(1006);
    expect(h.socket.status.state).toBe("reconnecting");
    expect(h.opened).toHaveLength(1);

    // 100ms ceiling on the first attempt; nothing before it.
    vi.advanceTimersByTime(99);
    expect(h.opened).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(h.opened).toHaveLength(2);

    // Second failure: the ceiling doubles, so 100ms is no longer enough.
    h.opened[1]?.serverClose(1006);
    vi.advanceTimersByTime(100);
    expect(h.opened).toHaveLength(2);
    vi.advanceTimersByTime(100);
    expect(h.opened).toHaveLength(3);
  });

  it("replays from the cursor reached before the disconnect, not from zero", () => {
    const h = harness();
    h.socket.start();
    h.opened[0]?.accept();
    h.opened[0]?.push(frame(1));
    h.cursor = 9; // the queue advanced while the socket was up

    h.opened[0]?.serverClose(4413); // WS_WATCHER_TOO_SLOW — recoverable by replaying
    vi.advanceTimersByTime(100);

    expect(h.urls).toEqual([0, 9]);
  });

  it("resets the delay ladder once a connection succeeds", () => {
    const h = harness();
    h.socket.start();
    h.opened[0]?.serverClose(1006);
    vi.advanceTimersByTime(100);
    h.opened[1]?.accept();

    h.opened[1]?.serverClose(1006);
    vi.advanceTimersByTime(100);

    expect(h.opened).toHaveLength(3);
  });

  it("caps the delay at maxMs", () => {
    const h = harness();

    expect(h.socket.delayFor(1)).toBe(100);
    expect(h.socket.delayFor(2)).toBe(200);
    expect(h.socket.delayFor(10)).toBe(800);
  });

  it.each(TERMINAL_CLOSE_CODES)("stops for good on close code %i", (code) => {
    const h = harness();
    h.socket.start();
    h.opened[0]?.accept();

    h.opened[0]?.serverClose(code, "error.game_not_found");
    vi.advanceTimersByTime(10_000);

    expect(h.opened).toHaveLength(1);
    expect(h.socket.status.state).toBe("closed");
    // The server's keyed reason is carried out as data, untranslated.
    expect(h.socket.status.reasonKey).toBe("error.game_not_found");
    expect(h.socket.status.closeCode).toBe(code);
  });

  it("does not reconnect after stop(), and stop() is idempotent", () => {
    const h = harness();
    h.socket.start();
    h.opened[0]?.accept();

    h.socket.stop();
    h.socket.stop();
    vi.advanceTimersByTime(10_000);

    expect(h.opened[0]?.closedByClient).toBe(true);
    expect(h.opened).toHaveLength(1);
    expect(h.socket.status.state).toBe("closed");
  });

  it("cancels a pending retry when stopped mid-backoff", () => {
    const h = harness();
    h.socket.start();
    h.opened[0]?.serverClose(1006);

    h.socket.stop();
    vi.advanceTimersByTime(10_000);

    expect(h.opened).toHaveLength(1);
  });

  it("treats a constructor that throws as a failed attempt, not a crash", () => {
    let attempts = 0;
    const socket = new EventSocket({
      open: () => {
        attempts += 1;
        throw new Error("blocked scheme");
      },
      cursor: () => 0,
      onFrames: () => undefined,
      backoff: { initialMs: 50, maxMs: 50, factor: 1 },
      random: () => 1,
    });

    expect(() => {
      socket.start();
    }).not.toThrow();
    expect(attempts).toBe(1);
    vi.advanceTimersByTime(50);
    expect(attempts).toBe(2);
    socket.stop();
  });
});

describe("EventSocket — a save that takes the game's id over (MON-907)", () => {
  /**
   * A harness with a **real** `EventQueue` behind it, which is the point of these three tests.
   *
   * The others pin the cursor with a plain number, and for reconnect arithmetic that is the right
   * fixture. Here the claim under test spans two objects — the socket asks the queue to forget, and
   * the *next connect* has to read what the queue then says — so a fake cursor would let the reset
   * be asserted and the consequence be assumed. This is the wiring `GameProvider` does, minus React.
   */
  function resetHarness() {
    const queue = new EventQueue();
    const opened: FakeSocket[] = [];
    const urls: number[] = [];
    const socket = new EventSocket({
      open: (since) => {
        urls.push(since);
        const fake = new FakeSocket();
        opened.push(fake);
        return fake;
      },
      cursor: () => queue.cursor,
      onFrames: (frames) => {
        queue.offer(frames);
      },
      onCursorReset: () => {
        queue.reset();
      },
      backoff: { initialMs: 100, maxMs: 800, factor: 2 },
      random: () => 1,
    });
    return { queue, opened, urls, socket };
  }

  it("is not terminal: 4409 means come back, unlike 4404 and 4429", () => {
    expect(TERMINAL_CLOSE_CODES).not.toContain(WS_CURSOR_RESET);
  });

  it("forgets the cursor and reconnects at since=0", () => {
    const h = resetHarness();
    h.queue.offer([frame(1), frame(2)]); // the game as it stood before the takeover
    h.socket.start();
    h.opened[0]?.accept();
    // The opening connect carries the real cursor, so the second one carrying 0 is a *change* and
    // not the value a fresh queue would have produced anyway.
    expect(h.urls).toEqual([2]);

    h.opened[0]?.serverClose(WS_CURSOR_RESET, "error.session_replaced");
    vi.advanceTimersByTime(100);

    expect(h.urls).toEqual([2, 0]);
    expect(h.queue.cursor).toBe(0);
    expect(h.queue.log).toEqual([]);
    // ... and the replacement's own events are accepted, which the old high-water mark of 2 would
    // have swallowed whole: the restored game's log restarts at seq 1.
    h.opened[1]?.accept();
    h.opened[1]?.push(frame(1));
    expect(h.queue.log.map((entry) => entry.seq)).toEqual([1]);
  });

  it("leaves the cursor alone on a close that is an ordinary retry", () => {
    const h = resetHarness();
    h.queue.offer([frame(1), frame(2)]);
    h.socket.start();
    h.opened[0]?.accept();

    // 4413 — fell behind. The backlog is still ours to replay, so forgetting it here would throw
    // away a log the server is about to re-send and re-narrate the whole game at the player.
    h.opened[0]?.serverClose(4413, "error.watcher_too_slow");
    vi.advanceTimersByTime(100);

    expect(h.urls).toEqual([2, 2]);
    expect(h.queue.cursor).toBe(2);
  });
});

describe("parseFrame", () => {
  it("accepts a well-formed LoggedEvent", () => {
    expect(parseFrame(JSON.stringify(frame(3)))).toEqual(frame(3));
  });

  it.each([
    ["a non-string", 42],
    ["unparseable JSON", "{"],
    ["a bare array", "[]"],
    ["a missing seq", JSON.stringify({ event: { type: "turn_started" } })],
    ["a seq below 1", JSON.stringify({ seq: 0, event: { type: "turn_started" } })],
    ["a fractional seq", JSON.stringify({ seq: 1.5, event: { type: "turn_started" } })],
    ["a missing event", JSON.stringify({ seq: 1 })],
    ["an event without a type tag", JSON.stringify({ seq: 1, event: { player: 0 } })],
  ])("rejects %s", (_label, data) => {
    expect(parseFrame(data)).toBeNull();
  });
});
