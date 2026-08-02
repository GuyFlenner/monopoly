import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ApiClient, ApiError, EventSocket, isApiError } from "@/api";

import type { PyBridge } from "./bridge";
import { LOAD_STAGES } from "./engine";
import { createFakeBridge, envelope } from "./fixtures";
import { localApiClient } from "./index";
import { LocalEngineGate } from "./LocalEngineGate";

/**
 * The whole local transport, driven through the *real* `ApiClient` and the *real* `EventSocket`.
 *
 * The point of testing at this level rather than one layer down: MON-805's central claim is that
 * nothing above `src/local` changes, and the way to check a claim about unchanged code is to run it.
 * So these tests call `client.createGame`, read `client.saveGame`'s typed answer and catch
 * `ApiError`s out of the same `catch` a panel would — with a fake Python side underneath and no
 * server, no WebSocket and no Pyodide anywhere.
 */

async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await Promise.resolve();
  }
}

const SEATS = [
  { name: "Ruti", token: "cat", is_bot: false, bot_level: null, grammatical_gender: "f" as const },
  { name: "Dan", token: "dog", is_bot: false, bot_level: null, grammatical_gender: "m" as const },
];

const NEW_GAME = {
  seats: SEATS,
  board_id: "classic",
  ruleset: "universal" as const,
  house_rules: {},
  locale: "he",
  seed: 7,
  game_id: null,
};

describe("an ApiClient wired to the local transport", () => {
  it("creates a game and reads the view back out of the response", async () => {
    const bridge = createFakeBridge();
    const created = await localApiClient(bridge).createGame(NEW_GAME);

    expect(created.state.game_id).toBe("g1");
    expect(bridge.calls[0]?.fn).toBe("createGame");
    expect(JSON.parse(bridge.calls[0]?.args[0] as string)).toMatchObject({
      seed: 7,
      board_id: "classic",
    });
  });

  it("throws a keyed ApiError for a refusal, exactly as it does against the server", async () => {
    const bridge = createFakeBridge({
      answers: {
        submitCommand: () =>
          envelope(422, { reason_key: "error.insufficient_funds", params: { short_by: 40 } }),
      },
    });

    const failure = await localApiClient(bridge)
      .submitCommand("g1", { kind: "roll_dice", player: 0 })
      .catch((cause: unknown) => cause);

    expect(isApiError(failure)).toBe(true);
    const error = failure as ApiError;
    expect(error.status).toBe(422);
    expect(error.reasonKey).toBe("error.insufficient_funds");
    expect(error.params).toEqual({ short_by: 40 });
  });

  it("throws error.network for a 404 whose body is not the declared shape", async () => {
    const bridge = createFakeBridge({
      answers: { getGame: () => envelope(404, "<html>gone</html>") },
    });
    const failure = (await localApiClient(bridge)
      .getGame("g1")
      .catch((cause: unknown) => cause)) as ApiError;
    expect([failure.status, failure.reasonKey]).toEqual([404, "error.network"]);
  });

  it("resolves a delete, which is the one 204 on the whole surface", async () => {
    await expect(localApiClient(createFakeBridge()).deleteGame("g1")).resolves.toBeUndefined();
  });

  it("returns the save file with the hidden information the projection withholds", async () => {
    const saved = await localApiClient(createFakeBridge()).saveGame("g1");
    expect(saved).toMatchObject({ game_id: "g1", rng: { seed: 1 } });
  });

  it("starts the bot pump after a command, and the frames arrive on the event stream", async () => {
    const bridge = createFakeBridge({ botMoves: 2 });
    const client = localApiClient(bridge);

    const frames: { seq: number }[] = [];
    const socket = new EventSocket({
      open: (since) => client.openEventStream("g1", since),
      cursor: () => frames.reduce((highest, frame) => Math.max(highest, frame.seq), 0),
      onFrames: (arrived) => {
        frames.push(...arrived.map((frame) => ({ seq: frame.seq })));
      },
    });
    socket.start();
    await settle();

    await client.submitCommand("g1", { kind: "end_turn", player: 0, elapsed_seconds: 0 });
    await settle();
    socket.stop();

    expect(bridge.steps()).toBe(2);
    expect(frames.map((frame) => frame.seq)).toEqual([1, 2, 3, 4]);
  });

  it("pumps after a game is created too, so a computer in seat one does not look broken", async () => {
    const bridge = createFakeBridge({ botMoves: 1 });
    await localApiClient(bridge).createGame(NEW_GAME);
    await settle();
    expect(bridge.steps()).toBe(1);
  });

  it("does not pump for a read, however many reads there are", async () => {
    const bridge = createFakeBridge({ botMoves: 5 });
    const client = localApiClient(bridge);
    await client.listBoards();
    await client.listRulesets();
    await client.getGame("g1", 0);
    await client.validateCommand("g1", { kind: "roll_dice", player: 0 });
    await settle();
    expect(bridge.steps()).toBe(0);
  });

  it("does not make the caller wait for the bots", async () => {
    // MON-304's requirement, restated on this transport: the response is the human's own move, and
    // a pump awaited inside `fetch` would make ending a turn beside a computer feel like a stall.
    // The bot steps are slowed here on purpose — with an instant fake, "did not wait" and "was
    // fast enough that it did not matter" are the same observation, and only one of them is a test.
    const order: string[] = [];
    const inner = createFakeBridge({ botMoves: 1 });
    const bridge: PyBridge = {
      ...inner,
      advanceBotsStep: async (gameId) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push("bot step");
        return inner.advanceBotsStep(gameId);
      },
    };

    await localApiClient(bridge).submitCommand("g1", {
      kind: "end_turn",
      player: 0,
      elapsed_seconds: 0,
    });
    order.push("the command's own answer");
    await new Promise((resolve) => setTimeout(resolve, 40));

    // One move and then the step that reports done — both after the caller was already served.
    expect(order).toEqual(["the command's own answer", "bot step", "bot step"]);
  });

  it("closes the stream with a terminal code when the game is gone, so it does not retry forever", async () => {
    const bridge = createFakeBridge({ missing: true });
    const client = localApiClient(bridge);
    const socket = new EventSocket({
      open: (since) => client.openEventStream("gone", since),
      cursor: () => 0,
      onFrames: vi.fn(),
    });
    socket.start();
    await settle();

    expect(socket.status.state).toBe("closed");
    expect(socket.status.closeCode).toBe(4404);
    expect(socket.status.reasonKey).toBe("error.game_not_found");
  });
});

