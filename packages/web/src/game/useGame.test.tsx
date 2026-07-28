import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiClient } from "@/api";
import type { ApiError, LoggedEvent, SocketLike } from "@/api";
import { loggedEvent, makePlayer, makeState, makeView, ROLL_DICE } from "@/test/fixtures";

import { GameProvider } from "./GameProvider";
import { useGame } from "./useGame";

/**
 * The claim under test is "the view updates from the server's response, never from a guess".
 * A client that patched cash optimistically would pass a naive render test and be holding a
 * copy of the reducer, so the assertions here are specifically about *where* the number came
 * from: the fake server answers with a cash figure no arithmetic in this package could have
 * produced, and the screen has to show that one.
 */

class FakeSocket implements SocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;

  close(): void {
    this.onclose?.({ code: 1000, reason: "", wasClean: true });
  }

  push(frame: LoggedEvent): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

let sockets: FakeSocket[] = [];

function Probe(): React.JSX.Element {
  const { state, board, legalCommands, send, events, status } = useGame();
  return (
    <div>
      <p data-testid="cash">{state === undefined ? "-" : String(state.players[0]?.cash)}</p>
      <p data-testid="tiles">{board === undefined ? "-" : String(board.tiles.length)}</p>
      <p data-testid="commands">{legalCommands.map((command) => command.kind).join(",")}</p>
      <p data-testid="events">{events.map((entry) => entry.seq).join(",")}</p>
      <p data-testid="connection">{status.connection.state}</p>
      <p data-testid="cursor">{String(status.cursor)}</p>
      <p data-testid="error">{status.error?.reasonKey ?? ""}</p>
      {legalCommands.map((command) => (
        <button
          key={command.kind}
          type="button"
          onClick={() => {
            void send(command).catch(() => undefined);
          }}
        >
          {command.kind}
        </button>
      ))}
    </div>
  );
}

