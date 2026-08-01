/**
 * The viewer end to end: one fetch, a walk over the log, and nothing invented.
 *
 * What is asserted here, and why each one would pass a broken implementation without it:
 *
 * 1. **It fetches its own copy, from `since=0`.** A panel reading `useGame().events` would look
 *    identical on a short game and lose the opening turns of a long one (the queue is bounded), so
 *    the request itself is asserted — including that the game screen's own query is not the one that
 *    answered it.
 * 2. **Stepping changes the board, not just the text.** A viewer that only sliced the event log
 *    would pass every assertion about sentences and show a board frozen at the end of the game. So
 *    the ownership marker and the token are checked at two positions.
 * 3. **What no event stated reads "not said yet".** The most tempting bug in this whole feature is a
 *    plausible zero — a cash column showing 0 for a seat no `cash_changed` has mentioned, which is
 *    indistinguishable from a seat that has genuinely been cleaned out.
 * 4. **The three states of a fetch**, because a replay is a network request against a game the server
 *    may have expired, and a panel that answers that with a blank card is MON-708's defect again.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { AnnouncerProvider } from "@/a11y";
import { ApiClient, type LoggedEvent, type SocketLike } from "@/api";
import { makeRingBoard, makeSeats } from "@/board/fixtures";
import { GameProvider } from "@/game";
import { expectAxeClean } from "@/test/axe";
import { loggedEvent, makeState, makeView } from "@/test/fixtures";
import { ThemeSprite } from "@/theme";

import { ReplayPanel } from "./ReplayPanel";

class FakeSocket implements SocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  close(): void {
    /* nothing to tear down in a fake */
  }
}

/** Ruti rolls, moves to Connecticut Avenue (square 9), buys it, and pays for it. */
const LOG: readonly LoggedEvent[] = [
  loggedEvent(1, { type: "turn_started", player: 0, turn_number: 1 }),
  loggedEvent(2, {
    type: "dice_rolled",
    player: 0,
    first: 4,
    second: 5,
    total: 9,
    doubles_streak: 0,
    purpose: "move",
  }),
  loggedEvent(3, {
    type: "token_moved",
    player: 0,
    from_tile: 0,
    to_tile: 9,
    forward: true,
    passed_go: false,
  }),
  loggedEvent(4, { type: "property_acquired", player: 0, tile: 9, price: 100, via: "purchase" }),
  loggedEvent(5, {
    type: "cash_changed",
    player: 0,
    delta: -100,
    reason: "purchase",
    balance: 1400,
    counterparty: "bank",
  }),
];

const GAME_GONE = { reason_key: "error.game_not_found", params: {} };

type Reply = { readonly status: number; readonly body: unknown } | "hang";

interface Harness {
  readonly requests: string[];
  readonly container: HTMLElement;
  readonly closes: number[];
  readonly answer: (next: Reply) => void;
}

/** The view the replay route answers with: the whole log, plus the board and the seat names. */
function viewWithLog(events: readonly LoggedEvent[]): unknown {
  return makeView({
    board: makeRingBoard(),
    // The *current* state, which is what the server sends: the replay may only read the roster and
    // the board out of it, and a test that seeded a mid-game state here would hide it doing more.
    state: makeState({ players: makeSeats(["Ruti", "Dan"]), current_player_id: 1, turn_number: 7 }),
    events: [...events],
    event_cursor: events.length,
  });
}

