import { describe, expect, it, vi } from "vitest";

import { parseFrame } from "@/api";

import { createFakeBridge, envelope } from "./fixtures";
import {
  createLocalSocketFactory,
  LOCAL_WS_GAME_NOT_FOUND,
  LocalEventBus,
  LocalSocket,
} from "./localSocket";

/**
 * The event stream without a socket, and the bot pump behind it.
 *
 * Two properties are load-bearing, and both are about *when* rather than what:
 *
 * 1. **Delivery is cursor-driven.** Every frame a listener receives comes from
 *    `events_since(gameId, itsOwnCursor)`, so a subscription that opened halfway through a bot's
 *    turn gets the backlog and one that has already seen a frame never gets it twice. The
 *    alternative — pushing what a step returned — is what makes the animation queue replay a game
 *    that never happened.
 * 2. **The pump is one `await` per step.** The thinking delay is inside Python, so nothing here
 *    holds a timer and a test does not need fake ones.
 */

/** Wait for the microtask the socket defers its open to, plus any deliveries it started. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await Promise.resolve();
  }
}

function collectorSocket(bus: LocalEventBus, gameId: string, since = 0) {
  const socket = new LocalSocket(bus, gameId, since);
  const frames: unknown[] = [];
  const closes: { code: number; reason: string; wasClean: boolean }[] = [];
  let opened = 0;
  socket.onopen = () => {
    opened += 1;
  };
  socket.onmessage = (event) => {
    frames.push(parseFrame(event.data));
  };
  socket.onclose = (event) => {
    closes.push(event);
  };
  return { socket, frames, closes, opened: () => opened };
}

describe("LocalSocket", () => {
  it("opens on a later turn, so a caller can attach its handlers first", async () => {
    const bus = new LocalEventBus(createFakeBridge());
    const { opened } = collectorSocket(bus, "g1");
    expect(opened()).toBe(0); // a real WebSocket never fires onopen from its constructor either
    await settle();
    expect(opened()).toBe(1);
  });

  it("replays the backlog after ?since= and nothing before it", async () => {
    const bridge = createFakeBridge({ botMoves: 2 });
    const bus = new LocalEventBus(bridge);
    await bridge.advanceBotsStep("g1");
    await bridge.advanceBotsStep("g1");
    expect(bridge.log).toHaveLength(4);

    const late = collectorSocket(bus, "g1", 2);
    await settle();
    expect(late.frames.map((frame) => (frame as { seq: number }).seq)).toEqual([3, 4]);
  });

  it("hands each frame over as text, so parseFrame is still the thing that validates it", async () => {
    const bridge = createFakeBridge({ botMoves: 1 });
    const bus = new LocalEventBus(bridge);
    const socket = new LocalSocket(bus, "g1", 0);
    const raw: unknown[] = [];
    socket.onmessage = (event) => {
      raw.push(event.data);
    };
    await settle();
    await bus.pump("g1");
    await settle();

    expect(raw.length).toBeGreaterThan(0);
    expect(raw.every((data) => typeof data === "string")).toBe(true);
    expect(parseFrame(raw[0])).toMatchObject({ seq: 1, event: { type: "dice_rolled" } });
  });

  it("never delivers the same frame twice, however often it is asked to", async () => {
    const bridge = createFakeBridge({ botMoves: 2 });
    const bus = new LocalEventBus(bridge);
    const listener = collectorSocket(bus, "g1");
    await settle();

    await bus.pump("g1");
    await bus.deliver("g1");
    await bus.deliver("g1");
    await settle();

    const seqs = listener.frames.map((frame) => (frame as { seq: number }).seq);
    expect(seqs).toEqual([1, 2, 3, 4]);
  });

  it("closes with the mirror of the HTTP 404 when the game is gone", async () => {
    const bus = new LocalEventBus(createFakeBridge({ missing: true }));
    const listener = collectorSocket(bus, "gone");
    await settle();
    expect(listener.closes).toEqual([
      { code: LOCAL_WS_GAME_NOT_FOUND, reason: "error.game_not_found", wasClean: false },
    ]);
  });

  it("stops delivering once closed, and closing twice fires one onclose", async () => {
    const bridge = createFakeBridge({ botMoves: 1 });
    const bus = new LocalEventBus(bridge);
    const listener = collectorSocket(bus, "g1");
    await settle();

    listener.socket.close();
    listener.socket.close(4000, "again");
    await bus.pump("g1");
    await settle();

    expect(listener.closes).toEqual([{ code: 1000, reason: "", wasClean: true }]);
    expect(listener.frames).toEqual([]);
  });

  it("does not open at all if it was closed before its first turn", async () => {
    const bus = new LocalEventBus(createFakeBridge());
    const { socket, opened, closes } = collectorSocket(bus, "g1");
    socket.close();
    await settle();
    expect(opened()).toBe(0);
    expect(closes).toHaveLength(1);
  });
});

describe("LocalEventBus.pump", () => {
  it("steps until the facade says done, delivering as it goes", async () => {
    const bridge = createFakeBridge({ botMoves: 3 });
    const bus = new LocalEventBus(bridge);
    const listener = collectorSocket(bus, "g1");
    await settle();

    await bus.pump("g1");
    await settle();

    expect(bridge.steps()).toBe(3);
    expect(listener.frames).toHaveLength(6);
    // One more step call than moves: the loop learns it is finished by being told.
    expect(bridge.calls.filter((call) => call.fn === "advanceBotsStep")).toHaveLength(4);
  });

  it("stops rather than looping when a step answers something it cannot read", async () => {
    // The 404 of a game left mid-turn, which is a real sequence: a pause is tenths of a second and
    // leaving is one click. A pump that treated it as "not done" would spin forever.
    const bridge = createFakeBridge({
      botMoves: 99,
      answers: { advanceBotsStep: () => envelope(404, { reason_key: "error.game_not_found" }) },
    });
    await new LocalEventBus(bridge).pump("g1");
    expect(bridge.calls.filter((call) => call.fn === "advanceBotsStep")).toHaveLength(1);
  });

  it("drops a re-entrant pump instead of running two loops over one game", async () => {
    const bridge = createFakeBridge({ botMoves: 3 });
    const bus = new LocalEventBus(bridge);
    await Promise.all([bus.pump("g1"), bus.pump("g1"), bus.pump("g1")]);
    expect(bridge.steps()).toBe(3);
  });

  it("delivers a command's own events to a listener that was not the one who sent it", async () => {
    // The commanding client gets them in its response; a second subscription has only this.
    const bridge = createFakeBridge();
    const bus = new LocalEventBus(bridge);
    const listener = collectorSocket(bus, "g1");
    await settle();
    bridge.log.push({ seq: 1, event: { type: "cash_changed" } });

    await bus.pump("g1");
    await settle();
    expect(listener.frames).toHaveLength(1);
  });

  it("leaves an unsubscribed listener alone", async () => {
    const bridge = createFakeBridge({ botMoves: 1 });
    const bus = new LocalEventBus(bridge);
    const deliver = vi.fn();
    const unsubscribe = bus.subscribe("g1", { deliver, cursor: () => 0, gone: vi.fn() });
    unsubscribe();
    await bus.pump("g1");
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe("createLocalSocketFactory", () => {
  it("reads the game and the cursor out of the URL ApiClient built", async () => {
    const bridge = createFakeBridge({ botMoves: 2 });
    await bridge.advanceBotsStep("g1");
    await bridge.advanceBotsStep("g1");
    const bus = new LocalEventBus(bridge);

    const socket = createLocalSocketFactory(bus)("ws://kesef.test/api/games/g%201/ws?since=3");
    const frames: unknown[] = [];
    socket.onmessage = (event) => {
      frames.push(event.data);
    };
    await settle();

    const replay = bridge.calls.find((call) => call.fn === "eventsSince");
    expect(replay?.args).toEqual(["g 1", 3]);
    expect(frames).toHaveLength(1); // seq 4 only
  });

  it("treats a missing or nonsense cursor as replay-from-the-start", async () => {
    const bridge = createFakeBridge();
    const bus = new LocalEventBus(bridge);
    createLocalSocketFactory(bus)("ws://kesef.test/api/games/g1/ws");
    createLocalSocketFactory(bus)("ws://kesef.test/api/games/g1/ws?since=nonsense");
    await settle();

    const replays = bridge.calls.filter((call) => call.fn === "eventsSince");
    // Three calls for two sockets: the second one's open re-delivers to the first, which is the
    // behaviour that matters — every listener is asked from *its own* cursor, every time.
    expect(replays).toHaveLength(3);
    expect(replays.map((call) => call.args[1])).toEqual([0, 0, 0]);
  });
});