function renderGame(fetchImpl: ReturnType<typeof vi.fn>): void {
  const client = new ApiClient({
    fetch: fetchImpl as never,
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
        <Probe />
      </GameProvider>
    </QueryClientProvider>,
  );
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  sockets = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useGame", () => {
  it("renders the projection the server sent, board and legal commands included", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(json(200, makeView({ legal_commands: [ROLL_DICE], event_cursor: 0 }))),
      );

    renderGame(fetchImpl);

    // The probe renders "-" until a view arrives, so this waits on the content rather than on
    // the element — `findByTestId` would resolve on the placeholder.
    await waitFor(() => {
      expect(screen.getByTestId("cash")).toHaveTextContent("1500");
    });
    expect(screen.getByTestId("tiles")).toHaveTextContent("3");
    expect(screen.getByTestId("commands")).toHaveTextContent("roll_dice");
  });

  it("hands legal_commands over verbatim rather than filtering them", async () => {
    const commands = [ROLL_DICE, { kind: "declare_bankruptcy", player: 0 } as const];
    const fetchImpl = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(json(200, makeView({ legal_commands: [...commands] }))),
      );

    renderGame(fetchImpl);

    // Bankruptcy while holding 1500 in cash is exactly the command a client tempted to
    // "help" would hide. The engine offered it, so it is offered (ADR-005).
    await waitFor(() => {
      expect(screen.getByTestId("commands")).toHaveTextContent("roll_dice,declare_bankruptcy");
    });
  });

  it("takes the post-command state from the response, not from a local patch", async () => {
    const opening = makeView({ legal_commands: [ROLL_DICE] });
    // 1337 is not derivable from anything the client holds — if it appears, it came from the
    // server. A patched-cash implementation would show 1500 or 1500 minus something.
    const applied = makeView({
      state: makeState({ players: [makePlayer(0, { name: "Ruti", cash: 1337 }), makePlayer(1)] }),
      legal_commands: [],
      events: [loggedEvent(1, { type: "turn_started", player: 0, turn_number: 1 })],
      event_cursor: 1,
    });
    const fetchImpl = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Promise.resolve(json(200, applied));
      }
      return Promise.resolve(json(200, opening));
    });

    renderGame(fetchImpl);
    const button = await screen.findByRole("button", { name: "roll_dice" });
    await userEvent.click(button);

    await waitFor(() => {
      expect(screen.getByTestId("cash")).toHaveTextContent("1337");
    });
    // The command's events reached the queue, so the narration and the animation script see
    // them without a second round trip.
    expect(screen.getByTestId("events")).toHaveTextContent("1");
    expect(screen.getByTestId("cursor")).toHaveTextContent("1");
  });

  it("does not change state while a command is in flight", async () => {
    let resolvePost: ((response: Response) => void) | undefined;
    const fetchImpl = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Promise<Response>((resolve) => {
          resolvePost = resolve;
        });
      }
      return Promise.resolve(json(200, makeView({ legal_commands: [ROLL_DICE] })));
    });

    renderGame(fetchImpl);
    await userEvent.click(await screen.findByRole("button", { name: "roll_dice" }));

    // Mid-flight: the engine has not answered, so nothing has happened yet.
    expect(screen.getByTestId("cash")).toHaveTextContent("1500");
    expect(screen.getByTestId("commands")).toHaveTextContent("roll_dice");
    resolvePost?.(json(200, makeView({ legal_commands: [] })));
  });

  it("surfaces a rejected command as a key and params, never as prose", async () => {
    const fetchImpl = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Promise.resolve(
          json(422, { reason_key: "error.not_your_turn", params: { player: 1 } }),
        );
      }
      return Promise.resolve(json(200, makeView({ legal_commands: [ROLL_DICE] })));
    });

    renderGame(fetchImpl);
    await userEvent.click(await screen.findByRole("button", { name: "roll_dice" }));

    await waitFor(() => {
      expect(screen.getByTestId("error")).toHaveTextContent("error.not_your_turn");
    });
  });

  it("re-reads the view from the server when a socket frame says something happened", async () => {
    const opening = makeView({ legal_commands: [ROLL_DICE], event_cursor: 0 });
    const afterBot = makeView({
      state: makeState({ players: [makePlayer(0, { name: "Ruti", cash: 1200 }), makePlayer(1)] }),
      event_cursor: 3,
    });
    let served = 0;
    const fetchImpl = vi.fn().mockImplementation(() => {
      served += 1;
      return Promise.resolve(json(200, served === 1 ? opening : afterBot));
    });

    renderGame(fetchImpl);
    await screen.findByRole("button", { name: "roll_dice" });

    // A bot moved. The frame says *what* happened; the refetch says what is now true.
    act(() => {
      sockets[0]?.push(
        loggedEvent(3, {
          type: "cash_changed",
          player: 0,
          delta: -300,
          reason: "rent",
          balance: 1200,
          counterparty: 1,
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("cash")).toHaveTextContent("1200");
    });
    expect(screen.getByTestId("events")).toHaveTextContent("3");
  });

  it("opens the subscription at the cursor and keeps the game when the socket drops", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(json(200, makeView())));

    renderGame(fetchImpl);
    await waitFor(() => {
      expect(screen.getByTestId("cash")).toHaveTextContent("1500");
    });

    act(() => {
      sockets[0]?.onclose?.({ code: 1006, reason: "", wasClean: false });
    });

    // The state is untouched by a disconnect: a socket is a mailbox, not a source of truth.
    expect(screen.getByTestId("cash")).toHaveTextContent("1500");
    expect(screen.getByTestId("connection")).toHaveTextContent("reconnecting");
  });

  it("reports a failed first fetch as a key", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(json(404, { reason_key: "error.game_not_found", params: {} })),
      );

    renderGame(fetchImpl);

    await waitFor(() => {
      expect(screen.getByTestId("error")).toHaveTextContent("error.game_not_found");
    });
  });

  it("refuses to run outside a provider rather than inventing an empty game", () => {
    const queryClient = new QueryClient();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => {
      render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      );
    }).toThrow(/GameProvider/);
  });
});

describe("useGame's error typing", () => {
  it("carries the params through to the caller, not only the key", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          json(422, { reason_key: "error.insufficient_funds", params: { short: 40 } }),
        ),
      );
    const seen: (ApiError | undefined)[] = [];

    function Capture(): React.JSX.Element {
      const { status } = useGame();
      seen.push(status.error);
      return <p>{status.error?.reasonKey ?? "none"}</p>;
    }

    const client = new ApiClient({
      fetch: fetchImpl as never,
      origin: "http://kesef.test/",
      createSocket: () => new FakeSocket(),
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <GameProvider gameId="g1" client={client}>
          <Capture />
        </GameProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText("error.insufficient_funds")).toBeInTheDocument();
    });
    expect(seen.at(-1)?.params).toEqual({ short: 40 });
  });
});