function mount(initial: Reply, options: { readonly onClose?: () => void } = {}): Harness {
  let reply = initial;
  const requests: string[] = [];
  const closes: number[] = [];
  const client = new ApiClient({
    baseUrl: "/api",
    fetch: (input) => {
      requests.push(input);
      if (reply === "hang") {
        return new Promise<Response>(() => undefined);
      }
      return Promise.resolve(
        new Response(JSON.stringify(reply.body), {
          status: reply.status,
          headers: { "content-type": "application/json" },
        }),
      );
    },
    createSocket: () => new FakeSocket(),
    origin: "http://kesef.test/",
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <AnnouncerProvider>
        <GameProvider gameId="g1" client={client}>
          {/* The band patterns live in the app shell's one sprite; a panel rendered on its own
              supplies it as a sibling, exactly as `Board.test.tsx` does. */}
          <ThemeSprite />
          <ReplayPanel
            onClose={
              options.onClose ??
              (() => {
                closes.push(1);
              })
            }
          />
        </GameProvider>
      </AnnouncerProvider>
    </QueryClientProvider>,
  );
  return {
    requests,
    container,
    closes,
    answer: (next) => {
      reply = next;
    },
  };
}

/** The replay board's cell for a square index. Its own id space — the live board is elsewhere. */
function replayCell(index: number): HTMLElement {
  const cell = document.querySelector<HTMLElement>(`#kesef-replay-tile-${String(index)}`);
  if (cell === null) {
    throw new Error(`no replay cell rendered for square ${String(index)}`);
  }
  return cell;
}

function seatRow(playerId: number): HTMLElement {
  const row = document.querySelector<HTMLElement>(
    `[data-testid="replay-seat"][data-player="${String(playerId)}"]`,
  );
  if (row === null) {
    throw new Error(`no seat row for player ${String(playerId)}`);
  }
  return row;
}

async function openedAtTheEnd(): Promise<Harness> {
  const harness = mount({ status: 200, body: viewWithLog(LOG) });
  expect(await screen.findByTestId("replay-position")).toHaveTextContent("Event 5 of 5");
  return harness;
}

describe("the fetch", () => {
  it("asks for the whole log, from the beginning", async () => {
    const harness = await openedAtTheEnd();
    // `since=0` is the replay of the *whole* game (G-34). Anything else would be a viewer whose
    // first frame depends on what this browser tab happened to have seen already.
    expect(harness.requests).toEqual(["/api/games/g1?since=0"]);
  });

  it("says it is loading while the request is out", () => {
    mount("hang");
    expect(screen.getByTestId("replay-loading")).toBeInTheDocument();
  });

  it("renders the server's own reason when the game has gone, with a retry", async () => {
    const harness = mount({ status: 404, body: GAME_GONE });

    expect(await screen.findByTestId("replay-error")).toBeInTheDocument();
    expect(screen.getByText("That game no longer exists.")).toBeInTheDocument();

    // The retry is meaningful here — unlike a rejected command, a fetch can succeed on the second
    // go (a request that raced a session being created).
    harness.answer({ status: 200, body: viewWithLog(LOG) });
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("replay-position")).toHaveTextContent("Event 5 of 5");
    expect(harness.requests).toHaveLength(2);
  });

  it("says so plainly when there is nothing to step through", async () => {
    mount({ status: 200, body: viewWithLog([]) });
    expect(await screen.findByTestId("replay-empty")).toBeInTheDocument();
    // And no controls: a slider with one position on it is a control that cannot do anything.
    expect(screen.queryByTestId("replay-controls")).toBeNull();
  });
});

describe("the frame it opens on", () => {
  it("is the end of the log, so a player recognises the table they left", async () => {
    await openedAtTheEnd();
    expect(screen.getByTestId("replay-slider")).toHaveValue("5");
  });

  it("describes that frame from the events and not from the current state", async () => {
    await openedAtTheEnd();
    // The fixture's *current* state says turn 7 and Dan to act; the log's last `turn_started` says
    // turn 1 and Ruti. The replay must show the log's answer.
    const frame = screen.getByTestId("replay-frame");
    expect(frame).toHaveTextContent("Turn 1");
    expect(frame).toHaveTextContent("Ruti");
    expect(frame).toHaveTextContent("Rolled 4 and 5");
  });
});

