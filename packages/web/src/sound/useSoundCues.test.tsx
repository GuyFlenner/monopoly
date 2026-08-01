/**
 * End to end from the wire to the port (MON-706) — the shape of `useEventNarration.test.tsx`,
 * against the speaker instead of the region, and for the same three claims:
 *
 * 1. A view's events become cues, in order.
 * 2. A **replayed** `seq` becomes no cue at all, because the hook reads the queue's de-duplicated
 *    feed. On a naive implementation this fails as a double click rather than as an error, which is
 *    exactly why it is asserted rather than left to somebody listening.
 * 3. Muting silences the game without perturbing the feed.
 *
 * The port is a recorder. Nothing here asserts on audio — see `audioPort.ts` for why that is the
 * design rather than a shortcut.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiClient } from "@/api";
import type { LoggedEvent, SocketLike } from "@/api";
import { GameProvider, useGame } from "@/game";
import { loggedEvent, makeView, ROLL_DICE } from "@/test/fixtures";

import type { AudioPort, CueName } from ".";
import { forgetCachedMute, writeMuted } from "./mute";
import { useSoundCues } from "./useSoundCues";

class FakeSocket implements SocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;

  close(): void {
    /* nothing to tear down in a fake */
  }

  push(frame: LoggedEvent): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

let sockets: FakeSocket[] = [];
let played: CueName[] = [];
/**
 * The queue's cursor, as the game screen sees it.
 *
 * Recorded so a test can wait for the opening view to have been **consumed** rather than for the
 * socket to exist. The socket is created synchronously on mount, so `waitFor(sockets.length === 1)`
 * resolves before the fetch has resolved — which made the two muted tests below pass vacuously and
 * then, in the resume test, fail loudly when the deferred cues arrived after the unmute. The cursor
 * is the only signal that says "the events have reached the feed".
 */
let cursor = 0;

/** The injected port: the seam the whole feature is built around. */
const recorder: AudioPort = {
  play: (cue) => {
    played.push(cue);
  },
};

/**
 * The composition `GameScreen` performs, reduced to its two hooks.
 *
 * `useGame()` is here because it is what *fetches*: `useSoundCues` only subscribes to the queue, and
 * a view's events reach that queue from `useGame`'s effect — deliberately, so an event is never
 * played before the view that explains it has been committed. A harness that omitted it would test a
 * hook nothing had given anything to.
 */
function Cueing(): null {
  cursor = useGame().status.cursor;
  useSoundCues(recorder);
  return null;
}

/** Wait until the opening view's events have been offered to the feed. */
async function feedCaughtUp(upTo: number): Promise<void> {
  await waitFor(() => {
    expect(cursor).toBe(upTo);
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ROLL: LoggedEvent = loggedEvent(1, {
  type: "dice_rolled",
  player: 0,
  first: 2,
  second: 1,
  total: 3,
  doubles_streak: 0,
  purpose: "move",
});

/** A move, which cues nothing: the silence between the two cues is part of the assertion. */
const MOVE: LoggedEvent = loggedEvent(2, {
  type: "token_moved",
  player: 0,
  from_tile: 0,
  to_tile: 2,
  forward: true,
  passed_go: false,
});

const SALARY: LoggedEvent = loggedEvent(3, {
  type: "cash_changed",
  player: 0,
  delta: 200,
  balance: 1700,
  reason: "go_salary",
  counterparty: "bank",
});

const OPENING: LoggedEvent[] = [ROLL, MOVE, SALARY];

function renderCues(events: LoggedEvent[] = OPENING): void {
  const view = makeView({
    legal_commands: [ROLL_DICE],
    events,
    event_cursor: events.reduce((max, entry) => Math.max(max, entry.seq), 0),
  });
  const client = new ApiClient({
    fetch: () => Promise.resolve(json(200, view)),
    origin: "http://kesef.test/",
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <GameProvider gameId="g1" client={client}>
        <Cueing />
      </GameProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  sockets = [];
  played = [];
  cursor = 0;
  globalThis.localStorage.clear();
  forgetCachedMute();
  vi.restoreAllMocks();
});

describe("useSoundCues", () => {
  it("plays a cue per cueing event, in order, and nothing for the rest", async () => {
    renderCues();

    await waitFor(() => {
      expect(played).toEqual(["dice", "cash"]);
    });
    // Three events, two cues: `token_moved` is deliberately silent, and the ordering is the feed's.
    expect(played).toHaveLength(2);
  });

  it("does not replay a cue for a frame the queue has already seen", async () => {
    // A reconnect replays the backlog from the cursor. Without the queue's de-duplication every
    // reconnect would fire the whole game's sounds at once — which is the failure mode that makes a
    // player mute the game and never come back.
    renderCues();
    await waitFor(() => {
      expect(played).toHaveLength(2);
    });

    act(() => {
      for (const frame of OPENING) {
        sockets[0]?.push(frame);
      }
    });

    expect(played).toEqual(["dice", "cash"]);
  });

  it("cues a genuinely new frame that arrives over the socket", async () => {
    renderCues();
    await waitFor(() => {
      expect(played).toHaveLength(2);
    });

    act(() => {
      sockets[0]?.push(loggedEvent(4, { type: "sent_to_jail", player: 0, via: "tile" }));
    });

    expect(played).toEqual(["dice", "cash", "jail"]);
  });

  it("plays nothing at all when the game is muted", async () => {
    writeMuted(true);
    renderCues();

    // Waiting for the *feed* rather than for the socket, so this cannot pass by being too early —
    // three events have been offered and dropped by the time the assertion runs. See `cursor`.
    await feedCaughtUp(3);
    expect(played).toEqual([]);
  });

  it("resumes cueing the moment the mute is lifted, without missing the next event", async () => {
    // The feed must not be perturbed by muting — `useEventFeed` holds its listener in a ref
    // precisely so a re-render does not unsubscribe, and an unsubscribe between two frames of one
    // command would drop the second. So muting is checked *inside* the listener, and this is what
    // proves the subscription survived.
    writeMuted(true);
    renderCues();
    await feedCaughtUp(3);
    expect(played).toEqual([]);

    act(() => {
      writeMuted(false);
    });
    act(() => {
      sockets[0]?.push(
        loggedEvent(9, {
          type: "property_acquired",
          player: 0,
          tile: 1,
          price: 60,
          via: "purchase",
        }),
      );
    });

    expect(played).toEqual(["purchase"]);
  });
});
