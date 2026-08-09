import { describe, expect, it, vi } from "vitest";

import { createLocalFetch } from "./localFetch";
import { createFakeBridge, envelope } from "./fixtures";

/**
 * The route table, and the two things that make it worth having.
 *
 * 1. **`ApiClient`'s paths reach the right facade call.** Every path here is copied from
 *    `api/client.ts`, so a route renamed there and not here is a 404 in production and a failure
 *    in this file. That is the only reason to spell the URLs out rather than build them from the
 *    client.
 * 2. **A refusal stays a refusal.** The status and the `{reason_key, params}` body are the facade's
 *    verbatim, because `client.ts` builds its `ApiError` out of exactly those two and nothing above
 *    it can tell which transport it is talking to.
 */

function fetchWith(...args: Parameters<typeof createFakeBridge>): {
  localFetch: ReturnType<typeof createLocalFetch>;
  bridge: ReturnType<typeof createFakeBridge>;
} {
  const bridge = createFakeBridge(...args);
  return { localFetch: createLocalFetch(bridge), bridge };
}

describe("the route table", () => {
  it.each([
    ["GET", "/api/boards", "listBoards", []],
    ["GET", "/api/rulesets", "listRulesets", []],
    // `""` is the seat credential this request carried, i.e. none (ADR-012). It is always passed
    // and never `null` — see `bridge.ts` — and it sits before the parameters that get omitted.
    ["GET", "/api/games/g1", "getGame", ["g1", "", null]],
    ["GET", "/api/games/g1?since=7", "getGame", ["g1", "", "7"]],
    ["GET", "/api/games/g1?since=0", "getGame", ["g1", "", "0"]],
    ["GET", "/api/games/g1/save", "saveGame", ["g1", ""]],
    ["DELETE", "/api/games/g1", "deleteGame", ["g1", ""]],
    ["POST", "/api/games/g1/seats/2/claim", "claimSeat", ["g1", 2]],
    ["DELETE", "/api/games/g1/seats/2/claim", "releaseSeat", ["g1", 2, ""]],
  ])("routes %s %s to %s", async (method, path, fn, args) => {
    const { localFetch, bridge } = fetchWith();
    await localFetch(path, { method });
    expect(bridge.calls).toEqual([{ fn, args }]);
  });

  it("forwards a POST body verbatim, because the facade validates it, not this file", async () => {
    const { localFetch, bridge } = fetchWith();
    const body = JSON.stringify({ command: { kind: "roll_dice", player: 0 } });
    await localFetch("/api/games/g1/commands", { method: "POST", body });
    await localFetch("/api/games/g1/validate", { method: "POST", body });
    await localFetch("/api/games", { method: "POST", body: JSON.stringify({ seats: [] }) });
    await localFetch("/api/games/load", {
      method: "POST",
      body: JSON.stringify({ game_id: "g1" }),
    });

    expect(bridge.calls).toEqual([
      { fn: "submitCommand", args: ["g1", body, ""] },
      { fn: "validateCommand", args: ["g1", body, ""] },
      { fn: "createGame", args: [JSON.stringify({ seats: [] })] },
      // `null` is the absent `?if_exists=`, forwarded present-or-absent exactly as `?since=` is:
      // the facade defaults it to "refuse", so this file never picks a conflict policy (ADR-011).
      { fn: "loadGame", args: [JSON.stringify({ game_id: "g1" }), "", null] },
    ]);
  });

  it("distinguishes an omitted cursor from a zero one, because they are different answers", async () => {
    const { localFetch, bridge } = fetchWith();
    await localFetch("/api/games/g1");
    await localFetch("/api/games/g1?since=0");
    expect(bridge.calls.map((call) => call.args[2])).toEqual([null, "0"]);
  });

  it("passes a nonsense cursor through, so the facade refuses it with the same key HTTP does", async () => {
    const { localFetch, bridge } = fetchWith();
    await localFetch("/api/games/g1?since=nonsense");
    expect(bridge.calls[0]?.args[2]).toBe("nonsense");
  });

  it("decodes a game id the client percent-encoded", async () => {
    const { localFetch, bridge } = fetchWith();
    await localFetch(`/api/games/${encodeURIComponent("a b.c")}`);
    expect(bridge.calls[0]?.args[0]).toBe("a b.c");
  });

  it("honours a non-default base path, since ApiClient's is configurable", async () => {
    const bridge = createFakeBridge();
    const localFetch = createLocalFetch(bridge, { basePath: "/engine/" });
    await localFetch("/engine/boards");
    expect(bridge.calls).toEqual([{ fn: "listBoards", args: [] }]);
  });
});