describe("stepping back through the game", () => {
  it("takes the square's owner off the board again", async () => {
    await openedAtTheEnd();

    // At the end, Ruti owns square 9 — `property_acquired` said so.
    expect(within(replayCell(9)).getByTestId("ownership-marker")).toBeInTheDocument();

    // Two steps back is *before* the purchase: the token is standing there and nobody owns it.
    await userEvent.click(screen.getByTestId("replay-back"));
    await userEvent.click(screen.getByTestId("replay-back"));

    expect(screen.getByTestId("replay-position")).toHaveTextContent("Event 3 of 5");
    expect(within(replayCell(9)).queryByTestId("ownership-marker")).toBeNull();
    expect(within(replayCell(9)).getByTestId("token-cluster")).toBeInTheDocument();
  });

  it("shortens the written history to match", async () => {
    await openedAtTheEnd();
    expect(screen.getByText("Ruti bought Connecticut Avenue for 100.")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("replay-back"));
    await userEvent.click(screen.getByTestId("replay-back"));

    // The move is still in the history; the purchase has not happened yet.
    expect(screen.getByText("Ruti moved to Connecticut Avenue.")).toBeInTheDocument();
    expect(screen.queryByText("Ruti bought Connecticut Avenue for 100.")).toBeNull();
  });

  it("empties the board completely at position zero", async () => {
    await openedAtTheEnd();
    await userEvent.click(screen.getByTestId("replay-first"));

    expect(screen.getByTestId("replay-position")).toHaveTextContent("Event 0 of 5");
    // No token anywhere: no `token_moved` has been folded in, and seeding the start of a game from
    // board data would be the viewer asserting a fact nothing gave it.
    expect(document.querySelectorAll('[data-testid="token-cluster"]')).toHaveLength(0);
    expect(screen.getByTestId("replay-nothing-yet")).toBeInTheDocument();
    // The history is empty too, and says so in the log's own words.
    expect(screen.getByText("Nothing yet. Roll the dice to start the story.")).toBeInTheDocument();
  });
});

describe("the seat list", () => {
  it("shows the square and the balance the events stated", async () => {
    await openedAtTheEnd();
    const ruti = seatRow(0);
    expect(within(ruti).getByTestId("replay-seat-square")).toHaveTextContent("Connecticut Avenue");
    expect(within(ruti).getByTestId("replay-seat-cash")).toHaveTextContent("1400");
  });

  it("says 'not said yet' for a seat no event has mentioned", async () => {
    await openedAtTheEnd();
    // Dan is in the game and no event in this log names him. The honest answer is that the log has
    // not said where he is or what he holds — *not* square 0 with 1500, which is what reading the
    // current projection (or a plausible default) would print.
    const dan = seatRow(1);
    expect(within(dan).getByTestId("replay-seat-square")).toHaveTextContent("not said yet");
    expect(within(dan).getByTestId("replay-seat-cash")).toHaveTextContent("not said yet");
  });

  it("forgets the balance again when stepped back before the payment", async () => {
    await openedAtTheEnd();
    await userEvent.click(screen.getByTestId("replay-back"));
    expect(within(seatRow(0)).getByTestId("replay-seat-cash")).toHaveTextContent("not said yet");
  });
});

describe("the panel itself", () => {
  it("is a modal dialog that can be left", async () => {
    const harness = await openedAtTheEnd();
    const dialog = screen.getByRole("dialog", { name: "Replay" });
    expect(dialog).toHaveAttribute("aria-modal", "true");

    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(harness.closes).toEqual([1]);
  });

  it("has no live region of its own", async () => {
    // The one `<Announcer>` at the root owns narration (GAP D1/G-54). A replay stepping through 96
    // events beside a second live region would be the double-speak defect at ninety-six times the
    // volume.
    const harness = await openedAtTheEnd();
    expect(harness.container.querySelectorAll("[aria-live]")).toHaveLength(0);
    expect(
      harness.container.querySelectorAll('[role="status"], [role="alert"], [role="log"]'),
    ).toHaveLength(0);
  });

  it("is axe clean, loading and loaded", async () => {
    const loading = mount("hang");
    await expectAxeClean(loading.container);
    loading.container.remove();

    const loaded = mount({ status: 200, body: viewWithLog(LOG) });
    await screen.findByTestId("replay-position");
    await waitFor(() => {
      expect(screen.getByTestId("replay-board-grid")).toBeInTheDocument();
    });
    await expectAxeClean(loaded.container);
  });
});
