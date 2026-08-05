import { describe, expect, it, vi } from "vitest";

import { ApiClient, DEFAULT_BASE_URL, defaultBaseUrl } from "./client";
import { ApiError, isApiError } from "./errors";
import type { Command, GameView } from "./types";

/**
 * What can actually break here is the error path, and it breaks silently: a client that turns
 * a keyed 422 into `new Error("Unprocessable Entity")` still "works" — every screen just shows
 * English prose from the transport for the rest of the product's life. So most of this file is
 * about `{reason_key, params}` surviving, in both directions and in the failure modes where
 * there is no such body at all.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clientWith(fetchImpl: ReturnType<typeof vi.fn>): ApiClient {
  return new ApiClient({ fetch: fetchImpl as never, origin: "http://kesef.test/" });
}

const ROLL: Command = { kind: "roll_dice", player: 0 };

const EMPTY_VIEW = { event_cursor: 0, events: [], legal_commands: [] } as unknown as GameView;

describe("ApiClient — the happy paths", () => {
  it("posts a new game as JSON to the configured base url", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, EMPTY_VIEW));

    await clientWith(fetchImpl).createGame({
      seats: [
        { name: "Ruti", token: "cat", is_bot: false, bot_level: null, grammatical_gender: "f" },
        { name: "Dan", token: "dog", is_bot: false, bot_level: null, grammatical_gender: "m" },
      ],
      board_id: "classic",
      ruleset: "universal",
      house_rules: {},
      locale: "en",
      seed: null,
      game_id: null,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/games");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toMatchObject({ board_id: "classic" });
  });

  it("passes the event cursor as ?since= and omits it when there is none", async () => {
    // A fresh Response per call: a body can only be read once, so a shared one would fail the
    // second request for a reason that has nothing to do with the cursor.
    const fetchImpl = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse(200, EMPTY_VIEW)));
    const client = clientWith(fetchImpl);

    await client.getGame("g1", 7);
    await client.getGame("g1");

    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/api/games/g1?since=7");
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("/api/games/g1");
  });

  it("wraps a command in the CommandRequest envelope the server declares", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, EMPTY_VIEW));

    await clientWith(fetchImpl).submitCommand("g1", ROLL);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/games/g1/commands");
    expect(JSON.parse(init.body as string)).toEqual({ command: ROLL });
  });

  it("reads an illegal-but-not-an-error validate answer as a 200", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { legal: false, reason_key: "error.not_your_turn", params: {} }),
      );

    const answer = await clientWith(fetchImpl).validateCommand("g1", ROLL);

    expect(answer.legal).toBe(false);
    expect(answer.reason_key).toBe("error.not_your_turn");
  });

  it("treats a 204 as a resolved delete rather than a parse failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

    await expect(clientWith(fetchImpl).deleteGame("g1")).resolves.toBeUndefined();
  });

  it("escapes a game id into the path so it cannot address another route", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, EMPTY_VIEW));

    await clientWith(fetchImpl).getGame("a/b");

    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/api/games/a%2Fb");
  });

  it("posts a save to the load route as the whole body (MON-704)", async () => {
    // The body is the `GameState` itself, not `{state: ...}` — `POST /games/load` declares the
    // schema directly (see `api.load_game`'s hand-written `openapi_extra`), so a wrapper here would
    // be a 422 on every load.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, EMPTY_VIEW));
    const save = { schema_version: 1, game_id: "kitchen-table", rng: { seed: 7 } };

    await clientWith(fetchImpl).loadGame(save);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/games/load");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(save);
  });

  it("posts whatever the file said, without vetting it first", async () => {
    // The parameter is `unknown` on purpose. Whether a document is a `GameState`, and whether its
    // `schema_version` is one the engine still reads, are the engine's questions — answered as
    // `error.save_schema_mismatch` on the far side. A validator here would be a second opinion about
    // the engine's schema held by the layer least able to keep it current.
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(422, { reason_key: "error.save_schema_mismatch", params: {} }),
      );

    const failure = await clientWith(fetchImpl)
      .loadGame({ not: "a game" })
      .catch((cause: unknown) => cause);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(isApiError(failure) && failure.reasonKey).toBe("error.save_schema_mismatch");
  });
});

describe("ApiClient — every failure is a typed key, never prose", () => {
  it("parses a 422 {reason_key, params} into an ApiError carrying both", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(422, { reason_key: "error.insufficient_funds", params: { short: 40 } }),
      );

    const failure = await clientWith(fetchImpl)
      .submitCommand("g1", ROLL)
      .catch((error: unknown) => error);

    expect(isApiError(failure)).toBe(true);
    expect(failure).toBeInstanceOf(ApiError);
    const error = failure as ApiError;
    expect(error.status).toBe(422);
    expect(error.reasonKey).toBe("error.insufficient_funds");
    // The params are the whole point of G-33: without them the catalogue entry cannot say
    // how much short, and the client would have to invent a sentence.
    expect(error.params).toEqual({ short: 40 });
    expect(typeof failure).not.toBe("string");
  });

  it("keeps the params of a 404 too, so the key can name the game", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(404, { reason_key: "error.game_not_found", params: { game_id: "g9" } }),
      );

    const error = (await clientWith(fetchImpl)
      .getGame("g9")
      .catch((cause: unknown) => cause)) as ApiError;

    expect(error.reasonKey).toBe("error.game_not_found");
    expect(error.params).toEqual({ game_id: "g9" });
  });

  it("drops a param that is neither a number nor a string rather than interpolating it", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(422, {
        reason_key: "error.illegal_move",
        params: { tile: 16, offer: { cash: 1 }, note: "x" },
      }),
    );

    const error = (await clientWith(fetchImpl)
      .submitCommand("g1", ROLL)
      .catch((cause: unknown) => cause)) as ApiError;

    // `[object Object]` in a sentence read aloud to a six-year-old is worse than a gap.
    expect(error.params).toEqual({ tile: 16, note: "x" });
  });

  it("falls back to error.network when the body is not the declared shape", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("<html>502 from a proxy</html>", { status: 502 }));

    const error = (await clientWith(fetchImpl)
      .getGame("g1")
      .catch((cause: unknown) => cause)) as ApiError;

    expect(error.reasonKey).toBe("error.network");
    // The status is kept: "answered 502 with rubbish" and "nothing answered" are different
    // diagnoses even though the player sees one sentence.
    expect(error.status).toBe(502);
  });

  it("turns a rejected fetch into an ApiError rather than letting a TypeError escape", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    const failure = await clientWith(fetchImpl)
      .listBoards()
      .catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).reasonKey).toBe("error.network");
    expect((failure as ApiError).status).toBe(0);
    expect(failure).not.toBeInstanceOf(TypeError);
  });

  it("turns a 200 with an unparseable body into an ApiError, not a SyntaxError", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("not json", { status: 200 }));

    const failure = await clientWith(fetchImpl)
      .listRulesets()
      .catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).reasonKey).toBe("error.network");
  });
});

describe("ApiClient — the event stream url", () => {
  it("builds an absolute ws:// url carrying the cursor", () => {
    const client = new ApiClient({ origin: "http://kesef.test/play" });

    expect(client.eventStreamUrl("g1", 12)).toBe("ws://kesef.test/api/games/g1/ws?since=12");
  });

  it("uses wss:// on an https page so an encrypted page cannot open a plain socket", () => {
    const client = new ApiClient({ origin: "https://kesef.test/play" });

    expect(client.eventStreamUrl("g1")).toBe("wss://kesef.test/api/games/g1/ws?since=0");
  });

  it("sends the socket to the API's own host when the API is not on this origin", () => {
    // MON-901's split deployment: the page is served from GitHub Pages, the API answers from
    // Render. `new URL(path, base)` lets the absolute base win, so the socket has to leave the
    // page's host entirely — a relative resolution here would open a socket back at github.io,
    // which has no server behind it.
    const client = new ApiClient({
      baseUrl: "https://kesef-street-api.onrender.com",
      origin: "https://guyflenner.github.io/monopoly/",
    });

    expect(client.eventStreamUrl("g1", 3)).toBe(
      "wss://kesef-street-api.onrender.com/games/g1/ws?since=3",
    );
  });

  it("takes wss from the API's scheme, not the page's", () => {
    // The asymmetry worth pinning: the scheme that matters is the one the socket actually connects
    // with. A plain-http page pointed at an https API must still get `wss` — and, the direction that
    // would be a real defect, an https *page* must not launder an http API into looking encrypted.
    const encrypted = new ApiClient({
      baseUrl: "https://api.kesef.test",
      origin: "http://localhost:5173/",
    });
    expect(encrypted.eventStreamUrl("g1")).toBe("wss://api.kesef.test/games/g1/ws?since=0");

    const plain = new ApiClient({
      baseUrl: "http://api.kesef.test",
      origin: "https://kesef.test/play",
    });
    expect(plain.eventStreamUrl("g1")).toBe("ws://api.kesef.test/games/g1/ws?since=0");
  });

  it("treats a trailing slash on the API url as the same place", () => {
    const client = new ApiClient({
      baseUrl: "https://api.kesef.test/",
      origin: "https://kesef.test/",
    });

    expect(client.eventStreamUrl("g1")).toBe("wss://api.kesef.test/games/g1/ws?since=0");
  });

  it("opens the socket through the injected factory at the cursor it is given", () => {
    const created: string[] = [];
    const client = new ApiClient({
      origin: "http://kesef.test/",
      createSocket: (url) => {
        created.push(url);
        return {
          close: () => undefined,
          onopen: null,
          onmessage: null,
          onerror: null,
          onclose: null,
        };
      },
    });

    client.openEventStream("g1", 5);

    expect(created).toEqual(["ws://kesef.test/api/games/g1/ws?since=5"]);
  });
});

describe("defaultBaseUrl — which API a client with no opinion talks to", () => {
  /*
    `import.meta.env` is frozen per module in Vitest, so these stub it rather than assigning to it.
    The behaviour is worth pinning at all because both directions are silent failures: an unset
    build that starts pointing somewhere absolute would send a developer's browser at production,
    and a split build that fell back to `/api` would fetch the *page's* host and 404 with no clue
    why.
  */
  it("stays same-origin when the build set nothing", () => {
    vi.stubEnv("VITE_API_URL", undefined);
    expect(defaultBaseUrl()).toBe(DEFAULT_BASE_URL);
    vi.unstubAllEnvs();
  });

  it("uses the API url the build was given", () => {
    vi.stubEnv("VITE_API_URL", "https://kesef-street-api.onrender.com");
    expect(defaultBaseUrl()).toBe("https://kesef-street-api.onrender.com");
    vi.unstubAllEnvs();
  });

  it("ignores a blank value rather than fetching the empty string", () => {
    // A CI variable that exists and is empty is the ordinary way this goes wrong: `VITE_API_URL=`
    // is set, so a truthiness check on `!== undefined` alone would make every request relative to
    // nothing.
    vi.stubEnv("VITE_API_URL", "   ");
    expect(defaultBaseUrl()).toBe(DEFAULT_BASE_URL);
    vi.unstubAllEnvs();
  });
});
