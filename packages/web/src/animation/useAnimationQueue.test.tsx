/**
 * The hook, the feed, and the one criterion that has to be proved rather than asserted.
 *
 * ## The falsifier: nothing blocks input, ever
 *
 * "A player can always act" is the kind of claim every implementation passes until the day somebody
 * adds `disabled={motion.playing}` to be tidy. So the central test here mounts a real
 * `<GameProvider>` over a fake edge, rolls, waits until a piece is provably **mid-walk** — the drawn
 * position is neither where it started nor where it ends — and then sends a second command from that
 * exact moment, asserting the server received it. It is not a test that a button was enabled; it is a
 * test that the round trip completed while the board was moving.
 *
 * The second falsifier is about replay. A reload is handed the whole game in one batch and a
 * reconnect is pushed a backlog; animating either would show a player a cartoon of a game that has
 * already finished. `isReplay` is unit-tested on its own, and the mounted test asserts that a
 * forty-event first batch leaves the queue idle immediately rather than walking forty squares.
 *
 * ## The clock is injected; the timers are real
 *
 * `useAnimationQueue` takes a `now`, so a walk can be held mid-flight for as long as an assertion
 * needs by simply not advancing it. The hook's own `setTimeout` stays real and is what notices the
 * change, which is why every step below waits on an *observable* rather than on a sleep — there is no
 * fixed delay in this file to be too short on a slow machine.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { ApiClient, type LoggedEvent, type SocketLike } from "@/api";
import { GameProvider, useGame } from "@/game";
import { loggedEvent, makePlayer, makeState, makeView, ROLL_DICE } from "@/test/fixtures";

import { isReplay, useAnimationQueue } from "./useAnimationQueue";

/** How long an assertion will wait for the hook's own timer to notice the clock moved. */
const SETTLE = { timeout: 4000 } as const;

class SilentSocket implements SocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  close(): void {
    this.onclose?.({ code: 1000, reason: "", wasClean: true });
  }
}

/** The clock the test moves by hand. */
let clock = 0;
const now = (): number => clock;

function moveEvent(seq: number, player: number, from: number, to: number): LoggedEvent {
  return loggedEvent(seq, {
    type: "token_moved",
    player,
    from_tile: from,
    to_tile: to,
    forward: true,
    passed_go: false,
  });
}

/**
 * The subject: the queue's overrides on screen, and a button that sends a command.
 *
 * The button is deliberately *not* conditioned on anything the hook returns. That is the point — a
 * probe that hid its own button while animating would be testing the probe.
 */
function Probe(): React.JSX.Element {
  const { state, legalCommands, send } = useGame();
  const motion = useAnimationQueue({ now });
  const truth = state?.players[0]?.position ?? -1;

  return (
    <div>
      <p data-testid="drawn">{String(motion.tokens.get(0) ?? truth)}</p>
      <p data-testid="truth">{String(truth)}</p>
      <p data-testid="remaining">{String(motion.remaining)}</p>
      <p data-testid="dice-beat">{String(motion.dice)}</p>
      <p data-testid="card">{motion.card?.cardId ?? "none"}</p>
      <button
        type="button"
        onClick={() => {
          const command = legalCommands[0];
          if (command !== undefined) {
            void send(command).catch(() => undefined);
          }
        }}
      >
        act
      </button>
      <button
        type="button"
        onClick={() => {
          motion.skip();
        }}
      >
        skip
      </button>
    </div>
  );
}

/** Views the fake edge hands back, in order; the last one repeats. */
let responses: unknown[] = [];
let posted: unknown[] = [];

function mount(): void {
  const client = new ApiClient({
    baseUrl: "http://test",
    fetch: (_input, init) => {
      if (init?.method === "POST" && typeof init.body === "string") {
        posted.push(JSON.parse(init.body));
      }
      const body = responses.length > 1 ? responses.shift() : responses[0];
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    },
    createSocket: () => new SilentSocket(),
  });

  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <GameProvider client={client} gameId="g1">
        <Probe />
      </GameProvider>
    </QueryClientProvider>,
  );
}

