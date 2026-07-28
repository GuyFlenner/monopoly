import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiClient } from "@/api";
import type { LoggedEvent, SocketLike } from "@/api";
import { GameProvider } from "@/game";
import { loggedEvent, makeTile, makeView, ROLL_DICE } from "@/test/fixtures";

import { Announcer } from "./Announcer";
import { AnnouncerProvider, useAnnouncer } from "./AnnouncerContext";
import { useEventNarration } from "./useEventNarration";

/**
 * End to end from the wire to the region. Two claims:
 *
 * 1. A view's events become sentences, in order, with the tile's *name* — resolved from the
 *    board's own namespace, not from an index.
 * 2. A replayed `seq` becomes no sentence at all, because the queue de-duplicated it before the
 *    narration saw it. On a naive implementation this fails as double-speak rather than as an
 *    error, which is why it is asserted here rather than left to a human AT pass.
 */

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
let announced: string[] = [];

/** Records what reached the bus, which is what "was announced" means before any dwell timer. */
function Recorder(): null {
  const { bus } = useAnnouncer();
  useEffect(
    () =>
      bus.subscribe((added) => {
        announced.push(...added.map((announcement) => announcement.key));
      }),
    [bus],
  );
  return null;
}

function Narrating(): null {
  useEventNarration();
  return null;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ROLL_AND_MOVE: LoggedEvent[] = [
  loggedEvent(1, {
    type: "dice_rolled",
    player: 0,
    first: 2,
    second: 1,
    total: 3,
    doubles_streak: 0,
    purpose: "move",
  }),
  loggedEvent(2, {
    type: "token_moved",
    player: 0,
    from_tile: 0,
    to_tile: 2,
    forward: true,
    passed_go: false,
  }),
];

const MOVE_ONLY: LoggedEvent[] = ROLL_AND_MOVE.slice(1);

function renderNarration(events: LoggedEvent[] = ROLL_AND_MOVE): HTMLElement {
  const view = makeView({
    legal_commands: [ROLL_DICE],
    events,
    event_cursor: events.reduce((max, entry) => Math.max(max, entry.seq), 0),
    board: {
      id: "classic",
      name_key: "board.classic.name",
      tiles: [makeTile(0), makeTile(1), makeTile(2, { name_key: "tile.classic.baltic_avenue" })],
      go_to_jail_target: 10,
    },
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
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <AnnouncerProvider>
        <Announcer />
        <Recorder />
        <GameProvider gameId="g1" client={client}>
          <Narrating />
        </GameProvider>
      </AnnouncerProvider>
    </QueryClientProvider>,
  );
  return container;
}

function politeText(container: HTMLElement): string {
  return container.querySelector('[aria-live="polite"]')?.textContent ?? "";
}

beforeEach(() => {
  sockets = [];
  announced = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useEventNarration", () => {
  it("narrates a view's events in order, into the one polite region", async () => {
    const container = renderNarration();

    await waitFor(() => {
      expect(announced).toEqual(["a11y.dice_result", "a11y.moved"]);
    });
    // The first sentence is in the region; the second is queued behind it (Announcer.test.tsx
    // owns the dwell).
    expect(politeText(container)).toBe("Rolled 2 and 1, total 3.");
  });

  it("resolves the tile's name from the board's own namespace, not as a bare key", async () => {
    // Only the move, so the sentence under test is the one holding the region rather than the
    // one queued behind the dice.
    const container = renderNarration(MOVE_ONLY);

    // `tile.classic.baltic_avenue` lives in `board-classic`, not in `common`: resolving it
    // against the default namespace would throw on a missing key (see i18n/index.ts), and a
    // client that fell back to the index would say "Ruti moved to 2".
    await waitFor(() => {
      expect(politeText(container)).toBe("Ruti moved to Baltic Avenue.");
    });
  });

  it("does not narrate a frame the queue has already seen", async () => {
    renderNarration();
    await waitFor(() => {
      expect(announced).toHaveLength(2);
    });

    // Exactly what a reconnect does: the socket replays the backlog from the cursor, and the
    // overlap is the events already narrated.
    act(() => {
      for (const frame of ROLL_AND_MOVE) {
        sockets[0]?.push(frame);
      }
    });

    expect(announced).toEqual(["a11y.dice_result", "a11y.moved"]);
  });

  it("narrates a genuinely new frame that arrives over the socket", async () => {
    renderNarration();
    await waitFor(() => {
      expect(announced).toHaveLength(2);
    });

    act(() => {
      sockets[0]?.push(loggedEvent(3, { type: "turn_started", player: 1, turn_number: 2 }));
    });

    expect(announced).toEqual(["a11y.dice_result", "a11y.moved", "a11y.turn"]);
  });
});