describe("the loading gate", () => {
  it("shows the stage it is on, then hands the client over", async () => {
    let announce: ((key: string) => void) | undefined;
    const client = new ApiClient();
    const start = vi.fn(async (options: { onProgress?: (key: string) => void }) => {
      announce = options.onProgress;
      await Promise.resolve();
      return client;
    });

    render(
      <LocalEngineGate start={start}>
        {(ready) => <p>{ready === client ? "ready" : "wrong client"}</p>}
      </LocalEngineGate>,
    );

    // The first stage is on screen before anything resolves, and it is a translated sentence rather
    // than the key itself — which is what proves both catalogues carry it.
    expect(screen.getByText(/python/i)).toBeInTheDocument();
    act(() => {
      announce?.(LOAD_STAGES.rules);
    });
    expect(screen.getByText("Loading the rules…")).toBeInTheDocument();
    expect(await screen.findByText("ready")).toBeInTheDocument();
  });

  it("reports a failure with a key and offers a retry that actually retries", async () => {
    const client = new ApiClient();
    const start = vi
      .fn(() => Promise.resolve(client))
      .mockRejectedValueOnce(new Error("the CDN was unreachable"))
      .mockResolvedValueOnce(client);
    // The cause is logged for a developer, not rendered; the console noise is not the assertion.
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(<LocalEngineGate start={start}>{() => <p>ready</p>}</LocalEngineGate>);

    const retry = await screen.findByRole("button", { name: /try again/i });
    expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument();
    expect(screen.queryByText("the CDN was unreachable")).not.toBeInTheDocument();

    await userEvent.click(retry);
    expect(await screen.findByText("ready")).toBeInTheDocument();
    expect(start).toHaveBeenCalledTimes(2);
    logged.mockRestore();
  });

  it("does not restart a multi-megabyte download when its parent re-renders", async () => {
    const client = new ApiClient();
    const start = vi.fn(() => Promise.resolve(client));
    const { rerender } = render(
      <LocalEngineGate start={start}>{() => <p>ready</p>}</LocalEngineGate>,
    );
    // A fresh arrow function each time, which is what a caller writing `start={() => …}` produces.
    rerender(
      <LocalEngineGate start={() => Promise.resolve(client)}>{() => <p>ready</p>}</LocalEngineGate>,
    );
    expect(await screen.findByText("ready")).toBeInTheDocument();
    expect(start).toHaveBeenCalledTimes(1);
  });
});