/** One seat, at a known square. Every fixture here is about one piece. */
function viewAt(position: number, events: readonly LoggedEvent[]): unknown {
  return makeView({
    state: makeState({ players: [makePlayer(0, { position })], current_player_id: 0 }),
    events: [...events],
    legal_commands: [ROLL_DICE],
  });
}

/** The square the piece is being drawn on, as text. */
function drawn(): string {
  return screen.getByTestId("drawn").textContent;
}

beforeEach(() => {
  clock = 0;
  responses = [];
  posted = [];
});

describe("replay is not news", () => {
  it("treats the first batch as history, however short", () => {
    // Nothing has been animated, so nothing on screen was arrived at by watching. A brand-new game's
    // setup events are history too: nobody saw them happen.
    expect(isReplay([moveEvent(1, 0, 0, 3)], 0)).toBe(true);
  });

  it("animates frames that continue where the animation left off", () => {
    expect(isReplay([moveEvent(8, 0, 0, 3)], 7)).toBe(false);
  });

  it("treats a gap as history — a walk from a square nobody saw is a journey that did not happen", () => {
    // The reconnect backlog, and the bounded log's dropped frames. Both arrive as a `seq` that does
    // not follow the last one animated.
    expect(isReplay([moveEvent(40, 0, 0, 3)], 7)).toBe(true);
  });

  it("says nothing about an empty batch", () => {
    expect(isReplay([], 0)).toBe(false);
  });

  it("leaves the board on the truth when a reload replays the whole game", async () => {
    responses = [
      viewAt(
        24,
        Array.from({ length: 40 }, (_, index) => moveEvent(index + 1, 0, index, index + 1)),
      ),
    ];
    mount();

    await waitFor(() => {
      expect(screen.getByTestId("truth")).toHaveTextContent("24");
    });
    // Forty moves, and not one square of travel: the queue drained on arrival, with the clock frozen
    // at zero — so nothing here could have been reached by time passing.
    expect(screen.getByTestId("remaining")).toHaveTextContent("0");
    expect(screen.getByTestId("drawn")).toHaveTextContent("24");
  });
});

describe("a live command", () => {
  it("settles the dice, then walks the piece square by square behind the projection", async () => {
    responses = [
      viewAt(0, [loggedEvent(1, { type: "turn_started", player: 0, turn_number: 1 })]),
      viewAt(5, [
        loggedEvent(2, {
          type: "dice_rolled",
          player: 0,
          first: 2,
          second: 3,
          total: 5,
          doubles_streak: 0,
          purpose: "move",
        }),
        moveEvent(3, 0, 0, 5),
      ]),
    ];
    mount();

    await waitFor(() => {
      expect(screen.getByTestId("truth")).toHaveTextContent("0");
    });
    await userEvent.click(screen.getByRole("button", { name: "act" }));
    await waitFor(() => {
      expect(screen.getByTestId("truth")).toHaveTextContent("5");
    });

    // The settle is first in the timeline, so the piece has not moved yet even though the projection
    // already says 5.
    expect(screen.getByTestId("dice-beat")).toHaveTextContent("1");
    expect(screen.getByTestId("drawn")).toHaveTextContent("0");

    // Through the 420 ms settle and into the first of five 90 ms squares.
    clock = 500;
    await waitFor(() => {
      expect(screen.getByTestId("drawn")).toHaveTextContent("1");
    }, SETTLE);

    // 190 ms into the walk: two whole squares crossed, standing on the third.
    clock = 610;
    await waitFor(() => {
      expect(screen.getByTestId("drawn")).toHaveTextContent("3");
    }, SETTLE);

    clock = 2000;
    await waitFor(() => {
      expect(screen.getByTestId("remaining")).toHaveTextContent("0");
    }, SETTLE);
    // Drained, so the override is gone and the projection's own figure is what shows.
    expect(screen.getByTestId("drawn")).toHaveTextContent("5");
  });
});

