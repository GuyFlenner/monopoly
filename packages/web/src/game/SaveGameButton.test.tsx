/**
 * The save affordance and its three states (MON-704, MON-708).
 *
 * The state worth the test is the third one: a save is a network request against a game the server
 * may have expired, and a button that answers that with nothing at all — appearing not to work — is
 * exactly the defect MON-708 exists to remove.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ApiClient, type SocketLike } from "@/api";
import { expectAxeClean } from "@/test/axe";
import { makeState } from "@/test/fixtures";

import { GameProvider } from "./GameProvider";
import { SaveGameButton } from "./SaveGameButton";
import type { SaveFilePort } from "./saveFile";

class FakeSocket implements SocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  close(): void {
    /* nothing to tear down in a fake */
  }
}

/**
 * The save route's body: the engine's `GameState`.
 *
 * Built from the projection plus the two things a save carries and a view does not. No fixture
 * builds a real `GameState` on purpose — nothing else in this package may read one (`api/types.ts`),
 * and only `game_id` and `turn_number` are touched here.
 */
const SAVE = { ...makeState({ game_id: "kitchen-table" }), turn_number: 9, rng: { seed: 7 } };

const GAME_GONE = { reason_key: "error.game_not_found", params: {} };

type Reply = { readonly status: number; readonly body: unknown } | "hang";

interface Harness {
  /** What the port was asked to write — the filename and bytes a player would receive. */
  readonly offered: { filename: string; json: string }[];
  readonly requests: string[];
  readonly container: HTMLElement;
  /** Change what the next request answers, so one mount can fail and then succeed. */
  readonly answer: (next: Reply) => void;
}

function mount(initial: Reply): Harness {
  let reply = initial;
  const offered: { filename: string; json: string }[] = [];
  const requests: string[] = [];
  const port: SaveFilePort = {
    save: (filename, json) => {
      offered.push({ filename, json });
    },
  };
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
      <GameProvider gameId="kitchen-table" client={client}>
        <SaveGameButton port={port} />
      </GameProvider>
    </QueryClientProvider>,
  );
  return {
    offered,
    requests,
    container,
    answer: (next) => {
      reply = next;
    },
  };
}

function saveButton(): HTMLElement {
  return screen.getByRole("button", { name: "Save this game to a file" });
}

describe("SaveGameButton", () => {
  it("downloads the save route's payload under a name carrying the turn", async () => {
    const harness = mount({ status: 200, body: SAVE });

    await userEvent.click(saveButton());

    await waitFor(() => {
      expect(harness.offered).toHaveLength(1);
    });
    expect(harness.requests).toContain("/api/games/kitchen-table/save");
    expect(harness.offered[0]?.filename).toBe("kesef-street-kitchen-table-turn-9.json");
    // The bytes are the server's answer, unaltered. Nothing in this package reads inside them —
    // this is the one payload carrying the deck order (ADR-008 §2).
    expect(JSON.parse(harness.offered[0]?.json ?? "null")).toEqual(SAVE);
  });

  it("says it is saving while the request is out", async () => {
    // A disabled button with a changed label, rather than nothing: the request goes to a server that
    // may be slow, and a second click would download the same file twice.
    mount("hang");

    await userEvent.click(saveButton());

    const saving = await screen.findByRole("button", { name: "Saving…" });
    expect(saving).toBeDisabled();
  });

  it("renders the server's key when the game has gone, and keeps the button", async () => {
    // The retry *is* the button, so the failure renders beside it rather than replacing it — a
    // message that has swallowed its own retry is a dead end.
    const harness = mount({ status: 404, body: GAME_GONE });

    await userEvent.click(saveButton());

    expect(await screen.findByText("That game no longer exists.")).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
    expect(harness.offered).toEqual([]);
  });

  it("clears a previous failure when the next save succeeds", async () => {
    // A stale error message beside a button that has since worked is a screen lying about the last
    // thing that happened.
    const harness = mount({ status: 404, body: GAME_GONE });

    await userEvent.click(saveButton());
    expect(await screen.findByText("That game no longer exists.")).toBeInTheDocument();

    harness.answer({ status: 200, body: SAVE });
    await userEvent.click(saveButton());

    await waitFor(() => {
      expect(harness.offered).toHaveLength(1);
    });
    expect(screen.queryByText("That game no longer exists.")).toBeNull();
  });

  it("is axe clean, idle and failed", async () => {
    const idle = mount("hang");
    await expectAxeClean(idle.container);
    idle.container.remove();

    const failing = mount({ status: 404, body: GAME_GONE });
    await userEvent.click(saveButton());
    await screen.findByText("That game no longer exists.");
    await expectAxeClean(failing.container);
  });
});