describe("what comes back", () => {
  it("carries the facade's status and keyed body straight through", async () => {
    const refusal = { reason_key: "error.not_your_turn", params: { player: 1 } };
    const bridge = createFakeBridge({ answers: { submitCommand: () => envelope(422, refusal) } });
    const response = await createLocalFetch(bridge)("/api/games/g1/commands", {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual(refusal);
  });

  it("answers a 204 with a null body, which is what a delete has to be", async () => {
    // `new Response(body, {status: 204})` throws on a non-null body, and that `TypeError` would
    // reach `client.ts` as `error.network` — a successful delete reported as a network failure.
    const { localFetch } = fetchWith();
    const response = await localFetch("/api/games/g1", { method: "DELETE" });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("reports an unroutable path as a keyed 404, not as an exception", async () => {
    const { localFetch } = fetchWith();
    const response = await localFetch("/api/nonesuch");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      reason_key: "error.not_found",
      params: { status: 404 },
    });
  });

  it("reports a wrong method on a known path as a keyed 405", async () => {
    const { localFetch } = fetchWith();
    const response = await localFetch("/api/boards", { method: "POST" });
    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({
      reason_key: "error.method_not_allowed",
      params: { status: 405 },
    });
  });

  it("has no route that lists the live games, in either transport", async () => {
    // MON-909: `GET /games` enumerated every live game id, and nothing ever called it. `/games` is
    // still a known path because `POST` creates, so the answer is the same keyed 405 the HTTP app
    // now gives — and no call reaches the bridge.
    const { localFetch, bridge } = fetchWith();
    const response = await localFetch("/api/games");
    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({
      reason_key: "error.method_not_allowed",
      params: { status: 405 },
    });
    expect(bridge.calls).toEqual([]);
  });

  it("treats GET /games/load as a game called load, exactly as starlette's router does", async () => {
    // Not a 405. `/games/{game_id}` is a full match for that path and method, so the answer is the
    // ordinary `error.game_not_found` — one of the small places where mirroring beats being tidy.
    const { localFetch, bridge } = fetchWith();
    await localFetch("/api/games/load");
    expect(bridge.calls).toEqual([{ fn: "getGame", args: ["load", "", null] }]);
  });

  it("turns a broken bridge into a bodiless 500 rather than a thrown error", async () => {
    const bridge = createFakeBridge({ answers: { listBoards: () => "the runtime died" } });
    const response = await createLocalFetch(bridge)("/api/boards");
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("");
  });
});

describe("the bot pump's trigger", () => {
  it("fires for the three routes that can hand the table to a computer, and no others", async () => {
    const onMutation = vi.fn();
    const bridge = createFakeBridge();
    const localFetch = createLocalFetch(bridge, { onMutation });

    await localFetch("/api/games", { method: "POST", body: "{}" });
    await localFetch("/api/games/load", { method: "POST", body: "{}" });
    await localFetch("/api/games/g7/commands", { method: "POST", body: "{}" });

    expect(onMutation.mock.calls).toEqual([["g1"], ["g1"], ["g7"]]);

    onMutation.mockClear();
    await localFetch("/api/games/g7");
    await localFetch("/api/games/g7/save");
    await localFetch("/api/games/g7/validate", { method: "POST", body: "{}" });
    await localFetch("/api/games/g7", { method: "DELETE" });
    expect(onMutation).not.toHaveBeenCalled();
  });

  it("does not fire when the command was refused", async () => {
    const onMutation = vi.fn();
    const bridge = createFakeBridge({
      answers: { submitCommand: () => envelope(422, { reason_key: "error.not_your_turn" }) },
    });
    await createLocalFetch(bridge, { onMutation })("/api/games/g1/commands", {
      method: "POST",
      body: "{}",
    });
    expect(onMutation).not.toHaveBeenCalled();
  });

  it("does not fire when a creation answered something that is not a view", async () => {
    const onMutation = vi.fn();
    const bridge = createFakeBridge({
      answers: { createGame: () => envelope(201, { unexpected: true }) },
    });
    await createLocalFetch(bridge, { onMutation })("/api/games", { method: "POST", body: "{}" });
    expect(onMutation).not.toHaveBeenCalled();
  });
});

describe("aborting", () => {
  it("rejects an already-aborted request instead of performing it", async () => {
    const { localFetch, bridge } = fetchWith();
    const controller = new AbortController();
    controller.abort();

    await expect(localFetch("/api/boards", { signal: controller.signal })).rejects.toThrow();
    expect(bridge.calls).toEqual([]);
  });

  it("rejects a request aborted while the facade was working", async () => {
    const controller = new AbortController();
    const bridge = createFakeBridge({
      answers: {
        listBoards: () => {
          controller.abort();
          return envelope(200, []);
        },
      },
    });
    await expect(
      createLocalFetch(bridge)("/api/boards", { signal: controller.signal }),
    ).rejects.toThrow();
  });
});

/**
 * The credential, moved across the language boundary and never inspected (ADR-012, MON-906).
 *
 * `localFetch` is the *only* place a `Bearer` header becomes a facade argument, so a header this
 * file failed to read would leave the in-tab engine treating its own player as a spectator — a
 * failure that no server-side test can see and that the HTTP transport does not share.
 */
describe("the seat credential", () => {
  it("lifts Authorization: Bearer off the request and hands it to the facade", async () => {
    const { localFetch, bridge } = fetchWith();

    await localFetch("/api/games/g1", { headers: { authorization: "Bearer s3cret" } });

    expect(bridge.calls).toEqual([{ fn: "getGame", args: ["g1", "s3cret", null] }]);
  });

  it("reads the scheme case-insensitively, as a header parser must", async () => {
    const { localFetch, bridge } = fetchWith();

    await localFetch("/api/games/g1", { headers: { Authorization: "bearer s3cret" } });

    expect(bridge.calls[0]?.args[1]).toBe("s3cret");
  });

  it("treats a scheme this API does not serve as no credential at all", async () => {
    // The same answer `api.secret_of` gives: a spectator, rather than a refusal explaining how to
    // authenticate. There is nothing a client could usefully do differently.
    const { localFetch, bridge } = fetchWith();

    await localFetch("/api/games/g1", { headers: { authorization: "Basic hunter2" } });

    expect(bridge.calls[0]?.args[1]).toBe("");
  });

  it("carries it on every route that has an authority dimension", async () => {
    const { localFetch, bridge } = fetchWith();
    const headers = { authorization: "Bearer s3cret" };
    const body = JSON.stringify({ command: { kind: "roll_dice", player: 0 } });

    await localFetch("/api/games/g1/commands", { method: "POST", body, headers });
    await localFetch("/api/games/g1/validate", { method: "POST", body, headers });
    await localFetch("/api/games/g1/save", { headers });
    await localFetch("/api/games/g1", { method: "DELETE", headers });
    await localFetch("/api/games/g1/seats/1/claim", { method: "DELETE", headers });

    expect(bridge.calls.map((call) => call.args.at(-1))).toEqual([
      "s3cret",
      "s3cret",
      "s3cret",
      "s3cret",
      "s3cret",
    ]);
  });

  it("starts the bot pump from the view inside a GameCreated envelope", async () => {
    // `POST /games` answers `{host_secret, view}` since ADR-012, so the game id moved one level
    // down. Read from the wrong place, `onMutation` is never called and a game seated with a bot in
    // seat one opens waiting for a computer that is never asked to move.
    const bridge = createFakeBridge();
    const mutated: string[] = [];
    const localFetch = createLocalFetch(bridge, {
      onMutation: (gameId) => mutated.push(gameId),
    });

    await localFetch("/api/games", { method: "POST", body: JSON.stringify({ seats: [] }) });

    expect(mutated).toEqual(["g1"]);
  });
});