describe("a card drawn", () => {
  it("goes up on a live draw and comes down when its beat ends (MON-709)", async () => {
    responses = [
      viewAt(0, [loggedEvent(1, { type: "turn_started", player: 0, turn_number: 1 })]),
      viewAt(0, [
        loggedEvent(2, {
          type: "card_drawn",
          player: 0,
          deck: "chance",
          card_id: "card.chance.advance_to_go",
        }),
      ]),
    ];
    mount();

    await waitFor(() => {
      expect(screen.getByTestId("truth")).toHaveTextContent("0");
    });
    await userEvent.click(screen.getByRole("button", { name: "act" }));

    await waitFor(() => {
      expect(screen.getByTestId("card")).toHaveTextContent("card.chance.advance_to_go");
    }, SETTLE);

    // Past the dwell. The card is content, not a counter, so it must come *off* the frame — there is
    // no field in the projection behind it to keep it honest.
    clock = 5000;
    await waitFor(() => {
      expect(screen.getByTestId("card")).toHaveTextContent("none");
    }, SETTLE);
  });

  it("holds up no card when the batch is history — nobody watched that draw", async () => {
    // A reload's `since=0` replay. Reduced motion keeps a card's dwell (`plan`'s `instant`); history
    // drops the step entirely (`plan`'s `history`), and this is the hook choosing between them.
    responses = [
      viewAt(7, [
        moveEvent(1, 0, 0, 3),
        loggedEvent(2, {
          type: "card_drawn",
          player: 0,
          deck: "community_chest",
          card_id: "card.chest.doctors_fee",
        }),
        moveEvent(3, 0, 3, 7),
      ]),
    ];
    mount();

    await waitFor(() => {
      expect(screen.getByTestId("truth")).toHaveTextContent("7");
    });
    expect(screen.getByTestId("remaining")).toHaveTextContent("0");
    expect(screen.getByTestId("card")).toHaveTextContent("none");
  });
});

describe("nothing blocks input, ever", () => {
  it("accepts a command while a piece is mid-walk", async () => {
    responses = [
      viewAt(0, [loggedEvent(1, { type: "turn_started", player: 0, turn_number: 1 })]),
      viewAt(12, [moveEvent(2, 0, 0, 12)]),
      viewAt(20, [moveEvent(3, 0, 12, 20)]),
    ];
    mount();

    await waitFor(() => {
      expect(screen.getByTestId("truth")).toHaveTextContent("0");
    });
    await userEvent.click(screen.getByRole("button", { name: "act" }));
    await waitFor(() => {
      expect(screen.getByTestId("truth")).toHaveTextContent("12");
    });

    // Hold the walk at a square that is neither the start nor the end. "Mid-flight" is asserted here
    // rather than assumed, because a test that acted before the walk began would prove nothing.
    clock = 300;
    await waitFor(() => {
      expect(drawn()).not.toBe("0");
    }, SETTLE);
    expect(drawn()).not.toBe("12");
    expect(screen.getByTestId("remaining")).toHaveTextContent("1");

    // And from exactly there, act. The command has to reach the server.
    const before = posted.length;
    await userEvent.click(screen.getByRole("button", { name: "act" }));
    await waitFor(() => {
      expect(posted.length).toBeGreaterThan(before);
    });
    await waitFor(() => {
      expect(screen.getByTestId("truth")).toHaveTextContent("20");
    });
  });

  it("lands the piece on its true square when the player skips mid-walk", async () => {
    responses = [
      viewAt(0, [loggedEvent(1, { type: "turn_started", player: 0, turn_number: 1 })]),
      viewAt(12, [moveEvent(2, 0, 0, 12)]),
    ];
    mount();

    await waitFor(() => {
      expect(screen.getByTestId("truth")).toHaveTextContent("0");
    });
    await userEvent.click(screen.getByRole("button", { name: "act" }));
    await waitFor(() => {
      expect(screen.getByTestId("truth")).toHaveTextContent("12");
    });
    clock = 300;
    await waitFor(() => {
      expect(drawn()).not.toBe("0");
    }, SETTLE);
    expect(drawn()).not.toBe("12");

    await userEvent.click(screen.getByRole("button", { name: "skip" }));

    expect(screen.getByTestId("remaining")).toHaveTextContent("0");
    // Twelve because the *projection* says twelve. The queue reports nothing at all — see
    // `queue.test.ts` on why reporting a computed destination would be the bug.
    expect(screen.getByTestId("drawn")).toHaveTextContent("12");
  });
});
